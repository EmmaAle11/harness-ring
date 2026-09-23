/**
 * El caso es REAL y esta pineado: H-20260917-75135851 y -c53885df (h-008 v2,
 * vueltas 1 y 3) agotaron las 90 iteraciones contra 18 fallos que ya estaban en
 * el arbol. Medido con `npx vitest run` sobre HEAD limpio: mismos 18.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { avisoDeRojoPrevio } from './stages-model.mjs';

const ctxCon = (files) => ({ manifest: { task: { files } } });

test('nombra las rutas de test que la spec declara', () => {
  const a = avisoDeRojoPrevio(ctxCon([
    'src/app/clientPortal/components/ExpedienteScreen.tsx',
    'src/app/clientPortal/lib/expediente-campos.ts',
    'src/app/clientPortal/lib/expediente-campos.test.ts',
  ]));
  assert.match(a, /expediente-campos\.test\.ts/, 'no le dice QUE ruta pasar');
  assert.ok(!a.includes('ExpedienteScreen.tsx'), 'el .tsx no es un fichero de test');
  assert.ok(!a.includes('expediente-campos.ts`'), 'el modulo tampoco');
});

test('reconoce .spec y .test, ts y tsx', () => {
  const a = avisoDeRojoPrevio(ctxCon(['a.spec.ts', 'b.test.tsx', 'c.spec.js', 'd.ts']));
  for (const f of ['a.spec.ts', 'b.test.tsx', 'c.spec.js']) assert.ok(a.includes(f), f);
  assert.ok(!a.includes('d.ts`'), 'un .ts normal no es un test');
});

test('el aviso SIGUE SALIENDO sin ficheros de test: el rojo previo no depende de la spec', () => {
  // Una tarea sin tests declarados igual corre `run_test` y ve los 18 fallos.
  const a = avisoDeRojoPrevio(ctxCon(['src/x.ts']));
  assert.match(a, /PREEXISTENTES/);
  assert.match(a, /SIN ruta corre la suite ENTERA/);
});

test('sin manifiesto no revienta', () => {
  for (const c of [null, undefined, {}, { manifest: {} }, { manifest: { task: {} } }]) {
    assert.ok(avisoDeRojoPrevio(c).length > 0);
  }
});

test('dice las DOS cosas: pasa la ruta, y no arregles lo ajeno', () => {
  const a = avisoDeRojoPrevio(ctxCon(['x.test.ts']));
  assert.match(a, /Pasa siempre la ruta/i, 'como preguntar solo por lo suyo');
  assert.match(a, /NO los arregles/, 'que hacer con el rojo que no es suyo');
  assert.match(a, /Anota/, 'y que lo reporte en vez de callarlo');
});

test('no tiene escapes literales: el prompt se lee, no se imprime crudo', () => {
  // El patch anterior dejo `\\n` en el fuente y el modelo habria visto la barra.
  const a = avisoDeRojoPrevio(ctxCon(['x.test.ts']));
  assert.ok(!a.includes('\\n'), 'hay un \\n literal en el texto del aviso');
  assert.ok(a.includes('\n'), 'el aviso no tiene saltos de linea reales');
});

test('CABLEADO: el prompt del builder lo incluye', async () => {
  const src = await import('node:fs').then((fs) => fs.readFileSync(
    new URL('./stages-model.mjs', import.meta.url), 'utf8',
  ));
  const llamadas = [...src.matchAll(/^\s+avisoDeRojoPrevio\(ctx\),/gm)].length;
  assert.equal(llamadas, 1, 'el aviso existe pero no se invoca en el prompt');
  assert.ok(
    src.indexOf('avisoDeRojoPrevio(ctx)') > src.indexOf('avisoDeSemillas(ctx)'),
    'va junto a los otros avisos del builder',
  );
});
