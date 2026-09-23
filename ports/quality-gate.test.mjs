// ── PuertaDeCalidad (QualityGatePort) ────────────────────────────────────────
//
// TEST PRIMERO.
//
// BLOQUEANTE 1. `stages.mjs:32-34` exige que el workspace contenga literalmente
// `scripts/gate.sh`, con la ruta compuesta en logica --join(ws,'scripts','gate.sh')--
// y si no esta, lanza y mata la vuelta.
//
// Y ES UN FALLO TARDIO: se descubre en la ETAPA 15, despues de 14 etapas y de
// todas las invocaciones de modelo, cuando se sabia en el segundo cero. Tres
// vueltas de h-009 murieron ahi el 22-sep.
//
// LA FORMA DEL CONTRATO la da Aider: `--test-cmd` es un STRING y el contrato es
// «imprime en stdout/stderr y devuelve != 0». No hace falta saber que es bash ni
// que se llama gate.sh; hace falta un comando, un codigo de salida y donde
// escribio su evidencia. Un puerto que preguntara «que framework usas»
// reproduciria el acoplamiento en otra capa.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OPERACIONES, assertPuerta, puertaNula } from './quality-gate.mjs';

test('el puerto declara sus operaciones', () => {
  for (const op of ['id', 'disponible', 'ejecutar', 'describe']) {
    assert.ok(OPERACIONES.includes(op), `falta '${op}'`);
  }
});

test('`disponible()` se puede preguntar AL ARRANCAR, no en la etapa 15', () => {
  // Esta es la razon de existir del puerto. Saber en el segundo cero que la
  // puerta no esta, en vez de gastar 14 etapas y todas las llamadas al modelo.
  const p = puertaNula('no hay gate configurado en este proyecto');
  const d = p.disponible('/cualquier/ruta');
  assert.equal(d.ok, false);
  assert.match(d.porque, /gate|configurad/i);
});

test('EL ADAPTADOR NULO NUNCA DEVUELVE PASS', () => {
  // El fallo que `dominios.json` ya documenta para este mismo repo: con otra
  // disposicion de carpetas todo caia a `plataforma`, que cuenta 0 dominios, y
  // maxDomains aprobaba cualquier cosa EN SILENCIO.
  //
  // «Cero hallazgos porque el control no corrio» y «cero hallazgos porque no
  // habia nada» son estados DISTINTOS, y quien los confunde es quien se pierde.
  const p = puertaNula('sin configurar');
  const r = p.ejecutar({ workspace: '/x', modo: 'full' });
  assert.equal(r.veredicto, 'NOT_CONFIGURED');
  assert.notEqual(r.veredicto, 'PASS');
});

test('un adaptador incompleto se RECHAZA al negociar, no al usarse', () => {
  assert.throws(() => assertPuerta({ id: () => 'x' }, 'adaptador-roto'), /quality|puerta|falta/i);
  assert.doesNotThrow(() => assertPuerta(puertaNula('x')));
});

test('`ejecutar` devuelve veredicto, codigo de salida y donde quedo la evidencia', () => {
  // El veredicto solo no basta: en H-20260816-b0ae48ef faltaba el PUNTERO a la
  // evidencia y no se pudo auditar que fallo.
  const p = puertaNula('x');
  const r = p.ejecutar({ workspace: '/x', modo: 'fast' });
  for (const k of ['veredicto', 'codigoSalida', 'stdout', 'stderr', 'ms']) {
    assert.ok(k in r, `la respuesta debe traer '${k}'`);
  }
});

test('`capabilities()` declara los modos que entiende', () => {
  // MCP negocia capacidades en el initialize y ambas partes respetan lo
  // declarado durante toda la sesion. Aqui igual: el motor pregunta antes.
  const p = puertaNula('x');
  const c = p.capabilities();
  assert.ok(Array.isArray(c.modos));
});
