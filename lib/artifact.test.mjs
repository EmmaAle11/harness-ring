import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { stageArtifactName, artifactPath, specManifestPath, validate } from './artifact.mjs';
import { ROOT } from './capabilities.mjs';

test('artifactPath sustituye el id del manifiesto, sea cual sea', () => {
  const id = 'H-20260817-abcdef12';
  assert.equal(artifactPath('.harness/runs/H-001/07-execution.json', id), `.harness/runs/${id}/07-execution.json`);
  assert.equal(artifactPath('.harness/runs/H-002/07-execution.json', id), `.harness/runs/${id}/07-execution.json`);
  assert.equal(artifactPath('.harness/runs/CUALQUIERA/01-knowledge.json', id), `.harness/runs/${id}/01-knowledge.json`);
});

test('no toca lo que no es un directorio de corrida', () => {
  const id = 'H-X';
  assert.equal(artifactPath('memory/runs-de-ayer/x.json', id), 'memory/runs-de-ayer/x.json');
});

test('la ruta del manifiesto se DERIVA de la spec, para las dos convenciones', () => {
  assert.equal(
    specManifestPath('/r', 'h-001-ring-execution'),
    '/r/.kiro/specs/h-001-ring-execution/h-001.json',
  );
  assert.equal(
    specManifestPath('/r', 'h-002-security-gate'),
    '/r/.kiro/specs/h-002-security-gate/h-002-security-gate.json',
  );
});

test('un `claim` VACIO no satisface el contrato Finding', () => {
  // EL DEFECTO, medido en H-20260819-68ac6919: el revisor del rework devolvio
  // dos hallazgos con `claim: ""` y `evidence` lleno, y la etapa 9 --que declara
  // «cada hallazgo trae file, symbol, claim y evidence citable»-- no disparo.
  // `validate` daba por presente todo lo que no fuera undefined ni null.
  const conVacio = { findings: [{ file: 'a.ts', symbol: 'f', claim: '', severity: 'P2', evidence: 'x' }] };
  const faltan = validate('FindingSet', conVacio);
  assert.equal(faltan.length, 1);
  assert.match(faltan[0], /findings\[0\] incumple Finding: falta 'claim'/);

  // Y solo en blanco: una cadena de espacios es igual de vacia.
  assert.equal(validate('FindingSet', { findings: [{ ...conVacio.findings[0], claim: '   ' }] }).length, 1);

  // Un hallazgo completo pasa.
  assert.deepEqual(validate('FindingSet', { findings: [{ ...conVacio.findings[0], claim: 'algo real' }] }), []);

  // CERO hallazgos sigue siendo valido: es el resultado esperado de un fix bueno.
  assert.deepEqual(validate('FindingSet', { findings: [] }), []);
});

test('un array vacio y un `false` SIGUEN siendo valores, no ausencias', () => {
  // La regla de la cadena vacia no puede desbordarse a los otros tipos:
  // `unknowns: []` es «no hay incognitas» y `pass: false` es un veredicto.
  assert.deepEqual(validate('ArchitectureBaseline', { scope: 'x', facts: [], unknowns: [] }), []);
  assert.deepEqual(validate('Verdict', { pass: false, blockers: 0, refutationRate: 0 }), []);
});

test('el Verdict dice QUE bloqueo, no solo cuantos', () => {
  // `11-convergence.json` proyectaba seis campos y `claim` no era uno: decia
  // «2 hallazgos confirmados: P2, P4» sin decir cuales. Es el artefacto que
  // decide REWORK; sin el motivo es un semaforo.
  const src = readFileSync(resolve(import.meta.dirname, 'stages-deterministic.mjs'), 'utf8');
  assert.match(src, /symbol: f\.symbol, claim: f\.claim,/);
});

test('el enunciado del rework NOMBRA `claim`', () => {
  // El enunciado acotado pedia `evidence` y no pedia `claim`. El contrato ya lo
  // hace cumplir, pero pedirlo mal y arreglarlo despues gasta una vuelta entera.
  const src = readFileSync(resolve(import.meta.dirname, 'stages-model.mjs'), 'utf8');
  assert.match(src, /Cada hallazgo lleva `claim`/);
});
