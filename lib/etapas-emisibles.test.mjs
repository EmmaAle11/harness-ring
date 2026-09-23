// El control que vigila a los controles. Se prueba sobre FUENTES SINTETICAS y ademas sobre
// el `gate.sh` real: lo primero fija la regla, lo segundo impide que la regla se cumpla
// porque el fichero cambio de forma y el regex dejo de casar con nada
// (memory/failures/el-cableado-mide-presencia-no-ejecucion.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { llamadas, hallazgos, etapasQueNoPuedenFallar, DECLARADAS } from './etapas-emisibles.mjs';

const GATE = resolve(fileURLToPath(new URL('../../scripts/gate.sh', import.meta.url)));

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

test('el regex SIGUE CASANDO con el gate real', () => {
  // Sin esto, un cambio de formato en gate.sh dejaria 0 llamadas, 0 hallazgos y un verde
  // que no mira nada. El numero exacto no importa; que haya muchas, si.
  const n = llamadas(readFileSync(GATE, 'utf8')).length;
  assert.ok(n > 20, `solo ${n} llamadas a record reconocidas en gate.sh: el patron dejo de casar`);
});

test('el gate.sh de HOY no tiene ninguna etapa que no pueda fallar', () => {
  const h = hallazgos(readFileSync(GATE, 'utf8'));
  assert.deepEqual(h, [], `etapas que no pueden fallar: ${h.map((x) => x.etapa).join(', ')}`);
});
