/**
 * Los CTQ son una DECLARACION MEDIDA, y estos tests la mantienen honesta: cada
 * umbral tiene que traer el comando que lo produjo, y ninguno puede prometer lo
 * que el numero de muestras no sostiene.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const RAIZ = new URL('../../', import.meta.url).pathname;
const CTQ = JSON.parse(readFileSync(`${RAIZ}harness/policy/ctq.json`, 'utf8'));

test('todo CTQ trae el mecanismo que lo mide', () => {
  // Un umbral sin comando es una opinion con formato de dato.
  for (const c of CTQ.ctq) {
    assert.ok(c.mecanismo?.length > 5, `${c.id} no dice como se mide`);
    assert.ok(Number.isFinite(c.medido), `${c.id} no trae cifra medida`);
  }
});

test('todo CTQ declara piso o techo, no los dos', () => {
  // «mas es mejor» y «menos es mejor» son direcciones opuestas: mezclarlas deja
  // un control que no sabe hacia donde mirar.
  for (const c of CTQ.ctq) {
    const tiene = ['piso', 'techo'].filter((k) => Number.isFinite(c[k]));
    assert.ok(tiene.length <= 1, `${c.id} declara piso Y techo`);
  }
});

test('la cifra medida cumple su propio umbral', () => {
  for (const c of CTQ.ctq) {
    if (Number.isFinite(c.piso)) assert.ok(c.medido >= c.piso, `${c.id}: medido ${c.medido} < piso ${c.piso}`);
    if (Number.isFinite(c.techo)) assert.ok(c.medido <= c.techo, `${c.id}: medido ${c.medido} > techo ${c.techo}`);
  }
});

test('NO se promete disponibilidad: n=34 no sostiene ni dos nueves', () => {
  const t = JSON.stringify(CTQ);
  assert.ok(!/99[.,]9/.test(t), 'aparece una cifra de nueves que las muestras no sostienen');
  assert.match(CTQ.$comment.join(' '), /CINCO NUEVES/i, 'debe explicar POR QUE no se declara');
  assert.ok(CTQ.$noMedido.some((x) => /Disponibilidad/i.test(x)), 'la disponibilidad va en $noMedido');
});

test('lo no medido se declara, no se omite', () => {
  // Omitir lo que no se sabe deja leer el fichero como si lo cubriera todo.
  assert.ok(CTQ.$noMedido.length >= 4);
  for (const x of CTQ.$noMedido) assert.ok(x.length > 20, `entrada demasiado vaga: ${x}`);
});

test('el CTQ del FE refleja el cierre de los 18 rojos', () => {
  const fe = CTQ.ctq.find((c) => c.id === 'fe:suite');
  assert.equal(fe.medido, 1, 'quedaba 1 fallo verificado preexistente');
  assert.match(fe.$nota, /Expedientes\.grupo\.test\.tsx/, 'el que queda se nombra');
});

test('la perdida de la tercera familia esta declarada, no escondida', () => {
  const p = CTQ.ctq.find((c) => c.id === 'proveedores:familias');
  assert.equal(p.medido, 2);
  assert.match(p.$nota, /DEGRADED/, 'debe decir que independence se degrada');
});
