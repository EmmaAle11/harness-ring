/**
 * Logica pura que decide algo y no tiene un solo test al lado.
 *
 * CLAUDE.md declara la forma buena de este repo: «los predicados y
 * transformaciones viven en archivos sueltos junto al servicio con su `.spec.ts`
 * al lado, y el `.service.ts` solo orquesta». El piso de tests detecta que un
 * test DESAPAREZCA; no detecta que un fichero no haya tenido ninguno nunca.
 *
 * LO QUE COSTO, y es de hoy. `sas-acta.guard.ts` y `sas.ts` decidian si se emite
 * una carta y no tenian un solo test: una linea de junio estrecho el predicado
 * --`^SAS\d+` en vez de «folio presente»-- y cerro esa puerta en produccion sin
 * que nada fallara. El mismo dia, `resolvePoderPrincipal` decidia QUE Poder firma
 * una carta y tampoco tenia ninguno.
 *
 * Un predicado de decision sin test no es deuda: es una autoridad que cualquiera
 * puede cambiar en silencio.
 *
 * LA DEFINICION ES ESTRECHA A PROPOSITO. Un `.tsx` es un componente y se prueba
 * de otra forma; un `.service.ts` de Nest es marco. Aqui entra lo que es
 * literalmente logica: un `.ts` que EXPORTA funciones y no arrastra ni React ni
 * decoradores de Nest. Medido el 21-ago con esta definicion: 139 ficheros, 78 con
 * spec, 61 sin. Con una definicion ancha salian 325 y 227, y ese numero no
 * distingue un predicado de una pantalla.
 *
 * PURO: recibe los ficheros ya leidos. Sin E/S no hace falta montar un arbol de
 * mentira para probarlo.
 */

const MARCO = /\.(service|controller|module|dto|entity|guard|interceptor|middleware|pipe|strategy|filter)\.ts$/;
const NEST = /@(Injectable|Controller|Module|Entity|Column|Global|Catch)\(/;
const REACT = /from\s+['"]react['"]/;

/** ¿Este fichero es logica pura, de la que CLAUDE.md dice que lleva su spec al lado? */
export function esLogicaPura({ path, texto } = {}) {
  if (!path || !path.endsWith('.ts')) return false;
  if (/\.(spec|test)\.ts$/.test(path)) return false;
  if (!(path.startsWith('src/') || path.startsWith('backend/src/'))) return false;
  if (MARCO.test(path)) return false;
  const t = String(texto ?? '');
  if (NEST.test(t) || REACT.test(t)) return false;
  return /export\s+(function|const|default function)/.test(t);
}

/** La ruta del spec hermano, en las cuatro formas que este repo usa. */
export const hermanos = (path) => {
  const base = path.replace(/\.tsx?$/, '');
  return ['.spec.ts', '.spec.tsx', '.test.ts', '.test.tsx'].map((s) => base + s);
};

/**
 * @param ficheros [{path, texto}] — todos los del repo, ya leidos
 * @param existe   (ruta) => boolean
 * @returns {pura, conSpec, sinSpec:[rutas]}
 */
export function revisar(ficheros = [], existe = () => false) {
  const pura = (ficheros ?? []).filter(esLogicaPura).map((f) => f.path);
  const sinSpec = pura.filter((p) => !hermanos(p).some(existe));
  return { pura: pura.length, conSpec: pura.length - sinSpec.length, sinSpec };
}

// ── CLI para `scripts/gate.sh` (A.4 de CODETA) ───────────────────────────────
// Imprime `<pura> <sinSpec>` en la primera linea y la lista de ficheros sin spec
// en las siguientes. Solo lee lo VERSIONADO (`git ls-files`): lo no trackeado no
// es del arbol que se juzga.
//
// PORTADO de `feat/staging-aafa` (92f54ad6) el 2026-09-22: la etapa `divergencia`
// del gate lo pedia -- las otras cuatro ramas tenian el control `logica_sin_test`
// y esta no, y un fichero versionado tiene una copia POR RAMA.
//
// CON `ENV_LIMPIO`, QUE EL ORIGINAL NO LLEVA: dentro de un hook de git, GIT_DIR y
// GIT_INDEX_FILE apuntan al repo PRINCIPAL, asi que `git ls-files` leeria el
// indice equivocado y contaria ficheros de otro arbol. El guarda
// «nada del harness llama a git sin ENV_LIMPIO» (stages.test.mjs) lo exige, y
// existe porque ese fallo borro 1181 ficheros y se empujo a origin.
import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { execFileSync } = await import('node:child_process');
  const { readFileSync, existsSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { ENV_LIMPIO } = await import('./sandbox.mjs');
  const root = process.argv[2] || process.cwd();
  const rutas = execFileSync('git', ['ls-files', '--', '*.ts'], {
    cwd: root, encoding: 'utf8', env: ENV_LIMPIO(),
  }).split('\n');
  const ficheros = rutas.filter(Boolean).map((p) => {
    try { return { path: p, texto: readFileSync(join(root, p), 'utf8') }; } catch { return null; }
  }).filter(Boolean);
  const r = revisar(ficheros, (p) => existsSync(join(root, p)));
  process.stdout.write(`${r.pura} ${r.sinSpec.length}\n${r.sinSpec.join('\n')}\n`);
}
