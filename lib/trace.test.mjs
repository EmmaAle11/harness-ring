// node --test harness/lib/
//
// Fase 9. Lo que se fija: que el trace lleve lo que hace falta para RECONSTRUIR
// una corrida sin memoria humana, que las metricas salgan del harness y no de lo
// que declare un modelo, y que no arrastre secretos.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTrace, sinSecretos, checkTrace, resumenAbortada } from './trace.mjs';

const art = (stage, n, payload, contract = 'X') => ({ stage, n, contract, status: 'OK', payload });

/** Una corrida sintetica con lo justo para ejercer la extraccion. */
const corrida = () => ({
  executionId: 'H-TEST-0001',
  verdict: 'PASSED',
  startedAt: '2026-08-16T10:00:00.000Z',
  endedAt: '2026-08-16T10:30:00.000Z',
  stages: [
    { n: 7, stage: 'Execution', status: 'OK', contract: 'ChangeSet', artifact: 'a/07.json', ms: 600000 },
    { n: 7, stage: 'Execution', status: 'OK', contract: 'ChangeSet', artifact: 'a/07.json', ms: 300000 },
    { n: 10, stage: 'Convergence', status: 'OK', contract: 'Verdict', artifact: 'a/10.json', ms: 10 },
  ],
  artifacts: {
    Plan: art('Plan', 4, { id: 'WP-1', goal: 'extraer formatFileSize' }),
    Execution: art('Execution', 7, {
      files: ['src/a.ts'], diff: 'x', iterations: 9,
      toolCalls: [
        { tool: 'read_file', allowed: true, exitCode: 0 },
        { tool: 'create_file', allowed: false, rule: 'denyPaths', error: 'no' },
      ],
      mutations: [
        { op: 'create_file', path: 'src/a.ts', baseHash: null, before: null, after: 'aaaa1111', changed: true },
        { op: 'apply_patch', path: 'src/a.ts', baseHash: 'aaaa1111', before: 'aaaa1111', after: 'aaaa1111', changed: false },
      ],
    }),
    Adversarial: art('Adversarial', 9, {
      findings: [
        { file: 'src/a.ts', symbol: 'f', claim: 'algo', severity: 'P5', verdict: 'CONFIRMED', evidence: ['x'] },
        { file: 'src/b.ts', symbol: 'g', claim: 'otra', severity: 'P4', verdict: 'REFUTED', evidence: ['y'] },
      ],
    }),
    Convergence: art('Convergence', 10, { pass: true, blockers: 0, raw: 2, unified: 2, refutationRate: 0.5 }),
    Security: art('Security', 11, { sca: 'WARN', sbom: 'MISSING', sast: 'MISSING', owasp: 'MISSING', findings: [] }),
    CapabilityLayer: art('CapabilityLayer', 12, { capabilities: ['builder'], harnessTools: ['read_file'], toolsUsed: ['read_file'] }),
    AdapterLayer: art('AdapterLayer', 13, { bindings: [{ capability: 'builder', provider: 'claude', model: 'opus', invocations: 9 }] }),
    Evidence2: art('Evidence2', 15, {
      sha: 'abc1234', mode: 'full', verdict: 'PASS', evidencePath: '/ws/.harness/evidence/abc1234-1.json',
      checks: [{ check: 'unit_tests:fe', status: 'PASS' }, { check: 'lint', status: 'PASS' }],
    }),
  },
});

// ── Correlacion ─────────────────────────────────────────────────────────────
test('todo lleva ID prefijado por el executionId', () => {
  const t = buildTrace(corrida());
  assert.equal(t.toolCalls[0].toolCallId, 'H-TEST-0001:tc:1');
  assert.equal(t.mutations[1].mutationId, 'H-TEST-0001:mu:2');
  assert.equal(t.findings[0].findingId, 'H-TEST-0001:f:1');
  // Sin el prefijo, «el hallazgo 3» no significa nada fuera de su fichero y dos
  // corridas no se pueden comparar sin acarrear cual era cual.
  for (const id of [t.toolCalls[0].toolCallId, t.mutations[0].mutationId, t.findings[0].findingId]) {
    assert.match(id, /^H-TEST-0001:/);
  }
});

test('un hallazgo se enlaza con las mutaciones de SU fichero', () => {
  const t = buildTrace(corrida());
  assert.deepEqual(t.findings[0].relatedMutations, ['H-TEST-0001:mu:1', 'H-TEST-0001:mu:2']);
  assert.deepEqual(t.findings[1].relatedMutations, [], 'src/b.ts no se toco: no hay correlacion que inventar');
});

test('parentExecutionId viaja en el trace, no solo en el prompt de Knowledge', () => {
  assert.equal(buildTrace(corrida(), { parentExecutionId: 'H-PREV-9999' }).parentExecutionId, 'H-PREV-9999');
  assert.equal(buildTrace(corrida()).parentExecutionId, null, 'la primera de la serie lo dice, no lo omite');
});

// ── Metricas: del harness, no del modelo ────────────────────────────────────
test('las metricas se derivan de los artefactos, no de lo que nadie declare', () => {
  const m = buildTrace(corrida()).metrics;
  assert.equal(m.reworks, 1, 'dos Execution = un rework');
  assert.equal(m.toolCalls, 2);
  assert.equal(m.toolCallsDenied, 1);
  assert.equal(m.mutations, 2);
  assert.equal(m.mutationsApplied, 1, 'la que no cambio nada no cuenta como aplicada');
  assert.equal(m.findings, 2);
  assert.equal(m.findingsConfirmed, 1, 'el REFUTED no cuenta');
  assert.equal(m.durationMs, 900010);
});

test('sin dato de uso, `tokens` es null y se dice por que — nunca cero', () => {
  const m = buildTrace(corrida()).metrics;
  assert.equal(m.tokens, null);
  assert.match(m.costNote, /no reportan uso/);
  // Un cero seria mentira y una estimacion seria peor: pareceria medida.
  assert.notEqual(m.tokens, 0);
});

test('planHash cambia si cambia el plan, y es lo que ancla la corrida a su intencion', () => {
  const a = buildTrace(corrida());
  const otra = corrida();
  otra.artifacts.Plan.payload.goal = 'otra cosa';
  assert.notEqual(a.planHash, buildTrace(otra).planHash);
  assert.equal(a.plan.goal, 'extraer formatFileSize');
});

// ── ADR-006 ─────────────────────────────────────────────────────────────────
test('los campos del grafo EXISTEN y se declaran MISSING', () => {
  const g = buildTrace(corrida()).graph;
  for (const k of ['snapshotBefore', 'queries', 'impactAnalysis', 'snapshotAfter', 'diff', 'findings']) {
    assert.equal(g[k], 'MISSING', `${k} deberia declararse MISSING`);
  }
  assert.match(g.why, /ADR-006/);
  // Un hueco con nombre es auditable; uno sin nombre no. Omitirlos habria hecho
  // parecer que el grafo no hace falta, en vez de que no existe todavia.
});

// ── Secretos ────────────────────────────────────────────────────────────────
test('el barrido caza FORMAS de credencial', () => {
  // Los cebos se COMPONEN en vez de escribirse literales. No es coquetería: el
  // pre-commit del repo busca las mismas formas en el diff, y un fixture literal
  // bloquea el commit del test que existe para detectarlas. Bien hecho por el
  // hook -- no puede distinguir una clave de ejemplo de una real, y esa
  // indistincion es justo lo que lo hace util.
  const casos = [
    ['AK' + 'IA' + 'IOSFODNN7EXAMPLE', 'AWS'],
    ['sk' + '-abcdefghijklmnopqrstuvwxyz0123', 'sk-'],
    ['gh' + 'p_' + 'a'.repeat(36), 'github'],
    ['ey' + 'JhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.xxx', 'jwt'],
    ['-----BEGIN RSA PRIVATE ' + 'KEY-----', 'pem'],
    ['authorization: Bearer0123456789abcdef', 'kv'],
  ];
  for (const [texto, que] of casos) {
    assert.ok(sinSecretos({ x: texto }).length, `no detecto ${que}`);
  }
});

test('NO grita con la palabra "password", que aparece en cualquier diff de login', () => {
  // Un detector que grita con esto se acaba ignorando, y entonces no detecta nada.
  assert.deepEqual(sinSecretos({ diff: 'const password = form.password; // campo del login' }), []);
  assert.deepEqual(sinSecretos(buildTrace(corrida())), [], 'un trace normal esta limpio');
});

// ── La traza sigue siendo evaluable por FT-1 ────────────────────────────────
test('el trace enriquecido no rompe checkTrace: los campos nuevos son ADITIVOS', () => {
  const manifest = { stages: [{ stage: 'Execution', n: 7 }, { stage: 'Convergence', n: 10 }] };
  const t = buildTrace(corrida());
  const p = checkTrace(t, manifest);
  // Los artefactos sinteticos no existen en disco, asi que se espera ESA queja y
  // ninguna sobre el orden o las etapas: lo que se comprueba es que los campos
  // nuevos no confunden al validador.
  assert.ok(p.every((x) => /artefacto/.test(x)), `quejas inesperadas: ${JSON.stringify(p)}`);
  assert.equal(t.reworks, 1);
});

test('`tests` sale de gateChecks, no de los estados de las 16 etapas', () => {
  const c = corrida();
  c.artifacts.Evidence2.payload.gateChecks = [
    { check: 'unit_tests:fe', status: 'PASS', nota: '64/683' },
    { check: 'build:fe', status: 'PASS', nota: '' },
    { check: 'lint', status: 'PASS', nota: '' },
  ];
  const t = buildTrace(c);
  // `checks` son los estados de las etapas del anillo -- Knowledge, Execution…
  // y leerlos como si fueran la puerta dejaba `tests` vacio en una corrida que
  // habia corrido 683 tests de frontend.
  assert.deepEqual(t.tests.map((x) => x.check), ['unit_tests:fe', 'build:fe']);
  assert.equal(t.tests[0].nota, '64/683', 'la nota lleva el piso, que es lo que hace util el dato');
});

test('sin gateChecks, `tests` queda vacio y no se rellena con las etapas', () => {
  const t = buildTrace(corrida());
  assert.deepEqual(t.tests, [], 'vacio honesto antes que un dato de otra cosa');
});

// ── El REWORK no puede borrar lo que hizo el intento anterior ───────────────
test('los tool calls y mutaciones de TODOS los intentos entran en el trace', () => {
  const c = corrida();
  const primero = art('Execution', 7, {
    files: ['src/a.ts'], diff: 'x', iterations: 20,
    toolCalls: [{ tool: 'apply_patch', allowed: true, exitCode: 0 }, { tool: 'run_test', allowed: true, exitCode: 1 }],
    mutations: [{ op: 'apply_patch', path: 'src/a.ts', baseHash: 'bbbb', before: 'bbbb', after: 'cccc', changed: true }],
  });
  // `artifacts.Execution` es el VIGENTE -- el reintento, que solo verifico --
  // y `attempts` la serie. Leyendo solo el vigente, la traza decia
  // «1 rework, 0 mutaciones» sobre una vuelta que habia escrito ficheros.
  c.attempts = { Execution: [primero, c.artifacts.Execution] };

  const t = buildTrace(c);
  assert.equal(t.toolCalls.length, 4, 'dos del primer intento + dos del segundo');
  assert.equal(t.mutations.length, 3);
  assert.deepEqual(t.toolCalls.map((x) => x.tool), ['apply_patch', 'run_test', 'read_file', 'create_file']);
  assert.equal(t.metrics.executionAttempts, 2);
  assert.equal(t.metrics.iterationsTotal, 29, 'la vuelta entera, no solo el ultimo intento');
  assert.equal(t.metrics.iterations, 9, 'y el ultimo aparte, que es lo que costo converger');
});

test('sin attempts, se cae al artefacto vigente y no revienta', () => {
  const t = buildTrace(corrida());
  assert.equal(t.toolCalls.length, 2);
  assert.equal(t.metrics.executionAttempts, 1);
});

test('toolsUsed sale de los toolCalls acumulados, no del artefacto de una etapa', () => {
  const c = corrida();
  const primero = art('Execution', 7, {
    files: ['src/a.ts'], diff: 'x', iterations: 5,
    toolCalls: [{ tool: 'apply_patch', allowed: true, exitCode: 0 }],
    mutations: [],
  });
  // El reintento no llamo a nada. CapabilityLayer solo ve ese ultimo intento, asi
  // que copiarle el campo daba «11 llamadas · usadas: —»: dos cifras del mismo
  // hecho sacadas de sitios distintos.
  const vacio = art('Execution', 7, { files: ['src/a.ts'], diff: 'x', iterations: 1, toolCalls: [], mutations: [] });
  c.artifacts.Execution = vacio;
  c.artifacts.CapabilityLayer.payload.toolsUsed = [];
  c.attempts = { Execution: [primero, vacio] };

  const t = buildTrace(c);
  assert.deepEqual(t.toolsUsed, ['apply_patch']);
  assert.equal(t.metrics.toolCalls, 1, 'y las dos cifras cuadran');
});

// Dos contratos distintos con nombres parecidos: la etapa 2 produce un FactSet y
// la 15 un EvidencePackage. El fallback `Evidence2 ?? Evidence` venia de cuando
// la 15 se llamaba `Evidence`; tras el renombrado recogia el artefacto de la 2 y
// una vuelta que no llegaba a la 15 rendia `evidencia undefined (undefined)`.
test('sin EvidencePackage, `finalEvidence` es null y NO el FactSet de la etapa 2', () => {
  const t = buildTrace({
    executionId: 'H-X', verdict: 'FAILED', reason: 'murio en la 7',
    startedAt: 'a', endedAt: 'b',
    stages: [{ n: 2, stage: 'Evidence', status: 'OK', contract: 'FactSet', artifact: 'x.json', ms: 1 }],
    artifacts: { Evidence: { stage: 'Evidence', payload: { facts: [{ claim: 'x' }] } } },
  });
  assert.equal(t.finalEvidence, null, 'un FactSet no es un EvidencePackage por parecerse de nombre');
  assert.deepEqual(t.tests, []);
});

test('una vuelta abortada no es una vuelta SIN evidencia', () => {
  // Sin `trace.json` --que el orquestador escribe al cerrar-- `reconstruct` decia
  // «no se reconstruye entera» y no ensenaba NADA, teniendo los artefactos por
  // etapa en disco. Medido sobre H-20260824-fa058d63: 11 artefactos y una salida
  // vacia con cuatro lineas de queja.
  //
  // Es la otra mitad de lo que dejo sin adjudicar la contradiccion del item cm-4:
  // el tablero no decia a donde mirar --arreglado en campaign.mjs-- y `trace` no
  // ensenaba lo que SI habia cuando se miraba.
  const arts = {
    Knowledge: { stage: 'Knowledge', status: 'OK' },
    Compute: { stage: 'Compute', status: 'WARN', reason: 'refutacion DEGRADADA: sin tercera familia' },
    Convergence: { stage: 'Convergence', status: 'FAIL', reason: '3 hallazgo(s) confirmados' },
  };
  const L = resumenAbortada(arts);
  assert.match(L[0], /ABORTADA/);
  assert.match(L[0], /3 etapa\(s\)/);
  // El ESTADO de cada etapa, no solo su nombre: un WARN y un FAIL no son un OK.
  assert.ok(L.some((l) => /Compute\s+WARN\s+refutacion DEGRADADA/.test(l)), L.join('\n'));
  assert.ok(L.some((l) => /Convergence\s+FAIL/.test(l)), L.join('\n'));
  // Y DONDE murio, que es la pregunta que se hace quien abre esto.
  assert.match(L.at(-1), /murio DESPUES de 'Convergence'/);

  // Sin artefactos no se inventa un resumen: no hay nada que contar.
  assert.deepEqual(resumenAbortada({}), []);
  assert.deepEqual(resumenAbortada(null), []);
});
