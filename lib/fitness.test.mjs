// node --test harness/lib/
//
// WP-F3: **cada fitness test debe verse FALLAR antes de darse por bueno.** Un
// fitness test que nunca fallo no demuestra nada -- es la misma regla que este
// repo exige a cualquier fix (memory/failures/el-fix-que-no-existe.md).
//
// Por eso cada FT tiene aqui su caso rojo Y su caso verde. Sobre corridas
// sinteticas: la corrida real llegara con los handlers, y para entonces estos
// tests ya tienen que discriminar.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ft1, ft2, ft3, ft4, ft5 } from './fitness.mjs';
import { buildTrace, checkTrace } from './trace.mjs';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const manifiesto = { stages: [{ stage: 'A' }, { stage: 'B' }], task: { forbiddenPaths: ['src/**'] } };

const etapa = (n, stage, extra = {}) => ({
  n, stage, status: 'OK', contract: 'Workspace',
  artifact: `.harness/runs/X/${n}-${stage}.json`, ms: 1, ...extra,
});

// `artifact` se resuelve leyendo disco; en estos casos sinteticos no existe, asi
// que FT-1 se prueba contra `checkTrace` con artefactos ya validados aparte.
const traza = (stages, extra = {}) => ({
  executionId: 'X', startedAt: 'a', endedAt: 'b', stages, invocations: 1, awaitingHuman: [], ...extra,
});

// ── FT-1 ────────────────────────────────────────────────────────────────────
test('FT-1 FALLA si falta una etapa', () => {
  const p = checkTrace(traza([etapa(1, 'A')]), manifiesto);
  assert.ok(p.some((x) => /recorrio 1 de 2/.test(x)));
});

test('FT-1 FALLA si una etapa se salta sin motivo', () => {
  const p = checkTrace(traza([etapa(1, 'A', { status: 'SKIPPED' }), etapa(2, 'B')]), manifiesto);
  assert.ok(p.some((x) => /sin motivo declarado/.test(x)), 'una etapa saltada en silencio debe salir');
});

test('FT-1 FALLA si el orden no coincide con el anillo', () => {
  // El mensaje cambio al ensenar a checkTrace que REWORK existe: ya no compara
  // posicion a posicion —eso daba "18 de 16 etapas" sobre una vuelta valida—
  // sino que exige que el orden solo retroceda donde el motor lo permite.
  const p = checkTrace(traza([etapa(1, 'B'), etapa(2, 'A')]), manifiesto);
  assert.ok(p.some((x) => /retrocede sin ser un REWORK/.test(x)), p.join(' · '));
});

test('FT-1 FALLA sin executionId', () => {
  assert.ok(checkTrace(traza([etapa(1, 'A'), etapa(2, 'B')], { executionId: null }), manifiesto)
    .some((x) => /sin executionId/.test(x)));
});

test('FT-1 FALLA si no hay traza', () => {
  assert.equal(ft1(null, manifiesto).pass, false);
  assert.equal(ft1({ trace: null }, manifiesto).pass, false);
});

// ── FT-2 ────────────────────────────────────────────────────────────────────
test('FT-2 FALLA si hubo una pausa humana', () => {
  const r = ft2({ trace: traza([], { awaitingHuman: [{ stage: 'Plan' }] }) });
  assert.equal(r.pass, false);
  assert.match(r.detail.join(' '), /pausas esperando/);
});

test('FT-2 FALLA si hicieron falta dos ordenes', () => {
  const r = ft2({ trace: traza([], { invocations: 2 }) });
  assert.equal(r.pass, false);
  assert.match(r.detail.join(' '), /2 invocaciones/);
});

test('FT-2 PASA con una orden y cero pausas', () => {
  assert.equal(ft2({ trace: traza([]) }).pass, true);
});

// ── FT-3 ────────────────────────────────────────────────────────────────────
const conWs = (files) => ({
  artifacts: {
    Sandbox: { payload: { kind: 'worktree', path: '/tmp/ws', rollback: 'abc' } },
    Execution: { payload: { files, diff: '' } },
  },
});

test('FT-3 FALLA si el arbol principal cambio', () => {
  const r = ft3(conWs([]), manifiesto, { fingerprintAntes: 'OTRA-COSA' });
  assert.equal(r.pass, false);
  assert.match(r.detail.join(' '), /arbol principal CAMBIO/);
});

test('FT-3 FALLA si se escribio en forbiddenPaths', () => {
  const r = ft3(conWs(['src/aafa.service.ts']), manifiesto);
  assert.equal(r.pass, false);
  assert.match(r.detail.join(' '), /forbiddenPaths/);
});

test('FT-3 FALLA sin Workspace', () => {
  assert.equal(ft3({ artifacts: {} }, manifiesto).pass, false);
});

test('FT-3 PASA con ficheros dentro del workspace', () => {
  assert.equal(ft3(conWs(['scripts/gate.sh']), manifiesto).pass, true);
});

// ── FT-4 ────────────────────────────────────────────────────────────────────
const conBindings = (bindings) => ({ artifacts: { AdapterLayer: { payload: { bindings } } } });
const TRES = [
  { capability: 'builder', provider: 'claude', invocations: 1 },
  { capability: 'reviewer', provider: 'ollama', invocations: 2 },
  { capability: 'security', provider: 'opencode', invocations: 1 },
];

test('FT-4 FALLA si una capacidad se asigno y nunca se invoco', () => {
  const r = ft4(conBindings(TRES.map((b) => (b.capability === 'security' ? { ...b, invocations: 0 } : b))));
  assert.equal(r.pass, false);
  assert.match(r.detail.join(' '), /NUNCA invocado/);
});

test('FT-4 FALLA con un solo proveedor, aunque todo se invoque', () => {
  const r = ft4(conBindings(TRES.map((b) => ({ ...b, provider: 'claude' }))));
  assert.equal(r.pass, false);
  assert.match(r.detail.join(' '), /solo 1 proveedor|compartieron proveedor/);
});

test('FT-4 no depende de una lista fija de proveedores', () => {
  // La politica cambio de local-first a Claude-first: el test debe seguir valiendo.
  const r = ft4(conBindings([
    { capability: 'builder', provider: 'claude', invocations: 1 },
    { capability: 'reviewer', provider: 'deepseek', invocations: 2 },
  ]));
  assert.equal(r.pass, true, 'claude + deepseek cumple sin que ollama aparezca');
});

test('FT-4 FALLA si builder y reviewer comparten proveedor', () => {
  const r = ft4(conBindings(TRES.map((b) => ({ ...b, provider: b.capability === 'reviewer' ? 'claude' : b.provider }))));
  assert.equal(r.pass, false);
  assert.match(r.detail.join(' '), /compartieron proveedor/);
});

test('FT-4 FALLA sin AdapterBinding', () => {
  assert.equal(ft4({ artifacts: {} }).pass, false);
});

test('FT-4 PASA con tres proveedores y builder != reviewer', () => {
  assert.equal(ft4(conBindings(TRES)).pass, true);
});

// ── FT-5 — el que distingue anillo de tuberia ───────────────────────────────
const conLearning = (lr) => ({ executionId: 'H-1', artifacts: { Learning: { payload: lr } } });

test('FT-5 FALLA sin LearningRecord: quedo un arco', () => {
  const r = ft5({ executionId: 'H-1', artifacts: {} });
  assert.equal(r.pass, false);
  assert.match(r.detail.join(' '), /quedo un arco/);
});

test('FT-5 FALLA si worthKeeping no se decidio', () => {
  assert.equal(ft5(conLearning({})).pass, false);
});

test('FT-5 FALLA sin la SEGUNDA corrida, aunque todo lo demas este bien', () => {
  const r = ft5(conLearning({ worthKeeping: false }));
  assert.equal(r.pass, false, 'una sola vuelta NO demuestra un anillo');
  assert.match(r.detail.join(' '), /SEGUNDA corrida/);
});

test('FT-5 FALLA si la segunda corrida no cita a la primera', () => {
  const r = ft5(conLearning({ worthKeeping: false }), null, {
    next: { executionId: 'H-2', artifacts: { Knowledge: { payload: { facts: ['algo sin relacion'] } } } },
  });
  assert.equal(r.pass, false);
  assert.match(r.detail.join(' '), /flecha Learning->Knowledge no existe/);
});

test('FT-5 PASA si la segunda corrida consume lo que aprendio la primera', () => {
  const r = ft5(conLearning({ worthKeeping: false }), null, {
    next: { executionId: 'H-2', artifacts: { Knowledge: { payload: { previo: 'H-1' } } } },
  });
  assert.equal(r.pass, true);
});

// ── La traza ────────────────────────────────────────────────────────────────
test('buildTrace conserva el motivo de cada etapa y suma el tiempo', () => {
  const t = buildTrace({
    executionId: 'X', startedAt: 'a', endedAt: 'b', verdict: 'FAILED', reason: 'STOP',
    stages: [etapa(1, 'A', { ms: 10 }), etapa(2, 'B', { status: 'FAIL', reason: 'premisa falsa', ms: 5 })],
  });
  assert.equal(t.totalMs, 15);
  assert.equal(t.stages[1].reason, 'premisa falsa');
  assert.equal(t.invocations, 1);
  assert.deepEqual(t.awaitingHuman, []);
});

test('la vuelta REGISTRA su spec, y fitness no la adivina', () => {
  // MEDIDO en H-20260819-0015833a (la vuelta de H-004): FT-3 salio en rojo
  // diciendo que los cuatro ficheros estaban en `forbiddenPaths`. Lo estaban en
  // los de H-001 --que prohibe `backend/src/**`--, que era el manifiesto que
  // `doxia fitness` tomaba por defecto. La vuelta no registraba su spec.
  //
  // La direccion peligrosa es la contraria: un manifiesto ajeno tambien puede
  // dar PASS a una vuelta que SI escribio donde tenia prohibido. Un veredicto
  // calculado contra la spec equivocada se lee igual que uno bueno.
  const cli = readFileSync(resolve(import.meta.dirname, '..', 'bin', 'doxia.mjs'), 'utf8');

  // El defecto exacto: un id de spec cableado como valor por defecto.
  assert.doesNotMatch(cli, /val\('--spec'\) \?\? 'h-001-ring-execution'/);

  // La vuelta lo escribe...
  assert.match(cli, /JSON\.stringify\(\{ \.\.\.trace, specId \}/);
  // ...y fitness lo lee de ahi.
  assert.match(cli, /t\.specId \?\? null/);
  // Y si no lo sabe, lo DICE en vez de responder con otra spec.
  assert.match(cli, /no se va a adivinar/);
});
