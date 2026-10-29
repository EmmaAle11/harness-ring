import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * NOMBRAR UNA REF POR CADENA Y TRAGARSE EL ERROR ES MENTIR EN SILENCIO.
 *
 * `git log origin/rama-que-no-existe -- ruta/ 2>/dev/null` sale VACIO, byte a
 * byte igual que `git log origin/rama-viva -- ruta/` cuando no hay commits ahi.
 * Quien llama recibe la misma cadena en los dos casos y no puede distinguir
 * «no hay nada» de «no puedo ver la rama».
 *
 * MEDIDO el 2026-08-26: `scripts/h006-preflight.sh` existe para avisar de si
 * `second` esta tocando `src/app/clientPortal/` antes de que el anillo mueva
 * nada ahi. Al renombrarse su rama, el detector paso a imprimir «ninguno» y
 * «0» TENIENDO 56 COMMITS SUYOS DELANTE en ese mismo subarbol. No fallo: mintio.
 * Y mintio en la direccion peligrosa -- «no hay colision» -- que es la que deja
 * pasar. La rama se renombro esa misma tarde: el defecto no era hipotetico, se
 * materializo mientras se escribia este fichero.
 *
 * La regla, de `third`: un detector que no puede ver la rama tiene que anunciar
 * que esta CIEGO. Lo que no puede es informar «no hay colision».
 *
 * Por eso el barrido es POR CLASE y no por nombre. Buscar el nombre viejo
 * encuentra la instancia de hoy y se pierde la de la proxima vez que alguien
 * renombre, clone sin fetch, o trabaje en una rama que aun no esta en origin.
 * La causa no es el nombre desactualizado: es la forma.
 */
const CONSULTA_REF = /\bgit\s+(log|rev-list|merge-base|diff|show|cherry)\b[^\n]*\borigin\/[A-Za-z0-9._\/-]+/;
const TRAGA_STDERR = /2>\s*(\/dev\/null|&1)/;
const esComentario = (l) => /^\s*(#|\/\/|\*|\/\*)/.test(l);

/** Lineas que consultan una ref literal Y se comen el error. Devuelve [nLinea]. */
export const refsQueMienten = (src) =>
  src.split('\n').flatMap((l, i) =>
    !esComentario(l) && CONSULTA_REF.test(l) && TRAGA_STDERR.test(l) ? [i + 1] : []);

test('el barrido caza una consulta a ref literal que se traga el error', () => {
  // Las muestras se ARMAN, no se escriben literales: escritas, el barrido del
  // test de abajo leeria ESTE fichero y se cazaria a si mismo. Ya paso con el
  // guard de ENV_LIMPIO en `stages.test.mjs`, dos veces.
  const consulta = (sub) => `ult=$(git ${sub} origin/una-rama -- src/ ${'2>'}/dev/null)`;
  const limpia = (sub) => `ult=$(git ${sub} origin/una-rama -- src/)`;

  for (const sub of ['log -1', 'rev-list --count', 'diff --stat']) {
    assert.deepEqual(refsQueMienten(consulta(sub)), [1], `no cazo: ${sub}`);
    assert.deepEqual(refsQueMienten(limpia(sub)), [], `falso positivo: ${sub}`);
  }

  // Un comentario que DESCRIBE el defecto no es el defecto. Sin esta linea, la
  // explicacion de la cabecera de h006-preflight.sh se contaria como instancia.
  assert.deepEqual(refsQueMienten(`# ${consulta('log -1')}`), []);
});


