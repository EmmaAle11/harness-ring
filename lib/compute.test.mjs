// node --test harness/lib/
//
// Compute como SCHEDULER, no como router. Lo que se prueba no es "eligio un
// modelo" sino que la eleccion sea REPRODUCIBLE y EXPLICABLE: ante el mismo
// catalogo, politica y salud, la misma decision, y con el motivo de cada
// descarte. Una eleccion que no se puede explicar no se puede auditar.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { computeRequest, decide } from './compute.mjs';

const router = JSON.parse(readFileSync(new URL('../policy/router.json', import.meta.url), 'utf8'));
const catalog = JSON.parse(readFileSync(new URL('../policy/catalog.json', import.meta.url), 'utf8'));

const cap = (id, model_class) => ({ id, model_class });
const salud = (alive, models) => ({
  alive: new Set(alive),
  models: new Map(Object.entries(models ?? {}).map(([k, v]) => [k, new Set(v)])),
});
const TODO = salud(['claude', 'deepseek', 'ollama', 'opencode'], {
  deepseek: ['deepseek-v4-pro', 'deepseek-flash'],
  ollama: ['qwen3.8:27b', 'deepseek-coder-v2:16b', 'qwen2.5-coder:7b', 'qwen2.5-coder:14b'],
});

const pide = (id, cls, opts = {}) =>
  decide(computeRequest(cap(id, cls), { router, ...opts }), { catalog, router, health: opts.health ?? TODO });

// ── 1.2 · La solicitud es normalizada, no un puñado de argumentos ────────────
test('computeRequest normaliza: riesgo, capacidades exigidas y presupuesto', () => {
  const r = computeRequest(cap('builder', 'edit'), { router });
  assert.equal(r.capability, 'builder');
  assert.equal(r.risk, 'critical');
  assert.deepEqual(r.requiredCapabilities, ['tool_calling', 'structured_output', 'long_context']);
  assert.equal(r.budget.maxCostTier, 'premium');
  assert.deepEqual(r.forbidden, ['ollama:*', 'opencode:*']);
});

// ── Criterio 9 · reproducibilidad ───────────────────────────────────────────
test('misma peticion, catalogo y politica -> MISMA decision', () => {
  const a = pide('reviewer', 'review');
  const b = pide('reviewer', 'review');
  assert.deepEqual(a, b, 'una decision que varia sin causa no es auditable');
  assert.equal(a.id, 'deepseek:deepseek-v4-pro');
});

// ── 1.5 · La decision se explica ────────────────────────────────────────────
test('la decision dice que se considero, que se descarto y por que regla', () => {
  const d = pide('builder', 'edit');
  assert.equal(d.id, 'claude:opus');

  const porModelo = Object.fromEntries(d.considered.map((c) => [c.model, c]));
  // `edit` prohibe los locales: el escritor es lo unico que entra al arbol.
  assert.equal(porModelo['claude:opus'].aceptado, true);
  assert.ok(d.policy.requiredCapabilities.includes('tool_calling'));
  assert.equal(d.policy.risk, 'critical');
  // Todo descarte trae regla Y motivo, nunca uno sin el otro.
  for (const c of d.considered.filter((x) => !x.aceptado)) {
    assert.ok(c.regla, `${c.model} descartado sin regla`);
    assert.ok(c.motivo, `${c.model} descartado sin motivo`);
  }
});

// ── 1.4 · Fallback determinista, nunca "cualquier modelo disponible" ────────
test('el fallback sale de `prefer`, y jamas incluye un prohibido', () => {
  // El INVARIANTE, no la lista de hoy. Estaba fijado con un `deepEqual` literal y
  // se ponia rojo con cada ajuste de politica -- que es ruido, no proteccion: lo
  // que no puede cambiar nunca es que un fallback salga de `prefer` y respete
  // `forbidden`, no que ese dia hubiera tres entradas y no dos.
  const d = pide('reviewer', 'review');
  const enPrefer = router.classes.review.prefer.map((c) => `${c.provider}:${c.model}`);

  assert.ok(d.fallback.length, 'sin fallback, el primario es un punto unico de fallo');
  for (const f of d.fallback) {
    assert.ok(enPrefer.includes(f), `'${f}' no esta en prefer: caer fuera de la lista es "cualquier modelo disponible"`);
  }
  assert.ok(!d.fallback.some((f) => f.startsWith('claude:')), 'claude esta prohibido en review (ADR-003)');
  // opencode queda fuera: no soporta structured_output, que `review` exige.
  assert.ok(!d.fallback.includes('opencode:default'));
});

test('si el primario no esta instalado, cae al SIGUIENTE de prefer, no a cualquiera', () => {
  const d = pide('reviewer', 'review', {
    health: salud(['deepseek', 'ollama'], {
      deepseek: ['deepseek-flash'],                    // falta el `pro`
      ollama: ['qwen3.8:27b', 'deepseek-coder-v2:16b'],
    }),
  });
  assert.equal(d.id, 'deepseek:deepseek-flash');
  const pro = d.considered.find((c) => c.model === 'deepseek:deepseek-v4-pro');
  assert.equal(pro.regla, 'availability');
});

// ── 1.3 · La politica decide; no hay `if (reviewer) useClaude()` ────────────
test('un modelo sin las capacidades exigidas se rechaza ANTES de invocarlo', () => {
  const d = pide('reviewer', 'review', { health: salud(['opencode']) });
  // opencode declara structured_output:false -> `review` no lo admite.
  assert.ok(d.error, 'deberia quedarse sin candidatos');
  assert.match(d.error, /no soporta structured_output/);
});

test('un modelo fuera de presupuesto se descarta con ese motivo', () => {
  const barato = JSON.parse(JSON.stringify(router));
  barato.classes.review.maxCostTier = 'free';
  const d = decide(computeRequest(cap('reviewer', 'review'), { router: barato }),
    { catalog, router: barato, health: TODO });
  assert.equal(d.provider, 'ollama', 'con presupuesto free solo queda el local');
  assert.equal(d.considered.find((c) => c.model === 'deepseek:deepseek-v4-pro').regla, 'budget');
});

// ── ADR-003 · la diversidad es por FAMILIA, no por proveedor ────────────────
test('opencode NO vale como revisor de deepseek: sirve deepseek por debajo', () => {
  assert.equal(catalog.providerFamily.opencode, 'deepseek');

  // AISLADO a proposito. Con el router real, `ollama` va antes que `opencode` en
  // `prefer` y gana igual aunque el veto fuera por proveedor: el test pasaria sin
  // comprobar nada. Aqui opencode es el UNICO candidato, asi que solo hay dos
  // salidas -- se rechaza por familia, o se acepta un revisor que corre el mismo
  // modelo que escribio.
  const sintetico = {
    classes: { review: { why: 'aislado', prefer: [{ provider: 'opencode', model: 'default' }] } },
  };
  const d = decide(
    computeRequest(cap('reviewer', 'review'), { router: sintetico, avoid: ['deepseek:deepseek-v4-pro'] }),
    { catalog, router: sintetico, health: salud(['opencode']) },
  );
  assert.ok(d.error, 'opencode sirve deepseek: heredaria el punto ciego del escritor');
  assert.match(d.error, /ADR-003/);
  assert.equal(d.considered[0].regla, 'diversity');
});

test('sin ningun candidato de otra familia, se DETIENE en vez de degradar', () => {
  const d = pide('reviewer', 'review', {
    avoid: ['deepseek:deepseek-v4-pro'],
    health: salud(['deepseek', 'opencode'], { deepseek: ['deepseek-v4-pro', 'deepseek-flash'] }),
  });
  assert.ok(d.error, 'una revision del mismo punto ciego vale menos que ninguna');
  assert.match(d.error, /diversity|no soporta/);
});

// ── El error tambien se explica ─────────────────────────────────────────────
test('quedarse sin candidatos deja el registro de por que cayo cada uno', () => {
  const d = pide('reviewer', 'review', { health: salud([]) });
  assert.ok(d.error);
  assert.ok(d.considered.length >= 4);
  assert.ok(d.considered.every((c) => !c.aceptado && c.regla));
});

// ── Fase 11 · La familia es de quien RAZONA, no de quien sirve ───────────────
//
// `providerFamily` basta para un proveedor que sirve una sola familia. ollama
// sirve las que tenga descargadas, y con `ollama -> local` un revisor
// `ollama:deepseek-coder-v2` sobre un escritor `deepseek:deepseek-v4-pro`
// pasaba el filtro de diversidad heredando exactamente el punto ciego que
// ADR-003 existe para evitar. Es el MISMO razonamiento que ya obligo a vetar
// opencode, sin aplicar.
test('familiaDe: el mapa por MODELO gana al mapa por proveedor', async () => {
  const { familiaDe, parteDe } = await import('./compute.mjs');
  const cat = {
    providerFamily: { ollama: 'qwen', deepseek: 'deepseek' },
    modelFamily: { 'ollama:deepseek-coder-v2:16b': 'deepseek' },
  };
  assert.equal(familiaDe(cat, 'ollama', 'qwen3-coder'), 'qwen');
  assert.equal(familiaDe(cat, 'ollama', 'deepseek-coder-v2:16b'), 'deepseek',
    'un modelo DeepSeek servido en local sigue siendo DeepSeek');
  assert.equal(familiaDe(cat, 'nuevo'), 'nuevo', 'lo no declarado es su propia familia');
});

test('parteDe respeta los dos puntos DENTRO del nombre del modelo', async () => {
  const { parteDe } = await import('./compute.mjs');
  assert.deepEqual(parteDe('ollama:deepseek-coder-v2:16b'), ['ollama', 'deepseek-coder-v2:16b']);
  assert.deepEqual(parteDe('claude:opus'), ['claude', 'opus']);
});

test('un modelo DeepSeek en local NO vale como revisor de un escritor DeepSeek', async () => {
  const { decide, computeRequest } = await import('./compute.mjs');
  const catalog = {
    providerFamily: { ollama: 'qwen', deepseek: 'deepseek' },
    modelFamily: { 'ollama:deepseek-coder-v2:16b': 'deepseek' },
    models: [
      { provider: 'ollama', model_id: 'deepseek-coder-v2:16b', structured_output: true, cost: { tier: 'free' } },
      { provider: 'ollama', model_id: 'qwen3-coder', structured_output: true, cost: { tier: 'free' } },
    ],
  };
  const router = {
    classes: {
      review: {
        prefer: [
          { provider: 'ollama', model: 'deepseek-coder-v2:16b' },
          { provider: 'ollama', model: 'qwen3-coder' },
        ],
        requires: ['structured_output'], maxCostTier: 'free',
      },
    },
  };
  const health = { alive: new Set(['ollama']), models: new Map() };
  const req = computeRequest({ id: 'reviewer', model_class: 'review' }, {
    router, avoid: ['deepseek:deepseek-v4-pro'],
  });
  const d = decide(req, { catalog, router, health });

  assert.equal(d.id, 'ollama:qwen3-coder', 'salta el DeepSeek local y cae en la familia distinta');
  const rechazado = d.considered.find((c) => c.model === 'ollama:deepseek-coder-v2:16b');
  assert.equal(rechazado.regla, 'diversity');
  assert.match(rechazado.motivo, /familia 'deepseek'/);
});

// ── ADR-003 deja de ser prosa: la tercera familia se COMPRUEBA ──────────────
//
// La regla dice que quien refuta no puede compartir familia con quien escribio.
// Con `builder` en anthropic y `reviewer` en deepseek, el refutador necesita una
// TERCERA familia — y durante 19 vueltas seguidas no la hubo: `independence`
// salio `DEGRADED` en todas, con el motivo «sin tercera familia viva».
//
// El motivo era FALSO, y por eso nadie lo arreglaba. Ollama estaba vivo,
// `qwen3.8:27b` instalado, cumpliendo los dos `requires`, y `providerFamily` lo
// marca familia `qwen`. Lo que faltaba no era una familia: era estar en `prefer`,
// que es la unica lista de la que sale el fallback. Un mensaje que describe mal su
// causa mantiene abierto el defecto que nombra.
//
// Esto lo fija como INVARIANTE y no como la lista de hoy: da igual que manana el
// tercero sea otro modelo u otra familia; lo que no puede volver a pasar es que
// `review` se quede sin ninguno y el harness lo llame «no hay».
test('la clase `review` tiene al menos un modelo de una TERCERA familia', () => {
  const familiaDe = (p, m) => catalog.modelFamily?.[`${p}:${m}`] ?? catalog.providerFamily?.[p];
  const prefer = router.classes.review.prefer;

  const familias = new Set(prefer.map((c) => familiaDe(c.provider, c.model)));
  const terceras = [...familias].filter((f) => f && f !== 'anthropic' && f !== 'deepseek');

  assert.ok(
    terceras.length,
    'ninguna entrada de `review.prefer` sale de anthropic ni de deepseek: con el builder en una y '
    + 'el reviewer en la otra, el refutador de ADR-003 no tiene de donde salir y la independencia '
    + `queda DEGRADED para siempre. Familias en prefer: [${[...familias].join(', ')}]`,
  );

  // Y ese tercero tiene que ser ELEGIBLE, no solo estar apuntado: una entrada que
  // incumple los `requires` de la clase es una lista mas larga, no una familia mas.
  const req = router.classes.review.requires ?? [];
  const apto = prefer.some((c) => {
    const f = familiaDe(c.provider, c.model);
    if (!f || f === 'anthropic' || f === 'deepseek') return false;
    const m = catalog.models.find((x) => x.provider === c.provider && x.model_id === c.model);
    return m && req.every((k) => m[k]);
  });
  assert.ok(apto, `la tercera familia esta en la lista pero no cumple ${JSON.stringify(req)}: no sirve para refutar`);
});
