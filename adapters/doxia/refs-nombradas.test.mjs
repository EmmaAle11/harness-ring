import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../../lib/capabilities.mjs';
import { ENV_LIMPIO } from '../../lib/sandbox.mjs';

// El barrido sobre los scripts/ y harness/ del anfitrion no puede correr en un motor
// portable (no trae ese arbol). Vive en el adaptador DoxIA con guarda de entorno.
const CONSULTA_REF = /\bgit\s+(log|rev-list|merge-base|diff|show|cherry)\b[^\n]*\borigin\/[A-Za-z0-9._\/-]+/;
const TRAGA_STDERR = /2>\s*(\/dev\/null|&1)/;
const esComentario = (l) => /^\s*(#|\/\/|\*|\/\*)/.test(l);

const refsQueMienten = (src) =>
  src.split('\n').flatMap((l, i) =>
    !esComentario(l) && CONSULTA_REF.test(l) && TRAGA_STDERR.test(l) ? [i + 1] : []);

test('ningun script del repo consulta una ref literal tragandose el error', (t) => {
  if (!existsSync(join(ROOT, 'scripts', 'gate.sh'))) { t.skip('sin scripts/gate.sh: este arbol no es el anfitrion DoxIA'); return; }
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
