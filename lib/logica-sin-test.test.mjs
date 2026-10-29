// El trinquete: la deuda existente se DECLARA, y no puede crecer.
//
// Encender esto como bloqueante con 61 incumplimientos habria dejado la puerta
// roja de nacimiento, que es como se consigue que nadie la use -- la misma
// leccion que `npm audit` con su deuda heredada. Un techo sobre la CUENTA
// consigue lo que hace falta sin necesitar detectar «ficheros nuevos»: si
// alguien anade logica pura sin su spec, 61 pasa a 62 y este test cae.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { esLogicaPura, hermanos, revisar } from './logica-sin-test.mjs';


test('un .ts que exporta funciones y no arrastra marco es logica pura', () => {
  assert.equal(esLogicaPura({ path: 'src/lib/fechas.ts', texto: 'export function f() {}' }), true);
  assert.equal(esLogicaPura({ path: 'src/lib/fechas.spec.ts', texto: 'export function f() {}' }), false,
    'un spec no se exige a si mismo');
  assert.equal(esLogicaPura({ path: 'backend/src/aafa/aafa.service.ts', texto: 'export function f() {}' }), false,
    'un .service.ts es marco: se prueba por su comportamiento, no como funcion pura');
  assert.equal(esLogicaPura({ path: 'src/app/x/Pantalla.tsx', texto: 'export function f() {}' }), false,
    'un componente se prueba de otra forma');
  assert.equal(esLogicaPura({ path: 'src/lib/x.ts', texto: "import React from 'react';\nexport const f = () => 1;" }), false);
  assert.equal(esLogicaPura({ path: 'src/lib/x.ts', texto: '@Injectable()\nexport class S {}' }), false);
  assert.equal(esLogicaPura({ path: 'src/lib/tipos.ts', texto: 'type A = 1;' }), false,
    'un fichero que no exporta funciones no decide nada');
});

test('el spec hermano se busca en las cuatro formas que usa el repo', () => {
  assert.deepEqual(hermanos('src/lib/a.ts'),
    ['src/lib/a.spec.ts', 'src/lib/a.spec.tsx', 'src/lib/a.test.ts', 'src/lib/a.test.tsx']);
});

test('revisar cuenta y NOMBRA lo que falta, no solo cuanto falta', () => {
  const r = revisar(
    [{ path: 'src/lib/a.ts', texto: 'export function a() {}' },
     { path: 'src/lib/b.ts', texto: 'export function b() {}' }],
    (p) => p === 'src/lib/a.spec.ts',
  );
  assert.equal(r.pura, 2);
  assert.equal(r.conSpec, 1);
  assert.deepEqual(r.sinSpec, ['src/lib/b.ts'], 'una cifra sin la lista no se puede arreglar');
});

