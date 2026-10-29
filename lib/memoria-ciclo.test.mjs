// LA PRUEBA DE QUE EL CIRCULO SE CIERRA, no de que las piezas existen.
//
// Los tests de `memoria-escritor.test.mjs` prueban el escritor aislado. Este
// prueba la CADENA COMPLETA sobre dos vueltas, que es donde vivia el defecto:
//
//   vuelta 1: capture -> classify -> promote -> escribir  -> memory/
//   vuelta 2: lee memory/ -> el mismo hallazgo ya NO es novel -> no se duplica
//
// Si alguien desconecta el escritor, los tests del escritor siguen verdes y este
// cae: la vuelta 2 vuelve a proponer lo mismo como novedad. Esa es la regresion
// que importa y la que no tenia guarda.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { capture, decide, provenance } from './learning.mjs';
import { escribir } from './memoria-escritor.mjs';
import { frontmatter, auditar } from './memoria-mecanismo.mjs';

const POLICY = {
  version: 1,
  excluded: ['AGENT_BEHAVIOR', 'USER_PREFERENCE', 'EPHEMERAL_SESSION_CONTEXT'],
  maxConfidence: 0.9,
  confidenceByRuns: { 1: 0.5, 2: 0.75, 3: 0.9 },
  types: {
    FAILURE: { autoPromote: true, minConfidence: 0.75, dir: 'memory/failures' },
    VALIDATION: { autoPromote: true, minConfidence: 0.75, dir: 'memory/validations' },
    CODING_PATTERN: { autoPromote: true, minConfidence: 0.9, dir: 'memory/patterns' },
    ARCHITECTURE_DECISION: { autoPromote: false, minConfidence: 0.9, dir: 'memory/decisions' },
  },
};

/** Una vuelta con una etapa en rojo: la senal mas basica que el anillo produce. */
const vuelta = (id, etapa = 'build', motivo = 'OOM al cargar dos modelos de 13 GB') => ({
  executionId: id,
  trace: { stages: [{ stage: etapa, status: 'FAIL', reason: motivo }] },
  artifacts: {},
});

/** Lo que hace el anillo al cerrar: decidir y escribir. Es el cableado de bin/doxia.mjs. */
function cerrarVuelta(raiz, runs, previas) {
  const capturas = runs.map(capture);
  const resueltos = decide(capturas, POLICY, { previas }).map((c) => ({
    ...c,
    provenance: provenance(c, { promotedBy: 'trigger', model: 'modelo-x', date: '2026-10-29' }),
  }));
  return { resueltos, escritura: escribir(resueltos, POLICY, { raiz }) };
}

/** Lo que `stages.leerMemoriaVigente()` lee: el `title` del frontmatter. */
function memoriaVigente(raiz) {
  const base = join(raiz, 'memory');
  if (!existsSync(base)) return [];
  const out = [];
  for (const d of readdirSync(base, { withFileTypes: true }).filter((x) => x.isDirectory())) {
    for (const f of readdirSync(join(base, d.name)).filter((x) => x.endsWith('.md'))) {
      const fm = frontmatter(readFileSync(join(base, d.name, f), 'utf8'));
      if (fm.title) out.push({ statement: fm.title, id: fm.id, type: fm.type });
    }
  }
  return out;
}

test('UNA sola vuelta no promueve nada: la repetibilidad es de la serie', () => {
  const R = mkdtempSync(join(tmpdir(), 'ciclo-1-'));
  const { resueltos, escritura } = cerrarVuelta(R, [vuelta('run-001')], []);

  assert.equal(resueltos.length, 1);
  assert.equal(resueltos[0].confidence, 0.5, 'una corrida da 0.5');
  assert.equal(resueltos[0].decision.verdict, 'REVIEW', 'FAILURE exige 0.75: con una vuelta no llega');
  assert.equal(escritura.escritos.length, 0);
  assert.ok(!existsSync(join(R, 'memory')), 'no se crea memory/ por un candidato no promovido');
});

test('DOS vueltas con el mismo fallo: se promueve y SE ESCRIBE', () => {
  const R = mkdtempSync(join(tmpdir(), 'ciclo-2-'));
  const { resueltos, escritura } = cerrarVuelta(R, [vuelta('run-001'), vuelta('run-002')], []);

  assert.equal(resueltos[0].confidence, 0.75, 'dos corridas distintas suben la confianza');
  assert.equal(resueltos[0].repeatable, true);
  assert.equal(resueltos[0].decision.verdict, 'PROMOTE');
  assert.equal(escritura.escritos.length, 1, 'y esta vez SI llega a disco');

  const fm = frontmatter(readFileSync(escritura.escritos[0].path, 'utf8'));
  assert.equal(fm.type, 'FAILURE');
  assert.equal(fm.execution_id, 'run-002', 'la provenance apunta a la ultima corrida que lo sostiene');
});

test('EL CIRCULO: la vuelta 3 ya NO lo propone como novedad', () => {
  const R = mkdtempSync(join(tmpdir(), 'ciclo-3-'));

  // Vueltas 1-2: se aprende y se escribe.
  const a = cerrarVuelta(R, [vuelta('run-001'), vuelta('run-002')], []);
  assert.equal(a.escritura.escritos.length, 1);

  // Vuelta 3: el anillo arranca LEYENDO memory/, como hace de verdad.
  const previas = memoriaVigente(R);
  assert.equal(previas.length, 1, 'lo escrito debe ser legible como memoria vigente');

  const b = cerrarVuelta(R, [vuelta('run-001'), vuelta('run-002'), vuelta('run-003')], previas);

  assert.equal(b.resueltos[0].novel, false, 'ya se aprendio: no es nuevo');
  assert.equal(b.resueltos[0].decision.verdict, 'REJECT');
  assert.match(b.resueltos[0].decision.reason, /ya existe/);
  assert.equal(b.escritura.escritos.length, 0, 'y no se duplica el fichero');
  assert.equal(readdirSync(join(R, 'memory', 'failures')).length, 1);
});

test('un hallazgo DISTINTO sigue entrando: el filtro no es un tapon', () => {
  const R = mkdtempSync(join(tmpdir(), 'ciclo-4-'));
  cerrarVuelta(R, [vuelta('run-001'), vuelta('run-002')], []);

  const previas = memoriaVigente(R);
  const otro = [
    vuelta('run-003', 'sca', '8 vulnerabilidades high sin riesgo aceptado'),
    vuelta('run-004', 'sca', '8 vulnerabilidades high sin riesgo aceptado'),
  ];
  const { escritura } = cerrarVuelta(R, otro, previas);

  assert.equal(escritura.escritos.length, 1, 'lo nuevo entra aunque ya haya memoria');
  assert.equal(readdirSync(join(R, 'memory', 'failures')).length, 2);
});

test('lo que el anillo escribe NO sube el techo de mecanismos del gate', () => {
  const R = mkdtempSync(join(tmpdir(), 'ciclo-5-'));
  cerrarVuelta(R, [vuelta('run-001'), vuelta('run-002')], []);

  const au = auditar(join(R, 'memory'));
  assert.equal(au.sinMecanismo.length, 0,
    `el propio anillo romperia su puerta: ${JSON.stringify(au.sinMecanismo)}`);
  assert.equal(au.estadosRaros.length, 0);
});
