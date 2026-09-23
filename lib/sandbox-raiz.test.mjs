// ── La raiz del sandbox se inyecta, SIN abrir los guardarrailes ──────────────
//
// H2, tercer consumidor. `sandbox.mjs` es el cuello del grafo (lo importan nueve
// modulos) y el mas peligroso: dos de sus cuatro usos de ROOT son los
// GUARDARRAILES DE BORRADO -- las lineas que deciden que NO se puede destruir.
// El incidente que motivo esas lineas borro 1181 ficheros.
//
// ATRIBUCION VERIFICADA ANTES DE TOCAR NADA: forzando la raiz al arbol de DoxIA
// en una copia, los 7 rojos de sandbox.test.mjs pasan a 0. Son deuda real de
// ROOT, no del adaptador -- a diferencia de los 2 de index-repo, que persistian
// porque exigian el CONTENIDO del arbol.
//
// LO QUE ESTE FICHERO VIGILA no es que la inyeccion funcione --eso lo dicen los
// 23 tests propios de sandbox-- sino que AL HACERLA NO SE HAYA ABIERTO UN
// AGUJERO: inyectar una raiz no puede convertirse en una forma de saltarse el
// limite de borrado. Un `remove` que acepta cualquier raiz es exactamente el
// fallo de 1181 ficheros con una firma nueva.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { assertDestructible, assertOutsideMainTree, raizSandbox } from './sandbox.mjs';
import { ROOT, RUNTIME } from './capabilities.mjs';

// `WORKSPACES` es PRIVADO de sandbox.mjs y debe seguir siendolo: exportarlo solo
// para este test convertiria un detalle interno en superficie publica. Se deriva
// igual que alli (`resolve(RUNTIME, 'workspaces')`), y si esa derivacion cambiara
// los casos de abajo fallarian -- que es exactamente lo que se quiere.

test('raizSandbox es defensiva: lo que no es una raiz usable cae al defecto', () => {
  // `.map(fn)` pasa el INDICE como segundo argumento -- ya metio un indice como
  // taxonomia en un refactor de este repo. Y una raiz vacia compondria una ruta
  // RELATIVA contra el cwd del proceso, que dentro de un hook es otro.
  for (const basura of [undefined, null, 0, 1, '', '   ', [], {}, { raiz: '' }, { raiz: 42 }]) {
    assert.equal(raizSandbox(basura), ROOT,
      `raizSandbox(${JSON.stringify(basura)}) tenia que caer al ROOT deducido`);
  }
  assert.equal(raizSandbox('/tmp/otro'), '/tmp/otro');
  assert.equal(raizSandbox({ raiz: '/tmp/otro' }), '/tmp/otro');
});

test('EL AGUJERO QUE NO SE ABRE: la raiz inyectada no autoriza a borrar nada de fuera', () => {
  // PRIMERA VERSION DE ESTE TEST: pasaba, y NO MEDIA NADA. Comprobaba que
  // `assertDestructible(ROOT, {raiz: otra})` lanza -- y lanza SIEMPRE, porque la
  // PRIMERA guarda exige estar dentro de WORKSPACES y ROOT nunca lo esta. La
  // asercion moria en la linea 61 sin llegar a la 64, que es la que usa la raiz.
  // Se descubrio MUTANDO: con `if (false)` en el guardarrail de la raiz, el test
  // seguia verde. Un test de seguridad que sobrevive a su propia mutacion no
  // vigila el limite: vigila otro.
  //
  // Lo que si discrimina: una ruta que YA pasa la guarda de workspaces, para que
  // la decision recaiga de verdad sobre la raiz.
  const WORKSPACES = resolve(RUNTIME, 'workspaces');
  const comoWorkspace = join(WORKSPACES, 'H-20260101-deadbeef');

  // Con la raiz apuntando a ese mismo sitio, deja de ser un workspace borrable y
  // pasa a ser «una raiz»: es la linea 64 la que decide.
  assert.throws(() => assertDestructible(comoWorkspace, { raiz: comoWorkspace }),
    /es una raiz, no un workspace/,
    'la raiz inyectada tiene que protegerse: si no, inyectar una raiz es una forma de borrarla');

  // Y con otra raiz cualquiera, el mismo path sigue siendo un workspace normal.
  assert.equal(assertDestructible(comoWorkspace, { raiz: '/tmp/otra-raiz' }), comoWorkspace,
    'con una raiz ajena, un workspace de verdad tiene que seguir siendo destruible');
});

test('ninguna raiz inyectada hace destruible algo de FUERA de workspaces', () => {
  // La primera guarda no depende de la raiz, y eso es deliberado: es el limite
  // que no se puede abrir por configuracion.
  for (const raiz of ['/tmp', '/', ROOT, '/tmp/inventada']) {
    assert.throws(() => assertDestructible('/etc/passwd', { raiz }), /esta fuera de/);
    assert.throws(() => assertDestructible(join(ROOT, 'src'), { raiz }), /esta fuera de/);
  }
});

test('el limite de src/ se evalua contra la raiz que se da', () => {
  // MUTACION QUE ESTE TEST TIENE QUE CAZAR: volver a `resolve(ROOT, 'src')` en
  // assertOutsideMainTree. Para que la raiz decida, el workspace debe caer bajo
  // WORKSPACES (si no, salta la otra guarda) y a la vez bajo `<raiz>/src`.
  const WORKSPACES = resolve(RUNTIME, 'workspaces');
  const raizFalsa = WORKSPACES;                      // asi `<raiz>/src` esta DENTRO de workspaces
  const ws = { path: join(WORKSPACES, 'src', 'H-20260101-cafe') };
  assert.throws(() => assertOutsideMainTree(ws, { raiz: raizFalsa }),
    /dentro del codigo de produccion/,
    'con la raiz inyectada, <raiz>/src tiene que ser intocable');

  // Con la raiz deducida, ese mismo path es un workspace legitimo.
  assert.equal(assertOutsideMainTree(ws), true,
    'sin raiz inyectada el limite es el de DoxIA, y ahi ese path no es codigo');
});

test('sin opciones se comporta EXACTAMENTE como antes: la migracion no rompe a quien no pasa nada', () => {
  assert.throws(() => assertDestructible(ROOT), /raiz|repositorio|workspace/i);
  assert.throws(() => assertDestructible(resolve(ROOT, 'src')), /src|codigo|vivo|workspace/i);
  assert.throws(() => assertDestructible('/'), /raiz|repositorio|workspace/i);
});
