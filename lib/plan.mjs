// Resolucion de planes — ADR-005.
//
// El plan NO se copia al repo de codigo: la boveda YA es un repositorio en
// GitHub (EmmaAle11/doxia-second-brain). Se REFERENCIA pineado por commit, para
// que la misma orden lea el mismo texto dentro de un mes.
//
//   doxia-second-brain:DoxIA.md/Ingenieria/Plans/<fichero>.md@<commit>
//
// El texto resuelto se cachea DENTRO de la evidencia: si manana la boveda no
// esta disponible, se puede reconstruir que se ejecuto y contra que.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { ENV_LIMPIO } from './sandbox.mjs';

export const VAULTS = {
  'doxia-second-brain': process.env.DOXIA_VAULT || join(homedir(), 'Documentos', 'DoxIA'),
};

export function parseRef(ref) {
  const m = /^([\w-]+):(.+?)(?:@([0-9a-f]{7,40}|HEAD))?$/.exec(String(ref).trim());
  if (!m) {
    return {
      error:
        `referencia invalida: '${ref}'. Formato: ` +
        `<repo>:<ruta dentro del repo>[@<commit>]  p.ej. ` +
        `doxia-second-brain:DoxIA.md/Ingenieria/Plans/x.md@c7c28ba`,
    };
  }
  return { repo: m[1], path: m[2], commit: m[3] ?? 'HEAD' };
}

export function resolvePlan(ref) {
  const p = parseRef(ref);
  if (p.error) return p;

  const root = VAULTS[p.repo];
  if (!root || !existsSync(root)) {
    return { error: `repo '${p.repo}' no disponible localmente (${root ?? 'sin ruta'})` };
  }

  let commit;
  try {
    commit = execFileSync('git', ['rev-parse', p.commit], { cwd: root, env: ENV_LIMPIO(), encoding: 'utf8' }).trim();
  } catch {
    return { error: `commit '${p.commit}' no existe en ${p.repo}` };
  }

  let text;
  try {
    text = execFileSync('git', ['show', `${commit}:${p.path}`], {
      env: ENV_LIMPIO(),
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    // Fail-closed a proposito: un fichero que existe en disco pero no en el
    // commit NO se resuelve. Si se leyera del disco, la referencia dejaria de
    // estar pineada y la corrida no seria reproducible -- que es justo lo que
    // ADR-005 vino a garantizar.
    const enDisco = existsSync(join(root, p.path));
    return {
      error:
        `'${p.path}' no existe en ${p.repo}@${commit.slice(0, 7)}` +
        (enDisco ? '. Esta en disco SIN COMMITEAR: commitealo en la boveda para poder pinearlo.' : '.'),
    };
  }

  return {
    repo: p.repo,
    path: p.path,
    commit,                                   // SIEMPRE el sha completo: pineado de verdad
    ref: `${p.repo}:${p.path}@${commit.slice(0, 7)}`,
    sha256: createHash('sha256').update(text).digest('hex'),
    text,
  };
}

// ── el plan a `task`, con el vocabulario CERRADO ──────────────────────────────
//
// POR QUE CERRADO, y no es una preferencia de estilo.
//
// MEDIDO el 2026-08-26 midiendo si el anillo podria correr los tres planes de
// `third`. Escribi el extractor cinco veces y las cinco dio un numero distinto,
// porque cada version conocia un verbo menos del que el plan usaba:
//
//   v1  Create · Modify              -> 3 tareas «sin test», y era MI regex
//   v2  + Test                       -> 1 «sin test», y seguia siendo MI regex
//   v3  + Delete                     -> 0, y aparecio el numero real
//   v4  un backtick se lo comio el shell: el lookahead quedo vacio -> 14/14
//   v5  `\s*` acepta cero, asi que el espacio satisfacia la clase negada -> 44
//
// Las cuatro primeras PARECIAN resultados. Un extractor que ignora lo que no
// entiende no informa de lo que ignoro, y su silencio se lee como ausencia --
// `memory/failures/hable-de-una-poblacion-distinta-de-la-que-medi.md`, sub-clase
// C: un colador que se queda con lo que busca no puede informar de lo que falta.
//
// Por eso aqui un verbo desconocido es un PROBLEMA con su linea, nunca una linea
// que se salta. La conversion falla ruidosa y temprano, que es la unica forma de
// que el vocabulario se amplie a proposito en vez de por accidente.
export const VERBOS_FILES = {
  Create: 'crear', Modify: 'modificar', Modificar: 'modificar',
  Test: 'test', Delete: 'borrar',
};
const NO_TOCAR = /^\s*-?\s*\*\*No tocar:\*\*\s*`([^`]+)`/;
const LINEA_FILES = /^\s*-\s*\*{0,2}([A-Za-zÁ-úñ][A-Za-zÁ-úñ ]{0,18}?)\*{0,2}:\s*(.*)$/;
const RUTA = /^`([^`]+)`/;
// Una ruta que no nombra un fichero que pueda existir. `task.files` compara por
// PERTENENCIA EXACTA en los tres sitios que la usan (ver spec.mjs), asi que una
// plantilla o un ancla mal escrita no es un detalle de formato: es una entrada
// que jamas casara.
const PLANTILLA = /YYYYMMDD|<[^>]+>|NNNN|\bXXXX\b/;
const ANCLA_ROTA = /\.[a-z]+-\d+$/;

/** `ruta.ts:356` y `ruta.ts:160-231` nombran la MISMA ruta. */
const sinAncla = (p) => p.replace(/:\d+(?:-\d+)?$/, '');

/**
 * Deriva las tareas de un plan en markdown. NO decide si son ejecutables: eso es
 * `spec.revisar()`. Aqui solo se lee, y se dice todo lo que no se supo leer.
 */
export function tareasDePlan(texto) {
  const src = String(texto ?? '');
  const bloques = src.split(/^#{2,3} (?:Task|Tarea) /m).slice(1);
  const tareas = []; const problemas = [];

  // CERO TAREAS NO ES UN PLAN LIMPIO. Un documento sin bloques `## Task N` y uno
  // que los declara con otro encabezado dan la MISMA salida --0 tareas, 0
  // problemas-- y la segunda se lee como exito. MEDIDO nada mas cablear esto:
  // `2026-08-20-torre-de-control-…-plan.md` de la boveda salio «0 tarea(s) · 0
  // problema(s)», y hubo que abrirlo a mano para saber que de verdad no declara
  // tareas. La primera version de esta funcion tenia el hueco que la funcion
  // existe para cerrar.
  //
  // Se dice lo que se buscaba Y lo que se encontro, para que quien lo lea
  // distinga «no hay tareas» de «no supe verlas».
  if (!bloques.length) {
    const encabezados = [...src.matchAll(/^#{1,3} (.+)$/gm)].map((m) => m[1].trim());
    problemas.push(
      'CERO bloques `## Task N` / `## Tarea N` — esto NO significa «plan sin problemas». '
      + (encabezados.length
        ? `Los encabezados que SI hay: ${encabezados.slice(0, 6).map((h) => `«${h.slice(0, 44)}»`).join(', ')}`
          + `${encabezados.length > 6 ? ` (+${encabezados.length - 6})` : ''}`
        : 'El documento no tiene ningun encabezado markdown.'),
    );
  }
  bloques.forEach((b, i) => {
    const n = i + 1;
    const titulo = b.split('\n')[0].trim();
    const lineas = b.split('\n');
    const iFiles = lineas.findIndex((l) => /^\s*\*\*Files:\*\*/.test(l));
    const files = []; const forbiddenPaths = []; const acciones = [];
    if (iFiles < 0) {
      problemas.push(`T${n} (${titulo.slice(0, 40)}): sin bloque **Files:** — no hay allowlist que derivar`);
    } else {
      for (const l of lineas.slice(iFiles + 1)) {
        // El bloque termina en el siguiente **Xxx:** que NO sea una entrada.
        if (/^\s*\*\*[A-Za-zÁ-úñ]/.test(l) && !NO_TOCAR.test(l)) break;
        const noTocar = NO_TOCAR.exec(l);
        if (noTocar) { forbiddenPaths.push(noTocar[1]); continue; }
        const m = LINEA_FILES.exec(l);
        if (!m) continue;
        const [, verbo, resto] = m;
        if (!(verbo in VERBOS_FILES)) {
          problemas.push(`T${n}: verbo NO DECLARADO '${verbo}' — ${l.trim().slice(0, 70)}`);
          continue;
        }
        const r = RUTA.exec(resto);
        if (!r) {
          problemas.push(`T${n}: '${verbo}' sin ruta, la referencia es prosa — «${resto.trim().slice(0, 50)}»`);
          continue;
        }
        const ruta = sinAncla(r[1]);
        if (PLANTILLA.test(ruta)) problemas.push(`T${n}: ruta PLANTILLA, no existira nunca — ${ruta}`);
        else if (ANCLA_ROTA.test(ruta)) problemas.push(`T${n}: ancla con guion donde va ':' — ${ruta}`);
        else { files.push(ruta); acciones.push({ verbo: VERBOS_FILES[verbo], ruta }); }
      }
    }
    tareas.push({
      n, goal: titulo,
      files: [...new Set(files)],
      acciones,
      forbiddenPaths: [...new Set(forbiddenPaths)],
      acceptance: [...b.matchAll(/^-\s*\[ \]\s*\*\*([^*]+)\*\*/gm)].map((x) => x[1].trim()),
    });
  });
  return { tareas, problemas };
}

/**
 * LAS RUTAS DEL PLAN CONTRA EL ARBOL — paso 2 del plan de conversion.
 *
 * `task.files` compara por PERTENENCIA EXACTA en los tres sitios que la usan
 * (ver `spec.mjs`), asi que una ruta que no case es una entrada muerta. Y el
 * verbo dice QUE se espera de ella:
 *
 *   modificar · borrar   -> TIENE que existir. Si no, el builder no encontrara
 *                          nada que cambiar y la vuelta se gasta descubriendolo
 *                          dentro.
 *   crear                -> NO tiene que existir. Si ya esta, o el plan esta
 *                          viejo o va a sobrescribir trabajo ajeno.
 *   test                 -> NI UNA COSA NI OTRA, y no se comprueba.
 *
 * `Test:` NO SE COMPRUEBA, Y ESO ES EL ARREGLO. La primera version lo metia con
 * `modificar` y `borrar`, y al correrla contra los planes de `third` dio TRES
 * hallazgos --`correos-migrados.spec.ts`, `correos-aafa.spec.ts`,
 * `una-plantilla-por-correo.spec.ts`-- que eran los tres FALSOS: son los tests
 * que esa tarea va a ESCRIBIR. `Test:` nombra el fichero de prueba de la tarea,
 * y que exista o no depende de si la tarea lo crea o lo amplia. Un verbo cuyo
 * estado esperado es ambiguo no puede producir un veredicto: se calla.
 *
 * Un falso SPECIFICATION_BLOCKED es el peor fallo de un preflight --lo dice el
 * comentario de `spec.mjs` que gobierna la regla 3-- porque bloquea antes de que
 * nada pueda desmentirlo. Tres de cuatro hallazgos de la primera version lo eran.
 *
 * MEDIDO el 2026-08-26 sobre los planes de `third`: `AdminConfiguracion.tsx`
 * declarado `Modify` y ausente del tronco. Nadie lo veia hasta que el builder
 * fallara dentro de la vuelta, que es donde mas caro sale.
 *
 * `existe` se INYECTA a proposito: esta funcion es pura y se prueba sin arbol.
 * Si no se pasa, no se adivina -- se declara que no se pudo mirar, que no es lo
 * mismo que «todo bien».
 */
export function rutasContraElArbol(tareas, existe) {
  if (typeof existe !== 'function') {
    return ['CIEGO: sin forma de comprobar si las rutas existen. Esto NO es «las rutas estan bien»: '
          + 'es que no se miro. Pasa un predicado `existe(ruta)`.'];
  }
  const p = [];
  for (const t of tareas ?? []) {
    for (const { verbo, ruta } of t.acciones ?? []) {
      const hay = existe(ruta);
      if (hay === null || hay === undefined) {
        p.push(`T${t.n}: no se pudo comprobar '${ruta}' — sin resultado, que no es «no existe»`);
      } else if (verbo === 'crear' && hay) {
        p.push(`T${t.n}: 'Create' sobre algo que YA existe — ${ruta}`);
      } else if (verbo === 'modificar' || verbo === 'borrar') {
        if (!hay)
        p.push(`T${t.n}: '${verbo}' sobre algo que NO existe en el arbol — ${ruta}`);
      }
    }
  }
  return p;
}
