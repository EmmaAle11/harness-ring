/**
 * H-20260917-fef6f11b murio con ROLLBACK en Execution por `public/version.json`.
 * No lo escribio el builder: lo REGENERA vite cada vez que corre `run_test` o
 * `run_typecheck` (vite.config.ts:56 -> scripts/generate-version-manifest.mjs).
 *
 * La frontera es correcta y se queda. Lo que se corrige es a QUIEN se le imputa
 * una escritura que hicieron sus propias herramientas.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { esArtefactoDeBuild, sinArtefactosDeBuild, ARTEFACTOS_DE_BUILD } from './artefactos-de-build.mjs';

test('los dos ficheros que vite regenera estan declarados', () => {
  assert.ok(esArtefactoDeBuild('public/version.json'));
  assert.ok(esArtefactoDeBuild('src/generated/current-version.ts'));
});

test('NO es una barra libre: solo esas dos rutas', () => {
  assert.ok(!esArtefactoDeBuild('src/app/clientPortal/components/ExpedienteScreen.tsx'));
  assert.ok(!esArtefactoDeBuild('public/index.html'), 'public/ entero NO se exime');
  assert.ok(!esArtefactoDeBuild('src/generated/otra-cosa.ts'), 'src/generated/ entero tampoco');
  assert.equal(ARTEFACTOS_DE_BUILD.length, 2, 'la lista crece solo con una decision explicita');
});

test('filtra la lista del ChangeSet conservando el orden', () => {
  const dado = ['src/a.ts', 'public/version.json', 'src/b.ts', 'src/generated/current-version.ts'];
  assert.deepEqual(sinArtefactosDeBuild(dado), ['src/a.ts', 'src/b.ts']);
});

test('una lista sin artefactos no se toca', () => {
  const dado = ['src/a.ts', 'src/b.ts'];
  assert.deepEqual(sinArtefactosDeBuild(dado), dado);
});

test('entradas vacias o nulas no revientan', () => {
  for (const x of [null, undefined, []]) assert.deepEqual(sinArtefactosDeBuild(x), []);
  for (const x of [null, undefined, '']) assert.equal(esArtefactoDeBuild(x), false);
});

test('normaliza ./ y barras de Windows: la misma ruta es la misma ruta', () => {
  assert.ok(esArtefactoDeBuild('./public/version.json'));
  assert.ok(esArtefactoDeBuild('public\\version.json'));
});

test('la lista coincide con lo que el generador declara escribir', async () => {
  // Si manana el script escribe un tercero, este test cae y la lista se
  // actualiza A PROPOSITO -- no por sorpresa a mitad de una vuelta.
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../../scripts/generate-version-manifest.mjs', import.meta.url), 'utf8');
  assert.ok(src.includes('public/version.json'));
  assert.ok(src.includes('current-version.ts'));
});

test('CABLEADO: Execution descuenta los artefactos ANTES de juzgar la frontera', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./stages-model.mjs', import.meta.url), 'utf8');
  // Se comprueba la CONDUCTA, no la forma literal: que la lista que llega a la
  // frontera venga del filtro. Atarlo a `sinArtefactosDeBuild(cambiados)` textual
  // hacia que el test cayera al centralizar el filtro en una sola variable, que
  // es justo la mejora que pedia la auditoria.
  assert.match(
    src, /assertWithinBoundary\(builderCap, propios\)/,
    'la exencion existe pero Execution no la usa',
  );
  assert.match(
    src, /const propios = sinArtefactosDeBuild\(sandbox\.changedFiles\(ws\)\)/,
    '`propios` tiene que venir del filtro, no de git en crudo',
  );
});

test('authorize NO se exime: pedir el artefacto a mano sigue siendo violacion', async () => {
  // La exencion cubre el EFECTO COLATERAL de las tools, no la intencion. Si el
  // builder pide escribir public/version.json, eso se rechaza.
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./tools.mjs', import.meta.url), 'utf8');
  assert.ok(
    !src.includes('sinArtefactosDeBuild'),
    'tools.mjs no debe eximir: ahi el builder pide la escritura explicitamente',
  );
});
