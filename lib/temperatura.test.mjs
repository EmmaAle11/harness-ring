/**
 * LA TEMPERATURA POR CLASE, y sobre todo: QUE LLEGUE.
 *
 * MEDIDO el 2026-09-15 (h-008, 3 vueltas por brazo): temp 0.5 uniforme dio
 * -28,57% de etapas ejecutadas y rompio el determinismo (s^2 0 -> 2). De ahi
 * que `review` sea 0.3 y no 0.5: un paso medido hacia abajo desde el valor que
 * fallo.
 *
 * El riesgo real de este cambio no es el numero: es que la clase se pierda por
 * el camino. `executionRequest` normaliza con una lista CERRADA de campos, asi
 * que un `clase` no declarado alli se cae en silencio y la politica queda
 * escrita sin gobernar nada. Eso es lo que fijan los ultimos tres tests.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  temperaturaDe, motivoDeTemperatura, clasesConTemperatura, TEMPERATURA_POR_DEFECTO,
} from '../policy/temperatura.mjs';
import { executionRequest } from '../adapters/models/contract.mjs';

test('read es 0.0: inventariar tiene UNA respuesta correcta', () => {
  assert.equal(temperaturaDe('read'), 0.0);
});

test('review es 0.3, NO 0.5 — 0.5 degrado el anillo un 28,57%', () => {
  assert.equal(temperaturaDe('review'), 0.3);
  assert.ok(temperaturaDe('review') < 0.5, 'no volver al valor que fallo');
  assert.ok(temperaturaDe('review') > temperaturaDe('read'), 'refutar explora mas que contar');
});

test('edit es 0.0: el escritor es lo unico que entra al arbol', () => {
  assert.equal(temperaturaDe('edit'), 0.0);
});

test('ninguna clase pasa de 0.3: el techo medido', () => {
  for (const c of clasesConTemperatura()) {
    assert.ok(temperaturaDe(c) <= 0.3, `${c} = ${temperaturaDe(c)} supera el techo medido`);
    assert.ok(temperaturaDe(c) >= 0, `${c} negativa`);
  }
});

test('una clase desconocida cae al valor de siempre, no a cero', () => {
  // Caer a 0 seria un cambio de conducta silencioso para todo lo no declarado.
  assert.equal(temperaturaDe('no-existe'), TEMPERATURA_POR_DEFECTO);
  assert.equal(temperaturaDe(undefined), TEMPERATURA_POR_DEFECTO);
  assert.equal(temperaturaDe(null), TEMPERATURA_POR_DEFECTO);
  assert.equal(TEMPERATURA_POR_DEFECTO, 0.1);
});

test('cada clase declara POR QUE ese numero', () => {
  for (const c of clasesConTemperatura()) {
    assert.ok(motivoDeTemperatura(c).length > 40, `${c} sin motivo suficiente`);
  }
});

test('EL CAMPO SOBREVIVE A executionRequest — si se cae, la politica no gobierna nada', () => {
  const req = executionRequest({ prompt: 'x', model: 'm', clase: 'review' });
  assert.equal(req.clase, 'review');
});

test('sin clase el contrato la deja en null, no la inventa', () => {
  assert.equal(executionRequest({ prompt: 'x', model: 'm' }).clase, null);
});

test('el contrato no pierde los campos que ya llevaba', () => {
  const req = executionRequest({ prompt: 'x', model: 'm', cwd: '/tmp', capability: 'reviewer' });
  assert.equal(req.cwd, '/tmp');
  assert.equal(req.capability, 'reviewer');
  assert.equal(req.prompt, 'x');
});
