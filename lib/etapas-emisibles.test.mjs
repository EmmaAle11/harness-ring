// El control que vigila a los controles. Se prueba sobre FUENTES SINTETICAS.
// El caso contra el `gate.sh` real vive en adapters/doxia/etapas-emisibles.test.mjs:
// un motor portable no puede afirmar cosas sobre la puerta del anfitrion.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hallazgos, etapasQueNoPuedenFallar, DECLARADAS } from './etapas-emisibles.mjs';

test('una etapa que solo emite PASS no puede fallar', () => {
  const h = hallazgos('  record evidence PASS 0 0 "x" "y"\n');
  assert.deepEqual(h.map((x) => x.etapa), ['evidence']);
});

test('si tiene una rama FAIL, es un control y no se marca', () => {
  assert.deepEqual(hallazgos(`
    record lint PASS 0 0 "eslint" "ok"
    record lint FAIL 1 0 "eslint" "roto"`), []);
});

test('registrar con VARIABLE no se juzga: la variable puede valer FAIL', () => {
  // Era el falso positivo del primer barrido, y marcaba tres etapas sanas.
  assert.deepEqual(hallazgos('  record lock:full "$TURNO_ESTADO" 0 0 "x" "y"\n'), []);
});

test('DECLARAR no es mentir: NOT_CONFIGURED / MISSING / SKIP no son aprobar', () => {
  assert.deepEqual(hallazgos(`
    record integration_tests NOT_CONFIGURED 0 0 "—" "config inexistente"
    record llm_evaluation SKIP 0 0 "—" "Fase 2"`), []);
});

test('una declarada sale del hallazgo pero NO de la lista: sigue sin poder fallar', () => {
  const fuente = '  record architecture_validation PASS 0 0 "x" "y"\n';
  assert.deepEqual(hallazgos(fuente), [], 'esta declarada, no es hallazgo');
  assert.deepEqual(etapasQueNoPuedenFallar(fuente).map((x) => x.etapa), ['architecture_validation'],
    'pero se sigue viendo: una lista de declaradas que las ESCONDE es la siguiente averia');
  assert.ok(DECLARADAS.get('architecture_validation'), 'y cada declarada lleva su motivo');
});
