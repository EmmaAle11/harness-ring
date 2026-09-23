// ── rho-gate: parada temprana por densidad de accion ─────────────────────────
//
// TEST PRIMERO. Cada caso cita una vuelta REAL de `.harness/runs/`, con sus
// cifras medidas el 2026-09-22 sobre los 29 intentos de Execution que tienen
// telemetria. Si manana alguien afloja el umbral, estos numeros le dicen a que
// vuelta concreta le esta cambiando el desenlace.
//
// QUE MIDE rho = toolCalls / iterations: si el builder sigue TOCANDO el
// repositorio o si solo razona en circulo. NO es el vector `changeSurface`
// --ese describe lo que la spec PIDE y ya se refuto que prediga nada-- sino una
// senal que solo existe DURANTE la ejecucion.
//
// LA SEPARACION MEDIDA (29 intentos, recalculada por mi desde los artefactos,
// no heredada de un informe):
//   OK           n=14  rho [0.900 .. 0.958]
//   AGOTAMIENTO  n= 6  rho [0.156 .. 0.375]   <- lo que este gate caza
//   BLOQUEO      n= 8  rho [0.500 .. 0.857]   <- NO es su objetivo: ya paran solos
// Hueco entre el peor OK (0.900) y el mejor agotamiento (0.375): +0.525.
//
// LOS BLOQUEOS QUEDAN FUERA A PROPOSITO. Paran en 2-7 iteraciones por si solos,
// no gastan presupuesto, y su rho (0.500-0.857) invade la banda del umbral. Un
// gate que intentara cazarlos tambien tendria que subir theta hasta rozar el
// 0.900 del peor OK. Son el problema contrario --no llegan a empezar-- y piden
// otro remedio.
import test from 'node:test';
import assert from 'node:assert/strict';
import { veredictoRho, crearGuardiaRho, RHO_W, RHO_THETA } from './rho-gate.mjs';

test('los valores por defecto son los MEDIDOS, no numeros redondos de gusto', () => {
  // RECALIBRADO tras h-009: el agotamiento mas alto paso de 0.375 a 0.725, asi
  // que theta subio de 0.6 a 0.75 -- el primer valor del barrido 0.600..0.900
  // con recall 1.00 y cero falsos positivos. W=8 sigue dejando pasar los
  // bloqueos (2-7 iteraciones) sin juzgarlos.
  assert.equal(RHO_THETA, 0.75);
  assert.equal(RHO_W, 8);
  assert.ok(RHO_THETA > 0.725 && RHO_THETA < 0.900,
    'theta cae entre el agotamiento mas alto MEDIDO y el OK mas bajo');
  assert.ok(RHO_W > 7, 'W deja fuera el bloqueo mas largo (7 iteraciones)');
});

test('h-009 V1: el agotamiento del regimen GRANDE tambien se caza', () => {
  // H-20260922-db22e905 · 40 iteraciones, 29 llamadas, rho=0.725. Murio por tope
  // agotado y con theta=0.6 el gate NO disparo NUNCA. Esta es la vuelta que
  // obligo a recalibrar: si este test se pone en rojo, alguien bajo el umbral
  // por debajo de un agotamiento real y medido.
  const r = veredictoRho({ iterations: 40, toolCalls: 29 });
  assert.equal(r.parar, true, 'rho=0.725 es agotamiento medido, no una vuelta viva');
  assert.equal(r.onFail, 'STOP');
});

test('la frontera nueva no se come al peor OK historico', () => {
  // H-20260824-fa058d63: 20 iteraciones, 18 llamadas, rho=0.900. Es el OK con el
  // rho mas bajo de las 15 vueltas buenas. Queda +0.150 por encima del umbral.
  const r = veredictoRho({ iterations: 20, toolCalls: 18 });
  assert.equal(r.parar, false, 'el OK mas bajo debe sobrevivir al umbral nuevo');
});

test('las seis vueltas de AGOTAMIENTO se cazan: TP=6, FN=0', () => {
  // it/tc reales de .harness/runs/. Todas terminaron en FAILED tras agotar el tope.
  const agotamiento = [
    { run: 'H-20260917-c53885df', it: 90, tc: 14 },
    { run: 'H-20260917-75135851', it: 90, tc: 15 },
    { run: 'H-20260915-61318185', it: 90, tc: 20 },
    { run: 'H-20260915-a48557d6', it: 40, tc: 12 },
    { run: 'H-20260915-8cf63595', it: 40, tc: 13 },
    { run: 'H-20260915-f15f6ffa', it: 40, tc: 15 },
  ];
  for (const v of agotamiento) {
    const r = veredictoRho({ iterations: v.it, toolCalls: v.tc });
    assert.equal(r.parar, true, `${v.run} deberia cortarse (rho=${(v.tc / v.it).toFixed(3)})`);
  }
});

test('las catorce vueltas OK NO se tocan: FP=0 — cortar una buena cuesta mas', () => {
  const buenas = [
    { run: 'H-20260824-fa058d63', it: 20, tc: 18 },
    { run: 'H-20260827-8c236b59', it: 11, tc: 10 },
    { run: 'H-20260915-476fb0f6', it: 11, tc: 10 },
    { run: 'H-20260918-bc2160bb', it: 13, tc: 12 },
    { run: 'H-20260921-5e4450b5', it: 13, tc: 12 },
    { run: 'H-20260917-0ebc2c27', it: 14, tc: 13 },
    { run: 'H-20260824-5c7f7943', it: 16, tc: 15 },
    { run: 'H-20260921-26bf176e', it: 16, tc: 15 },
    { run: 'H-20260918-98966ed0', it: 17, tc: 16 },
    { run: 'H-20260824-d897a07f', it: 19, tc: 18 },
    { run: 'H-20260917-a2f816c4', it: 20, tc: 19 },
    { run: 'H-20260918-9a093b28', it: 20, tc: 19 },
    { run: 'H-20260824-0999c854', it: 22, tc: 21 },
    { run: 'H-20260917-fef6f11b', it: 24, tc: 23 },
  ];
  for (const v of buenas) {
    const r = veredictoRho({ iterations: v.it, toolCalls: v.tc });
    assert.equal(r.parar, false, `${v.run} acabo en OK y el gate la cortaria`);
  }
});

test('el calentamiento protege a los BLOQUEOS: nadie juzga antes de W', () => {
  // H-20260915-13d44956: BLOCKED tras 2 iteraciones, 1 llamada. rho=0.500 < 0.6,
  // pero con 2 iteraciones no hay evidencia de nada. Sin la ventana, este gate
  // acusaria de «dejo de tocar el repositorio» a quien no tuvo tiempo de tocarlo.
  const r = veredictoRho({ iterations: 2, toolCalls: 1 });
  assert.equal(r.parar, false);
  assert.match(r.reason ?? '', /calentamiento|W=/);
});

test('la frontera es estricta: rho igual al umbral NO corta', () => {
  // 15/20 = 0.750 exacto. Ante la duda no se corta: el coste de un falso
  // positivo (matar una vuelta buena) es mayor que el de una cola desperdiciada.
  assert.equal(veredictoRho({ iterations: 20, toolCalls: 15 }).parar, false);
  assert.equal(veredictoRho({ iterations: 20, toolCalls: 14 }).parar, true);
});

test('MODO SOMBRA: mide y NO corta — para estrenar sin arriesgar', () => {
  // h-009 es 4,4x mayor que cualquier task medida. El umbral se calibro en un
  // regimen que h-009 no habita: una task grande PODRIA necesitar mas iteraciones
  // de lectura legitimas. En sombra el gate registra rho sin decidir.
  const r = veredictoRho({ iterations: 90, toolCalls: 14, sombra: true });
  assert.equal(r.parar, false, 'en sombra nunca corta');
  assert.equal(r.habriaParado, true, 'pero deja constancia de que habria cortado');
  assert.ok(typeof r.rho === 'number');
});

test('`onFail: STOP` — esto no mejora reintentando', () => {
  // Un builder que dejo de tocar el repositorio no se arregla dandole otra vuelta:
  // es el mismo caso que un ciclo detectado en Convergence. Si subiera como RETRY,
  // el anillo gastaria otro presupuesto entero para llegar al mismo sitio.
  const r = veredictoRho({ iterations: 90, toolCalls: 14 });
  assert.equal(r.onFail, 'STOP');
});

test('el guardia cuenta lo que el bucle real le dice, y coincide con la funcion pura', () => {
  const g = crearGuardiaRho();
  // Reproduce H-20260915-a48557d6: 40 iteraciones, 12 llamadas.
  for (let i = 0; i < 40; i++) {
    g.alIterar();
    if (i < 12) g.alLlamarHerramienta();
  }
  const v = g.veredicto();
  assert.equal(v.parar, true);
  assert.equal(v.rho, veredictoRho({ iterations: 40, toolCalls: 12 }).rho);
});

test('division por cero: sin iteraciones no hay densidad que medir', () => {
  const r = veredictoRho({ iterations: 0, toolCalls: 0 });
  assert.equal(r.parar, false);
  assert.ok(Number.isFinite(r.rho));
});

test('el motivo NOMBRA la cifra: un veredicto sin su numero no se puede auditar', () => {
  const r = veredictoRho({ iterations: 90, toolCalls: 14 });
  assert.match(r.reason, /0\.156/);
  assert.match(r.reason, /90/);
});

// ── El cable, no solo la pieza ───────────────────────────────────────────────
// Un modulo con 10 tests en verde que nadie invoca es un modulo inerte. Esto
// comprueba que el bucle REAL del builder lo consulta. Se lee el fichero en vez
// de importarlo porque `ejecutarAgentic` necesita un proveedor vivo.
test('el bucle del builder CONSULTA el gate: la pieza esta cableada', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./agentic.mjs', import.meta.url), 'utf8');
  assert.match(src, /import \{ veredictoRho \}/, 'agentic.mjs importa el gate');
  assert.match(src, /veredictoRho\(\{\s*iterations/, 'lo invoca con el contador real del bucle');
  assert.match(src, /if \(rg\.parar\) return parar\('FAILED'/, 'y ACTUA sobre el veredicto');
});

test('el gate se consulta junto a los demas topes, antes de gastar la iteracion', async () => {
  // Si se consultara DESPUES de invocar al modelo, cortaria una iteracion tarde:
  // pagaria la llamada que pretende ahorrar.
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./agentic.mjs', import.meta.url), 'utf8');
  const posGate = src.indexOf('veredictoRho({ iterations');
  const posInc  = src.indexOf('iterations++');
  assert.ok(posGate > 0 && posInc > 0);
  assert.ok(posGate < posInc, 'el gate se consulta ANTES de `iterations++`');
});

test('el modo sombra viaja por ENTORNO: el arbol de trabajo no llega a la vuelta', async () => {
  // El workspace se construye desde HEAD. Si el interruptor viviera solo en
  // `policy/tools.json`, ponerlo en el arbol de trabajo NO tendria efecto en la
  // corrida y yo creeria estar midiendo en sombra mientras el gate corta.
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./agentic.mjs', import.meta.url), 'utf8');
  assert.match(src, /DOXIA_RHO_SOMBRA/, 'hay interruptor por entorno');
  assert.match(src, /sombra: rhoSombra/, 'y alimenta al gate');
});
