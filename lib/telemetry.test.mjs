// node --test harness/lib/telemetry.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registrar, drenar, leer, resumir } from './telemetry.mjs';

const limpiar = () => drenar();

test('la duracion SIEMPRE se mide, aunque el proveedor no publique nada', () => {
  limpiar();
  registrar({ provider: 'claude', model: 'opus', ms: 4200, ok: true });
  const [r] = resumir(drenar());
  assert.equal(r.durationMs, 4200);
  assert.equal(r.tokensStatus, 'MISSING');
  assert.equal(r.estimatedCost, null);
  assert.equal(r.costStatus, 'MISSING');
  assert.match(r.costNote, /no publica uso/);
});

test('"no lo publica" es null, NUNCA cero', () => {
  limpiar();
  registrar({ provider: 'claude', model: 'opus', ms: 100 });
  const [r] = resumir(drenar());
  assert.equal(r.totalTokens, null, 'un cero aqui diria que la llamada no gasto tokens, y es falso');
  assert.notEqual(r.totalTokens, 0);
});

test('cuando el proveedor SI publica, se agrega entrada y salida', () => {
  limpiar();
  registrar({ provider: 'deepseek', model: 'v4', ms: 10, usage: { tokensInput: 100, tokensOutput: 20, totalTokens: 120 } });
  registrar({ provider: 'deepseek', model: 'v4', ms: 30, usage: { tokensInput: 5, tokensOutput: 1, totalTokens: 6 } });
  const [r] = resumir(drenar());
  assert.equal(r.calls, 2);
  assert.equal(r.tokensInput, 105);
  assert.equal(r.tokensOutput, 21);
  assert.equal(r.totalTokens, 126);
  assert.equal(r.tokensStatus, 'REPORTED');
  assert.equal(r.msPerCall, 20);
  // Hay tokens y AUN ASI el coste es MISSING: el catalogo declara tier, no precio.
  assert.equal(r.estimatedCost, null);
  assert.match(r.costNote, /tier cualitativo/);
});

test('una invocacion FALLIDA tambien costo su tiempo y se cuenta', () => {
  limpiar();
  registrar({ provider: 'ollama', model: 'qwen3-coder', ms: 90000, ok: false, code: 'TIMEOUT' });
  const [r] = resumir(drenar());
  assert.equal(r.failed, 1);
  assert.equal(r.durationMs, 90000, 'contarla como cero hace parecer barato al que falla');
});

test('se agrega por (proveedor, modelo) y se ordena por lo que mas costo', () => {
  limpiar();
  registrar({ provider: 'claude', model: 'haiku', ms: 100 });
  registrar({ provider: 'claude', model: 'opus', ms: 9000 });
  registrar({ provider: 'ollama', model: 'qwen3-coder', ms: 500 });
  const r = resumir(drenar());
  assert.deepEqual(r.map((x) => x.id), ['claude:opus', 'ollama:qwen3-coder', 'claude:haiku']);
});

test('drenar VACIA: dos vueltas no comparten contabilidad', () => {
  limpiar();
  registrar({ provider: 'x', model: 'y', ms: 1 });
  assert.equal(drenar().length, 1);
  assert.deepEqual(leer(), [], 'si no vaciara, la vuelta N+1 heredaria el gasto de la N');
  assert.deepEqual(resumir(drenar()), []);
});
