import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

// El generador de manifest es del anfitrion (scripts/generate-version-manifest.mjs),
// no viaja con el motor. Se comprueba aqui, en el adaptador DoxIA, y se declara
// skip cuando el arbol anfitrion no esta.
const MANIFIESTO = new URL('../../../scripts/generate-version-manifest.mjs', import.meta.url);

test('la lista coincide con lo que el generador declara escribir', (t) => {
  if (!existsSync(MANIFIESTO)) {
    t.skip('sin scripts/generate-version-manifest.mjs: este arbol no es el anfitrion DoxIA');
    return;
  }
  // Si manana el script escribe un tercero, este test cae y la lista se
  // actualiza A PROPOSITO -- no por sorpresa a mitad de una vuelta.
  const src = readFileSync(MANIFIESTO, 'utf8');
  assert.ok(src.includes('public/version.json'));
  assert.ok(src.includes('current-version.ts'));
});
