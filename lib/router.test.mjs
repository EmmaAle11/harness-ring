// node --test harness/lib/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveModel, modelId } from './router.mjs';

const router = JSON.parse(
  readFileSync(new URL('../policy/router.json', import.meta.url), 'utf8'),
);
// Compute razona sobre capacidades del MODELO: sin catalogo no puede decidir.
const catalog = JSON.parse(
  readFileSync(new URL('../policy/catalog.json', import.meta.url), 'utf8'),
);

const agente = (id, model_class) => ({ id, model_class });

test('resuelve por clase, nunca por proveedor nombrado en el agente', () => {
  const r = resolveModel(agente('researcher', 'read'), {
    router,
    catalog,
    available: new Set(['ollama', 'claude', 'deepseek']),
  });
  assert.ok(!r.error, r.error);
  // Politica 2026-08-14: Claude por defecto. Los locales son respaldo, no primera opcion.
  assert.equal(r.provider, 'claude');
});

test('el local sigue siendo respaldo cuando Claude no responde', () => {
  const r = resolveModel(agente('researcher', 'read'), { router, catalog, available: new Set(['ollama']) });
  assert.ok(!r.error, r.error);
  assert.equal(r.provider, 'ollama', 'degradar a local es legitimo; quedarse sin revisor NO');
});

test('cae al siguiente preferido si el primero no esta vivo', () => {
  const r = resolveModel(agente('architect', 'design'), {
    router,
    catalog,
    available: new Set(['claude']),
  });
  assert.ok(!r.error);
  assert.equal(r.provider, 'claude');
});

// ── Un proveedor vivo NO implica el modelo descargado ───────────────────────
// El router daba por bueno cualquier modelo mientras el proveedor respondiera,
// asi que dar de alta uno en router.json antes de bajarlo lo hacia elegible y el
// fallo salia como un 404 en mitad de la vuelta.

test('un modelo que el proveedor no tiene NO se elige; se cae al siguiente', () => {
  const r = resolveModel(agente('reviewer', 'review'), {
    router,
    catalog,
    available: new Set(['ollama']),
    // ollama vivo, pero solo con el 16b: lo que preceda en `prefer` no esta.
    models: new Map([['ollama', new Set(['deepseek-coder-v2:16b'])]]),
  });
  assert.ok(!r.error, r.error);
  assert.equal(r.model, 'deepseek-coder-v2:16b');
});

test('proveedor vivo sin ningun modelo instalado se declara, no se aprueba', () => {
  const r = resolveModel(agente('reviewer', 'review'), {
    router,
    catalog,
    available: new Set(['ollama']),
    models: new Map([['ollama', new Set(['un-modelo-que-nadie-pidio'])]]),
  });
  assert.match(r.error, /ningun modelo de la clase 'review' esta instalado/);
});

test('un proveedor que no publica inventario no se filtra', () => {
  // claude es un CLI y no enumera: no poder comprobarlo no es saber que falta.
  const r = resolveModel(agente('builder', 'edit'), {
    router,
    catalog,
    available: new Set(['claude']),
    models: new Map([['ollama', new Set([])]]),
  });
  assert.ok(!r.error, r.error);
  assert.equal(r.provider, 'claude');
});

test('sin inventario el comportamiento es el de antes: nadie se queda sin modelo', () => {
  const r = resolveModel(agente('reviewer', 'review'), { router, catalog, available: new Set(['ollama']) });
  assert.ok(!r.error, r.error);
});

// ── ADR-003: la razon de ser del router ─────────────────────────────────────
test('el reviewer NO recibe el modelo que uso el builder', () => {
  const available = new Set(['ollama', 'claude']);
  const builder = resolveModel(agente('builder', 'edit'), { router, catalog, available });
  assert.ok(!builder.error);

  const reviewer = resolveModel(agente('reviewer', 'review'), {
    router,
    catalog,
    available,
    avoid: [builder.id],
  });
  assert.ok(!reviewer.error, reviewer.error);
  assert.notEqual(reviewer.id, builder.id, 'un revisor del mismo modelo hereda su punto ciego');
  assert.notEqual(reviewer.provider, builder.provider);
});

test('PARADA DURA: solo Claude vivo -> el reviewer no tiene a quien recurrir', () => {
  // Con `edit` en Claude y `review` sin ninguna entrada de Claude, un entorno
  // donde solo vive Claude NO puede revisar de forma independiente. Debe parar.
  const available = new Set(['claude']);
  const builder = resolveModel(agente('builder', 'edit'), { router, catalog, available });
  assert.ok(!builder.error, 'el builder si puede resolver');

  const reviewer = resolveModel(agente('reviewer', 'review'), {
    router,
    catalog, available, avoid: [builder.id],
  });
  assert.ok(reviewer.error, 'debe FALLAR, no degradar en silencio');
  assert.ok(!reviewer.provider, 'no devuelve un modelo de consolacion');
});

test('PARADA DURA: el veto es por FAMILIA, no por modelo', () => {
  // Dos modelos de la misma familia comparten punto ciego. Si `review`
  // solo tuviera opciones del proveedor vetado, debe fallar aunque el MODELO
  // difiera. Se comprueba con un router sintetico para no depender de la tabla.
  const sintetico = {
    classes: {
      edit:   { why: 'x', prefer: [{ provider: 'claude', model: 'opus' }] },
      review: { why: 'y', prefer: [{ provider: 'claude', model: 'sonnet' }] },
    },
  };
  const b = resolveModel(agente('builder', 'edit'), { router: sintetico, catalog, available: new Set(['claude']) });
  const rv = resolveModel(agente('reviewer', 'review'), {
    router: sintetico, catalog, available: new Set(['claude']), avoid: [b.id],
  });
  assert.ok(rv.error, 'claude:opus escribiendo y claude:sonnet revisando NO cumple ADR-003');
  assert.match(rv.error, /ADR-003/);
});

test('sin ningun proveedor vivo, error que dice cuales harian falta', () => {
  const r = resolveModel(agente('builder', 'edit'), { router, catalog, available: new Set() });
  assert.ok(r.error);
  assert.match(r.error, /ningun proveedor vivo/);
  assert.match(r.error, /claude/);
});

test('clase desconocida se detecta y se nombra', () => {
  const r = resolveModel(agente('x', 'inventada'), { router, catalog, available: new Set(['ollama']) });
  assert.ok(r.error);
  assert.match(r.error, /clase de modelo desconocida/);
});

test('modelId es estable', () => {
  assert.equal(modelId({ provider: 'ollama', model: 'devstral:latest' }), 'ollama:devstral:latest');
});

// ── El router y las capacidades no pueden derivar ───────────────────────────────
test('toda clase usada por una capacidad existe en el router', async () => {
  const { loadCapabilities } = await import('./capabilities.mjs');
  const clases = new Set(Object.keys(router.classes));
  for (const a of loadCapabilities()) {
    assert.ok(
      clases.has(a.model_class),
      `capacidad '${a.id}' declara model_class '${a.model_class}', que no existe en router.json`,
    );
  }
});

// ── Una lista de respaldo con un solo proveedor no es una lista de respaldo ──
//
// MEDIDO 2026-08-18: Claude se cayo y las cuatro vueltas del dia murieron en las
// etapas 3 y 4. `read`, `plan` y `review` sobrevivieron porque tenian candidato
// fuera de claude; `design` tenia dos entradas -- claude:opus y claude:sonnet --
// que es el mismo proveedor dos veces, y `edit` tenia una. Un punto unico de
// fallo escrito en plural.
//
// Se comprueba contra el router VERSIONADO, no contra un fixture: lo que puede
// volver a romperse es el fichero de politica, no un objeto de prueba.
test('con claude CAIDO, TODA capacidad sigue teniendo modelo', async () => {
  const { loadRouter, loadCatalog, loadCapabilities } = await import('./capabilities.mjs');
  const router = loadRouter(); const catalog = loadCatalog(); const caps = loadCapabilities();
  const available = new Set(['deepseek', 'ollama', 'opencode']);

  for (const c of caps) {
    const m = resolveModel(c, { router, catalog, available, models: new Map() });
    assert.ok(!m.error, `'${c.id}' (${c.model_class}) se queda sin modelo sin claude: ${m.error}`);
    assert.notEqual(m.provider, 'claude');
  }
});

// LA POLITICA CAMBIO, Y ESTE TEST ES DONDE SE DICE.
//
// Este caso afirmaba lo contrario: con claude caido el escritor cae a deepseek,
// `review` se quedaba sin familia distinta y Compute DETENIA el anillo. Su propio
// comentario dejaba escrito el disparador -- «si manana vuelve un qwen al `prefer`
// de `review`, este test se pone en rojo y obliga a decir que la politica
// cambio»--, y es exactamente lo que paso el 2026-08-21. Se pone al dia en vez de
// borrarse: un test que se elimina cuando molesta no protegia nada.
//
// QUE CAMBIO. `ollama:qwen3.8:27b` entra en `review.prefer`. Estaba instalado,
// vivo y cumpliendo los dos `requires` desde antes; lo que no estaba era en la
// lista, que es la unica de la que sale el fallback. Durante 19 vueltas la
// independencia salio DEGRADED con el motivo «sin tercera familia viva», que
// describia mal su causa: la familia existia y el que no la veia era el `prefer`.
//
// EL PRECIO, declarado: es CPU. ~90 s por pasada de refutacion, tres pasadas por
// ronda. Se paga a proposito -- una revision de la familia que escribio hereda su
// punto ciego, y eso no se compensa con velocidad (ADR-003).
test('con claude caido, la refutacion cae en la TERCERA familia en vez de detenerse', async () => {
  const { loadRouter, loadCatalog, loadCapabilities } = await import('./capabilities.mjs');
  const router = loadRouter(); const catalog = loadCatalog(); const caps = loadCapabilities();
  const salud = { router, catalog, available: new Set(['deepseek', 'ollama', 'opencode']), models: new Map() };

  const b = resolveModel(caps.find((c) => c.id === 'builder'), salud);
  assert.equal(b.id, 'deepseek:deepseek-v4-pro', 'el escritor cae a su unico respaldo de pago');

  const r = resolveModel(caps.find((c) => c.id === 'reviewer'), { ...salud, avoid: [b.id] });
  assert.ok(!r.error, `con una tercera familia viva ya no hay motivo para detenerse: ${r.error ?? ''}`);

  const familiaDe = (id) => catalog.modelFamily?.[id] ?? catalog.providerFamily?.[id.split(':')[0]];
  assert.notEqual(familiaDe(r.id), familiaDe(b.id),
    'el refutador comparte familia con el escritor: eso es justo lo que ADR-003 prohibe');
  assert.equal(familiaDe(r.id), 'qwen', 'hoy la tercera familia es qwen; si cambia, este test lo dice');
});

test('el escritor NUNCA es local, ni con todo lo demas caido', async () => {
  const { loadRouter, loadCatalog, loadCapabilities } = await import('./capabilities.mjs');
  const router = loadRouter(); const catalog = loadCatalog(); const caps = loadCapabilities();
  // Solo ollama vivo: el builder debe quedarse SIN modelo, no caer a un local.
  const m = resolveModel(caps.find((c) => c.id === 'builder'), {
    router, catalog, available: new Set(['ollama']), models: new Map(),
  });
  assert.ok(m.error, 'el builder es lo unico que entra al arbol: preferir parar a escribir con un local');
  // El invariante es mas fuerte que `forbidden`: un local no llega ni a
  // CONSIDERARSE para `edit`, porque no esta en su `prefer`. La lista negra es el
  // cinturon; no estar en la lista es el tirante.
  assert.ok(
    !m.considered.some((x) => x.model.startsWith('ollama') || x.model.startsWith('opencode')),
    `un local se considero para escribir: ${m.considered.map((x) => x.model).join(', ')}`,
  );
  assert.match(m.error, /ningun proveedor vivo/);
});
