// node --test harness/lib/
//
// WP-A3: la prueba que discrimina. Es FT-3 en miniatura.
//
// Y los tests de `assertDestructible` NO son ceremonia: la primera version de
// este modulo borro el repositorio entero cuando una sonda le paso ROOT como
// ruta de workspace. La guarda existe por eso, y estos casos la fijan.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import * as sandbox from './sandbox.mjs';
import { ROOT, RUNTIME } from './capabilities.mjs';

// UN NOMBRE POR PROCESO, no un literal compartido.
//
// `sandbox.create(ID)` crea un worktree DE VERDAD: entra en `.git/worktrees` y deja
// su rama `harness/<ID>`. Y esa administracion es GLOBAL al repositorio -- la
// comparten todos los worktrees del mismo `.git`, que tras la separacion de hoy son
// tres arboles y sus anillos.
//
// Con el literal, DOS corridas simultaneas de esta suite pelean por el mismo nombre:
// una crea `test-sandbox` mientras la otra lo esta retirando. Y la suite corre en
// CADA commit de cualquiera de los tres, porque el pre-commit lanza `gate --fast` y
// `--fast` lanza `node --test harness/`.
//
// Encaja con el perfil del intermitente que este repo arrastra desde el 2026-08-18:
// ~1 de cada 8-15 corridas COMPLETAS falla y en solitario cada fichero pasa. Una
// colision en un registro global es exactamente asi de rara y asi de invisible.
// Localizado el 2026-08-21 por la sesion de AAFA, inventariando worktrees.
//
// NO se afirma que esto lo elimine: no esta diagnosticado, y arreglar por conjetura
// es el defecto que este repo mide. Lo que hace es QUITAR LA VARIABLE. Si el
// intermitente sobrevive a esto, la ultima estructura compartida queda descartada;
// si desaparece, estaba aqui.
//
// `process.pid` y no una marca de tiempo: dos corridas del mismo segundo tendrian el
// mismo nombre, y es justo el caso que hay que separar.
const ID = `test-sandbox-${process.pid}`;

// ── La guarda ────────────────────────────────────────────────────────────────
test('assertDestructible REHUSA todo lo que no sea un workspace', () => {
  const prohibidas = [
    ROOT,                                   // el repositorio entero  <- el incidente
    resolve(ROOT, 'src'),
    resolve(ROOT, 'backend', 'src'),
    resolve(RUNTIME, 'workspaces'),         // la raiz de los workspaces
    '/', '/home/emmanuel', '/tmp/cualquiera',
    '', null, undefined, 42,
  ];
  for (const p of prohibidas) {
    assert.throws(() => sandbox.assertDestructible(p), /REHUSADO|ruta invalida/, `deberia rehusar: ${p}`);
  }
});

// ── Las once rutas de arriba NO llegan a la segunda guarda ───────────────────
//
// MEDIDO POR MUTACION: se abrieron los cuatro limites de `assertDestructible`
// uno a uno --incluido sustituir el guardarrail de la raiz por `if (false)`-- y
// los 23 tests de este fichero SIGUIERON EN VERDE. Sobrevivir a la mutacion de
// lo que vigilas significa que vigilas otra cosa.
//
// LA CAUSA: las once prohibidas estan todas FUERA de WORKSPACES, asi que la
// PRIMERA guarda (`!abs.startsWith(WORKSPACES + '/')`) las atrapa y las lineas
// posteriores nunca se ejecutan. El bucle prueba once veces el mismo limite.
//
// Para ejercitar la SEGUNDA guarda hace falta una ruta que YA pase la primera:
// dentro de workspaces y, a la vez, igual a la raiz declarada.
test('la segunda guarda existe: dentro de workspaces, la RAIZ sigue siendo intocable', () => {
  const WS = resolve(RUNTIME, 'workspaces');
  const dentro = join(WS, 'H-20260101-deadbeef');

  // Pasa la primera guarda (esta dentro de WORKSPACES) y aun asi se rehusa,
  // porque con esa raiz inyectada el path ES la raiz. Este caso CAE si se abre
  // el guardarrail de la linea 64; el bucle de arriba no.
  assert.throws(() => sandbox.assertDestructible(dentro, { raiz: dentro }),
    /es una raiz, no un workspace/,
    'con la raiz apuntando ahi, ese path no es un workspace destruible');

  // Control negativo: el MISMO path con otra raiz si es destruible. Sin el, el
  // caso de arriba podria estar pasando por cualquier otro motivo.
  assert.equal(sandbox.assertDestructible(dentro, { raiz: '/tmp/otra-raiz' }), dentro,
    'un workspace legitimo tiene que seguir siendo destruible');
});

test('la tercera guarda es INALCANZABLE, y eso se declara en vez de fingir cobertura', () => {
  // MI PRIMERA VERSION de este caso usaba `WORKSPACES + '/'` creyendo que pasaba
  // la primera guarda y moria en la de profundidad. No: `resolve()` ELIMINA la
  // barra final, asi que el path queda igual a WORKSPACES y lo atrapa la primera.
  // El mutante que abria la profundidad SOBREVIVIA a mi test.
  //
  // Al medir los segmentos se ve que la guarda no puede dispararse nunca:
  //   WORKSPACES + '/'   -> resolve lo deja en WORKSPACES  -> muere en la 1a
  //   WORKSPACES + '/x'  -> 8 segmentos vs 8 exigidos      -> pasa
  //   WORKSPACES + '/a/b'-> 9 segmentos vs 8 exigidos      -> pasa
  // Cualquier ruta que supere la primera guarda tiene AL MENOS un segmento mas
  // que WORKSPACES, que es exactamente lo que la tercera pide.
  //
  // Es codigo defensivo redundante, no un limite vivo. Se deja --cuesta una
  // comparacion y protege de un futuro cambio en la primera guarda-- pero NO se
  // le escribe un test que aparente cubrirlo: un test que no puede fallar es
  // peor que ninguno, porque cuenta como cobertura.
  const WS = resolve(RUNTIME, 'workspaces');
  assert.equal(resolve(WS + '/'), WS,
    'si resolve() dejara de normalizar la barra final, la tercera guarda pasaria a ser alcanzable y este caso hay que reescribirlo');
  assert.ok(resolve(WS, 'x').split('/').length >= WS.split('/').length + 1,
    'cualquier hijo directo de workspaces ya cumple la profundidad exigida');
});

test('assertDestructible ACEPTA un workspace legitimo', () => {
  const ok = join(RUNTIME, 'workspaces', 'algo');
  assert.equal(sandbox.assertDestructible(ok), resolve(ok));
});

test('remove NUNCA borra fuera de workspaces, aunque se lo pidan', () => {
  assert.throws(() => sandbox.remove({ path: ROOT }), /REHUSADO/);
  assert.ok(existsSync(join(ROOT, 'package.json')), 'el repositorio sigue en pie');
});

// ── El aislamiento ───────────────────────────────────────────────────────────
test('el worktree cae FUERA del arbol principal', () => {
  const ws = sandbox.create(ID);
  try {
    assert.equal(ws.kind, 'worktree');
    assert.ok(existsSync(ws.path));
    assert.ok(resolve(ws.path).startsWith(resolve(RUNTIME, 'workspaces')));
    sandbox.assertOutsideMainTree(ws);
  } finally {
    sandbox.remove(ws);
  }
});

test('AISLAMIENTO: escribir dentro NO cambia el arbol principal', () => {
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

test('rollback deja el worktree en su commit base', () => {
  const ws = sandbox.create(ID);
  try {
    writeFileSync(join(ws.path, 'BASURA.txt'), 'x');
    assert.ok(sandbox.changedFiles(ws).length > 0);
    sandbox.rollback(ws);
    assert.deepEqual(sandbox.changedFiles(ws), []);
  } finally {
    sandbox.remove(ws);
  }
});

test('remove es idempotente', () => {
  const ws = sandbox.create(ID);
  sandbox.remove(ws);
  sandbox.remove(ws);
  assert.ok(!existsSync(ws.path));
});

test('un executionId con rutas relativas se rechaza', () => {
  assert.throws(() => sandbox.create('../../etc'), /executionId invalido/);
  assert.throws(() => sandbox.create('a/b'), /executionId invalido/);
});

// ── changedFiles: rutas intactas ────────────────────────────────────────────
test('changedFiles NO corrompe la primera ruta ni cuela los node_modules enlazados', () => {
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
test('diff INCLUYE los ficheros nuevos, no solo los ya rastreados', () => {
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
test('rollback deshace las mutaciones aplicadas y devuelve el hash original', async () => {
  const { runTool } = await import('./tools.mjs');
  const { loadCapabilities } = await import('./capabilities.mjs');
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

// ── El sandbox debe aislar TAMBIEN dentro de un hook de git ─────────────────
// Descubierto al meter los tests del harness en el gate: pasaban sueltos y 5
// fallaban en el pre-commit. Un hook exporta GIT_DIR y GIT_INDEX_FILE, y todo
// `git` hijo las hereda; `git worktree add` con GIT_DIR apuntando al repo
// principal deja de aislar, que es lo unico que el sandbox existe para dar.
//
// Este test POLUCIONA el entorno a proposito: sin el, la correccion no esta
// protegida, porque en una corrida normal las variables no estan puestas y los
// demas tests pasan con o sin ella.
test('AISLAMIENTO: sigue aislando con GIT_DIR y GIT_INDEX_FILE heredados', () => {
  const previo = { GIT_DIR: process.env.GIT_DIR, GIT_INDEX_FILE: process.env.GIT_INDEX_FILE };
  process.env.GIT_DIR = '.git';
  process.env.GIT_INDEX_FILE = '.git/index';

  const id = `TEST-hook-${process.pid}`;
  let ws;
  try {
    ws = sandbox.create(id);
    assert.ok(existsSync(ws.path), 'el worktree no se creo con el entorno de un hook');
    sandbox.assertOutsideMainTree(ws);
    assert.deepEqual(sandbox.changedFiles(ws), [], 'un worktree recien creado esta limpio');
  } finally {
    if (ws) { try { sandbox.remove(ws); } catch { /* ya no existe */ } }
    for (const [k, v] of Object.entries(previo)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

// ── La evidencia describe el WORKSPACE, no el arbol principal ───────────────
// Evidence2 invocaba el gate.sh del arbol principal con cwd en el workspace, y
// no basta: gate.sh calcula su ROOT desde BASH_SOURCE y hace `cd` alli. La
// evidencia de la vuelta describia un arbol SIN el cambio, y de paso corria
// vitest y jest en el arbol principal -- lo que el sandbox existe para evitar.
// Se vio porque el fichero de evidencia con el executionId aparecio en el arbol
// principal en vez de en el workspace.
test('EVIDENCIA: el workspace tiene su propio gate, y es el que debe correr', () => {
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
test('un renombrado se reporta como sus DOS rutas, no como una cadena `a -> b`', () => {
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

// ── La puerta de la etapa 6, ejecutable ──────────────────────────────────────
//
// El manifiesto la declara desde H-001 -- «el worktree existe, esta en el commit
// esperado y su ruta cae bajo .harness/workspaces/», onFail STOP-- y no la
// comprobaba nadie: `sandboxStage` creaba el worktree y devolvia el objeto. De las
// tres condiciones solo la tercera tenia guarda.
//
// Importa porque `git worktree add` puede quedarse a medias -- la administracion de
// worktrees es GLOBAL al repositorio-- y entonces el fallo no aparece aqui sino
// diez pasos despues, como un ENOENT sobre un fichero que la vuelta creo.
test('un workspace recien creado se comprueba: existe, es un worktree y esta en su commit', () => {
  const ws = sandbox.create(ID);
  try {
    assert.equal(sandbox.assertUsable(ws), ws, 'lo que create devuelve tiene que pasar su propia puerta');

    // Y las tres condiciones se comprueban de verdad, no se declaran.
    assert.throws(
      () => sandbox.assertUsable({ ...ws, path: join(RUNTIME, 'workspaces', 'no-existe-jamas') }),
      /no existe/, 'un worktree ausente tiene que decirlo aqui, no diez pasos despues',
    );
    assert.throws(
      () => sandbox.assertUsable({ ...ws, commit: '0'.repeat(40) }),
      /no es la base declarada/, 'un worktree en otro commit no es el sandbox que se pidio',
    );
  } finally {
    sandbox.remove(ws);
  }
});

test('un directorio que NO es worktree se rechaza aunque exista', () => {
  const suelto = join(RUNTIME, 'workspaces', 'test-no-worktree');
  rmSync(suelto, { recursive: true, force: true });
  mkdirSync(suelto, { recursive: true });
  try {
    // Existe y cae bajo workspaces/, pero git no lo conoce. Sin esta comprobacion
    // `create` devolveria algo que parece un sandbox y no lo es.
    assert.throws(
      () => sandbox.assertUsable({ kind: 'worktree', path: suelto, commit: null }),
      /no lo reconoce como worktree|resuelve a otro arbol/,
    );
  } finally {
    rmSync(suelto, { recursive: true, force: true });
  }
});

test('y `create` la USA: una guarda que nadie llama no existe', () => {
  // Sin esto los dos tests de arriba pasarian con la comprobacion desconectada:
  // prueban la funcion, no que el sandbox la atraviese al nacer.
  const src = readFileSync(new URL('./sandbox.mjs', import.meta.url), 'utf8');
  assert.match(src, /enlazarDependencias\(path\);\n\s*assertUsable\(ws\);\n\s*return ws;/);
});

// ── Los workspaces no los retiraba nadie ────────────────────────────────────
//
// Ni al fallar ni al cerrar en verde: el de H-20260821-84b9ad17, que cerro
// PASSED 16/16, seguia registrado horas despues. Y el registro de worktrees es
// GLOBAL al `.git`, asi que cada vuelta dejaba basura en el `git worktree list`
// de los otros dos agentes que comparten el repositorio.
//
// Lo descubri afirmando dos veces lo contrario y mirando a la tercera.

// Los ids llevan FORMA DE VUELTA a proposito: desde que `aRetirar` descarta lo que
// no la tiene, la forma es parte del contrato y no un detalle del fixture.
test('se conserva la ULTIMA fallida y se retira todo lo demas', () => {
  const e = [
    { id: 'H-20260821-aaaaaaa1', verdict: 'PASSED', startedAt: '2026-08-21T10:00:00Z' },
    { id: 'H-20260821-bbbbbbb2', verdict: 'FAILED', startedAt: '2026-08-21T11:00:00Z' },
    { id: 'H-20260821-ccccccc3', verdict: 'FAILED', startedAt: '2026-08-21T13:00:00Z' },
    { id: 'H-20260821-ddddddd4', verdict: 'PASSED', startedAt: '2026-08-21T14:00:00Z' },
  ];
  const fuera = sandbox.aRetirar(e, { actual: 'E' });
  assert.deepEqual(fuera, ['H-20260821-aaaaaaa1', 'H-20260821-bbbbbbb2', 'H-20260821-ddddddd4']);
  assert.ok(!fuera.includes('H-20260821-ccccccc3'), 'la ultima fallida es la unica que alguien va a querer abrir');
});

test('la vuelta en curso NUNCA se retira a si misma', () => {
  const e = [{ id: 'H-20260821-eeeeeee5', verdict: 'FAILED', startedAt: '1' }, { id: 'Y', verdict: 'PASSED', startedAt: '2' }];
  assert.ok(!sandbox.aRetirar(e, { actual: 'Y' }).includes('Y'));
  assert.ok(!sandbox.aRetirar(e, { actual: 'H-20260821-eeeeeee5' }).includes('H-20260821-eeeeeee5'));
});

test('si TODAS cerraron en verde no se conserva ninguna', () => {
  // Las que pasaron ya tienen su diff en .harness/runs/<id>/. Conservarlas «por
  // si acaso» es como se llega a tres worktrees huerfanos sin que nadie lo note.
  assert.deepEqual(sandbox.aRetirar([{ id: 'H-20260821-aaaaaaa1', verdict: 'PASSED' }, { id: 'H-20260821-bbbbbbb2', verdict: 'PASSED' }], { actual: 'H-20260821-eeeeeee5' }), ['H-20260821-aaaaaaa1', 'H-20260821-bbbbbbb2']);
});

test('una vuelta sin traza cuenta como fallida: murio antes de cerrar', () => {
  // Es el caso de la que un `kill` se llevo hoy a media Execution. Tratarla como
  // exitosa borraria justo el arbol que hay que mirar para saber que paso.
  const fuera = sandbox.aRetirar([{ id: 'H-20260821-aaaaaaa1', verdict: 'PASSED', startedAt: '1' }, { id: 'H-20260821-bbbbbbb2', verdict: 'FAILED', startedAt: '2' }], { actual: 'H-20260821-fffffff6' });
  assert.deepEqual(fuera, ['H-20260821-aaaaaaa1']);
});

test('la base de la vuelta es un SHA resuelto, no la cadena HEAD', () => {
  // Si devuelve 'HEAD', `create` lo resolvera cuando llegue la etapa 6 -- quince
  // minutos y cinco etapas despues-- y la vuelta correra contra lo que haya
  // entonces. Paso hoy: lance sobre 896eb9f2 y el workspace salio en 678ff8ae.
  const b = sandbox.baseCommit();
  assert.match(b, /^[0-9a-f]{40}$/, `la base sigue sin resolverse: '${b}'`);
});

test('un fixture no es una vuelta muerta: el barrido no se lo lleva', async () => {
  // `limpiarWorkspaces` lista TODO directorio bajo `.harness/workspaces/`, y ahí
  // viven los nueve fixtures de nombre fijo de la suite. Ninguno tiene
  // `runs/<id>/trace.json`, así que el `catch` los daba por FAILED y salían a
  // borrar. El código preguntaba «¿tiene traza?» y respondía «es una vuelta
  // muerta»; la pregunta correcta es «¿es una vuelta?».
  //
  // Y el daño peor no es borrar un fixture —la suite lo recrea—: es que el hueco
  // de «conservar la última fallida para depurar» se lo quede uno. MEDIDO antes
  // del arreglo: conservaba `test-tools` y mandaba a borrar la vuelta real.
  const { aRetirar } = await import('./sandbox.mjs');
  const entradas = [
    { id: 'H-20260823-4e052d0a', verdict: 'FAILED', startedAt: '2026-08-23T09:55:00Z' },
    { id: 'H-20260822-907b6e42', verdict: 'FAILED', startedAt: '2026-08-22T20:16:00Z' },
    { id: 'test-agentic', verdict: 'FAILED', startedAt: 'test-agentic' },
    { id: 'test-tools', verdict: 'FAILED', startedAt: 'test-tools' },
  ];
  const fuera = aRetirar(entradas, { actual: 'H-20260823-nuevo' });

  for (const f of ['test-agentic', 'test-tools']) {
    assert.ok(!fuera.includes(f), `el barrido se lleva el fixture '${f}': la suite se queda sin él a media corrida`);
  }
  // Y la última fallida DE VERDAD se conserva, que es para lo que existe el hueco.
  assert.ok(!fuera.includes('H-20260823-4e052d0a'), 'se conserva la última vuelta fallida');
  assert.deepEqual(fuera, ['H-20260822-907b6e42']);
});
