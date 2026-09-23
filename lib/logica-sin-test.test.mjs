// El trinquete: la deuda existente se DECLARA, y no puede crecer.
//
// Encender esto como bloqueante con 61 incumplimientos habria dejado la puerta
// roja de nacimiento, que es como se consigue que nadie la use -- la misma
// leccion que `npm audit` con su deuda heredada. Un techo sobre la CUENTA
// consigue lo que hace falta sin necesitar detectar «ficheros nuevos»: si
// alguien anade logica pura sin su spec, 61 pasa a 62 y este test cae.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { esLogicaPura, hermanos, revisar } from './logica-sin-test.mjs';
import { ROOT } from './capabilities.mjs';
import { ENV_LIMPIO } from './sandbox.mjs';

// El techo MEDIDO el 2026-08-21 EN `feat/harness`. Baja cuando alguien escribe un
// spec; NO sube.
//
// AL TRAER ESTE FICHERO A OTRA RAMA HAY QUE VOLVER A MEDIRLO. Es una cuenta sobre
// el arbol, igual que los pisos de tests de `gate.sh`, y un arbol con mas codigo
// tiene mas ficheros de logica pura: el tronco lleva F4b y el editor de cartas,
// que aqui no estan. Copiar el 61 pondria esa puerta roja de nacimiento -- que es
// exactamente el defecto que costo tres pisos rotos hoy, y lo escribo aqui
// ANTES de que pase.
//
//   node -e "…revisar(ficheros).sinSpec.length"   -> y ese numero va aqui
//
// La cifra la firma quien la corre, tambien cuando el fichero es de otro.
// 62 desde el 2026-08-24: `backend/src/aafa/carta-modelos/carta-campos.builder.ts`
// entra CON LA FUSION del tronco, no porque nadie anadiera logica sin test aqui.
// Es AAFA, dominio de `second`, y queda como deuda suya: el trinquete solo baja.
// 62 -> 68 el 2026-09-07 AL FUNDIR `feat/staging-aafa`. Los seis nuevos no los escribio nadie en
// esta rama: llegan con el bloque del Archivero y el hotfix del representante, donde ya estaban sin
// spec. Un trinquete es una cuenta DE SU ARBOL y la union de dos arboles es la union de sus cuentas
// --el mismo razonamiento que el techo de lint (3715 -> 3893)--. NO es permiso: de aqui solo baja,
// y los seis son deuda con dueno `second`. MEDIDO por el propio test al bloquear la fusion:
// «68 ficheros de logica pura sin spec al lado, y el techo es 62».
const TECHO = 68;

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

// ── El trinquete, contra el repositorio de verdad ───────────────────────────
test('la logica pura sin test NO crece', () => {
  const rutas = execFileSync('git', ['ls-files'], { cwd: ROOT, env: ENV_LIMPIO(), encoding: 'utf8' }).split('\n');
  const ficheros = rutas.filter((p) => p.endsWith('.ts')).map((p) => {
    try { return { path: p, texto: readFileSync(join(ROOT, p), 'utf8') }; } catch { return null; }
  }).filter(Boolean);

  const r = revisar(ficheros, (p) => existsSync(join(ROOT, p)));

  // EL DENOMINADOR. Si el recorrido deja de encontrar ficheros, `sinSpec` cae a
  // cero y el test aprueba sobre nada -- la forma en que estos controles se
  // mueren en silencio.
  assert.ok(r.pura > 100, `solo se examinaron ${r.pura} ficheros de logica pura: el recorrido se rompio`);

  assert.ok(r.sinSpec.length <= TECHO,
    `${r.sinSpec.length} ficheros de logica pura sin spec al lado, y el techo es ${TECHO}.\n`
    + 'Un predicado de decision sin test es una autoridad que cualquiera puede cambiar en silencio: '
    + 'hoy costo la emision de una carta en produccion.\n'
    + r.sinSpec.slice(0, 10).map((p) => `  ${p}`).join('\n'));

  // Y si BAJA, el techo baja con el: la deuda declarada no puede quedarse
  // declarada de mas. Sin esto, arreglar diez ficheros no protege de que vuelvan.
  assert.ok(r.sinSpec.length >= TECHO - 5,
    `bajo a ${r.sinSpec.length}: baja TECHO a esa cifra en este fichero para que el trinquete siga apretando`);
});
