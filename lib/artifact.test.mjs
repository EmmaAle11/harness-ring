// node --test harness/lib/
//
// ESTE es el test que faltaba. El orquestador consolidaba al cerrar dos
// artefactos cuyo nombre llevaba escrito a mano; cuando la reordenacion en dos
// mitades movio Observability a la 14 y AdapterLayer a la 13, los literales se
// quedaron en 11 y 14 y la consolidacion dejo de encontrarlos. Como callaba ante
// un fichero ausente, nada se puso rojo: FT-1 sobrevivia porque `trace.json` se
// escribe aparte, y FT-4 leia el snapshot de mitad de vuelta.
//
// Derivar el nombre del manifiesto hace que una reordenacion futura NO rompa
// nada; comprobarlo aqui hace que volver a escribirlo a mano falle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { stageArtifactName, artifactPath, specManifestPath, validate } from './artifact.mjs';
import { ROOT } from './capabilities.mjs';

const M = JSON.parse(
  readFileSync(new URL('../../.kiro/specs/h-001-ring-execution/h-001.json', import.meta.url), 'utf8'),
);

test('el nombre del artefacto sale del manifiesto, no de un literal', () => {
  // Las dos que el orquestador consolida al cerrar, que son las que se rompieron.
  assert.equal(stageArtifactName(M, 'Observability'), '14-observability.json');
  assert.equal(stageArtifactName(M, 'AdapterLayer'), '13-adapterlayer.json');
});

test('toda etapa del manifiesto tiene un nombre derivable y unico', () => {
  const nombres = M.stages.map((s) => stageArtifactName(M, s.stage));
  assert.equal(nombres.length, 16);
  assert.equal(new Set(nombres).size, 16, 'dos etapas escribiendo el mismo fichero se pisan');
  // El prefijo numerico ES la posicion: si dejan de coincidir, el orden que
  // documenta el nombre y el que ejecuta el motor son distintos.
  for (const s of M.stages) {
    assert.ok(
      stageArtifactName(M, s.stage).startsWith(String(s.n).padStart(2, '0') + '-'),
      `'${s.stage}' es la etapa ${s.n} pero su artefacto no lo refleja`,
    );
  }
});

test('una etapa que no existe lanza en vez de devolver algo inservible', () => {
  assert.throws(() => stageArtifactName(M, 'NoExiste'), /sin etapa 'NoExiste'/);
});

// ── La ruta no puede depender de un id escrito a mano ───────────────────────
// Llevaba `replace('H-001', ...)` y funcionaba mientras solo existio ese
// manifiesto. Con h-002-security-gate, cuyos artefactos declaran `runs/H-002/`,
// el replace no encontro nada: las 16 etapas escribieron en un directorio
// literal compartido y el orquestador reventó buscando el trace de la vuelta.
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

// ── La ruta del manifiesto: UNA autoridad, dos consumidores ─────────────────
//
// `run --ring` la derivaba y `fitness` tenia 'h-001.json' escrito a mano. Evaluar
// los fitness de H-002 reventaba con ENOENT sobre
// `.kiro/specs/h-002-security-gate/h-001.json`. Solo se noto al existir un SEGUNDO
// manifiesto -- igual que el `artifactPath` con 'H-001' dentro.
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

test('los dos manifiestos que existen se resuelven a un fichero real', () => {
  for (const id of ['h-001-ring-execution', 'h-002-security-gate']) {
    const p = specManifestPath(ROOT, id);
    assert.ok(existsSync(p), `${id} -> ${p} no existe`);
    assert.equal(JSON.parse(readFileSync(p, 'utf8')).stages.length, 16);
  }
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
