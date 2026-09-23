import { test } from 'node:test';
import assert from 'node:assert/strict';
import { revisar } from './sbom-cubre-los-arboles.mjs';

const sbom = (...nombres) => ({ components: nombres.map((name) => ({ name })) });
const FE = sbom('react', 'vite');
const BE = sbom('@nestjs/core', 'pdfjs-dist', '@napi-rs/canvas');

test('con los dos arboles inventariados, no hay fallos', () => {
  assert.deepEqual(revisar(FE, BE), []);
});

test('el defecto real: el SBOM del backend es en realidad el de la raiz', () => {
  // Lo que hacia la puerta hasta el 2026-09-02: `npm sbom` UNA vez desde la raiz. El artefacto
  // existia, el comando salia 0, y no contenia una sola linea del arbol que se despliega.
  const fallos = revisar(FE, FE);
  assert.match(fallos.join('\n'), /pdfjs-dist/);
  assert.match(fallos.join('\n'), /MISMO contenido/);
});

test('falta UN testigo: el arbol se inventario a medias', () => {
  const fallos = revisar(FE, sbom('@nestjs/core', 'pdfjs-dist'));
  assert.equal(fallos.length, 1);
  assert.match(fallos[0], /@napi-rs\/canvas/);
});

test('un SBOM vacio no pasa por tener la forma correcta', () => {
  assert.match(revisar(sbom(), BE).join('\n'), /la raiz no trae componentes/);
  assert.match(revisar(FE, { components: [] }).join('\n'), /el backend no trae componentes/);
});

test('un JSON ilegible (null) se trata como vacio, no como valido', () => {
  // `leer()` devuelve null si el fichero no parsea. Sin esta rama, un SBOM corrupto pasaria por
  // «sin componentes que comprobar» -- que es la clase del instrumento que confunde error con vacio.
  assert.ok(revisar(null, null).length >= 2);
});
