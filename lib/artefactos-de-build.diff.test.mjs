/**
 * EL REVISOR NO LEE LA LISTA, LEE EL DIFF.
 *
 * Filtrar la lista de ficheros cerro los cinco puntos que deciden veredictos,
 * pero dejo pasar el sexto: `sandbox.diff(ws)` seguia trayendo los bloques de
 * los dos artefactos que regenera vite. MEDIDO en H-20260918-9a093b28: 2 de 5
 * bloques, 1.523 de 15.321 caracteres, que el revisor recibia como trabajo del
 * builder.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffSinArtefactosDeBuild } from './artefactos-de-build.mjs';

// Forma real de un diff de git, con los dos artefactos en medio.
const DIFF = `diff --git a/src/app/Foo.tsx b/src/app/Foo.tsx
index 111..222 100644
--- a/src/app/Foo.tsx
+++ b/src/app/Foo.tsx
@@ -1,3 +1,4 @@
+const x = 1;
diff --git a/public/version.json b/public/version.json
index 333..444 100644
--- a/public/version.json
+++ b/public/version.json
@@ -1 +1 @@
-{"v":"a"}
+{"v":"b"}
diff --git a/src/generated/current-version.ts b/src/generated/current-version.ts
index 555..666 100644
--- a/src/generated/current-version.ts
+++ b/src/generated/current-version.ts
@@ -1 +1 @@
-export const V = 'a';
+export const V = 'b';
diff --git a/src/lib/bar.ts b/src/lib/bar.ts
index 777..888 100644
--- a/src/lib/bar.ts
+++ b/src/lib/bar.ts
@@ -1 +1,2 @@
+export const y = 2;
`;

test('quita los bloques de los artefactos y deja los del builder', () => {
  const r = diffSinArtefactosDeBuild(DIFF);
  assert.ok(!r.includes('public/version.json'), 'sobrevivio el bloque de version.json');
  assert.ok(!r.includes('current-version.ts'), 'sobrevivio el bloque de current-version.ts');
  assert.ok(r.includes('src/app/Foo.tsx'), 'se llevo por delante trabajo real del builder');
  assert.ok(r.includes('src/lib/bar.ts'), 'se llevo por delante el ultimo bloque');
});

test('no corta de mas: los bloques que deja quedan enteros', () => {
  const r = diffSinArtefactosDeBuild(DIFF);
  // El contenido del ultimo bloque tiene que llegar completo, no truncado por
  // el corte del bloque anterior.
  assert.match(r, /export const y = 2;/);
  assert.match(r, /const x = 1;/);
  assert.equal([...r.matchAll(/^diff --git /gm)].length, 2, 'deberian quedar exactamente 2 bloques');
});

test('un diff sin artefactos vuelve intacto', () => {
  const limpio = `diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n`;
  assert.equal(diffSinArtefactosDeBuild(limpio), limpio);
});

test('aguanta vacio, null y no-texto sin lanzar', () => {
  assert.equal(diffSinArtefactosDeBuild(''), '');
  assert.equal(diffSinArtefactosDeBuild(null), '');
  assert.equal(diffSinArtefactosDeBuild(undefined), '');
});

test('CABLEADO: Execution pasa el diff filtrado, no el crudo', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./stages-model.mjs', import.meta.url), 'utf8');
  const sinComentarios = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const crudas = [...sinComentarios.matchAll(/sandbox\.diff\(ws\)/g)].length;
  const envueltas = [...sinComentarios.matchAll(/diffSinArtefactosDeBuild\(sandbox\.diff\(ws\)\)/g)].length;
  assert.equal(crudas, envueltas, `${crudas - envueltas} llamada(s) a sandbox.diff sin filtrar`);
});
