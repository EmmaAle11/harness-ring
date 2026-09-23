// ── Proveedores vetados: la lista que NADIE puede saltarse ───────────────────
//
// TEST PRIMERO.
//
// Que `gemini` no aparezca en ningun `prefer` de router.json NO basta como veto:
// `prefer` es una PREFERENCIA, y el adaptador sigue registrado en PROVIDERS. Una
// spec que nombre el modelo, un `avoid` que empuje el fallback hasta el, o una
// futura clase de modelo que lo liste, lo devuelven al anillo sin que nadie lo
// note. Un proveedor prohibido tiene que fallar CERRADO en el unico sitio por el
// que se decide: `compute.decide()`.
//
// DECISION DEL USUARIO, 2026-09-22: «Dejaras de usar gemini ya de por vida ya no
// lo uses.» Es una prohibicion permanente, no una preferencia de coste.
//
// CONSECUENCIA MEDIDA Y ACEPTADA: sin gemini quedan dos familias --anthropic
// (builder) y deepseek (reviewer)--, asi que la etapa 10 no encuentra una TERCERA
// familia para refutar y `adversarial` cae al modelo del reviewer.
// `independence.status` pasa a DEGRADED y lo DECLARA en el binding. No se rompe,
// se dice. Las 3 pasadas del adversarial vuelven a ser tres muestras del MISMO
// criterio: miden su varianza, no lo corroboran.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decide, PROVEEDORES_VETADOS } from './compute.mjs';

const leer = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const catalog = leer('../policy/catalog.json');
const router = leer('../policy/router.json');

test('la lista de vetados existe y nombra a gemini', () => {
  assert.ok(PROVEEDORES_VETADOS instanceof Set);
  assert.ok(PROVEEDORES_VETADOS.has('gemini'), 'gemini esta vetado de por vida');
});

test('un proveedor vetado se RECHAZA aunque este vivo y en el prefer', () => {
  // Se construye una clase que lo prefiere explicitamente y una salud que lo
  // declara vivo con su modelo servido: el caso mas favorable posible.
  const routerConGemini = {
    ...router,
    classes: {
      ...router.classes,
      prueba_veto: { prefer: [{ provider: 'gemini', model: 'gemini-2.5-pro' }] },
    },
  };
  const health = {
    alive: new Set(['gemini']),
    models: new Map([['gemini', new Set(['gemini-2.5-pro'])]]),
  };
  const r = decide(
    { capability: 'x', modelClass: 'prueba_veto', requiredCapabilities: [],
      avoid: [], forbidden: [], budget: { maxCostTier: 'high' } },
    { catalog, router: routerConGemini, health },
  );
  assert.notEqual(r.provider, 'gemini',
    'un proveedor vetado NO puede ser elegido ni siendo el unico preferido y estando vivo');
  assert.ok(r.error, 'sin candidatos permitidos, decide() devuelve error en vez de inventar uno');
});

test('el rechazo NOMBRA la regla: un veto silencioso no se puede auditar', () => {
  const routerConGemini = {
    ...router,
    classes: { ...router.classes, prueba_veto2: { prefer: [{ provider: 'gemini', model: 'gemini-2.5-pro' }] } },
  };
  const health = { alive: new Set(['gemini']), models: new Map([['gemini', new Set(['gemini-2.5-pro'])]]) };
  const r = decide(
    { capability: 'x', modelClass: 'prueba_veto2', requiredCapabilities: [],
      avoid: [], forbidden: [], budget: { maxCostTier: 'high' } },
    { catalog, router: routerConGemini, health },
  );
  const rechazos = JSON.stringify(r.considered ?? r);
  assert.match(rechazos, /veto/i, 'el motivo del rechazo dice que fue un veto');
});

test('el veto NO estorba a los proveedores permitidos', () => {
  // La prohibicion tiene que ser quirurgica: si tumbara tambien a claude o
  // deepseek, el anillo entero se quedaria sin modelos y el veto seria un apagon.
  const health = {
    alive: new Set(['claude', 'deepseek', 'ollama']),
    models: new Map([
      ['claude', new Set(['opus', 'sonnet', 'haiku'])],
      ['deepseek', new Set(['deepseek-v4-pro'])],
      ['ollama', new Set(['qwen2.5-coder:7b'])],
    ]),
  };
  // `premium`, no `high`: el unico preferido de `edit` es `claude:opus`, que en
  // el catalogo es tier premium. Con un tope mas bajo lo rechaza el PRESUPUESTO
  // y el test estaria midiendo otra cosa -- pasaria en rojo por un motivo que no
  // es el veto, que es justo lo que este caso debe descartar.
  const r = decide(
    { capability: 'builder', modelClass: 'edit', requiredCapabilities: [],
      avoid: [], forbidden: [], budget: { maxCostTier: 'premium' } },
    { catalog, router, health },
  );
  assert.ok(r.provider, 'con claude vivo, la clase `edit` sigue resolviendo');
  assert.equal(r.provider, 'claude');
  assert.notEqual(r.provider, 'gemini');
});

test('gemini no aparece en ningun `prefer` de la policy real', () => {
  // Cinturon Y tirantes: el veto en codigo es la defensa, pero dejarlo tambien
  // fuera de la policy evita que alguien lo lea ahi y crea que esta disponible.
  for (const [nombre, cls] of Object.entries(router.classes ?? {})) {
    const pref = JSON.stringify(cls.prefer ?? []);
    assert.ok(!pref.includes('gemini'), `la clase '${nombre}' todavia prefiere gemini`);
  }
});
