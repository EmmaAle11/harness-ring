// ── La raiz de index-repo se puede inyectar ──────────────────────────────────
//
// H2: migrar los consumidores de ROOT al PuertoAnfitrion. `index-repo.mjs` es el
// segundo del orden topologico: es HOJA (fanin 0, no obliga a rehacer nada) y
// sus dos usos ya estaban PARAMETRIZADOS --`ficherosDeGit(root = ROOT)` e
// `indexar({ root = ROOT })`--, asi que lo unico que faltaba era que el VALOR POR
// DEFECTO se pudiera inyectar en vez de quedar clavado al ROOT deducido.
//
// EL CRITERIO DE EXITO NO ES QUE LA SUITE SIGA VERDE. Un cambio que conserva la
// conducta deja los tests igual de verdes con y sin el --lo dice
// `patterns/la-extraccion-que-conserva-la-conducta-se-fija-en-el-cableado.md`--,
// asi que lo que se afirma aqui es lo OTRO: que con una raiz distinta el modulo
// mira OTRO sitio. Eso si cambia de valor al revertir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { ENV_LIMPIO } from './sandbox.mjs';
import { ROOT } from './capabilities.mjs';

import { ficherosDeGit, raizDeIndice } from './index-repo.mjs';


// Un repositorio de verdad, con git, fuera del arbol de DoxIA.
const conRepo = (fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'idx-raiz-'));
  try {
    // ENV_LIMPIO() NO ES OPCIONAL, y un control del harness lo caza: dentro de un
    // hook, git exporta GIT_DIR/GIT_INDEX_FILE apuntando al repo que esta
    // commiteando, asi que estas tres ordenes operarian sobre el repo PRINCIPAL
    // en vez de sobre el temporal. Es el modo de fallo que borro 1181 ficheros.
    const git = (args) => execFileSync('git', args, { cwd: dir, env: ENV_LIMPIO(), stdio: 'ignore' });
    git(['init', '-q', '-b', 'main']);
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'solo-aqui.ts'), 'export const x = 1;\n');
    writeFileSync(join(dir, 'README.md'), '# ajeno\n');
    git(['add', '-A']);
    git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'i']);
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test('ficherosDeGit mira la raiz que se le da, no la deducida', () => {
  conRepo((dir) => {
    // `ficherosDeGit` devuelve {sha, path}, no cadenas. Mi primera version de
    // este test asumio la firma por el nombre en vez de leerla: el rojo decia
    // «la raiz inyectada no se uso» y la raiz SI se habia usado -- el listado
    // traia `src/solo-aqui.ts`, que solo existe en el temporal.
    const rutas = (r) => ficherosDeGit(r).map((f) => f.path);
    assert.ok(rutas(dir).includes('src/solo-aqui.ts'),
      `la raiz inyectada no se uso: ${JSON.stringify(rutas(dir).slice(0, 5))}`);
    // La prueba fuerte: ese fichero NO existe en DoxIA. Si el modulo hubiera
    // mirado el ROOT deducido, jamas apareceria en el listado.
    assert.ok(!rutas(ROOT).includes('src/solo-aqui.ts'),
      'el arbol de DoxIA no puede contener el fichero sembrado en el temporal');
  });
});

test('sin argumento sigue viendo el arbol de DoxIA: la migracion no rompe a quien no pasa nada', () => {
  const propios = ficherosDeGit();
  assert.ok(propios.length > 100, `se esperaban muchos ficheros propios, hubo ${propios.length}`);
  assert.deepEqual(propios, ficherosDeGit(ROOT),
    'el defecto y ROOT explicito tienen que dar lo mismo');
});

test('raizDeIndice es defensiva: lo que no es una raiz usable cae al defecto', () => {
  // `.map(fn)` pasa el INDICE como segundo argumento -- ya metio un indice como
  // taxonomia en un refactor de este repo. Y una raiz vacia compondria una ruta
  // RELATIVA que resuelve contra el cwd del proceso, que dentro de un hook es
  // otro: ese es el modo de fallo que borro 1181 ficheros.
  for (const basura of [undefined, null, 0, 1, '', '   ', [], {}, { raiz: '' }, { raiz: 42 }]) {
    assert.equal(raizDeIndice(basura), ROOT,
      `raizDeIndice(${JSON.stringify(basura)}) tenia que caer al ROOT deducido`);
  }
  assert.equal(raizDeIndice({ raiz: '/tmp/otro' }), '/tmp/otro');
  assert.equal(raizDeIndice('/tmp/directo'), '/tmp/directo',
    'una cadena no vacia es una raiz valida: es la forma que usan ficherosDeGit e indexar');
});
