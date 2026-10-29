import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { stageArtifactName, artifactPath, specManifestPath, validate } from '../../lib/artifact.mjs';
import { ROOT } from '../../lib/capabilities.mjs';

const M = () => JSON.parse(
  readFileSync(new URL('../../../.kiro/specs/h-001-ring-execution/h-001.json', import.meta.url), 'utf8'),
);

const HAY_H001 = existsSync(fileURLToPath(new URL('../../../.kiro/specs/h-001-ring-execution/h-001.json', import.meta.url)));

test('el nombre del artefacto sale del manifiesto, no de un literal', (t) => {
  if (!HAY_H001) { t.skip('sin .kiro/specs/h-001-ring-execution/h-001.json: este arbol no es el anfitrion DoxIA'); return; }
  // Las dos que el orquestador consolida al cerrar, que son las que se rompieron.
  assert.equal(stageArtifactName(M(), 'Observability'), '14-observability.json');
  assert.equal(stageArtifactName(M(), 'AdapterLayer'), '13-adapterlayer.json');
});

test('toda etapa del manifiesto tiene un nombre derivable y unico', (t) => {
  if (!HAY_H001) { t.skip('sin .kiro/specs/h-001-ring-execution/h-001.json: este arbol no es el anfitrion DoxIA'); return; }
  const nombres = M().stages.map((s) => stageArtifactName(M(), s.stage));
  assert.equal(nombres.length, 16);
  assert.equal(new Set(nombres).size, 16, 'dos etapas escribiendo el mismo fichero se pisan');
  // El prefijo numerico ES la posicion: si dejan de coincidir, el orden que
  // documenta el nombre y el que ejecuta el motor son distintos.
  for (const s of M().stages) {
    assert.ok(
      stageArtifactName(M(), s.stage).startsWith(String(s.n).padStart(2, '0') + '-'),
      `'${s.stage}' es la etapa ${s.n} pero su artefacto no lo refleja`,
    );
  }
});

test('una etapa que no existe lanza en vez de devolver algo inservible', (t) => {
  if (!HAY_H001) { t.skip('sin .kiro/specs/h-001-ring-execution/h-001.json: este arbol no es el anfitrion DoxIA'); return; }
  assert.throws(() => stageArtifactName(M(), 'NoExiste'), /sin etapa 'NoExiste'/);
});

test('los dos manifiestos que existen se resuelven a un fichero real', (t) => {
  if (!HAY_H001) { t.skip('sin .kiro/specs/h-001-ring-execution/h-001.json: este arbol no es el anfitrion DoxIA'); return; }
  for (const id of ['h-001-ring-execution', 'h-002-security-gate']) {
    const p = specManifestPath(ROOT, id);
    assert.ok(existsSync(p), `${id} -> ${p} no existe`);
    assert.equal(JSON.parse(readFileSync(p, 'utf8')).stages.length, 16);
  }
});
