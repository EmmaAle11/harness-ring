// ¿LE FALTA A ESTA RAMA UNA ETAPA QUE OTRA YA TIENE?
//
// `scripts/gate.sh` se declara «autoridad única» del definition of done. Lo es DENTRO de un
// árbol y NO entre árboles: un fichero versionado tiene una copia por rama. El 2026-08-27 el
// cerrojo de `--full` entró en `feat/audit-doxia` y tardó TRES DÍAS en llegar a la rama que
// despliega, porque nadie tenía forma de verlo. Esta etapa es esa forma.
//
// LA REGLA (decidida entre `second` y `third` el 2026-08-30):
//   la rama X falla si carece de una etapa que otra rama tiene Y QUE ES APLICABLE A X.
// Simétrica y local: cada puerta responde por SU déficit y por nada más. Estar ADELANTADO
// nunca es un déficit, así que las seis etapas propias de `harness-doxia` no ensucian a nadie.
//
// «Aplicable» NO lo decide este guarda: lo declara quien conoce la rama, en
// `harness/policy/etapas-no-aplicables.json`, con motivo y FECHA. La fecha es presión, no
// fallo: una declaración de tres meses se ve en la lista; una de hoy no molesta. Sin ella
// «declarada» es un cajón sin fondo y la comprobación acaba siendo papeleo.
//
// LAS REFS SON UNA CONSTANTE ESCRITA, no derivada de `git branch`: una rama de usar y tirar
// con un `gate.sh` tocado inyectaría déficits fantasma en todas las demás a la vez. Una
// constante escrita se mantiene; una derivada te sorprende.
//
// Y SI NO PUEDE RESOLVER LAS REFS, NO APRUEBA. Un guarda de divergencia que sale verde porque
// no encontró con qué comparar es `memory/failures/el-instrumento-que-confunde-error-con-vacio.md`.
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { ENV_LIMPIO } from './sandbox.mjs';
import { ROOT } from './capabilities.mjs';

export const REFS = [
  'origin/feat/audit-doxia',
  'origin/feat/staging-aafa',
  'origin/feat/harness-doxia',
  'origin/main',
];

/** Etapas con nombre LITERAL. Las que registran con variable (`record "$label"`) no se pueden
 *  juzgar por nombre, y contarlas daría un déficit fantasma en cuanto otra rama las renombre. */
export function etapasDe(fuente) {
  const out = new Set();
  for (const m of fuente.matchAll(/(?:^|\n)\s*record\s+("?)([A-Za-z_][\w:]*)\1\s/g)) out.add(m[2]);
  return out;
}

// ENV_LIMPIO Y `cwd: ROOT` (hallazgo del guardian de `stages.test.mjs` al fusionar, 2026-09-07).
// Sin ellos, dentro de un hook de git este `git show` hereda GIT_DIR/GIT_WORK_TREE del proceso que
// lo invoca y opera sobre OTRO repositorio: leeria las etapas del arbol equivocado y compararia
// ramas que no son estas. El fallo no seria un error, seria un diagnostico plausible sobre otro
// repo -- la misma clase que este fichero existe para medir.
const git = (args) => execFileSync('git', args, { cwd: ROOT, env: ENV_LIMPIO(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

/** `null` si la ref no se puede leer — el llamador lo traduce a NOT_CONFIGURED, nunca a PASS. */
export function etapasDeRef(ref, fichero = 'scripts/gate.sh') {
  try {
    return etapasDe(git(['show', `${ref}:${fichero}`]));
  } catch {
    return null;
  }
}

/** `{ techo: {rama: n}, declaradas: {rama: {etapa: {motivo, desde}}} }` */
export function poliza(ruta) {
  if (!existsSync(ruta)) return { techo: {}, declaradas: {} };
  try {
    const j = JSON.parse(readFileSync(ruta, 'utf8'));
    return { techo: j.techo ?? {}, declaradas: j.declaradas ?? {} };
  } catch {
    return { techo: {}, declaradas: {} };
  }
}

/**
 * El déficit de `rama`: etapas que otra ref tiene, ella no, y que NO están declaradas
 * inaplicables. Devuelve también las declaradas, con su antigüedad en días.
 */
export function deficit({ rama, porRef, decls = {}, hoy = new Date() }) {
  const mias = porRef[rama];
  if (!mias) throw new Error(`sin etapas para ${rama}`);
  const declRama = decls[rama.replace(/^origin\//, '')] ?? {};
  const sinDeclarar = [];
  const declaradas = [];
  const ajenas = new Map();
  for (const [ref, set] of Object.entries(porRef)) {
    if (ref === rama || !set) continue;
    for (const e of set) if (!mias.has(e) && !ajenas.has(e)) ajenas.set(e, ref);
  }
  for (const [etapa, ref] of [...ajenas].sort()) {
    const d = declRama[etapa];
    if (d) {
      const dias = d.desde ? Math.floor((hoy - new Date(d.desde)) / 86400000) : null;
      declaradas.push({ etapa, ref, motivo: d.motivo ?? '(sin motivo)', dias });
    } else {
      sinDeclarar.push({ etapa, ref });
    }
  }
  return { sinDeclarar, declaradas };
}

/** Quién la trajo y cuándo — un rojo que dice «te falta X, la puso Y el día Z» es una tarea;
 *  uno que dice sólo «te falta X» es un obstáculo, y a los pocos días alguien lo apaga. */
export function procedencia(etapa, ref) {
  try {
    const l = git(['log', '-1', '--format=%h %ad', '--date=short', `-Srecord ${etapa}`, ref, '--', 'scripts/gate.sh']).trim();
    return l || ref;
  } catch {
    return ref;
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────────
// Códigos: 0 PASS · 1 FAIL (déficit sin declarar) · 2 NOT_CONFIGURED (no pudo comparar).
// El 2 NO es un aprobado: es la puerta diciendo que no pudo mirar.
const GATE_LOCAL = new URL('../../scripts/gate.sh', import.meta.url).pathname;
if (process.argv[1]?.endsWith('divergencia-etapas.mjs')) {
  const POLIZA = new URL('../policy/etapas-no-aplicables.json', import.meta.url).pathname;
  let rama;
  try {
    rama = `origin/${git(['rev-parse', '--abbrev-ref', 'HEAD']).trim()}`;
  } catch {
    console.log('NOT_CONFIGURED: no se pudo resolver la rama actual');
    process.exit(2);
  }
  const porRef = Object.fromEntries(REFS.map((r) => [r, etapasDeRef(r)]));
  // LA RAMA PROPIA SE MIDE EN EL ARBOL, NO EN `origin`. Esto comparaba `origin/<rama>` contra las
  // demas, o sea la version EMPUJADA -- y la pregunta que hace esta etapa es «¿le falta a lo que
  // estoy a punto de commitear una etapa que otra rama ya tiene?». Medido el 2026-09-07: tras
  // fundir el tronco, el arbol YA tenia `controles`, `lock:integridad` y `memoria` --acababan de
  // ejecutarse en la misma corrida-- y esta etapa las reportaba como AUSENTES porque miraba una ref
  // que aun no las tenia. Un diagnostico correcto sobre otro objeto: la misma clase que el sha de
  // la evidencia sin mirar el arbol (H6). Las OTRAS ramas si se leen de `origin`: de ellas no hay
  // arbol local que mirar.
  const local = existsSync(GATE_LOCAL) ? etapasDe(readFileSync(GATE_LOCAL, 'utf8')) : null;
  if (local) porRef[rama] = local;
  const vivas = REFS.filter((r) => porRef[r]);
  if (!porRef[rama]) {
    console.log(`NOT_CONFIGURED: no se pudo leer ${rama}:scripts/gate.sh — sin ella no hay nada que comparar`);
    process.exit(2);
  }
  if (vivas.length < 2) {
    console.log(`NOT_CONFIGURED: solo ${vivas.length} de ${REFS.length} refs resolubles (${vivas.join(', ') || 'ninguna'}) — un guarda de divergencia sin con quien comparar NO aprueba`);
    process.exit(2);
  }
  const { techo, declaradas: decls } = poliza(POLIZA);
  const { sinDeclarar, declaradas } = deficit({ rama, porRef, decls });
  // TRINQUETE, no bloqueo. Con un deficit heredado, bloquear el primer dia garantiza que
  // alguien apague la etapa -- y una comprobacion apagada es peor que no tenerla. El techo es
  // el numero de HOY: sube nunca, baja siempre. Misma politica que la deuda de eslint.
  const corte = techo[rama.replace(/^origin\//, '')] ?? 0;
  for (const d of declaradas) {
    console.log(`declarada  ${d.etapa} — ${d.motivo}${d.dias === null ? ' (sin fecha)' : ` (${d.dias}d)`}`);
  }
  for (const d of sinDeclarar) console.log(`FALTA      ${d.etapa} — la tiene ${procedencia(d.etapa, d.ref)}`);
  console.log(`${vivas.length}/${REFS.length} refs · ${sinDeclarar.length} sin declarar (techo ${corte}) · ${declaradas.length} declaradas`);
  process.exit(sinDeclarar.length > corte ? 1 : 0);
}
