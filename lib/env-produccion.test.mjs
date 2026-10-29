// La comprobacion que habria evitado dejar el frontend en blanco.
//
// El build TERMINA CON EXITO sin `.env.production`. Se comprobo que el bundle
// subio, que el buildId era correcto, que index.html daba 200 y que las cadenas
// esperadas estaban dentro -- cuatro comprobaciones ciertas, ninguna medía si la
// aplicacion ARRANCA. `adminPath.ts` lanza al importarse cuando falta su
// variable, asi que el bundle muere antes de pintar nada.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sinComentarios, exigidas, faltantes } from './env-produccion.mjs';


test('una variable citada en un COMENTARIO no se consume', () => {
  // Y el caso que lo descubrio: CRLF. En JavaScript `.` no casa `\r` --es
  // terminador de linea--, asi que `//.*$` no casa NADA en un fichero con
  // finales de Windows y el limpiador se quedaba mudo. `VITE_TURNSTILE_SITE_KEY`
  // aparece UNA vez en todo src/, dentro de un comentario, y salia como
  // obligatoria. Un falso positivo en una puerta de despliegue es la forma mas
  // rapida de que alguien la desactive.
  assert.deepEqual(exigidas([{ path: 'a.ts', texto: '// usa VITE_ALGO cuando toque\r\nexport const x = 1;\r\n' }]), []);
  assert.deepEqual(exigidas([{ path: 'a.ts', texto: '/* VITE_OTRA se documenta aqui */\nconst y = 2;' }]), []);
  assert.ok(!sinComentarios('// VITE_X\r\ncodigo').includes('VITE_X'), 'CRLF: el comentario tiene que desaparecer');
});

test('con valor por defecto NO es obligatoria: degrada sola', () => {
  assert.deepEqual(exigidas([{ path: 'a.ts', texto: "const u = import.meta.env.VITE_API_URL || 'http://localhost:3000';" }]), []);
  assert.deepEqual(exigidas([{ path: 'a.ts', texto: "const u = import.meta.env.VITE_API_URL ?? 'x';" }]), []);
});

test('sin valor por defecto SI es obligatoria, la lea como la lea', () => {
  // Las dos formas que existen en este repo. La segunda --`_ENV.VITE_X`-- es la
  // de `adminPath.ts`, y es la que se me escapo la primera vez que lo medi: conte
  // 4 variables y eran 6.
  assert.deepEqual(exigidas([{ path: 'a.ts', texto: 'const p = import.meta.env.VITE_ADMIN;' }]), ['VITE_ADMIN']);
  assert.deepEqual(exigidas([{ path: 'a.ts', texto: 'const p = (_ENV.VITE_ADMIN as string | undefined)?.trim();' }]), ['VITE_ADMIN']);
});

test('un valor VACIO cuenta como ausente: `X=` no esta configurado', () => {
  assert.deepEqual(faltantes(['VITE_A', 'VITE_B'], 'VITE_A=algo\nVITE_B='), ['VITE_B']);
  assert.deepEqual(faltantes(['VITE_A'], '# VITE_A=comentada'), ['VITE_A'], 'una linea comentada no define nada');
});

