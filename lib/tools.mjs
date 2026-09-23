// Tools — el unico camino por el que un modelo toca algo.
//
// EXISTENCE != CAPABILITY. `harness/capabilities/builder.md` declaraba
// `tools: [Read, Edit, Write, Bash, Grep, Glob]` desde el primer dia y ninguna de
// las seis existia: eran nombres de las tools de un IDE, copiados a un manifiesto
// que nadie ejecutaba. El builder no podia leer un fichero ni correr un test.
//
// EL FLUJO, y no admite atajos:
//
//   MODEL -> REQUEST -> HARNESS POLICY -> TOOL CONTRACT -> SANDBOX -> RESULT
//
// El modelo NUNCA invoca un proceso. Emite un ToolCall {tool, args}; aqui se
// resuelve contra el registro, se autoriza contra el contrato de la capacidad y
// se ejecuta DENTRO del workspace. Un rechazo es un resultado registrado, no una
// excepcion que rompe la vuelta: el modelo lo recibe y puede corregirse.
//
// LA POLITICA NO SE REIMPLEMENTA AQUI. Quien decide sigue siendo
// capability-contract.mjs -- `checkWriteBoundary` para rutas y `checkAction` para
// acciones. Si este fichero tuviera su propia tabla de permisos habria dos
// autoridades sobre el mismo permiso, y esa es la clase de defecto que este repo
// mide desde hace nueve rondas.
import { readFileSync, writeFileSync, mkdirSync, rmSync, renameSync, existsSync, statSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { HARNESS } from './capabilities.mjs';
import { checkWriteBoundary, checkAction } from './capability-contract.mjs';
import { ENV_LIMPIO, diff as diffDelWorkspace } from './sandbox.mjs';
import { hashDe, checkMutation, mutationRecord } from './mutation.mjs';
import { indexar, localizar } from './index-repo.mjs';

const run = promisify(execFile);

export const loadToolPolicy = () =>
  JSON.parse(readFileSync(join(HARNESS, 'policy', 'tools.json'), 'utf8'));

/**
 * EL PRESUPUESTO DE SALIDA, resuelto desde la MISMA politica que los de entrada.
 *
 * `loop` declaraba seis limites de entrada y cero de salida. Esa asimetria es la
 * que convierte «leer mas» en «morir antes»: mas entrada produce mas hallazgos, y
 * mas hallazgos revientan un techo que nadie habia escrito. Tres vueltas murieron
 * asi con OUTPUT_TRUNCATED.
 *
 * Se lee aqui y no en un modulo aparte por una razon concreta: `tools.json` ya
 * tiene un lector. Un segundo lector del mismo fichero es el defecto dominante de
 * este repo -- dos autoridades sobre el mismo hecho -- servido con la excusa de la
 * separacion de responsabilidades.
 */

/**
 * QUE se le pide de menos a un contrato cuando su respuesta se corta.
 *
 * `undefined` NO es un fallo: es «esta politica no sabe que quitarle a ese
 * contrato», y quien llama cae al aviso generico. Inventar aqui una reduccion
 * generica -- «responde mas corto» -- seria repetir el ruego que ya se midio que
 * no funciona.
 */
export const reduccionDe = (contract) => loadToolPolicy().output?.reduccion?.[contract];

/**
 * El techo de salida que ACEPTA un proveedor, o `null` si no admite ninguno.
 *
 * `null` significa NO LO ACEPTA -- los CLIs no reciben un techo en la invocacion --
 * y es distinto de «no lo sabemos». Un proveedor ausente de la tabla devuelve
 * `null` por lo mismo: declarar un numero por defecto seria una politica que
 * nadie puede hacer cumplir.
 */
export const maxOutputTokensDe = (provider) => loadToolPolicy().output?.maxOutputTokens?.[provider] ?? null;

/**
 * EL PRESUPUESTO QUE FALTABA, y no es el de tamano: es el de PENSAMIENTO.
 *
 * MEDIDO el 2026-08-19 en H-20260819-4b5c6d6d, con la instrumentacion que la
 * vuelta anterior dejo puesta a proposito sin arreglar nada: la etapa 9 murio
 * con `32768 de salida, de los cuales 32768 de razonamiento`. CERO tokens
 * llegaron a la respuesta. El modelo no se quedo sin sitio para contestar: se
 * lo gasto entero antes de empezar.
 *
 * Eso REFUTA el arreglo anterior. Acortar el contrato -- «MAXIMO 3 hallazgos»,
 * «MAXIMO 5» -- acota lo que se RESPONDE, y aqui no se llego a responder. Por
 * eso el reintento con el mismo modelo fallaba dos veces: repetia un ruego que
 * no gobierna la variable que se desborda.
 *
 * Reproducido en pequeno contra la API, con techo de 2048:
 *
 *   reasoning_effort=none  ->  6 de salida, sin razonamiento, finish=stop
 *   reasoning_effort=low   ->  1009 de salida, 919 de razonamiento, finish=stop
 *   reasoning_effort=high  ->  2048 de salida, 2048 de razonamiento, finish=LENGTH
 *
 * La ultima linea es el fallo entero, a escala. Y el modo de pensamiento de
 * DeepSeek viene ACTIVADO POR DEFECTO: nadie lo habia acotado nunca, asi que el
 * techo de salida era lo unico que lo paraba, y lo paraba tarde.
 *
 * `null` = el proveedor no acepta el campo (los CLIs no lo reciben), igual que
 * en `maxOutputTokensDe`. No se inventa un valor por defecto.
 */
export const reasoningEffortDe = (provider) => loadToolPolicy().output?.reasoningEffort?.[provider] ?? null;

/**
 * A que se baja cuando la salida SE TRUNCO. No es «piensa menos por si acaso»:
 * es la unica palanca que la medida senala, usada solo despues de que el fallo
 * ocurra. Un reintento que repite el mismo esfuerzo repite el mismo desbordamiento.
 */
export const reasoningEffortTruncado = () => loadToolPolicy().output?.reasoningEffortTruncado ?? null;

let _registro = null;
/** El registro, indexado por id. Una tool fuera de el NO EXISTE para el modelo. */
export function toolRegistry() {
  _registro ??= new Map(loadToolPolicy().tools.map((t) => [t.id, t]));
  return _registro;
}

/** Descripcion del catalogo para el prompt. Se genera del registro, nunca a mano. */
export function toolCatalogText() {
  return [...toolRegistry().values()].map((t) => {
    // La ELECCION entra al catalogo con sus valores. Una tool cuyo modo el modelo
    // no sabe que existe es una tool a medias: `run_gate` corria siempre --fast
    // porque nadie le dijo que podia pedir --full, y el revisor exigia justo la
    // evidencia que --fast no da (H-20260817-009c7621).
    const a = [
      ...(t.args ?? []),
      ...(t.optionalArgs ?? []).map((o) => `${o}?`),
      ...(t.choice ? [`${t.choice.arg}?: ${Object.keys(t.choice.values).join('|')} (por defecto ${t.choice.default})`] : []),
    ];
    return `- ${t.id}(${a.join(', ')}) — ${t.why}`;
  }).join('\n');
}

// ── Contencion ───────────────────────────────────────────────────────────────

/**
 * Resuelve una ruta DENTRO del workspace, o lanza.
 *
 * `resolve` normaliza `..` y hace que una ruta absoluta gane, asi que tanto
 * '../../etc/passwd' como '/etc/passwd' caen fuera de la base y se rechazan con
 * la misma comprobacion. No hay lista negra de patrones: hay una sola pregunta,
 * y es la unica que no se puede burlar escribiendo la ruta de otra forma.
 */
export function resolveInside(ws, ruta) {
  const base = resolve(ws?.path ?? '');
  if (!base || base === '/') throw new Error('workspace sin ruta: no hay donde contener nada');
  if (typeof ruta !== 'string' || !ruta.length) throw new Error('ruta vacia');

  const abs = resolve(base, ruta);
  if (abs !== base && !abs.startsWith(base + '/')) {
    throw new Error(`'${ruta}' resuelve a '${abs}', FUERA del workspace ${base}`);
  }
  return abs;
}

/** La misma ruta, relativa a la raiz del workspace: es la forma que entiende la frontera. */
export const relDe = (ws, abs) => relative(resolve(ws.path), abs);

// ── Autorizacion ─────────────────────────────────────────────────────────────

/**
 * ¿Puede esta capacidad hacer esta llamada? Devuelve el veredicto, no lanza:
 * un rechazo es informacion que el modelo debe recibir para corregirse.
 *
 * @returns {{allowed:boolean, rule:string, detail?:string, paths?:string[], action?:string}}
 */
export function authorize(cap, call, ws) {
  const t = toolRegistry().get(call?.tool);
  if (!t) {
    return { allowed: false, rule: 'registry', detail: `'${call?.tool}' no es una herramienta del harness` };
  }

  for (const k of t.args ?? []) {
    if (call.args?.[k] === undefined || call.args[k] === null) {
      return { allowed: false, rule: 'contract', detail: `'${t.id}' exige el argumento '${k}'` };
    }
  }

  // Una ELECCION entre valores en lista blanca. No es un argumento libre: el argv
  // sale del registro, y componerlo desde el modelo seria darle la shell. Un valor
  // fuera de la lista se RECHAZA en vez de caer al defecto en silencio -- un
  // `mode: "ful"` que corriera --fast dejaria al modelo creyendo que verifico algo
  // que no verifico, que es la forma de defecto que este repo persigue.
  if (t.choice) {
    const v = call.args?.[t.choice.arg];
    if (v !== undefined && !(v in t.choice.values)) {
      return {
        allowed: false,
        rule: 'choice',
        detail: `'${t.choice.arg}' debe ser uno de [${Object.keys(t.choice.values).join(', ')}], no '${v}'`,
      };
    }
  }

  // Las rutas primero: sin contencion, ninguna otra comprobacion importa.
  const rutas = [];
  for (const k of ['path', 'source', 'destination']) {
    if (typeof call.args?.[k] === 'string') {
      try {
        rutas.push(relDe(ws, resolveInside(ws, call.args[k])));
      } catch (e) {
        return { allowed: false, rule: 'sandbox', detail: e.message };
      }
    }
  }

  if (t.kind === 'write') {
    // TODAS las rutas, no solo la primera: `move_file` saca un fichero de un sitio
    // y lo mete en otro, y una capacidad no puede mover algo fuera de donde puede
    // escribir por el hecho de que el origen si estuviera permitido.
    const v = checkWriteBoundary(cap, rutas);
    if (v.length) return { allowed: false, rule: v[0].rule, detail: v.map((x) => x.detail).join(' · ') };
  }

  if (t.action) {
    const a = checkAction(cap, t.action);
    if (!a.allowed) return { allowed: false, rule: a.rule, detail: a.detail };
  }

  return { allowed: true, rule: t.kind, paths: rutas, action: t.action ?? null };
}

// ── Ejecucion ────────────────────────────────────────────────────────────────

const corta = (s, n) => {
  const x = String(s ?? '');
  return x.length <= n ? x : `${x.slice(0, n)}\n… [${x.length - n} caracteres mas, recortados por el harness]`;
};

/**
 * F-3 · EL RECORTE DEJA DE SER SILENCIOSO PARA EL REGISTRO.
 *
 * `corta` avisaba AL MODELO y a nadie mas. El ToolResult no llevaba el hecho, asi
 * que `Validation`, `Adversarial` y `Convergence` juzgaban una decision tomada
 * sobre una lista truncada sin saberlo. MEDIDO: un `search` de `label` sobre el
 * god-service devuelve 29 018 chars y se ven 8 000 -- el modelo vio 111 de 244
 * coincidencias, y para las etapas de abajo eso era indistinguible de haberlas
 * visto todas.
 */

/**
 * `ruta\tsha ...`, que es el `baseHash` que el Mutation Protocol va a exigir.
 *
 * EL FANTASMA SE DICE. `git ls-files` lista el INDICE, y `move_file` renombra en
 * disco sin tocarlo: despues de una mudanza el origen sigue saliendo en el
 * listado aunque ya no exista. Un listado que lo calla manda al modelo a leer una
 * ruta muerta -- paso en H-20260820-481ff307, donde el builder tuvo que
 * descubrirlo por su cuenta con `git_status` y dejarlo escrito en su resumen.
 */
function conSha(ws, ruta) {
  try {
    const abs = resolveInside(ws, ruta);
    if (existsSync(abs) && statSync(abs).isFile()) {
      return `${ruta}\tsha ${hashDe(readFileSync(abs))}`;
    }
    return `${ruta}\tAUSENTE (git lo indexa, el disco no lo tiene)`;
  } catch { return ruta; }
}

const recortar = (s, n) => {
  const x = String(s ?? '');
  return x.length <= n
    ? { output: x, truncated: false }
    : { output: corta(x, n), truncated: true, omittedChars: x.length - n, totalChars: x.length };
};

/**
 * El indice DEL WORKSPACE, no el del arbol principal.
 *
 * Un workspace es un worktree donde el builder ya ha escrito: el indice del arbol
 * principal apuntaria a lineas que ahi se han movido. Construirlo cuesta 164 ms
 * la primera vez y 5 ms refrescarlo -- se paga cada llamada porque un rango
 * desactualizado es peor que una espera.
 */
const _indices = new Map();
function indiceDe(ws) {
  const i = indexar({ root: ws.path, previo: _indices.get(ws.path) ?? null });
  _indices.set(ws.path, i);
  return i;
}

/** Estado de un fichero AHORA, que es contra lo que se compara la intencion. */
const estadoDe = (abs) => existsSync(abs)
  ? { exists: true, currentHash: hashDe(readFileSync(abs)) }
  : { exists: false, currentHash: null };

/**
 * Lo que `git apply` no puede adivinar, comprobado ANTES de llamarlo.
 *
 * MEDIDO en H-20260820-4d51dd67: 15 `apply_patch`, 5 en verde. Los ocho fallos no
 * eran de git ni del cambio -- eran peticiones que se podian rechazar sin salir de
 * este fichero: dos parches VACIOS, uno sin cabecera, y dos sin una sola linea de
 * contexto. La prueba del ultimo caso es limpia: la llamada 12 y la 13 hacian EL
 * MISMO cambio sobre EL MISMO fichero, y la unica diferencia era que la 13 llevaba
 * tres lineas sin tocar. `git apply` situa un hunk por las lineas que NO cambian.
 *
 * Y el motivo se DICE. Antes esto llegaba a git, que contestaba «el parche no
 * aplica» -- cierto e inutil--, y el builder gastaba tres llamadas por intento:
 * fallar, releer, reintentar. `agentic.mjs` ya lo tiene escrito al devolver un
 * rechazo: una politica que no ensena solo consigue que se repita.
 */
export function revisarParche(patch, path = null) {
  const t = String(patch ?? '');
  if (!t.trim()) return 'el parche viene VACIO: no hay nada que aplicar';
  if (!/^--- /m.test(t) || !/^\+\+\+ /m.test(t)) {
    return 'falta la cabecera del diff: un parche empieza por `--- a/<ruta>` y `+++ b/<ruta>`';
  }
  if (!/^@@/m.test(t)) return 'falta la cabecera de hunk: `@@ -<linea>,<n> +<linea>,<n> @@`';

  // EL PARCHE DECIDE DONDE ESCRIBE, y `path` solo decidia donde se MIRABA.
  //
  // `git apply` obedece a las cabeceras del diff; el `path` declarado no le llega.
  // Servia para dos cosas -- la contencion (`resolveInside`) y el Mutation
  // Protocol (`baseHash`, `before`, `after`)--, y las dos se aplicaban sobre un
  // fichero que el parche no tenia por que tocar. De ahi salian tres cosas:
  //
  //   1. Se verificaba la version de A y se escribia en B. Es EXACTAMENTE lo que
  //      la regla del protocolo prohibe -- «nunca se aplica un cambio contra una
  //      version desconocida»-- burlada por el unico camino que no la miraba.
  //   2. La bitacora media el hash de A, que no habia cambiado, mientras git veia
  //      cambiar B. Las dos autoridades del ChangeSet describian ficheros
  //      distintos, y quien las comparaba encontraba una contradiccion sin
  //      mentiroso (ver `carearConGit` en mutation.mjs).
  //   3. Si B caia fuera de `task.files`, no lo veia nadie hasta el final de la
  //      etapa 7, donde la frontera LANZA y el `onFail: ROLLBACK` destruye el
  //      workspace: el rechazo llegaba cuando ya no se podia corregir.
  //
  // Una llamada declara UN `path` y UN `baseHash`, asi que versiona un fichero:
  // el parche tiene que tocar ese y solo ese. Un cambio en varios son varias
  // llamadas, cada una con su hash. Se rechaza aqui, donde el modelo aun puede
  // corregirse, y no en la frontera, donde ya solo queda el rollback.
  if (path) {
    const declarada = String(path).replace(/^\.\//, '');
    const ajenas = rutasDelParche(t).filter((r) => r !== declarada);
    if (ajenas.length) {
      return `el parche dice tocar ${ajenas.map((r) => `'${r}'`).join(', ')} y declaraste `
        + `'path: ${declarada}'. \`git apply\` obedece a las cabeceras \`--- a/<ruta>\` y `
        + `\`+++ b/<ruta>\`, no al \`path\`: escribiria en otro fichero del que nadie ha `
        + `declarado el \`baseHash\`. Reescribe las cabeceras con '${declarada}', o haz una `
        + `llamada por fichero con el \`baseHash\` de cada uno`;
    }
  }
  // Un fichero nuevo no tiene contexto que dar, y ahi la ausencia es correcta.
  if (/^--- \/dev\/null/m.test(t)) return null;
  if (!t.split('\n').some((l) => l.startsWith(' '))) {
    return 'ningun hunk lleva lineas de CONTEXTO. `git apply` localiza un hunk por las lineas '
      + 'que NO cambian, asi que uno de solo `-` y `+` no se puede situar y falla con «el parche '
      + 'no aplica». Incluye 3 lineas sin tocar antes y despues, cada una con su espacio inicial';
  }
  return null;
}

/**
 * Las rutas que un parche dice tocar, leidas de sus cabeceras.
 *
 * Un encabezado son DOS lineas SEGUIDAS, y exigir el par no es rigor de mas: una
 * linea `-- comentario` BORRADA de un .sql llega al diff como `--- comentario`, y
 * leerla como una ruta convertiria un parche correcto en un rechazo -- la misma
 * forma de defecto que esta funcion existe para evitar, del otro lado.
 */
export const rutasDelParche = (patch) => {
  const ls = String(patch ?? '').split('\n');
  const rutas = new Set();
  for (let i = 0; i < ls.length - 1; i++) {
    if (!ls[i].startsWith('--- ') || !ls[i + 1].startsWith('+++ ')) continue;
    for (const l of [ls[i], ls[i + 1]]) {
      // El tabulador con la fecha detras lo pone `diff -u`; git no, pero un parche
      // escrito por un modelo si. Y `git apply` corre con -p1, asi que se quita el
      // prefijo `a/` o `b/` -- ESE, no un componente cualquiera: un parche sin
      // prefijo se deja tal cual para no inventar una ruta distinta de la que git
      // va a buscar.
      const r = l.slice(4).split('\t')[0].trim().replace(/^[ab]\//, '');
      if (r && r !== '/dev/null') rutas.add(r);
    }
  }
  return [...rutas];
};

const gitEn = (ws, args, tope) =>
  run('git', args, { cwd: ws.path, env: ENV_LIMPIO(), maxBuffer: 32 * 1024 * 1024, timeout: 60000 })
    .then((r) => ({ ok: true, exitCode: 0, ...recortar(r.stdout || '(sin salida)', tope) }))
    // `git grep` sale 1 cuando no encuentra nada, y `git apply` cuando el parche no
    // aplica. Las dos son respuestas legitimas: el modelo debe VERLAS, no recibir
    // una excepcion que le oculte el motivo.
    .catch((e) => ({ ok: true, exitCode: e.code ?? 1, ...recortar(`${e.stdout ?? ''}${e.stderr ?? ''}`.trim() || e.message, tope) }));

/**
 * Ejecuta una llamada YA autorizada. Devuelve siempre un ToolResult.
 *
 * `ok` dice si la HERRAMIENTA funciono; `exitCode`, si el comando tuvo exito.
 * No son lo mismo y confundirlos es como un test rojo se lee como una tool rota:
 * `run_test` con tests en rojo es una ejecucion PERFECTA -- es justo el hecho que
 * el builder necesita observar.
 */
export async function runTool(call, { cap, ws, policy = loadToolPolicy() }) {
  const t0 = Date.now();
  const tope = policy.loop?.maxToolResultChars ?? 8000;
  const t = toolRegistry().get(call.tool);

  const auth = authorize(cap, call, ws);
  if (!auth.allowed) {
    return {
      tool: call.tool, args: call.args ?? {}, ok: false, allowed: false,
      rule: auth.rule, error: auth.detail, ms: Date.now() - t0,
    };
  }

  const a = call.args ?? {};
  const P = (k) => resolveInside(ws, a[k]);
  let r;

  // LA PUERTA DEL PROTOCOLO DE MUTACION. Antes de tocar el disco, se compara lo
  // que el modelo CREE que hay con lo que hay. Va aqui y no dentro de cada `case`
  // para que no haya una quinta operacion que se escriba manana sin pasar por
  // ella: una regla que cada caso decide si aplicar no es una regla.
  let mut = null;
  if (t.kind === 'write') {
    const abs = P(t.id === 'move_file' ? 'source' : 'path');
    const antes = estadoDe(abs);
    const v = checkMutation({
      op: t.id, path: a.path ?? a.source, baseHash: a.baseHash, ...antes,
    });
    if (!v.ok) {
      // EL RECHAZO DICE TAMBIEN LO QUE HABRIA PASADO DESPUES.
      //
      // El orden --protocolo primero, cuerpo del caso despues-- es deliberado y no
      // se toca: una regla que cada caso decide si aplicar no es una regla. Pero
      // eso deja al modelo con la respuesta del escalon de arriba y sin la del
      // suyo, y las dos son ciertas a la vez.
      //
      // MEDIDO en H-20260823-4e052d0a, llamada 86: `apply_patch` con
      // `baseHash: null` Y `patch: ''`. Se le contesto «sin baseHash», asi que
      // gasto la iteracion siguiente en conseguir el hash de un parche que no
      // podia aplicar nunca. `revisarParche` lo habria dicho en una linea, pero
      // vive dentro del `case` y el `case` no llego a correr.
      const forma = t.id === 'apply_patch' ? revisarParche(a.patch, a.path) : null;
      return {
        tool: t.id, args: a, allowed: true, rule: 'mutation', code: v.code,
        ok: false,
        error: forma ? `${v.detail} — y ademas: ${forma}` : v.detail,
        ms: Date.now() - t0,
      };
    }
    mut = { abs, before: antes.currentHash };
  }

  try {
    switch (t.id) {
      case 'read_file': {
        const abs = P('path');
        if (!existsSync(abs)) { r = { ok: true, exitCode: 1, output: `'${a.path}' no existe en el workspace` }; break; }
        const bruto = readFileSync(abs);
        const lineas = bruto.toString('utf8').split('\n');
        const from = Math.max(0, (a.offset ?? 1) - 1);
        const hasta = Math.min(lineas.length, a.limit ? from + a.limit : lineas.length);
        r = {
          ok: true, exitCode: 0,
          // El hash viaja CON el contenido. Es el token que la mutacion va a
          // exigir, y darlo aqui evita que el modelo tenga que gastar una llamada
          // extra en `inspect_file` solo para poder escribir.
          hash: hashDe(bruto),
          // C-2 · LA VENTANA SE DECLARA. Un `read_file` sin `limit` sobre
          // `aafa.service.ts` devolvia el 0,70 % del fichero y no lo decia: el
          // modelo se llevaba 8 000 chars creyendo que eran el fichero. Ahora sabe
          // cuanto hay, que trozo tiene y que le falta -- que es la diferencia
          // entre leer una ventana y creer que has leido el fichero.
          totalLines: lineas.length,
          from: from + 1,
          to: hasta,
          ...recortar(
            `[sha ${hashDe(bruto)}] [lineas ${from + 1}-${hasta} de ${lineas.length}]\n`
            + lineas.slice(from, hasta).map((l, i) => `${from + i + 1}\t${l}`).join('\n'),
            tope,
          ),
        };
        break;
      }
      case 'read_symbol': {
        // C-2 · LA UNIDAD DE LECTURA ES EL SIMBOLO.
        //
        // F-4 decia «que la tarea diga donde mirar», y eso pone la carga en quien
        // redacta la tarea y caduca en cuanto alguien la redacta mal. Aqui la
        // carga esta en la herramienta: el indice ya sabe donde vive el simbolo.
        //
        // MEDIDO: `aafa.service.ts` son 20 523 lineas y exporta DOS simbolos, uno
        // de ellos la clase entera. Sus 223 metodos tienen una mediana de 24
        // lineas. La diferencia entre poder tocar ese fichero y no poder es esta.
        const indice = indiceDe(ws);
        const sitios = localizar(indice, String(a.symbol), { path: a.path ?? null });
        if (!sitios.length) {
          r = {
            ok: true, exitCode: 1,
            output: `'${a.symbol}' no esta en el indice${a.path ? ` dentro de '${a.path}'` : ''}. `
              + 'El indice dice DONDE esta lo que existe; no encontrarlo no prueba que no exista '
              + '(puede no ser un export ni un metodo de clase). Prueba `search`.',
          };
          break;
        }
        // Varios sitios NO se resuelven eligiendo uno: se dicen. Adivinar cual
        // queria el modelo es la clase de ayuda que produce un parche en el
        // fichero equivocado.
        if (sitios.length > 1 && !a.path) {
          r = {
            ok: true, exitCode: 1,
            output: `'${a.symbol}' esta en ${sitios.length} sitios. Repite con \`path\`:\n`
              + sitios.map((x) => `  ${x.path}:${x.from}-${x.to} (${x.kind})`).join('\n'),
          };
          break;
        }
        const sitio = sitios[0];
        const absS = resolveInside(ws, sitio.path);
        if (!existsSync(absS)) { r = { ok: true, exitCode: 1, output: `el indice apunta a '${sitio.path}', que no esta en el workspace` }; break; }
        const bufS = readFileSync(absS);
        const sha = hashDe(bufS);
        const ls = bufS.toString('utf8').split('\n');
        r = {
          ok: true, exitCode: 0, hash: sha,
          path: sitio.path, from: sitio.from, to: sitio.to, totalLines: ls.length,
          // EL SHA SE VERIFICA. El indice es navegacion, no verdad: si el fichero
          // cambio despues de indexarse, el rango apunta a otro sitio. Se dice, y
          // el contenido se sirve igual --es el fichero real-- pero nadie puede
          // afirmar que sea el simbolo que pidio.
          ...(sitio.sha === undefined || ls.length < sitio.to ? { stale: true } : {}),
          ...recortar(
            `[sha ${sha}] [${sitio.path}:${sitio.from}-${sitio.to} · ${sitio.kind}`
            + `${sitio.parent ? ` de ${sitio.parent}` : ''} · el fichero tiene ${ls.length} lineas]\n`
            + ls.slice(sitio.from - 1, sitio.to).map((l, i) => `${sitio.from + i}\t${l}`).join('\n'),
            tope,
          ),
        };
        break;
      }
      case 'search':
        // `-E`: regex EXTENDIDA. `git grep` usa basica por defecto, donde `\(`
        // abre un grupo -- asi que `fmtSize\(`, que es lo que cualquier modelo
        // escribe para buscar una llamada, sale 128 «unmatched ( or \(» y el
        // builder gasta un turno en un error que no es suyo. Medido dos veces en
        // H-20260816-52af3889 y H-20260816-bebf4372.
        r = await gitEn(ws, ['grep', '-nE', '--untracked', '-e', String(a.pattern), ...(a.path ? ['--', a.path] : [])], tope);
        break;
      case 'list_files': {
        // UN SOLO PRESUPUESTO, y por eso el listado con `path` NO pasa por `recortar`.
        //
        // Con dos, ninguno sabia del otro: `gitEn` cortaba por caracteres, se
        // anadian 21 por linea de sha, y se volvia a cortar. MEDIDO por third sobre
        // `src backend/src`: git listaba 718 ficheros, sobrevivian 166 al primer
        // corte, y `omittedFiles` reportaba 41 -- los 551 perdidos ANTES no entraban
        // en la cuenta. Un conteo que sub-reporta es peor que ninguno: sin el, la
        // etapa de abajo desconfia; con `omittedFiles: 41`, se lo cree.
        const inventario = Boolean(a.path);
        r = await gitEn(ws, ['ls-files', '--cached', '--others', '--exclude-standard', ...(a.path ? ['--', a.path] : [])], inventario ? Infinity : tope);
        // EL SHA VIAJA CON EL NOMBRE, por la misma razon que ya esta escrita en
        // `read_file`: es el token que la mutacion va a exigir despues. La
        // diferencia es que un `move_file` NO necesita leer el fichero -- solo
        // moverlo-- y aun asi el Mutation Protocol le pide su `baseHash`, asi que
        // sin esto una mudanza de N ficheros gasta N llamadas a `inspect_file` que
        // no aportan nada mas que el hash.
        //
        // MEDIDO en H-20260820-bd6fe99e: 40 iteraciones agotadas moviendo ficheros,
        // 3 de ellas DENY por `MUTATION_UNVERSIONED` sobre ficheros que el builder
        // no tenia ningun motivo para leer. `list_files` es justo la herramienta que
        // enumera lo que se va a mover, y era la unica de las tres que no lo llevaba.
        //
        // SOLO CON `path`, que es el inventario de una tarea. Sin `path` esto lista
        // el repo entero y es orientacion --el researcher tambien usa esta tool--,
        // no material de mutacion: ahi el sha son 21 chars por linea que le quitan
        // sitio a rutas que si necesita.
        //
        // Y NO HAY TOPE DE FICHEROS. Lo hubo --50, luego 200-- y era un numero
        // atado a nada: acotaba la POBLACION EQUIVOCADA. El tope contaba lo que
        // `list_files` devuelve, y lo unico que se podia comparar contra el era lo
        // que la spec DECLARA, que no es lo mismo: una tarea de 10 ficheros que
        // liste `src/` se trae 900 rutas sin sha y el contador en verde. Lo que
        // acota de verdad ya existia: el presupuesto de salida. Se hashea LO QUE
        // CABE, y lo que no cabe se dice.
        //
        // Antes, ademas, un listado truncado se quedaba sin NINGUN sha -- la
        // condicion era `!r.truncated`. O sea que el caso grande, que es justo
        // donde el ahorro vale mas, era el unico que no lo tenia. Y el intento
        // siguiente --quitar con `pop()` la ultima linea partida-- se llevaba el
        // MARCADOR que `corta` deja detras y dejaba dentro la ruta partida, que
        // `conSha` etiquetaba `AUSENTE (git lo indexa, el disco no lo tiene)`:
        // una afirmacion falsa que culpa a git de un corte del harness.
        if (inventario && r.exitCode === 0 && r.output !== '(sin salida)') {
          // La poblacion ENTERA: `todas` no viene recortada por nadie.
          const todas = r.output.split('\n').filter(Boolean);
          const lineas = [];
          let usado = 0;
          for (const ruta of todas) {
            const linea = conSha(ws, ruta);
            if (usado + linea.length + 1 > tope) break;
            usado += linea.length + 1;
            lineas.push(linea);
          }
          const omitidas = todas.length - lineas.length;
          r = {
            ...r,
            output: lineas.join('\n'),
            ...(omitidas > 0 ? { truncated: true, omittedFiles: omitidas } : {}),
          };
        }
        break;
      }
      case 'inspect_file': {
        const abs = P('path');
        if (!existsSync(abs)) { r = { ok: true, exitCode: 1, output: `${a.path}: NO EXISTE` }; break; }
        const buf = readFileSync(abs);
        r = {
          ok: true, exitCode: 0, hash: hashDe(buf),
          output: `${a.path}: ${statSync(abs).size} bytes · ${buf.toString('utf8').split('\n').length} lineas`
            + ` · sha ${hashDe(buf)}`,
        };
        break;
      }
      case 'git_diff':
        // EL MISMO DIFF QUE SE LE VA A MEDIR, y no otro parecido. Eran DOS: el
        // ChangeSet se construye con `git add -N` + `git diff -M HEAD`, y esta
        // herramienta corria `git diff HEAD` a secas. Las diferencias no son
        // cosmeticas -- sin `add -N` los ficheros NUEVOS no salen, y sin `-M` un
        // renombrado se lee como un borrado entero mas una creacion entera--,
        // asi que el builder miraba su trabajo por una ventana distinta de la que
        // usan la etapa 7 para medir la superficie y el revisor para juzgarlo.
        //
        // Muerde justo en la clase `move`, que vale por `similarity index 100%`:
        // un builder que comprueba su propio renombrado con esta tool no veria
        // ni un `rename from`, y no por haberlo hecho mal.
        //
        // Es la misma forma que `run_test` contra jest: una herramienta que no
        // alcanza lo que la aceptacion exige comprobar.
        r = { ok: true, exitCode: 0, ...recortar(diffDelWorkspace(ws) || '(sin cambios)', tope) };
        break;
      case 'git_status':
        r = await gitEn(ws, ['status', '--porcelain'], tope);
        break;

      case 'apply_patch': {
        P('path');                                   // contencion: ya validada, se repite por si acaso
        // Lo que este fichero puede decidir, lo decide aqui. Mandarselo a git para
        // que conteste «el parche no aplica» cuesta la misma llamada y explica menos.
        const mal = revisarParche(a.patch, a.path);
        if (mal) { r = { ok: true, exitCode: 1, output: `parche RECHAZADO antes de git: ${mal}` }; break; }
        const tmp = join(ws.path, '.harness-patch.diff');
        writeFileSync(tmp, String(a.patch).endsWith('\n') ? a.patch : `${a.patch}\n`);
        r = await gitEn(ws, ['apply', '--verbose', '--recount', tmp], tope);
        rmSync(tmp, { force: true });
        break;
      }
      case 'create_file': {
        const abs = P('path');
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, String(a.content));
        r = { ok: true, exitCode: 0, output: `escrito ${a.path} (${String(a.content).length} bytes)` };
        break;
      }
      case 'delete_file': {
        // La ausencia ya la rechazo checkMutation con MUTATION_MISSING: aqui el
        // fichero existe y su hash coincide con el que el modelo declaro.
        rmSync(P('path'), { force: true });
        r = { ok: true, exitCode: 0, output: `borrado ${a.path} (era ${mut.before})` };
        break;
      }
      case 'move_file': {
        const dst = P('destination');
        // El DESTINO tambien es una afirmacion: mover encima de algo es
        // sobrescribirlo sin declararlo. Se rechaza; para reemplazar hay que
        // borrar primero, con su hash.
        if (existsSync(dst)) {
          return {
            tool: t.id, args: a, allowed: true, rule: 'mutation', code: 'MUTATION_EXISTS',
            ok: false, error: `'${a.destination}' ya existe (${hashDe(readFileSync(dst))}): mover encima seria sobrescribir`,
            ms: Date.now() - t0,
          };
        }
        mkdirSync(dirname(dst), { recursive: true });
        renameSync(P('source'), dst);
        mut.abs = dst;                        // el `after` se mide en el destino
        r = { ok: true, exitCode: 0, output: `${a.source} -> ${a.destination}` };
        break;
      }

      default: {
        // exec: el argv sale del REGISTRO, no del modelo. Lo unico que el modelo
        // aporta son rutas, y solo si la tool las acepta -- ya contenidas por
        // `authorize`. Dejarle componer el comando seria darle la shell.
        const extra = t.acceptsPaths ? auth.paths : [];
        // La eleccion se traduce AQUI, del registro: el modelo manda una clave
        // ('full'), nunca el flag. `authorize` ya rechazo lo que no esta en la
        // lista, asi que aqui el valor es siempre valido o es el defecto.
        const elegido = t.choice
          ? [t.choice.values[a?.[t.choice.arg] ?? t.choice.default]]
          : [];
        // EL DIRECTORIO TAMBIEN SALE DEL REGISTRO. Todo comando corria en la raiz
        // del workspace, y eso basta mientras el repo tenga un solo proyecto npm:
        // tiene DOS -- la raiz (vitest) y `backend/` (jest)--, y la regla del repo
        // es que no se corren nunca a la vez.
        //
        // MEDIDO en H-20260819-e62bf69e, la primera vuelta que toco `backend/src`:
        // el builder llamo a `run_test` 40 veces, siempre en rojo, porque vitest
        // desde la raiz no ve un spec de jest. Agoto el tope de iteraciones y la
        // vuelta murio con ROLLBACK en la etapa 7. El techo estaba ESCRITO en el
        // `$ceiling` de `run_test` como trabajo aplazado; la primera tarea que lo
        // piso fue esta.
        const dir = t.cwd ? join(ws.path, t.cwd) : ws.path;
        const { stdout, stderr } = await run(t.cmd[0], [...t.cmd.slice(1), ...elegido, ...extra], {
          cwd: dir, env: ENV_LIMPIO(), timeout: t.timeoutMs ?? 300000, maxBuffer: 32 * 1024 * 1024,
        }).catch((e) => { throw Object.assign(e, { __cmd: true }); });
        r = { ok: true, exitCode: 0, output: corta(`${stdout}${stderr}`.trim() || '(sin salida)', tope) };
      }
    }
  } catch (e) {
    r = e.__cmd
      ? { ok: true, exitCode: e.code ?? 1, output: corta(`${e.stdout ?? ''}${e.stderr ?? ''}`.trim() || e.message, tope) }
      : { ok: false, error: e.message };
  }

  // El REGISTRO de la mutacion: hash antes y despues, medidos por el harness.
  // Se emite aunque el comando fallara (un `git apply` que no aplica deja
  // `changed: false`, y ese es el hecho que hay que poder ver en la traza).
  const mutation = mut
    ? mutationRecord({
      op: t.id, path: a.path ?? a.source, destination: a.destination ?? null,
      baseHash: a.baseHash ?? null, before: mut.before,
      after: estadoDe(mut.abs).currentHash,
      capability: cap?.id, workspace: ws.path,
    })
    : null;

  return {
    tool: t.id, args: a, allowed: true, rule: auth.rule, ms: Date.now() - t0,
    ...r, ...(mutation ? { mutation } : {}),
  };
}
