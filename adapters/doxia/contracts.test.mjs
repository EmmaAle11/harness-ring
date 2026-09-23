import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadCapabilities } from '../../lib/capabilities.mjs';

const C = JSON.parse(readFileSync(new URL('../../contracts/contracts.json', import.meta.url), 'utf8'));

test('contracts.model refleja el manifiesto, etapa por etapa', () => {
  const M = JSON.parse(
    readFileSync(new URL('../../../.kiro/specs/h-001-ring-execution/h-001.json', import.meta.url), 'utf8'),
  );
  assert.deepEqual(C.model.slice(0, -1), M.stages.map((s) => s.stage));
});

const H1 = () => JSON.parse(
  readFileSync(new URL('../../../.kiro/specs/h-001-ring-execution/h-001.json', import.meta.url), 'utf8'),
);

test('ninguna etapa comparte nombre con otra: el mapa de handlers va por nombre', () => {
  const nombres = H1().stages.map((s) => s.stage);
  assert.equal(new Set(nombres).size, nombres.length,
    'dos etapas homonimas hacen que la segunda ejecute el handler de la primera');
});

test('H-001 recorre las mismas 16 etapas del anillo y en el mismo orden', () => {
  assert.deepEqual(
    H1().stages.map((s) => s.stage),
    C.stages.map((s) => s.stage),
    'H-001 y contracts.json describen anillos distintos',
  );
});

test('H-001 solo usa contratos que existen', () => {
  const conocidos = new Set(Object.keys(C.contracts));
  for (const s of H1().stages) {
    for (const x of [...s.input, s.output]) {
      assert.ok(conocidos.has(x), `H-001 etapa '${s.stage}': contrato desconocido '${x}'`);
    }
  }
});

test('toda etapa de H-001 declara criterio de transicion y que hacer si falla', () => {
  for (const s of H1().stages) {
    assert.ok(s.gate?.length > 10, `etapa '${s.stage}': sin criterio de transicion`);
    assert.ok(s.onFail?.length > 3, `etapa '${s.stage}': sin onFail — ninguna avanza "por defecto"`);
    assert.ok(s.artifact?.startsWith('.harness/runs/'), `etapa '${s.stage}': sin artefacto en disco`);
  }
});

test('los cinco fitness tests existen y dicen que prueban', () => {
  assert.equal(H1().fitnessTests.length, 5);
  for (const ft of H1().fitnessTests) {
    assert.ok(ft.assert?.length, `${ft.id}: sin aserciones`);
    assert.ok(ft.proves?.length, `${ft.id}: no declara que exit criterion demuestra`);
    assert.ok(ft.source, `${ft.id}: no declara de que artefacto se evalua`);
  }
  // FT-5 es el unico que un flujo lineal NO pasaria: exige una segunda corrida.
  assert.match(H1().fitnessTests.find((f) => f.id === 'FT-5').source, /SEGUNDA corrida/i);
});
