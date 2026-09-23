// node --test harness/lib/
//
// Learning en tres niveles, probado SIN modelo. Lo que se comprueba no es que
// "aprenda", sino que NO pueda escribir en memory/ por su cuenta lo que no
// deberia: un anillo que reescribe su propia memoria sin filtro puede
// envenenarla, y la vuelta N+1 arranca leyendo memory/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { capture, classify, promote, decide, provenance, claveDe, VEREDICTOS } from './learning.mjs';

const policy = JSON.parse(readFileSync(new URL('../policy/learning.json', import.meta.url), 'utf8'));

const corrida = (id, { stages = [], artifacts = {} } = {}) => ({
  executionId: id,
  trace: { stages },
  artifacts,
});

// ── Nivel 1 · Capture ───────────────────────────────────────────────────────
test('CAPTURE: recoge lo que PASO, no solo lo que el modelo dice que aprendio', () => {
  const r = corrida('H-1', {
    stages: [
      { stage: 'Execution', status: 'OK' },
      { stage: 'Security', status: 'FAIL', reason: 'secreto nuevo' },
      { stage: 'Adversarial', status: 'SKIPPED', reason: 'sin hallazgos' },
    ],
    artifacts: {
      Convergence: { payload: { raw: 4, unified: 2, blockers: 0, refutationRate: 0.5 } },
      Learning: { payload: { worthKeeping: true, lesson: 'el nombre sale del manifiesto' } },
    },
  });
  const c = capture(r);
  const kinds = c.signals.map((s) => s.kind);
  assert.ok(kinds.includes('failure'), 'una etapa en rojo es una senal aunque nadie la mencione');
  assert.ok(kinds.includes('gap'), 'una etapa saltada tambien');
  assert.ok(kinds.includes('validation'));
  assert.ok(kinds.includes('lesson'));
  assert.ok(c.signals.every((s) => s.executionId === 'H-1'), 'toda senal sabe de que corrida salio');
});

test('CAPTURE: una corrida sin traza no inventa senales', () => {
  assert.deepEqual(capture({ executionId: 'H-0' }).signals, []);
});

// ── Nivel 2 · Classification ────────────────────────────────────────────────
test('CLASSIFY: la confianza SALE de cuantas corridas lo vieron, no del modelo', () => {
  const sig = (id) => ({ executionId: id, signals: [{ kind: 'failure', statement: 'el mismo defecto', executionId: id }] });

  const una = classify([sig('H-1')], policy)[0];
  assert.equal(una.confidence, 0.5, 'una sola vez pudo ser casualidad');
  assert.equal(una.repeatable, false);

  const dos = classify([sig('H-1'), sig('H-2')], policy)[0];
  assert.equal(dos.confidence, 0.75);
  assert.equal(dos.repeatable, true);

  const tres = classify([sig('H-1'), sig('H-2'), sig('H-3')], policy)[0];
  assert.equal(tres.confidence, 0.9);
  assert.deepEqual(tres.evidence, ['H-1', 'H-2', 'H-3'], 'la evidencia nombra las corridas');
});

test('CLASSIFY: nada alcanza confianza 1.0 — repetirse no es ser cierto', () => {
  const muchas = ['H-1', 'H-2', 'H-3', 'H-4', 'H-5'].map((id) => ({
    executionId: id, signals: [{ kind: 'failure', statement: 'x', executionId: id }],
  }));
  assert.equal(classify(muchas, policy)[0].confidence, policy.maxConfidence);
  assert.ok(policy.maxConfidence < 1);
});

test('CLASSIFY: el mismo enunciado con otra redaccion es el MISMO aprendizaje', () => {
  assert.equal(claveDe('El nombre SALE del manifiesto.'), claveDe('el nombre sale del manifiesto'));
});

test('CLASSIFY: lo ya conocido deja de ser novedad', () => {
  const cap = [{ executionId: 'H-1', signals: [{ kind: 'failure', statement: 'defecto viejo', executionId: 'H-1' }] }];
  const c = classify(cap, policy, { previas: [{ statement: 'defecto viejo' }] })[0];
  assert.equal(c.novel, false);
});

// ── Nivel 3 · Promotion ─────────────────────────────────────────────────────
test('PROMOTE: un FAILURE repetido y nuevo se promueve solo', () => {
  const c = { type: 'FAILURE', candidate: 'x', confidence: 0.75, novel: true, worthKeeping: true, evidence: ['H-1', 'H-2'] };
  const d = promote(c, policy);
  assert.equal(d.verdict, 'PROMOTE');
  assert.equal(d.dir, 'memory/failures');
});

test('PROMOTE: visto UNA vez no basta — va a revision, no a memory/', () => {
  const c = { type: 'FAILURE', candidate: 'x', confidence: 0.5, novel: true, worthKeeping: true, evidence: ['H-1'] };
  const d = promote(c, policy);
  assert.equal(d.verdict, 'REVIEW');
  assert.match(d.reason, /confianza 0\.5 < 0\.75/);
});

test('PROMOTE: un ADR NUNCA se auto-promueve, por alta que sea la confianza', () => {
  const c = {
    type: 'ARCHITECTURE_DECISION', candidate: 'cambiar de proveedor',
    confidence: 0.9, novel: true, worthKeeping: true, evidence: ['H-1', 'H-2', 'H-3'],
  };
  const d = promote(c, policy);
  assert.equal(d.verdict, 'REVIEW', 'un ADR redirige todo lo que cuelga de el');
  assert.equal(policy.types.ARCHITECTURE_DECISION.autoPromote, false);
});

test('PROMOTE: una VULNERABILITY tampoco se auto-promueve', () => {
  const c = { type: 'VULNERABILITY', candidate: 'fuga', confidence: 0.9, novel: true, worthKeeping: true, evidence: ['H-1', 'H-2', 'H-3'] };
  assert.equal(promote(c, policy).verdict, 'REVIEW');
});

test('PROMOTE: una contradiccion va a revision aunque cumpla el umbral', () => {
  const c = {
    type: 'FAILURE', candidate: 'x', confidence: 0.9, novel: true,
    worthKeeping: true, contradiction: true, evidence: ['H-1', 'H-2', 'H-3'],
  };
  const d = promote(c, policy);
  assert.equal(d.verdict, 'REVIEW');
  assert.match(d.reason, /contradice/);
});

test('PROMOTE: las clases excluidas se RECHAZAN con motivo, no desaparecen', () => {
  for (const t of policy.excluded) {
    const d = promote({ type: t, candidate: 'x', confidence: 0.9, novel: true, worthKeeping: true, evidence: ['H-1'] }, policy);
    assert.equal(d.verdict, 'REJECT');
    assert.match(d.reason, /excluida/);
  }
});

test('PROMOTE: lo ya guardado se rechaza en vez de duplicarse', () => {
  const c = { type: 'FAILURE', candidate: 'x', confidence: 0.9, novel: false, worthKeeping: true, evidence: ['H-1', 'H-2'] };
  assert.equal(promote(c, policy).verdict, 'REJECT');
});

test('PROMOTE: todo veredicto es uno de los tres, y siempre trae motivo', () => {
  const casos = [
    { type: 'FAILURE', confidence: 0.9, novel: true, worthKeeping: true, evidence: ['a', 'b'] },
    { type: 'ARCHITECTURE_DECISION', confidence: 0.9, novel: true, worthKeeping: true, evidence: ['a'] },
    { type: 'USER_PREFERENCE', confidence: 0.9, novel: true, worthKeeping: true, evidence: ['a'] },
    { type: 'INVENTADA', confidence: 0.9, novel: true, worthKeeping: true, evidence: ['a'] },
  ];
  for (const c of casos) {
    const d = promote(c, policy);
    assert.ok(VEREDICTOS.includes(d.verdict), `veredicto raro: ${d.verdict}`);
    assert.ok(d.reason?.length > 5, 'un veredicto sin motivo no se puede auditar');
  }
});

// ── Provenance ──────────────────────────────────────────────────────────────
test('PROVENANCE: una entrada sabe de donde salio, con que y quien la promovio', () => {
  const c = { type: 'FAILURE', candidate: 'x', confidence: 0.75, evidence: ['H-1', 'H-2'] };
  const p = provenance(c, { promotedBy: 'trigger', model: 'deepseek:deepseek-v4-pro', date: '2026-08-14' });
  for (const k of ['origin', 'execution_id', 'evidence', 'date', 'agent', 'model', 'confidence', 'promoted_by']) {
    assert.notEqual(p[k], undefined, `provenance sin '${k}': no se podria revisar ni retirar`);
  }
  assert.equal(p.execution_id, 'H-2', 'la corrida que lo confirmo, no la primera que lo insinuo');
  assert.deepEqual(p.evidence, ['H-1', 'H-2']);
});

// ── La regla que gobierna el bloque ─────────────────────────────────────────
test('Learning NO escribe en memory/: el modulo no expone nada que escriba', async () => {
  const M = await import('./learning.mjs');
  for (const [k, v] of Object.entries(M)) {
    if (typeof v !== 'function') continue;
    assert.ok(!/^(write|save|persist|commit)/i.test(k), `'${k}' sugiere escritura: la promocion es un paso aparte`);
  }
  assert.equal(policy.rules.learningNeverWritesMemoryDirectly.enforced, true);
});

test('el ciclo completo: de una corrida sale un candidato resuelto', () => {
  const r = corrida('H-1', {
    stages: [{ stage: 'Security', status: 'FAIL', reason: 'secreto nuevo' }],
    artifacts: {},
  });
  const r2 = corrida('H-2', {
    stages: [{ stage: 'Security', status: 'FAIL', reason: 'secreto nuevo' }],
    artifacts: {},
  });
  const resueltos = decide([capture(r), capture(r2)], policy);
  assert.equal(resueltos.length, 1, 'la misma senal en dos vueltas es UN aprendizaje');
  const d = resueltos[0];
  assert.equal(d.type, 'FAILURE');
  assert.equal(d.repeatable, true);
  assert.equal(d.decision.verdict, 'PROMOTE');
  assert.deepEqual(d.evidence, ['H-1', 'H-2']);
});
