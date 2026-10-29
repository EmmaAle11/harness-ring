import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import * as sandbox from '../../lib/sandbox.mjs';
import { ROOT } from '../../lib/capabilities.mjs';

// Estos casos crean un worktree del arbol y leen scripts/gate.sh y src/ del ANFITRION,
// que un motor portable no trae. Viven en el adaptador DoxIA y se saltan sin el host.

// UN NOMBRE POR PROCESO, no un literal compartido (dos corridas simultaneas pelearian
// por el mismo worktree: la administracion de worktrees es GLOBAL al repositorio).
const ID = `test-sandbox-${process.pid}`;

test('AISLAMIENTO: escribir dentro NO cambia el arbol principal', (t) => {
  if (!existsSync(join(ROOT, 'scripts', 'gate.sh'))) { t.skip('sin scripts/gate.sh: este arbol no es el anfitrion DoxIA'); return; }
  const antes = sandbox.mainTreeFingerprint();
  const ws = sandbox.create(ID);
  try {
    mkdirSync(join(ws.path, 'src'), { recursive: true });
    writeFileSync(join(ws.path, 'src', 'PRUEBA-DE-AISLAMIENTO.ts'), 'export const x = 1;\n');

    assert.ok(
      sandbox.changedFiles(ws).some((f) => f.includes('PRUEBA-DE-AISLAMIENTO')),
      'el worktree debe VER su propio cambio',
    );
    assert.equal(
      sandbox.mainTreeFingerprint(), antes,
      'el arbol principal NO puede cambiar: si esto falla, el sandbox no aisla y H-001 no puede correr',
    );
    assert.ok(!existsSync(join(ROOT, 'src', 'PRUEBA-DE-AISLAMIENTO.ts')));
  } finally {
    sandbox.remove(ws);
  }
  assert.equal(sandbox.mainTreeFingerprint(), antes, 'tras remove, el arbol sigue igual');
});
// ── changedFiles: rutas intactas ────────────────────────────────────────────
test('changedFiles NO corrompe la primera ruta ni cuela los node_modules enlazados', (t) => {
  if (!existsSync(join(ROOT, 'scripts', 'gate.sh'))) { t.skip('sin scripts/gate.sh: este arbol no es el anfitrion DoxIA'); return; }
  const ws = sandbox.create(ID);
  try {
    // Fichero ya trackeado -> ` M ruta` con espacio inicial. Es el caso que
    // rompia: el helper git() hace .trim() de la salida y un slice(3) de ancho
    // fijo devolvia 'cripts/gate.sh' en vez de 'scripts/gate.sh'.
    writeFileSync(join(ws.path, 'scripts', 'gate.sh'),
      readFileSync(join(ws.path, 'scripts', 'gate.sh'), 'utf8') + '\n# sonda\n');

    const f = sandbox.changedFiles(ws);
    assert.ok(f.includes('scripts/gate.sh'), `ruta corrompida: ${JSON.stringify(f)}`);
    assert.ok(!f.some((x) => x.endsWith('node_modules')),
      'los node_modules enlazados no son parte del cambio');
  } finally {
    sandbox.remove(ws);
  }
});
// ── diff: los ficheros NUEVOS tambien son el cambio ─────────────────────────
// Lo encontro el revisor adversarial en H-20260816-52af3889 y lo clasifico P2.
// Con Execution como bucle de herramientas el builder CREA ficheros, y
// `git diff HEAD` no ve lo untracked: el ChangeSet declaraba tres rutas y
// mostraba el cambio de una. Quien aplicara ese diff se quedaria con un import
// a un modulo que no existe.
test('diff INCLUYE los ficheros nuevos, no solo los ya rastreados', (t) => {
  if (!existsSync(join(ROOT, 'scripts', 'gate.sh'))) { t.skip('sin scripts/gate.sh: este arbol no es el anfitrion DoxIA'); return; }
  const ws = sandbox.create(ID);
  try {
    writeFileSync(join(ws.path, 'src', 'NUEVO-EN-EL-DIFF.ts'), 'export const nuevo = 1;\n');
    writeFileSync(join(ws.path, 'scripts', 'gate.sh'),
      readFileSync(join(ws.path, 'scripts', 'gate.sh'), 'utf8') + '\n# sonda\n');

    const d = sandbox.diff(ws);
    assert.match(d, /src\/NUEVO-EN-EL-DIFF\.ts/, 'el fichero nuevo no sale en el diff');
    assert.match(d, /\+export const nuevo = 1;/, 'sale nombrado pero sin su contenido');
    assert.match(d, /scripts\/gate\.sh/, 'y el modificado sigue saliendo');
    assert.doesNotMatch(d, /node_modules/, 'los enlaces no entran por la puerta de `git add -N`');
  } finally {
    sandbox.remove(ws);
  }
});
// ── 5 · Revertir: el protocolo de mutacion tiene marcha atras ───────────────
// `rollback` existia desde el principio y nunca se habia demostrado sobre
// mutaciones REALES: solo se sabia que llamaba a `git reset --hard`. Un
// mecanismo de recuperacion que no se ha visto recuperar nada es una promesa.
test('rollback deshace las mutaciones aplicadas y devuelve el hash original', async (t) => {
  if (!existsSync(join(ROOT, 'scripts', 'gate.sh'))) { t.skip('sin scripts/gate.sh: este arbol no es el anfitrion DoxIA'); return; }
  const { runTool } = await import('../../lib/tools.mjs');
  const { loadCapabilities } = await import('../../lib/capabilities.mjs');
  const cap = loadCapabilities().find((c) => c.id === 'builder');
  const ws = sandbox.create(ID);

  try {
    const t = (tool, args) => runTool({ tool, args }, { cap, ws });
    const objetivo = join(ws.path, 'scripts', 'gate.sh');
    const original = readFileSync(objetivo, 'utf8');

    // Dos mutaciones: una reescritura declarada y una creacion.
    const { hash } = await t('read_file', { path: 'scripts/gate.sh' });
    const escrito = await t('create_file', { path: 'scripts/gate.sh', content: '# PISADO\n', baseHash: hash });
    await t('create_file', { path: 'src/lib/nacido-en-el-sandbox.ts', content: 'export const x = 1;\n' });

    assert.equal(escrito.mutation.before, hash);
    assert.notEqual(escrito.mutation.after, hash, 'el hash cambio: la mutacion ocurrio de verdad');
    assert.ok(sandbox.changedFiles(ws).length >= 2);

    sandbox.rollback(ws);

    assert.equal(readFileSync(objetivo, 'utf8'), original, 'el fichero volvio a su contenido original');
    assert.equal(existsSync(join(ws.path, 'src', 'lib', 'nacido-en-el-sandbox.ts')), false,
      'y el creado desaparecio: `git clean` es parte del rollback, no un extra');
    assert.deepEqual(sandbox.changedFiles(ws), [], 'el workspace no registra ningun cambio');

    // 6 · OBSERVABLE: el hash de despues del rollback es el de antes de mutar.
    const vuelto = await t('read_file', { path: 'scripts/gate.sh' });
    assert.equal(vuelto.hash, hash, 'mismo hash que antes de la primera mutacion');
  } finally {
    sandbox.remove(ws);
  }
});
// ── La evidencia describe el WORKSPACE, no el arbol principal ───────────────
// Evidence2 invocaba el gate.sh del arbol principal con cwd en el workspace, y
// no basta: gate.sh calcula su ROOT desde BASH_SOURCE y hace `cd` alli. La
// evidencia de la vuelta describia un arbol SIN el cambio, y de paso corria
// vitest y jest en el arbol principal -- lo que el sandbox existe para evitar.
// Se vio porque el fichero de evidencia con el executionId aparecio en el arbol
// principal en vez de en el workspace.
test('EVIDENCIA: el workspace tiene su propio gate, y es el que debe correr', (t) => {
  if (!existsSync(join(ROOT, 'scripts', 'gate.sh'))) { t.skip('sin scripts/gate.sh: este arbol no es el anfitrion DoxIA'); return; }
  const id = `TEST-gate-${process.pid}`;
  let ws;
  try {
    ws = sandbox.create(id);
    const gateWs = join(ws.path, 'scripts', 'gate.sh');
    assert.ok(existsSync(gateWs), 'sin gate propio, el workspace no se puede validar aislado');
    assert.notEqual(resolve(gateWs), resolve(join(sandbox.ROOT ?? '', 'scripts', 'gate.sh')));
    // Y su ROOT calculado es el del workspace, no el del arbol principal.
    assert.ok(resolve(gateWs).startsWith(resolve(ws.path)), 'el gate a ejecutar cae dentro del workspace');
  } finally {
    if (ws) { try { sandbox.remove(ws); } catch { /* ya no existe */ } }
  }
});
// -- changedFiles: un renombrado son DOS rutas --------------------------------
//
// MEDIDO en H-20260820-311fed39. La vuelta hizo el trabajo entero -- 6 renombrados
// en R100, 14 mutaciones, typecheck VERDE y tests VERDES-- y murio en la frontera:
// «quedo modificado 'src/app/archivero/ArchiveroModule.tsx ->
// src/app/aafa/archivero/ArchiveroModule.tsx', fuera de task.files».
//
// Claro que no estaba: `task.files` declara el origen y el destino POR SEPARADO,
// como debe. Lo que no existia era esa cadena. Porcelain escribe el renombrado en
// UNA linea, y esto devolvia la linea entera como si fuese una ruta.
//
// Y solo se ve cuando el builder CUMPLE la aceptacion: con `renameSync` git ve un
// borrado mas un untracked, y es `diff()` -- con su `git add -N`-- quien hace que
// status pase a decir `R`. Correr `git_diff` antes de `done`, que es el punto 8 de
// la aceptacion de una mudanza, se cobraba la vuelta.
test('un renombrado se reporta como sus DOS rutas, no como una cadena `a -> b`', (t) => {
  if (!existsSync(join(ROOT, 'scripts', 'gate.sh'))) { t.skip('sin scripts/gate.sh: este arbol no es el anfitrion DoxIA'); return; }
  const ws = sandbox.create(ID);
  try {
    execFileSync('git', ['mv', 'scripts/gate.sh', 'scripts/gate-movido.sh'],
      { cwd: ws.path, env: sandbox.ENV_LIMPIO(), stdio: 'pipe' });

    const f = sandbox.changedFiles(ws);
    assert.ok(f.includes('scripts/gate.sh'), `falta el origen: ${JSON.stringify(f)}`);
    assert.ok(f.includes('scripts/gate-movido.sh'), `falta el destino: ${JSON.stringify(f)}`);
    // Lo que rompia la frontera: una cadena compuesta no coincide con nada.
    assert.ok(!f.some((x) => x.includes(' -> ')), `ruta compuesta: ${JSON.stringify(f)}`);

    // Y ASI PASA LA FRONTERA. Con las dos rutas declaradas -- que es exactamente lo
    // que hace el manifiesto de una mudanza-- cada una se comprueba por separado.
    const permitidos = new Set(['scripts/gate.sh', 'scripts/gate-movido.sh']);
    for (const x of f) assert.ok(permitidos.has(x), `'${x}' no se puede comprobar contra task.files`);
  } finally {
    sandbox.remove(ws);
  }
});
