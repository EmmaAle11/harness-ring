// node --test harness/lib/fanout.test.mjs
//
// C-7 · el reparto. Lo que estos tests fijan: que reparte por MODULO, que no
// reparte lo que no hace falta, y que 19 de 20 shards NO es haber terminado.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { repartir, cierre, fusionar } from './fanout.mjs';
import { loadToolPolicy } from './tools.mjs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const POLICY = { minFiles: 8, maxFilesPerShard: 6 };

test('debajo del umbral NO se reparte: un shard con todo', () => {
  // H-001 son 4 ficheros. El fan-out cuesta una invocacion por trozo, y pagarla
  // para lo que cabe de sobra es gasto puro.
  const files = ['src/lib/a.ts', 'src/lib/a.spec.ts', 'src/app/admin/B.tsx', 'src/app/admin/B.spec.tsx'];
  assert.deepEqual(repartir(files, POLICY), [files]);
});

test('la policy REAL deja H-001 de una pieza', () => {
  const p = loadToolPolicy().fanout;
  assert.ok(p.minFiles > 4, 'una tarea de 4 ficheros no debe repartirse');
  assert.equal(repartir(['a', 'b', 'c', 'd'], p).length, 1);
});

test('reparte en trozos del tamano declarado, sin dejar ninguno suelto', () => {
  const files = Array.from({ length: 16 }, (_, i) => `src/app/aafa/C${i}.tsx`);
  const shards = repartir(files, POLICY);
  assert.deepEqual(shards.map((s) => s.length), [6, 6, 4]);
  assert.deepEqual(shards.flat().sort(), [...files].sort(), 'no se pierde ni se duplica ningun fichero');
});

test('un shard NO mezcla modulos si puede evitarlo', () => {
  // Un shard que sostiene dos contextos gasta la transcripcion que el fan-out
  // existe para ahorrar.
  const files = [
    ...Array.from({ length: 6 }, (_, i) => `backend/src/aafa/s${i}.ts`),
    ...Array.from({ length: 6 }, (_, i) => `src/app/admin/A${i}.tsx`),
  ];
  const shards = repartir(files, POLICY);
  assert.equal(shards.length, 2);
  for (const s of shards) assert.equal(new Set(s.map((f) => f.split('/').slice(0, 3).join('/'))).size, 1);
});

test('ningun shard sale de UN fichero por el orden de los modulos', () => {
  // El primer reparto agrupaba y empaquetaba por separado: un modulo pequeno que
  // cayera antes de uno grande se quedaba solo en su shard, con la misma
  // invocacion y una fraccion de la transcripcion aprovechada.
  const files = ['backend/src/aafa/s.ts', ...Array.from({ length: 14 }, (_, i) => `src/app/aafa/C${i}.tsx`), 'src/lib/x.ts'];
  const shards = repartir(files, POLICY);
  assert.deepEqual(shards.map((s) => s.length), [6, 6, 4]);
});

test('19 de 20 NO es haber terminado', () => {
  // Es `cerrar-por-abstencion-no-es-converger` aplicado al reparto: un fan-out
  // donde uno se queda a medias produce un arbol que la puerta aprueba y una
  // parte del trabajo que nadie nombra.
  const v = cierre([{ status: 'DONE' }, { status: 'NO_CHANGE_REQUIRED' }, { status: 'MAX_ITERATIONS', stop: 'reloj' }]);
  assert.equal(v.ok, false);
  assert.equal(v.cerrados, 2);
  assert.match(v.why, /#3 MAX_ITERATIONS \(reloj\)/);
});

test('NO_CHANGE_REQUIRED cierra un shard: no todo trozo tiene que escribir', () => {
  assert.equal(cierre([{ status: 'DONE' }, { status: 'NO_CHANGE_REQUIRED' }]).ok, true);
});

test('un shard sin resultado se cuenta como abierto, no se ignora', () => {
  const v = cierre([{ status: 'DONE' }, null]);
  assert.equal(v.ok, false);
  assert.match(v.why, /SIN_RESULTADO/);
});

test('la fusion es determinista y etiqueta cada llamada con su shard', () => {
  const f = fusionar([
    { iterations: 3, toolCalls: [{ tool: 'read_file' }], mutations: [{ op: 'apply_patch' }], usage: { totalTokens: 10 }, final: { summary: 'a' } },
    { iterations: 2, toolCalls: [{ tool: 'run_test' }], mutations: [], usage: { totalTokens: 5 }, final: { summary: 'b' } },
  ]);
  assert.equal(f.shards, 2);
  assert.equal(f.iterations, 5);
  assert.deepEqual(f.toolCalls.map((c) => c.shard), [1, 2]);
  assert.equal(f.usage.totalTokens, 15);
  assert.match(f.summary, /#1: a\n#2: b/);
});

test('el uso NO se suma si alguno no lo publica: seria una estimacion disfrazada', () => {
  const f = fusionar([{ usage: { totalTokens: 10 } }, { usage: null }]);
  assert.equal(f.usage, null);
});

test('un `move` NO se reparte: origen y destino son un solo hecho', async () => {
  // MEDIDO en H-20260819-5d44080c. El reparto puso los cinco DESTINOS en el
  // shard #1 y los ORIGENES en los shards #2 y #3: ninguno tenia las dos mitades
  // de un mismo renombrado. Cada shard podia hacer MEDIA mudanza, y el #1 gasto
  // sus 40 iteraciones haciendo typecheck sobre un arbol que otro le movia por
  // debajo. La vuelta murio con ROLLBACK en la etapa 7.
  //
  // `repartir` supone que los ficheros son SEPARABLES; un renombrado no lo es de
  // su destino. No se arregla ensenando a `repartir` a emparejar por nombre --esa
  // heuristica cae el dia que alguien mueve y renombra a la vez-- sino no
  // repartiendo lo que no es separable.
  const src = await readFile(resolve(import.meta.dirname, 'stages-model.mjs'), 'utf8');
  assert.match(src, /clase === 'move'\s*\?\s*\[task\.files\]/);

  // Y el reparto sigue vivo para lo demas: 15 ficheros separables SI se parten.
  const files = Array.from({ length: 15 }, (_, i) => `src/app/aafa/F${i}.tsx`);
  assert.ok(repartir(files, { minFiles: 8, maxFilesPerShard: 6 }).length > 1);
});
