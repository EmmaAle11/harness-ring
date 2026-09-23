// node --test harness/lib/
//
// El motor con etapas simuladas: se prueba el MECANISMO (orden, gates, onFail),
// no las capacidades. Un motor que solo se puede probar invocando modelos no se
// prueba nunca.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { runRing, MAX_REWORK, newExecutionId } from './ring.mjs';
import { RUNTIME } from './capabilities.mjs';

const manifiesto = (etapas) => ({
  stages: etapas.map((s, k) => ({
    n: k + 1, stage: s.stage, output: s.output ?? 'Workspace',
    artifact: `.harness/runs/TEST/${k + 1}-${s.stage}.json`,
    onFail: s.onFail ?? 'STOP',
  })),
});

// Workspace exige {kind, path, rollback}: payload minimo que CUMPLE el contrato.
const ws = () => ({ kind: 'none', path: '/x', rollback: 'abc' });
const ok = () => async () => ({ payload: ws() });
const boom = (msg) => async () => { throw new Error(msg); };

const limpia = () => { try { rmSync(join(RUNTIME, 'runs', 'TEST'), { recursive: true, force: true }); } catch {} };

test('recorre las etapas en orden y devuelve PASSED', async () => {
  limpia();
  const m = manifiesto([{ stage: 'A' }, { stage: 'B' }, { stage: 'C' }]);
  const r = await runRing(m, { A: ok(), B: ok(), C: ok() }, { executionId: 'TEST' });
  assert.equal(r.verdict, 'PASSED');
  assert.deepEqual(r.stages.map((s) => s.stage), ['A', 'B', 'C']);
  assert.ok(r.completed);
  limpia();
});

test('cada etapa sabe lo que viene; solo la ultima no tiene siguiente', async () => {
  limpia();
  const m = manifiesto([{ stage: 'A' }, { stage: 'B' }, { stage: 'C' }]);
  const visto = {};
  const espia = (s) => async (ctx) => {
    visto[s] = { next: ctx.next?.stage ?? null, remaining: ctx.remaining.map((x) => x.stage) };
    return { payload: ws() };
  };

  const r = await runRing(m, { A: espia('A'), B: espia('B'), C: espia('C') }, { executionId: 'TEST' });

  assert.equal(r.verdict, 'PASSED');
  assert.deepEqual(visto.A, { next: 'B', remaining: ['B', 'C'] });
  assert.deepEqual(visto.B, { next: 'C', remaining: ['C'] });
  // El cierre del anillo: la ultima etapa no tiene siguiente DENTRO del anillo.
  // Quien devuelve el control al principio esta fuera de el.
  assert.deepEqual(visto.C, { next: null, remaining: [] });
  limpia();
});

test('STOP detiene y nombra la etapa', async () => {
  limpia();
  const m = manifiesto([{ stage: 'A' }, { stage: 'B' }, { stage: 'C' }]);
  const r = await runRing(m, { A: ok(), B: boom('premisa falsa'), C: ok() }, { executionId: 'TEST' });
  assert.equal(r.verdict, 'FAILED');
  assert.match(r.reason, /STOP en 'B'.*premisa falsa/);
  assert.equal(r.stages.length, 2, 'C no debe ejecutarse');
  assert.ok(!r.completed);
  limpia();
});

test('un payload que INCUMPLE su contrato marca la etapa FAIL', async () => {
  limpia();
  const m = manifiesto([{ stage: 'A', output: 'Workspace' }]);
  // Le falta `rollback`: el artefacto no se escribe como OK.
  const r = await runRing(m, { A: async () => ({ payload: { kind: 'none', path: '/x' } }) }, { executionId: 'TEST' });
  assert.equal(r.verdict, 'FAILED');
  assert.match(r.stages[0].reason, /incumple.*rollback/);
  limpia();
});

test('SKIPPED sin motivo es un error del handler, no un pase', async () => {
  limpia();
  const m = manifiesto([{ stage: 'A' }]);
  const r = await runRing(m, { A: async () => ({ payload: null, status: 'SKIPPED' }) }, { executionId: 'TEST' });
  assert.equal(r.stages[0].status, 'FAIL');
  assert.match(r.stages[0].reason, /EXIGE reason/);
  limpia();
});

test('REWORK reintenta desde Execution y para al tercero', async () => {
  limpia();
  let intentos = 0;
  const m = manifiesto([
    { stage: 'Execution' },
    { stage: 'Convergence', onFail: 'REWORK — vuelve a la etapa 7' },
  ]);
  const r = await runRing(m, {
    Execution: async () => { intentos++; return { payload: ws() }; },
    Convergence: boom('P2 vivo'),
  }, { executionId: 'TEST' });

  assert.equal(r.verdict, 'FAILED');
  assert.match(r.reason, /REWORK agotado/);
  assert.equal(intentos, 1 + MAX_REWORK, 'la primera vez mas dos reintentos');
  limpia();
});

test('ROLLBACK invoca al manejador de rollback', async () => {
  limpia();
  let deshecho = false;
  const m = manifiesto([{ stage: 'Execution', onFail: 'ROLLBACK del worktree + STOP' }]);
  const r = await runRing(m, {
    Execution: boom('escribio fuera del workspace'),
    __rollback: async () => { deshecho = true; },
  }, { executionId: 'TEST' });

  assert.equal(r.verdict, 'FAILED');
  assert.ok(deshecho, 'la corrida debe descartarse entera');
  assert.match(r.reason, /ROLLBACK/);
  limpia();
});

test('una etapa sin handler falla en vez de saltarse en silencio', async () => {
  limpia();
  const r = await runRing(manifiesto([{ stage: 'Fantasma' }]), {}, { executionId: 'TEST' });
  assert.equal(r.verdict, 'FAILED');
  assert.match(r.stages[0].reason, /sin handler/);
  limpia();
});

test('executionId es unico y sirve como nombre de rama y carpeta', () => {
  const a = newExecutionId(), b = newExecutionId();
  assert.notEqual(a, b);
  assert.match(a, /^H-\d{8}-[0-9a-f]{8}$/);
});

// ── REWORK y la traza ───────────────────────────────────────────────────────
// El anillo tiene un salto hacia atras DECLARADO, pero checkTrace comparaba
// posicion a posicion y `completed` contaba entradas. Una vuelta con rework
// reportaba "18 de 16 etapas" y "etapa 11: se esperaba Security" (su posicion de
// entonces; hoy es la 8) siendo valida.
// Salio en la primera corrida real que reintento; ninguna lectura lo vio.
test('una vuelta con REWORK sigue siendo un recorrido COMPLETO', async () => {
  const { checkTrace } = await import('./trace.mjs');
  const m = manifiesto([
    { stage: 'Plan' }, { stage: 'Execution' }, { stage: 'Convergence' }, { stage: 'Learning' },
  ]);
  // Recorrido con un rework: Plan, Execution, Convergence, [vuelve] Execution,
  // Convergence, Learning. Seis entradas para un anillo de cuatro etapas.
  const trace = {
    executionId: 'TEST',
    stages: ['Plan', 'Execution', 'Convergence', 'Execution', 'Convergence', 'Learning']
      .map((stage, i) => ({ n: i + 1, stage, status: 'OK', artifact: `x/${i}.json` })),
  };
  const p = checkTrace(trace, m).filter((x) => !/artefacto/.test(x));
  assert.deepEqual(p, [], `una vuelta con rework no deberia tener problemas: ${p.join(' · ')}`);
  assert.equal(trace.reworks, 1, 'el numero de reintentos queda registrado');
});

test('una etapa que retrocede SIN ser un rework a Execution sigue siendo un error', async () => {
  const { checkTrace } = await import('./trace.mjs');
  const m = manifiesto([{ stage: 'Plan' }, { stage: 'Execution' }, { stage: 'Learning' }]);
  const trace = {
    executionId: 'TEST',
    stages: ['Plan', 'Execution', 'Plan', 'Learning']
      .map((stage, i) => ({ n: i + 1, stage, status: 'OK', artifact: `x/${i}.json` })),
  };
  const p = checkTrace(trace, m);
  assert.ok(p.some((x) => /retrocede sin ser un REWORK/.test(x)));
});

test('faltar una etapa se sigue reportando, con su nombre', async () => {
  const { checkTrace } = await import('./trace.mjs');
  const m = manifiesto([{ stage: 'Plan' }, { stage: 'Execution' }, { stage: 'Learning' }]);
  const trace = {
    executionId: 'TEST',
    stages: [{ n: 1, stage: 'Plan', status: 'OK', artifact: 'x/1.json' }],
  };
  assert.ok(checkTrace(trace, m).some((x) => /no recorrio 2 de 3.*Execution, Learning/.test(x)));
});
