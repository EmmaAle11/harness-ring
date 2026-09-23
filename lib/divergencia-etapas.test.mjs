import { test } from 'node:test';
import assert from 'node:assert/strict';
import { etapasDe, etapasDeRef, deficit } from './divergencia-etapas.mjs';

test('lee las etapas de nombre literal y salta las que registran con variable', () => {
  const s = `
    record specification PASS 0
    record "unit_tests:fe" FAIL 1
    record "$label" PASS 0
    record "$c" SKIP 0
  `;
  assert.deepEqual([...etapasDe(s)].sort(), ['specification', 'unit_tests:fe']);
});

test('una etapa que otra rama tiene y esta no, sin declarar, es deficit', () => {
  const r = deficit({
    rama: 'origin/mia',
    porRef: { 'origin/mia': new Set(['a']), 'origin/otra': new Set(['a', 'lock:full']) },
  });
  assert.deepEqual(r.sinDeclarar, [{ etapa: 'lock:full', ref: 'origin/otra' }]);
  assert.equal(r.declaradas.length, 0);
});

test('ESTAR ADELANTADO NO ES DEFICIT: las etapas propias no ensucian a nadie', () => {
  const r = deficit({
    rama: 'origin/mia',
    porRef: { 'origin/mia': new Set(['a', 'propia1', 'propia2']), 'origin/otra': new Set(['a']) },
  });
  assert.deepEqual(r.sinDeclarar, []);
});

test('declarada con fecha sale de sinDeclarar y lleva su antiguedad en dias', () => {
  const r = deficit({
    rama: 'origin/mia',
    porRef: { 'origin/mia': new Set(['a']), 'origin/otra': new Set(['a', 'gate:pisos']) },
    decls: { mia: { 'gate:pisos': { motivo: 'vigila el harness, no aplica aqui', desde: '2026-08-01' } } },
    hoy: new Date('2026-08-31'),
  });
  assert.deepEqual(r.sinDeclarar, []);
  assert.equal(r.declaradas[0].etapa, 'gate:pisos');
  assert.equal(r.declaradas[0].dias, 30);
});

test('una ref ilegible da null — el llamador NO puede leerlo como «sin diferencias»', () => {
  assert.equal(etapasDeRef('refs/no/existe/jamas'), null);
});

test('una ref ilegible no cuenta como rama sin etapas: se excluye de la comparacion', () => {
  const r = deficit({
    rama: 'origin/mia',
    porRef: { 'origin/mia': new Set(['a']), 'origin/rota': null, 'origin/otra': new Set(['a', 'b']) },
  });
  assert.deepEqual(r.sinDeclarar, [{ etapa: 'b', ref: 'origin/otra' }]);
});
