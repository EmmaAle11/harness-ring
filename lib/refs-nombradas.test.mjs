import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT } from './capabilities.mjs';
import { ENV_LIMPIO } from './sandbox.mjs';

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

test('ningun script del repo consulta una ref literal tragandose el error', () => {
  // EL BARRIDO TAMBIEN TIENE QUE ANUNCIAR SU CEGUERA, y este test es el sitio
  // donde no hacerlo seria una burla: `git ls-files` LANZA si ROOT no es un
  // arbol de git, y una excepcion aqui se lee como «el test falla», no como «el
  // test no pudo mirar». MEDIDO: `third`, auditandome, extrajo mi rama con
  // `git archive` a /tmp --que no es un repo-- y le salio ROJO. Estuvo a un
  // mensaje de reportarme un fallo que no existia; lo que lo paro fue leer el
  // error, no el test. La misma confusion que el test persigue, dentro del test.
  let rutas;
  try {
    rutas = execFileSync('git', ['ls-files'], { cwd: ROOT, env: ENV_LIMPIO(), encoding: 'utf8' })
      .split('\n')
      .filter((p) => /^(scripts\/|harness\/).*\.(sh|mjs)$/.test(p));
  } catch (e) {
    assert.fail(`BARRIDO CIEGO: no se pudo enumerar lo versionado desde '${ROOT}' (${e.message}).`
      + ` Esto NO es «no hay ficheros sucios»: es que no se pudo mirar.`
      + ` Corre el barrido dentro del arbol de git, no sobre una copia extraida.`);
  }

  assert.ok(rutas.length > 5,
    `BARRIDO VACIO: ${rutas.length} ficheros. El arbol tiene scripts/ y harness/;`
    + ` cero coincidencias significa que el barrido no esta mirando donde cree.`);

  const sucios = rutas.flatMap((p) => {
    let src; try { src = readFileSync(join(ROOT, p), 'utf8'); } catch { return []; }
    return refsQueMienten(src).map((n) => `${p}:${n}`);
  });

  assert.deepEqual(sucios, [],
    `consultan una ref literal y se comen el error: no distinguen «no hay nada» de «esa ref no existe».\n`
    + `Comprueba la ref antes (git rev-parse --verify --quiet) y anuncia la ceguera:\n  ${sucios.join('\n  ')}`);
});
