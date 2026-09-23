// Sandbox — DONDE puede equivocarse una capacidad sin danar el arbol real.
//
// Worktree git, no docker: da lo que hace falta -- aislamiento del arbol
// principal, mismo commit base, rollback trivial -- SIN instalar nada.
//
// ─────────────────────────────────────────────────────────────────────────────
// INCIDENTE 2026-08-14, y por que este fichero empieza con una guarda.
//
// La primera version de `remove()` hacia `rmSync(ws.path, {recursive, force})`
// confiando en que `ws.path` viniera de `create()`. Una SONDA que mutaba
// `create()` para devolver ROOT -- escrita para comprobar que el test de
// aislamiento discriminaba -- hizo que `remove()` BORRARA EL REPOSITORIO ENTERO.
// Se recupero de GitHub; se perdio el trabajo sin commitear.
//
// La leccion no es "no escribas sondas". Es que una funcion destructiva NO PUEDE
// confiar en su argumento. `assertDestructible()` corre en CADA borrado y es
// independiente de quien construyo la ruta.
//
// Ver memory/failures/la-funcion-destructiva-confio-en-su-argumento.md
// ─────────────────────────────────────────────────────────────────────────────
import { existsSync, rmSync, symlinkSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT, RUNTIME } from './capabilities.mjs';

const WORKSPACES = resolve(RUNTIME, 'workspaces');

/**
 * Entorno LIMPIO de variables de git.
 *
 * Un hook de git (pre-commit, PreToolUse de Kiro) exporta GIT_DIR,
 * GIT_INDEX_FILE y compania, y TODO `git` hijo las hereda. Un `git worktree add`
 * con GIT_DIR apuntando al repo principal no crea un worktree aislado: opera
 * sobre el indice del padre. El aislamiento —que es lo unico que el sandbox
 * existe para dar— desaparecia justo cuando el harness corria dentro de un hook.
 *
 * Salio al meter los tests del harness en el gate: pasaban sueltos y 5 fallaban
 * en el pre-commit. Es un fallo que solo aparece ejecutando dentro del hook, no
 * leyendo el codigo (leer-el-anillo-no-lo-ejecuta.md).
 */
export const ENV_LIMPIO = () => {
  const e = { ...process.env };
  for (const k of Object.keys(e)) if (k.startsWith('GIT_')) delete e[k];
  return e;
};

const git = (args, opts = {}) =>
  execFileSync('git', args, {
    cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: ENV_LIMPIO(), ...opts,
  }).trim();

/**
 * LA GUARDA. Ninguna ruta se borra sin pasar por aqui, venga de donde venga.
 * Es deliberadamente paranoica: la unica forma de que un `rmSync` sea seguro es
 * que la comprobacion NO dependa de quien construyo la ruta.
 */
export function assertDestructible(path) {
  if (!path || typeof path !== 'string') throw new Error(`ruta invalida: ${path}`);
  const abs = resolve(path);

  if (!abs.startsWith(WORKSPACES + '/')) {
    throw new Error(`REHUSADO: '${abs}' esta fuera de ${WORKSPACES}. Solo se borran workspaces.`);
  }
  if (abs === WORKSPACES || abs === resolve(ROOT) || abs === resolve('/')) {
    throw new Error(`REHUSADO: '${abs}' es una raiz, no un workspace.`);
  }
  if (abs.split('/').length < WORKSPACES.split('/').length + 1) {
    throw new Error(`REHUSADO: '${abs}' no tiene la profundidad de un workspace.`);
  }
  return abs;
}

/** Huella del arbol principal. Se compara antes y despues: es FT-3. */
export function mainTreeFingerprint() {
  return git(['status', '--porcelain'])
    .split('\n')
    .filter((l) => l && !l.includes('.harness/'))
    .sort()
    .join('\n');
}

/** El worktree DEBE caer bajo .harness/workspaces/ y fuera del codigo. */
export function assertOutsideMainTree(ws) {
  const abs = resolve(ws.path);
  if (abs.startsWith(resolve(ROOT, 'src')) || abs.startsWith(resolve(ROOT, 'backend', 'src'))) {
    throw new Error(`sandbox dentro del codigo de produccion: ${abs}`);
  }
  if (!abs.startsWith(WORKSPACES + '/')) throw new Error(`sandbox fuera de workspaces: ${abs}`);
  return true;
}

/** @returns Workspace {kind, path, rollback, commit, branch} */
/**
 * El commit contra el que corre una vuelta, RESUELTO UNA VEZ al arrancar.
 *
 * Era la cadena literal `'HEAD'`, y `create` la resolvia al llegar la etapa 6 --
 * quince minutos despues, porque Knowledge, Evidence, Decision, Plan y Compute
 * van antes. MEDIDO el 21-ago: lance H-20260821-6ebd7317 sobre `896eb9f2` y su
 * workspace salio en `678ff8ae`, tres commits mios mas tarde. La vuelta cambio
 * de base sin que nadie lo pidiera.
 *
 * No es teorico: si uno de esos commits rompe algo, la vuelta falla por una causa
 * que no tiene nada que ver con su tarea, y el diagnostico empieza mirando la
 * tarea. Una vuelta se corre CONTRA UN COMMIT, y ese commit es el que habia
 * cuando se lanzo.
 */
export function baseCommit() {
  try {
    return git(['rev-parse', 'HEAD']) || 'HEAD';
  } catch {
    return 'HEAD';   // sin git no hay base que fijar; `create` fallara con su propio motivo
  }
}

export function create(executionId, { commit = 'HEAD' } = {}) {
  if (!/^[\w.-]+$/.test(executionId ?? '')) {
    throw new Error(`executionId invalido: '${executionId}'`);
  }
  const path = join(WORKSPACES, executionId);
  const branch = `harness/${executionId}`;
  const base = git(['rev-parse', commit]);

  const ws = { kind: 'worktree', path, rollback: base, commit: base, branch };
  assertOutsideMainTree(ws);        // antes de tocar disco
  if (existsSync(path)) remove(ws);

  git(['worktree', 'add', '--detach', '-f', path, base]);
  git(['checkout', '-B', branch, base], { cwd: path });
  enlazarDependencias(path);
  assertUsable(ws);
  return ws;
}

/**
 * LA PUERTA DE LA ETAPA 6, EJECUTABLE.
 *
 * El manifiesto la declara desde H-001 -- «el worktree existe, esta en el commit
 * esperado y su ruta cae bajo .harness/workspaces/», con `onFail: STOP — sin
 * aislamiento no se ejecuta»-- y no la comprobaba nadie: `sandboxStage` creaba el
 * worktree y devolvia el objeto. De las tres condiciones solo la tercera tenia
 * guarda (`assertOutsideMainTree`, dentro de `create`).
 *
 * POR QUE IMPORTA, y no es teorico. `git worktree add` puede quedarse a medias --la
 * administracion de worktrees es GLOBAL al repositorio y varios procesos la tocan a
 * la vez-- y entonces `create` devuelve un workspace que parece bueno. El fallo no
 * aparece aqui: aparece diez pasos despues como un ENOENT sobre un fichero que la
 * vuelta creo, sin nada que lo conecte con su causa. Medido dos veces el 2026-08-20
 * en la suite del harness, con ~1 fallo por cada 8-15 corridas completas.
 *
 * NO se afirma que esto elimine esa carrera: no esta diagnosticada, y arreglar por
 * conjetura es el defecto que este repo mide desde hace nueve rondas. Lo que hace es
 * que el fallo se NOMBRE donde ocurre, que es la condicion para diagnosticarlo.
 */
export function assertUsable(ws) {
  if (!existsSync(ws.path)) {
    throw new Error(`el worktree '${ws.path}' no existe despues de crearlo: sin aislamiento no se ejecuta`);
  }
  let top;
  try {
    top = git(['rev-parse', '--show-toplevel'], { cwd: ws.path });
  } catch (e) {
    throw new Error(`'${ws.path}' existe pero git no lo reconoce como worktree: ${e.message}`);
  }
  if (resolve(top) !== resolve(ws.path)) {
    throw new Error(
      `'${ws.path}' resuelve a otro arbol ('${top}'): la vuelta escribiria fuera de su sandbox`,
    );
  }
  const head = git(['rev-parse', 'HEAD'], { cwd: ws.path });
  if (ws.commit && head !== ws.commit) {
    throw new Error(`el worktree quedo en '${head}' y se pidio '${ws.commit}': no es la base declarada`);
  }
  return ws;
}

/**
 * Enlaza node_modules del arbol principal al worktree.
 *
 * Un worktree recien creado NO tiene dependencias, asi que el gate dentro de el
 * fallaria en typecheck, lint, tests y build -- no por el cambio, sino por no
 * poder ejecutarse. Enlazar en vez de copiar: son ~1 GB y la corrida no los
 * modifica.
 *
 * Se enlaza, no se instala: `npm ci` en cada corrida anadiria minutos y podria
 * traer versiones distintas a las del arbol que se esta validando.
 */
function enlazarDependencias(path) {
  for (const rel of ['node_modules', join('backend', 'node_modules')]) {
    const origen = resolve(ROOT, rel);
    const destino = resolve(path, rel);
    if (!existsSync(origen) || existsSync(destino)) continue;
    try {
      symlinkSync(origen, destino, 'dir');
    } catch { /* sin dependencias: el gate lo reportara como no ejecutable */ }
  }
}

export function rollback(ws) {
  assertOutsideMainTree(ws);
  git(['reset', '--hard', ws.rollback], { cwd: ws.path });
  git(['clean', '-fd'], { cwd: ws.path });
  return ws;
}

/**
 * Lo que la capacidad escribio, relativo a la raiz del worktree.
 *
 * NO se corta por ancho fijo. `git status --porcelain` emite ` M ruta` con un
 * espacio inicial, pero el helper `git()` hace `.trim()` de la salida completa y
 * se come ese espacio EN LA PRIMERA LINEA -- un `slice(3)` devolvia entonces
 * `cripts/gate.sh` en vez de `scripts/gate.sh`. Fallaba solo en la primera
 * linea, lo que lo hacia parecer aleatorio.
 *
 * Se excluyen ademas los node_modules enlazados: `.gitignore` dice
 * `node_modules/` con barra, que casa directorios y NO enlaces simbolicos, asi
 * que git los reporta como untracked y ensuciaban el ChangeSet.
 */
export function changedFiles(ws) {
  assertOutsideMainTree(ws);
  const ENLAZADOS = new Set(['node_modules', 'backend/node_modules']);
  return git(['status', '--porcelain'], { cwd: ws.path })
    .split('\n')
    .flatMap((l) => {
      // El prefijo se lee TOLERANTE a proposito: `git()` hace .trim() de la salida
      // entera, asi que la PRIMERA linea pierde su espacio inicial y un ` M ruta`
      // llega como `M ruta`. Un slice de ancho fijo se comia la inicial de la ruta.
      const m = /^\s*(\S{1,2})\s+(.+)$/.exec(l);
      if (!m) return [];
      const [, estado, resto] = m;
      // UN RENOMBRADO SON DOS RUTAS, y las dos son cambios de verdad: una deja de
      // existir y la otra empieza. Porcelain lo escribe en UNA linea -- `R  origen
      // -> destino`-- y esto devolvia esa linea entera como si fuese un fichero.
      //
      // MEDIDO en H-20260820-311fed39: la vuelta hizo el trabajo completo -- 6
      // renombrados, typecheck y tests en VERDE-- y murio en la frontera con
      // «quedo modificado 'a -> b', fuera de task.files». Claro que no estaba: la
      // lista declara 'a' y 'b' por separado, como debe.
      //
      // Y solo se ve cuando el builder hace lo que la aceptacion le manda. Con
      // `renameSync` git ve borrado + untracked; es `diff()`, con su `git add -N`,
      // lo que hace que status pase a reportar `R`. Correr `git_diff` antes de
      // `done` -- el punto 8 de la aceptacion de una mudanza-- se cobraba la vuelta.
      //
      // La contencion NO se afloja: se comprueban las DOS rutas contra `task.files`
      // en vez de una cadena que no podia coincidir con nada.
      const rutas = /^[RC]/.test(estado) ? resto.split(' -> ') : [resto];
      return rutas.map((f) => f.trim()).filter((f) => f && !ENLAZADOS.has(f));
    });
}

/**
 * El diff del workspace, INCLUIDOS los ficheros nuevos.
 *
 * `git diff HEAD` no ve lo untracked. Mientras el builder devolvia el contenido
 * completo dentro del JSON dava igual: el revisor veia los ficheros nuevos por
 * `contents`. Cuando Execution paso a bucle de herramientas (Fase 7), el builder
 * CREA ficheros y quedaban fuera del diff -- el ChangeSet declaraba tres rutas en
 * `files` y mostraba el cambio de una sola.
 *
 * Lo encontro el revisor adversarial en la vuelta H-20260816-52af3889 y lo
 * clasifico P2: «los archivos nuevos estan untracked, por lo que el diff no es
 * reproducible». Tenia razon -- quien aplicara ese diff se quedaria con un import
 * a un modulo que no existe.
 *
 * `git add -N` (intent-to-add) hace que git los conozca sin anadir contenido al
 * indice, y entonces si salen. Se le pasan las rutas UNA A UNA en vez de `.`:
 * los node_modules enlazados son untracked para git (`.gitignore` dice
 * `node_modules/` con barra, que no casa un enlace simbolico) y `git add -N .`
 * los meteria en el diff. Y se filtran las borradas, que ya salen por estar
 * rastreadas y harian fallar al `add`.
 */
export function diff(ws) {
  assertOutsideMainTree(ws);
  try {
    const nuevos = changedFiles(ws).filter((f) => existsSync(join(ws.path, f)));
    if (nuevos.length) {
      execFileSync('git', ['add', '-N', '--', ...nuevos], {
        cwd: ws.path, env: ENV_LIMPIO(), stdio: 'pipe',
      });
    }
    // Mismo motivo que arriba: con GIT_DIR heredado, este diff describiria el
    // arbol principal en vez del workspace.
    // `-M` NO es cosmetico: sin deteccion de renombrados, un `git mv` se ve como
    // un borrado entero mas una creacion entera, y la clase `move` de C-5 --que
    // vale por `similarity index 100%`-- no puede existir. Un restructure de 200
    // ficheros se leia como 200 ficheros reescritos.
    return execFileSync('git', ['diff', '-M', 'HEAD'], {
      cwd: ws.path, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, env: ENV_LIMPIO(),
    });
  } catch {
    return '';
  }
}

/** Retira el worktree. Idempotente. NUNCA borra fuera de workspaces/. */
/**
 * Que workspaces se retiran al arrancar una vuelta.
 *
 * EL DEFECTO: no los retiraba NADIE. Ni al fallar ni al cerrar en verde -- el de
 * `H-20260821-84b9ad17`, que cerro PASSED 16/16, seguia registrado horas
 * despues. Y el registro de worktrees es GLOBAL al `.git`, asi que cada vuelta
 * mia dejaba basura en el `git worktree list` de los otros dos agentes.
 *
 * LA REGLA: se conserva la ULTIMA FALLIDA y se retira todo lo demas. La fallida
 * es la unica que alguien va a querer abrir --a ver que dejo el builder-- y las
 * que cerraron bien ya tienen su diff en `.harness/runs/<id>/`. Conservar todas
 * «por si acaso» es como se llega a tres worktrees huerfanos sin que nadie lo
 * note.
 *
 * SE LIMPIA AL ARRANCAR, no al terminar. Una vuelta que muere de un `kill` --hoy
 * paso-- no ejecuta su `finally`; la siguiente si arranca. Limpiar al empezar es
 * lo unico que sobrevive a la forma en que estas cosas se mueren de verdad.
 *
 * PURO: recibe la lista ya leida. La E/S es de `limpiarWorkspaces`.
 *
 * @param entradas [{id, verdict, startedAt}] — las vueltas con workspace en disco
 * @param actual   el id de la vuelta que va a arrancar; nunca se toca
 */
/** Forma de un executionId. Lo que no la tiene NO es una vuelta. */
export const ES_VUELTA = /^H-\d{8}-[0-9a-f]+$/;

export function aRetirar(entradas, { actual = null } = {}) {
  // LO QUE NO ES UNA VUELTA NO SE CLASIFICA COMO VUELTA MUERTA.
  //
  // `limpiarWorkspaces` lista TODO directorio bajo `.harness/workspaces/`, y ahi
  // viven tambien los nueve fixtures de nombre fijo de la suite --`test-agentic`,
  // `test-tools`, `test-stages`…--. Ninguno tiene `runs/<id>/trace.json`, asi que
  // el `catch` los daba por `FAILED` y este filtro los mandaba a borrar.
  //
  // El codigo preguntaba «¿tiene traza?» y respondia «es una vuelta muerta». La
  // pregunta correcta es «¿es una vuelta?»: un fixture no tiene traza PORQUE NO ES
  // UNA VUELTA, no porque haya muerto. Es `el-instrumento-que-confunde-error-con-vacio`
  // dentro del limpiador.
  //
  // Y el efecto peor no es borrar un fixture -- la suite lo recrea--: es que el
  // hueco de «conservar la ultima fallida para depurar» se lo puede quedar UN
  // FIXTURE. Medido: con `H-20260823-4e052d0a` y tres fixtures, el conservado fue
  // `test-tools` y la traza de la vuelta se fue a la basura.
  //
  // Lo caza third leyendo este fichero.
  const otras = (entradas ?? [])
    .filter((e) => e?.id && ES_VUELTA.test(e.id) && e.id !== actual);
  const fallidas = otras
    .filter((e) => e.verdict && e.verdict !== 'PASSED')
    .sort((a, b) => String(a.startedAt ?? '').localeCompare(String(b.startedAt ?? '')));
  const conservar = fallidas.length ? fallidas[fallidas.length - 1].id : null;
  return otras.filter((e) => e.id !== conservar).map((e) => e.id);
}

/** La mitad con E/S: lee los veredictos del disco y retira lo que diga `aRetirar`. */
export function limpiarWorkspaces({ actual = null } = {}) {
  if (!existsSync(WORKSPACES)) return { retirados: [], conservado: null };
  const ids = readdirSync(WORKSPACES, { withFileTypes: true })
    .filter((d) => d.isDirectory()).map((d) => d.name);
  const entradas = ids.map((id) => {
    let verdict = null; let startedAt = id;
    try {
      const t = JSON.parse(readFileSync(join(RUNTIME, 'runs', id, 'trace.json'), 'utf8'));
      verdict = t?.verdict ?? null; startedAt = t?.startedAt ?? id;
    } catch { /* sin traza: la vuelta murio antes de cerrar, cuenta como fallida */ }
    return { id, verdict: verdict ?? 'FAILED', startedAt };
  });
  const fuera = aRetirar(entradas, { actual });
  for (const id of fuera) {
    try { remove({ path: join(WORKSPACES, id), branch: `harness/${id}` }); } catch { /* ya no estaba */ }
  }
  const conservado = entradas.map((e) => e.id).find((id) => id !== actual && !fuera.includes(id)) ?? null;
  return { retirados: fuera, conservado };
}

export function remove(ws) {
  const abs = assertDestructible(ws?.path);          // <- la guarda, siempre
  try { git(['worktree', 'remove', '--force', abs]); } catch { /* ya no existe */ }
  try { rmSync(abs, { recursive: true, force: true }); } catch { /* ya no existe */ }
  if (ws.branch) { try { git(['branch', '-D', ws.branch]); } catch { /* nunca se creo */ } }
  try { git(['worktree', 'prune']); } catch { /* nada que podar */ }
}
