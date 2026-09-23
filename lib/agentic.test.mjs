// node --test harness/lib/
//
// El bucle, sin gastar un token: `invoke` se inyecta. Lo que se fija aqui es que
// los LIMITES son del harness y no del modelo -- un tope que el prompt puede
// levantar no es un tope.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { toolLoop, protocolo, podar } from './agentic.mjs';
import { loadToolPolicy } from './tools.mjs';
import { loadCapabilities, RUNTIME } from './capabilities.mjs';
import { ENV_LIMPIO } from './sandbox.mjs';

const WS = { kind: 'worktree', path: join(RUNTIME, 'workspaces', 'test-agentic'), rollback: 'HEAD' };
const CAP = () => loadCapabilities().find((c) => c.id === 'builder');
const ASIG = { provider: 'ficticio', model: 'ficticio' };

/** Un modelo de guion: devuelve la respuesta n-esima y guarda lo que recibio. */
function guion(respuestas) {
  const vistos = [];
  const invoke = async (_a, prompt) => {
    vistos.push(prompt);
    const r = respuestas[vistos.length - 1] ?? respuestas.at(-1);
    return { text: typeof r === 'function' ? r() : JSON.stringify(r) };
  };
  return { invoke, vistos };
}

before(() => {
  rmSync(WS.path, { recursive: true, force: true });
  mkdirSync(join(WS.path, 'src', 'lib'), { recursive: true });
  const g = (...a) => execFileSync('git', a, { cwd: WS.path, env: ENV_LIMPIO(), stdio: 'pipe' });
  g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  writeFileSync(join(WS.path, 'src', 'lib', 'base.ts'), 'export const uno = 1;\n');
  g('add', '-A'); g('commit', '-qm', 'base');
});
after(() => rmSync(WS.path, { recursive: true, force: true }));

const correr = (respuestas, policy) => {
  const { invoke, vistos } = guion(respuestas);
  return toolLoop({ cap: CAP(), assignment: ASIG, task: 'la tarea', workspace: WS, invoke, policy })
    .then((r) => ({ ...r, vistos }));
};

// ── El ciclo completo ────────────────────────────────────────────────────────
test('read -> patch -> observar -> corregir -> done: VARIAS tool calls en una ejecucion', async () => {
  const { hashDe } = await import('./mutation.mjs');
  const h = hashDe(readFileSync(join(WS.path, 'src/lib/base.ts')));

  const r = await correr([
    { tool: 'read_file', args: { path: 'src/lib/base.ts' } },
    // Primer intento: el parche no aplica.
    { tool: 'apply_patch', args: { path: 'src/lib/base.ts', baseHash: h, patch: '--- a/x\n+++ b/x\n@@ -9 +9 @@\n-no\n+si\n' } },
    // Lo OBSERVA y corrige: reescribe el fichero declarando su version.
    { tool: 'create_file', args: { path: 'src/lib/base.ts', baseHash: h, content: 'export const uno = 1;\nexport const dos = 2;\n' } },
    { tool: 'git_diff', args: {} },
    { tool: 'run_typecheck', args: {} },
    { done: true, summary: 'extraida la constante' },
  ]);

  assert.equal(r.status, 'DONE');
  assert.equal(r.toolCalls.length, 5, 'cinco llamadas en UNA ejecucion');
  assert.deepEqual(r.toolCalls.map((c) => c.tool), ['read_file', 'apply_patch', 'create_file', 'git_diff', 'run_typecheck']);
  assert.notEqual(r.toolCalls[1].exitCode, 0, 'el parche fallo');
  assert.equal(r.toolCalls[2].exitCode, 0, 'y la correccion no');
  assert.match(readFileSync(join(WS.path, 'src/lib/base.ts'), 'utf8'), /dos = 2/);
  assert.equal(r.final.summary, 'extraida la constante');

  // El bucle recoge las MUTACIONES aparte de las llamadas: `git_diff` y
  // `read_file` no mutan nada, y mezclarlas haria ilegible la traza.
  assert.equal(r.mutations.length, 2, 'dos escrituras, no cuatro');
  assert.deepEqual(r.mutations.map((m) => m.changed), [false, true],
    'el parche que no aplico queda registrado como no-cambio');
  assert.equal(r.mutations[1].baseHash, h);
});

test('MUTATION_CONFLICT vuelve al modelo, y el modelo se corrige releyendo', async () => {
  const { hashDe } = await import('./mutation.mjs');
  writeFileSync(join(WS.path, 'src', 'lib', 'concurrente.ts'), 'v1\n');
  const viejo = hashDe('v0\n');                      // un hash que NUNCA fue el suyo
  const bueno = hashDe(readFileSync(join(WS.path, 'src/lib/concurrente.ts')));

  const r = await correr([
    { tool: 'create_file', args: { path: 'src/lib/concurrente.ts', baseHash: viejo, content: 'v2\n' } },
    { tool: 'read_file', args: { path: 'src/lib/concurrente.ts' } },
    { tool: 'create_file', args: { path: 'src/lib/concurrente.ts', baseHash: bueno, content: 'v2\n' } },
    { tool: 'run_typecheck', args: {} },
    { done: true, summary: 'reintentado con la version buena' },
  ]);

  assert.equal(r.status, 'DONE');
  assert.equal(r.toolCalls[0].code, 'MUTATION_CONFLICT');
  assert.equal(readFileSync(join(WS.path, 'src/lib/concurrente.ts'), 'utf8'), 'v2\n', 'el tercer intento si escribio');
  assert.match(r.vistos[1], /MUTATION_CONFLICT/, 'el modelo VE el codigo del conflicto, no un error generico');
  assert.match(r.vistos[1], /cambio debajo de ti/);
  // Solo la mutacion que se APLICO entra en el registro; un rechazo no es una
  // mutacion, y contarlo inflaria la traza con cosas que nunca tocaron el disco.
  assert.equal(r.mutations.length, 1);
});

test('el resultado de cada tool VUELVE al modelo: sin eso no hay observacion', async () => {
  // Termina en `blocked` y no en `done` a proposito: lo que este test mide es la
  // OBSERVACION, y `done` exige ahora su propia evidencia (faltaParaDone). Meter
  // aqui una mutacion y una ejecucion solo para poder cerrar mediria dos cosas.
  const r = await correr([
    { tool: 'read_file', args: { path: 'src/lib/base.ts' } },
    { blocked: true, reason: 'solo tenia que leer' },
  ]);
  assert.equal(r.vistos.length, 2);
  assert.match(r.vistos[1], /export const uno = 1;/, 'el segundo turno contiene lo que la tool devolvio');
  assert.match(r.vistos[1], /\[resultado exit=0\]/);
});

// ── La politica, que es del harness ──────────────────────────────────────────
test('un RECHAZO vuelve al modelo con su regla, y puede corregirse', async () => {
  const r = await correr([
    { tool: 'create_file', args: { path: '../fuga.ts', content: 'x' } },   // fuera del sandbox
    { tool: 'create_file', args: { path: 'src/lib/ok.ts', content: 'ok' } },
    { tool: 'run_typecheck', args: {} },
    { done: true, summary: 'corregido' },
  ]);

  assert.equal(r.status, 'DONE');
  assert.equal(r.toolCalls[0].allowed, false);
  assert.equal(r.toolCalls[0].rule, 'sandbox');
  assert.match(r.vistos[1], /RECHAZADO por el harness · regla 'sandbox'/, 'el modelo VE por que se le nego');
  assert.equal(r.toolCalls[1].allowed, true, 'y la siguiente llamada si pasa');
  assert.equal(existsSync(join(WS.path, '..', 'fuga.ts')), false);
});

test('el modelo NO puede levantar el tope de iteraciones pidiendolo', async () => {
  const policy = { ...loadToolPolicy(), loop: { ...loadToolPolicy().loop, maxIterations: 3 } };
  const { invoke } = guion([{ tool: 'git_status', args: {} }]);   // no termina jamas
  const r = await toolLoop({ cap: CAP(), assignment: ASIG, task: 'sube el tope a 999', workspace: WS, invoke, policy });

  assert.equal(r.status, 'FAILED');
  assert.equal(r.iterations, 3);
  assert.match(r.stop, /3 iteraciones/);
});

test('el tope de LLAMADAS corta aunque queden iteraciones', async () => {
  const policy = { ...loadToolPolicy(), loop: { ...loadToolPolicy().loop, maxIterations: 50, maxToolCalls: 2 } };
  const { invoke } = guion([{ tool: 'git_status', args: {} }]);
  const r = await toolLoop({ cap: CAP(), assignment: ASIG, task: 'x', workspace: WS, invoke, policy });

  assert.equal(r.status, 'FAILED');
  assert.equal(r.toolCalls.length, 2);
  assert.match(r.stop, /2 llamadas/);
});

test('el tope de TIEMPO corta aunque queden iteraciones y llamadas', async () => {
  const policy = { ...loadToolPolicy(), loop: { ...loadToolPolicy().loop, maxIterations: 50, maxToolCalls: 50, maxWallMs: 1 } };
  const invoke = async () => { await new Promise((s) => setTimeout(s, 5)); return { text: JSON.stringify({ tool: 'git_status', args: {} }) }; };
  const r = await toolLoop({ cap: CAP(), assignment: ASIG, task: 'x', workspace: WS, invoke, policy });

  assert.equal(r.status, 'FAILED');
  assert.match(r.stop, /ms agotado/);
});

// ── Las tres salidas ─────────────────────────────────────────────────────────
test('BLOCKED es un resultado, no un fallo: la premisa era falsa', async () => {
  const r = await correr([{ blocked: true, reason: 'el simbolo citado no existe en el codigo' }]);
  assert.equal(r.status, 'BLOCKED');
  assert.equal(r.toolCalls.length, 0);
  assert.match(r.stop, /no existe en el codigo/);
});

test('basura repetida agota su propio tope y no el presupuesto entero', async () => {
  const policy = { ...loadToolPolicy(), loop: { ...loadToolPolicy().loop, maxConsecutiveUnparsable: 2 } };
  const { invoke } = guion([() => 'lo siento, no puedo ayudarte con eso']);
  const r = await toolLoop({ cap: CAP(), assignment: ASIG, task: 'x', workspace: WS, invoke, policy });

  assert.equal(r.status, 'FAILED');
  assert.equal(r.iterations, 2);
  assert.match(r.stop, /sin JSON reconocible/);
});

test('basura AISLADA no mata la vuelta: se le dice y sigue', async () => {
  const r = await correr([
    () => 'texto suelto',
    { tool: 'git_status', args: {} },
    { blocked: true, reason: 'ok' },
  ]);
  assert.equal(r.status, 'BLOCKED');
  assert.equal(r.iterations, 3);
  assert.match(r.vistos[1], /no era un objeto JSON/);
});

// ── DONE es contractual (Fase 11) ────────────────────────────────────────────
//
// EL DEFECTO MEDIDO. H-20260817-009c7621 murio en su rework 4: el builder
// declaro DONE tras 15 llamadas y CERO mutaciones. Lo cazaba la ETAPA, y solo
// cuando `ctx.rework > 0` -- en la primera pasada el mismo `done` vacio habria
// pasado. Ahora se rechaza donde se emite, en toda pasada, y se le devuelve al
// modelo con las dos salidas legitimas delante.
test('un DONE sin mutaciones se RECHAZA y vuelve al modelo con las dos salidas', async () => {
  const r = await correr([
    { tool: 'git_status', args: {} },
    { done: true, summary: 'ya estaba bien' },
    { blocked: true, reason: 'entendido' },
  ]);

  assert.equal(r.status, 'BLOCKED', 'el done vacio NO cerro la ejecucion');
  assert.match(r.vistos[2], /DONE RECHAZADO por el harness/);
  assert.match(r.vistos[2], /ninguna mutacion/);
  assert.match(r.vistos[2], /no_change_required/, 'se le ensena la otra salida, no solo se le niega');
});

test('un DONE con mutacion pero sin ejecutar nada tambien se rechaza', async () => {
  const r = await correr([
    { tool: 'create_file', args: { path: 'src/lib/sin-ejecutar.ts', content: 'x' } },
    { done: true, summary: 'los tests pasan' },
    { blocked: true, reason: 'entendido' },
  ]);
  assert.equal(r.status, 'BLOCKED');
  assert.match(r.vistos[2], /no has EJECUTADO nada/);
});

test('NO_CHANGE_REQUIRED es una salida propia, no un done mas barato', async () => {
  const r = await correr([
    { tool: 'read_file', args: { path: 'src/lib/base.ts' } },
    { no_change_required: true, reason: 'la constante ya estaba extraida' },
  ]);
  assert.equal(r.status, 'NO_CHANGE_REQUIRED');
  assert.equal(r.mutations.length, 0);
  assert.match(r.stop, /ya estaba extraida/);
});

test('faltaParaDone: una mutacion que no cambio nada no respalda un DONE', async () => {
  const { faltaParaDone } = await import('./agentic.mjs');
  const ejecuto = [{ tool: 'run_test', allowed: true }];
  assert.deepEqual(faltaParaDone({ mutations: [{ changed: true }], toolCalls: ejecuto }), []);
  assert.match(
    faltaParaDone({ mutations: [{ changed: false }], toolCalls: ejecuto }).join(),
    /ninguna mutacion/,
    'un `git apply` que no aplico deja changed:false y no es un cambio',
  );
  assert.match(
    faltaParaDone({ mutations: [{ changed: true }], toolCalls: [{ tool: 'run_test', allowed: false }] }).join(),
    /no has EJECUTADO/,
    'una ejecucion RECHAZADA no es una ejecucion',
  );
});

test('un fallo NO reintentable del proveedor corta en la primera: repetirlo es gasto puro', async () => {
  let veces = 0;
  const invoke = async () => {
    veces++;
    throw Object.assign(new Error('clave mala'), { code: 'AUTH_FAILURE', detail: 'clave mala', retryable: false });
  };
  const r = await toolLoop({ cap: CAP(), assignment: ASIG, task: 'x', workspace: WS, invoke });

  assert.equal(r.status, 'FAILED');
  assert.equal(veces, 1);
  assert.match(r.stop, /AUTH_FAILURE/);
});

// ── El presupuesto de contexto ───────────────────────────────────────────────
test('podar recorta por el MEDIO: conserva la tarea y lo recien observado', () => {
  const turnos = ['LA TAREA', 'a'.repeat(1000), 'b'.repeat(1000), 'c'.repeat(1000), 'ULTIMO'];
  podar(turnos, 1200);
  assert.equal(turnos[0], 'LA TAREA', 'la cabeza es la tarea y no se toca');
  assert.equal(turnos.at(-1), 'ULTIMO', 'la cola es lo ultimo observado y no se toca');
  assert.match(turnos[1], /recortado/, 'lo que sobra esta en medio');
  assert.ok(turnos.reduce((s, t) => s + t.length, 0) < 1300);
});

test('el transcript NO crece sin limite aunque las tools devuelvan mucho', async () => {
  writeFileSync(join(WS.path, 'src', 'lib', 'grande.ts'), 'const x = 1;\n'.repeat(4000));
  // `techoFijo` y no `maxTranscriptChars`: desde que el tope se DERIVA de la
  // ventana del modelo, la segunda es el suelo del desconocido y no puede bajar
  // nada. Forzar un transcript pequeno --que es lo que este test necesita-- es
  // exactamente para lo que existe el techo fijo. La propiedad que se mide no
  // cambia ni una asercion.
  const base = loadToolPolicy();
  const policy = { ...base, loop: { ...base.loop, maxIterations: 7, transcript: { ...base.loop.transcript, techoFijo: 14000 } } };
  const { invoke, vistos } = guion([{ tool: 'read_file', args: { path: 'src/lib/grande.ts' } }]);
  await toolLoop({ cap: CAP(), assignment: ASIG, task: 'x', workspace: WS, invoke, policy });

  // Sin tope, siete lecturas de 8 KB darian ~56 KB de prompt. El limite de coste
  // que esta maquina puede MEDIR son caracteres: los CLIs no reportan tokens y
  // un tope en tokens seria una cifra declarada por el proveedor.
  assert.equal(vistos.length, 7);

  // EL SUELO IRREDUCIBLE, y es lo que este test enseno al subir el tope de
  // resultado de 8 000 a 20 000: `podar` recorta por el MEDIO y conserva cabeza y
  // cola, asi que lo que NO puede quitar es la tarea mas el ultimo resultado. Ese
  // suelo crece con `maxToolResultChars`, y el `< 30000` cableado de antes estaba
  // calibrado contra resultados de 8 KB. Derivado de la politica, la asercion
  // sigue valiendo cuando alguien mueva cualquiera de los dos topes.
  const suelo = policy.loop.transcript.techoFijo + policy.loop.maxToolResultChars * 2;
  assert.ok(vistos.at(-1).length < suelo, `el ultimo prompt pesa ${vistos.at(-1).length}, suelo ${suelo}`);
  assert.ok(vistos.at(-1).length < vistos[4].length * 1.5, 'deja de crecer en vez de acumular');
  assert.match(vistos.at(-1), /recortado por el limite/);
});

// ── El protocolo ─────────────────────────────────────────────────────────────
test('una llamada NUNCA recibe mas presupuesto que el que le queda al bucle', async () => {
  // Dos relojes: si la llamada heredara `maxWallMs`, una invocacion colgada se
  // comeria la etapa entera y el tope del bucle no llegaria a evaluarse nunca.
  const policy = { ...loadToolPolicy(), loop: { ...loadToolPolicy().loop, maxWallMs: 900, maxCallMs: 999999 } };
  const vistos = [];
  const invoke = async (_a, _p, o) => {
    vistos.push(o.timeoutMs);
    await new Promise((s) => setTimeout(s, 400));
    return { text: JSON.stringify({ tool: 'git_status', args: {} }) };
  };
  await toolLoop({ cap: CAP(), assignment: ASIG, task: 'x', workspace: WS, invoke, policy });

  assert.ok(vistos.length >= 2, 'dio mas de una vuelta');
  assert.ok(vistos.every((t) => t <= 900), `alguna llamada pidio mas que el bucle: ${vistos}`);
  assert.ok(vistos.at(-1) < vistos[0], 'el presupuesto MENGUA con lo ya gastado');
});

test('el protocolo nombra las tres formas y sale del registro', () => {
  const p = protocolo();
  for (const forma of ['"tool"', '"done"', '"blocked"']) assert.ok(p.includes(forma), `falta ${forma}`);
  assert.match(p, /read_file\(path/);
  assert.match(p, /run_test\(/);
});

test('el protocolo ENSENA a leer por simbolo, no solo permite hacerlo', () => {
  // Una tool en el catalogo que el modelo no sabe cuando usar es una tool a
  // medias: `run_gate` corria siempre --fast por eso mismo. Aqui la diferencia es
  // mayor -- sin `read_symbol`, los 19 ficheros que no caben en una lectura
  // siguen fuera del alcance del harness.
  const p = protocolo();
  assert.match(p, /read_symbol/);
  assert.match(p, /te devuelve una VENTANA/, 'el 0,70 % mudo era el defecto');
  assert.match(p, /El indice dice DONDE, nunca QUE hace/, 'ADR-006 tambien para el indice');
});

// ── El presupuesto del bucle, por clase de cambio ─────────────────────────────
//
// MEDIDO en H-20260820-02e22ced: 14 mutaciones, 6 renombrados en R100, 9 ficheros,
// typecheck VERDE y tests VERDES en la llamada 38 de la iteracion 40. El tope cayo
// encima del ultimo verde, sin dejar una llamada para declarar `done`.
//
// No es subir un numero contra un fallo sin diagnosticar -- lo que la calibracion
// de `tools.json` prohibe--: las cuatro causas de desperdicio se corrigieron antes
// y bajaron el gasto de 16 llamadas a 7. Lo que queda es tamano de tarea.
test('`move` y `extraction` tienen tope propio, y las demas NO se mueven', async () => {
  const { presupuestoDe } = await import('./agentic.mjs');
  const base = loadToolPolicy();

  const move = presupuestoDe(base, 'move');
  assert.ok(move.loop.maxIterations > base.loop.maxIterations, 'una mudanza necesita mas vueltas');
  assert.ok(move.loop.maxIterations >= 42, 'el minimo medido fue 38 llamadas mas el `done`');
  assert.ok(move.loop.maxToolCalls > base.loop.maxToolCalls);

  // `extraction` entra el 2026-09-15 y por el motivo CONTRARIO al de `move`:
  // cuatro de las seis vueltas de h-008 agotaron 40 iteraciones con 12-15
  // llamadas. Pocas llamadas y muchas iteraciones, porque localizar un simbolo
  // en 7.331 lineas cuesta pasadas, no mutaciones. Por eso `maxIterations` sube
  // mas que `maxToolCalls`: quien muerde es el menor de los dos.
  const ext = presupuestoDe(base, 'extraction');
  assert.ok(ext.loop.maxIterations > base.loop.maxIterations, 'localizar por simbolo cuesta iteraciones');
  assert.ok(ext.loop.maxIterations >= 45, 'el tope que fallo era 40');
  assert.ok(
    ext.loop.maxIterations > ext.loop.maxToolCalls,
    'el reparto de extraction es el inverso al de move: mas iteraciones que llamadas',
  );

  for (const clase of ['fix', 'feature', 'architecture']) {
    assert.equal(
      presupuestoDe(base, clase).loop.maxIterations, base.loop.maxIterations,
      `'${clase}' no declara tope propio y no debe heredar el de move`,
    );
  }
  // Lo NO declarado se conserva: un override parcial no puede BORRAR una clave.
  for (const k of Object.keys(base.loop)) {
    if (k === 'byClass') continue;
    assert.ok(k in move.loop, `el override de 'move' borro '${k}'`);
  }
  assert.equal(move.loop.maxTranscriptChars, base.loop.maxTranscriptChars);

  // EL RELOJ SI SE MOVIO, y esta linea decia lo contrario. No es un override
  // parcial borrando nada: es una medicion que invalido la suposicion de que el
  // tiempo no era la restriccion.
  //
  // MEDIDO en H-20260823-907b6e42 (65 ficheros): 36 llamadas en 17 minutos, ~28 s
  // cada una. Las ~89 que necesita una mudanza de ese tamano son ~42 minutos, y el
  // reloj estaba en 45: caia ANTES que el conteo de llamadas. Subir solo las
  // llamadas no habria servido de nada.
  assert.ok(move.loop.maxWallMs > base.loop.maxWallMs,
    'el reloj es la restriccion que muerde primero en una mudanza grande, no el conteo');

  // UN TOPE QUE NO PUEDE MORDER ES UNA MENTIRA. El builder gasta una llamada por
  // iteracion --MEDIDO en H-20260823-f35cdedd: 90 iteraciones = 90 llamadas
  // exactas--, asi que quien manda es SIEMPRE el menor de los dos. Con
  // maxIterations por debajo de maxToolCalls, el presupuesto de llamadas es
  // inalcanzable y quien lo lea creera que tiene un margen que no existe.
  //
  // Paso: subi las llamadas a 120 y las iteraciones a 90, y la vuelta murio a las
  // 90 con el tope de 120 intacto. Es pinchar la magnitud de al lado, otra vez.
  assert.ok(move.loop.maxIterations >= move.loop.maxToolCalls,
    `maxIterations=${move.loop.maxIterations} < maxToolCalls=${move.loop.maxToolCalls}: el tope de llamadas no se puede alcanzar nunca`);
});

test('el handler de Execution CABLEA el presupuesto por clase', () => {
  // Una politica declarada y no aplicada es `el-fix-que-no-existe`: el JSON diria
  // 60 y el bucle seguiria parando en 40.
  const src = readFileSync(new URL('./stages-model.mjs', import.meta.url), 'utf8');
  assert.match(src, /policy: presupuestoDe\(loadToolPolicy\(\), clase\)/);
});

test('tres respuestas ilegibles dicen QUE devolvio el modelo, no solo que no valia', async () => {
  // El mismo hueco que `invokeCapability` cerro esta manana, sin cerrar en este
  // bucle: `texto` moria en la linea del `parar` y el motivo quedaba infalsificable.
  //
  // MEDIDO en H-20260820-5d727519, dentro de la primera campana: el item
  // cm-3-por-simbolo cayo aqui con 8 llamadas YA aplicadas -- create_file,
  // apply_patch, create_file-- y no sobrevivio un solo caracter de las tres
  // respuestas que lo tumbaron.
  const policy = { ...loadToolPolicy(), loop: { ...loadToolPolicy().loop, maxConsecutiveUnparsable: 2 } };
  const r = await toolLoop({
    cap: CAP(), assignment: ASIG, task: 'da igual', workspace: WS, policy,
    invoke: async () => ({ text: 'Claro, procedo a mover los ficheros.' }),
  });

  assert.equal(r.status, 'FAILED');
  assert.match(r.stop, /sin JSON reconocible/);
  assert.match(r.stop, /Claro, procedo a mover/, `el motivo no lleva la muestra: ${r.stop}`);
});

// ── EL TECHO DE TRANSCRIPCION ES DEL MODELO, NO DEL BUCLE ───────────────────
//
// `maxTranscriptChars` era UN numero para once modelos con ventanas de 32 768 a
// 262 144 tokens. Derivando la capacidad, el 60000 de siempre resulta ser el de
// `qwen2.5-coder` y ocho veces corto para todos los demas: el limite estaba
// medido sobre la poblacion equivocada, en el sitio que decide cuanto lee una
// vuelta.
const CAT = {
  models: [
    { provider: 'p', model_id: 'chico', context_window: 32768 },
    { provider: 'p', model_id: 'grande', context_window: 200000 },
    { provider: 'cli', model_id: 'sin-techo', context_window: 200000 },
  ],
};
const POL = {
  loop: { maxTranscriptChars: 60000, maxToolResultChars: 20000, transcript: { charsPorToken: 3, margenPromptTokens: 4000, turnosUtiles: 10 } },
  output: { maxOutputTokens: { p: 8192, cli: null } },
};

test('un modelo pequeno y uno grande NO reciben el mismo techo', async () => {
  const { topeDeTranscripcion } = await import('./agentic.mjs');
  const chico = topeDeTranscripcion({ provider: 'p', model: 'chico' }, { catalog: CAT, policy: POL });
  const grande = topeDeTranscripcion({ provider: 'p', model: 'grande' }, { catalog: CAT, policy: POL });
  assert.equal(chico, (32768 - 8192 - 4000) * 3, 'el chico se queda en SU capacidad');
  assert.equal(grande, 20000 * 10, 'el grande llega al techo de turnos utiles');
  assert.ok(grande > chico, 'si fueran iguales, el numero global seguiria mandando');
});

test('DESCONOCIDO no es ilimitado: se queda en el suelo', async () => {
  const { topeDeTranscripcion } = await import('./agentic.mjs');
  // Un modelo fuera del catalogo, y uno dentro pero sin ventana declarada. Los
  // dos son «no lo se», y «no lo se» no autoriza a dar mas.
  assert.equal(topeDeTranscripcion({ provider: 'x', model: 'y' }, { catalog: CAT, policy: POL }), 60000);
  assert.equal(topeDeTranscripcion({ provider: 'p', model: 'chico' },
    { catalog: { models: [{ provider: 'p', model_id: 'chico' }] }, policy: POL }), 60000);
});

test('`turnosUtiles` acota por arriba: esto NO es meter el repo en el contexto', async () => {
  const { topeDeTranscripcion } = await import('./agentic.mjs');
  // Sin este techo, una ventana de 262 144 daria 750 000 chars de transcripcion,
  // que es exactamente lo que ADR-008 prohibe.
  const enorme = { models: [{ provider: 'p', model_id: 'enorme', context_window: 262144 }] };
  const t = topeDeTranscripcion({ provider: 'p', model: 'enorme' }, { catalog: enorme, policy: POL });
  assert.equal(t, 20000 * 10);
  assert.ok(t < (262144 - 8192 - 4000) * 3, 'la capacidad da mucho mas, y no se le da');
});

test('un proveedor SIN techo de salida reserva el mayor declarado, no cero', async () => {
  const { topeDeTranscripcion } = await import('./agentic.mjs');
  // `maxOutputTokens: null` significa «no lo acepta», no «no gasta». Tratarlo
  // como cero le daria al CLI mas transcripcion que al que SI declara su techo.
  const pol = { ...POL, loop: { ...POL.loop, maxToolResultChars: 100000 } };
  const conTecho = topeDeTranscripcion({ provider: 'p', model: 'grande' }, { catalog: CAT, policy: pol });
  const sinTecho = topeDeTranscripcion({ provider: 'cli', model: 'sin-techo' }, { catalog: CAT, policy: pol });
  assert.ok(sinTecho <= conTecho, 'el desconocido nunca sale MEJOR parado que el declarado');
});

test('el tope de resultado de herramienta cubre el p100 MEDIDO', async () => {
  const { loadToolPolicy } = await import('./tools.mjs');
  // 30 resultados truncados en las 36 corridas en disco, de 8 582 a 18 205 chars.
  // Si alguien lo baja por debajo del maximo observado, vuelve a cortar lecturas
  // que ya sabemos que ocurren.
  assert.ok(loadToolPolicy().loop.maxToolResultChars >= 18205,
    'medido: el resultado mas grande que se trunco eran 18 205 chars');
});
