// Mutation Protocol — el modelo no transporta el filesystem: expresa INTENCIONES.
//
// Lo que la Fase 7 dejó abierto. Un `apply_patch` se aplicaba contra lo que
// hubiera en disco en ese instante, y «lo que hubiera» no es una version: es una
// suposicion. Si el fichero cambio entre que el modelo lo leyo y el momento de
// escribir --otra etapa, un rework, el propio modelo dos turnos antes-- el parche
// aterrizaba encima sin que nadie se enterara.
//
//   Model -> Mutation Intent -> Harness -> Mutation Policy -> Sandbox -> Apply
//
// LA REGLA: nunca se aplica un cambio contra una version desconocida. Toda
// escritura sobre algo que ya existe declara el hash que el modelo CREIA estar
// modificando; si no coincide, la mutacion se RECHAZA y vuelve al modelo. No se
// sobrescribe en silencio, y no se "resuelve" adivinando.
//
// PURO: sin E/S. Quien lee el disco es el llamante, que le pasa `exists` y
// `currentHash`. Asi la politica se puede probar sin tocar un fichero.
import { createHash } from 'node:crypto';

/** 16 hex del sha256. Suficiente para detectar un cambio; no es criptografia. */
export const HASH_LEN = 16;
export const hashDe = (contenido) =>
  createHash('sha256').update(contenido).digest('hex').slice(0, HASH_LEN);

/**
 * Los cinco veredictos. `MUTATION_CONFLICT` es el que da nombre al protocolo,
 * pero los otros cuatro son la misma idea: el modelo describio un mundo y el
 * disco dice otro, asi que no se toca nada.
 */
export const MutationCode = {
  OK: 'OK',
  MUTATION_CONFLICT: 'MUTATION_CONFLICT',
  MUTATION_EXISTS: 'MUTATION_EXISTS',
  MUTATION_MISSING: 'MUTATION_MISSING',
  MUTATION_UNVERSIONED: 'MUTATION_UNVERSIONED',
};

/** Operaciones que EXIGEN saber contra que version se aplican. */
export const EXIGEN_BASE = new Set(['apply_patch', 'delete_file', 'move_file']);

const no = (code, detail) => ({ ok: false, code, detail });

/**
 * ¿Se puede aplicar esta mutacion?
 *
 * @param op           apply_patch | create_file | delete_file | move_file
 * @param exists       ¿existe el fichero objetivo?
 * @param currentHash  su hash AHORA, o null si no existe
 * @param baseHash     el hash que el modelo declara haber visto
 * @returns {{ok, code, detail?}}
 */
export function checkMutation({ op, path, exists, currentHash, baseHash }) {
  const p = path ?? '(sin ruta)';

  if (op === 'create_file') {
    // Sin `baseHash`, crear significa CREAR: el modelo afirma que no existe. Si
    // existe, se rechaza en vez de sobrescribir -- que es justo el caso en que
    // una vuelta pisa el trabajo de otra sin dejar rastro.
    if (!baseHash) {
      return exists
        ? no(MutationCode.MUTATION_EXISTS,
          `'${p}' ya existe (${currentHash}). Para reescribirlo, declara su baseHash`)
        : { ok: true, code: MutationCode.OK };
    }
    if (!exists) {
      return no(MutationCode.MUTATION_MISSING,
        `declaras baseHash '${baseHash}' para '${p}', y el fichero no existe`);
    }
    return currentHash === baseHash
      ? { ok: true, code: MutationCode.OK }
      : no(MutationCode.MUTATION_CONFLICT,
        `'${p}' esta en '${currentHash}' y tu baseHash es '${baseHash}': cambio debajo de ti`);
  }

  if (!EXIGEN_BASE.has(op)) return { ok: true, code: MutationCode.OK };

  if (!baseHash) {
    return no(MutationCode.MUTATION_UNVERSIONED,
      `'${op}' sobre '${p}' sin baseHash: no se aplica un cambio contra una version desconocida`);
  }
  if (!exists) {
    return no(MutationCode.MUTATION_MISSING, `'${p}' no existe`);
  }
  return currentHash === baseHash
    ? { ok: true, code: MutationCode.OK }
    : no(MutationCode.MUTATION_CONFLICT,
      `'${p}' esta en '${currentHash}' y tu baseHash es '${baseHash}': cambio debajo de ti`);
}

/**
 * El registro de una mutacion APLICADA. Contesta las nueve preguntas que el
 * protocolo exige: que fichero, que operacion, que version esperaba el modelo,
 * que habia antes, que hay despues, quien autorizo y donde.
 *
 * `before === after` no es un error: significa que la operacion no cambio nada,
 * y eso es un hecho que conviene ver en la traza en vez de deducirlo.
 */
export const mutationRecord = ({ op, path, destination = null, baseHash = null, before, after, capability, workspace }) => ({
  op, path, ...(destination ? { destination } : {}),
  baseHash, before, after,
  changed: before !== after,
  authorizedBy: capability,
  appliedIn: workspace,
});

/**
 * LAS DOS AUTORIDADES, CAREADAS.
 *
 * El ChangeSet publica dos respuestas a «que se toco» y no las relaciona:
 *
 *   mutations -> una BITACORA: que se pidio, en que orden y contra que version.
 *   files     -> un ESTADO: que quedo distinto de HEAD cuando la etapa termino.
 *
 * Son cosas distintas y pueden discrepar sin que ninguna mienta. Un fichero
 * escrito y devuelto a su contenido original sale en la bitacora y no en el
 * estado. Uno que ensucia una herramienta de ejecucion --un `run_build`
 * regenera `public/version.json`-- sale en el estado y no en la bitacora.
 *
 * MEDIDO en H-20260820-c9a55e79, etapa 7 con `status: OK`: la bitacora daba
 * `AdminRespaldosS3.tsx` cambiado y ni `files` ni el diff de 74 lineas lo
 * mencionaban. El revisor leyo la bitacora y levanto un P1; el builder leyo el
 * diff y bloqueo con «el hallazgo es FALSO». Ninguno de los dos podia ganar la
 * discusion, porque cada uno miraba una autoridad distinta y el artefacto no
 * decia que fueran dos. Cuatro rondas del item cm-4 y el techo de la campana.
 *
 * Esto no decide quien tiene razon --eso depende del caso-- sino que hace que la
 * discrepancia EXISTA como dato en el artefacto, en vez de quedar para que la
 * descubra a mano quien compare tres campos. Es la misma forma que
 * `una-autoridad-por-hecho`: cuando hay dos, el careo es el hecho.
 *
 * @param mutations la bitacora de la etapa (cada una con `path`, `changed`, ...)
 * @param files     lo que git vio distinto de HEAD, relativo a la raiz del ws
 */
export function carearConGit(mutations = [], files = [], { blobDeHead = null } = {}) {
  // El modelo escribe la ruta y git la emite: `./src/x.ts` y `src/x.ts` son la
  // misma, y hacerlas discrepar seria fabricar justo el fantasma que esto cierra.
  const norm = (p) => String(p).replace(/^\.\//, '').replace(/\/{2,}/g, '/');
  const enGit = new Set(files.map(norm));

  // Un `move_file` son DOS rutas y las dos son cambios: el origen deja de existir
  // y el destino empieza. La bitacora las lleva en campos distintos.
  const bitacora = new Map();
  for (const m of mutations ?? []) {
    for (const p of [m?.path, m?.destination].filter(Boolean)) {
      const k = norm(p);
      bitacora.set(k, { quedo: (bitacora.get(k)?.quedo ?? false) || m.changed !== false, after: m.after ?? null });
    }
  }

  // UNA RESTAURACION NO ES UN FANTASMA.
  //
  // Si el modelo escribio y el resultado quedo IDENTICO a HEAD, git no reporta
  // nada --no hay diferencia que reportar-- y sin esto el careo lo acusaba de
  // declarar una escritura que no ocurrio. Ocurrio: su efecto neto es cero.
  //
  // MEDIDO en H-20260824-d897a07f: el harness sembro una credencial en
  // ConnectionStatus.tsx, el builder la retiro, el fichero volvio a HEAD
  // (after=357b2215ef2f531e) y el revisor leyo el fantasma como «el diff omite
  // la modificacion declarada» -- un P1 sobre trabajo correcto.
  //
  // SIN `after` NO SE DECIDE: se sigue reportando. Declarar restauracion por
  // falta de datos seria callar un fantasma, y el careo existe para desconfiar.
  const esRestauracion = (v) => {
    if (!blobDeHead || !v.after) return false;
    try { return blobDeHead(v.ruta) === v.after; } catch { return false; }
  };

  const soloBitacora = [...bitacora]
    .filter(([ruta, v]) => v.quedo && !enGit.has(ruta) && !esRestauracion({ ...v, ruta }))
    .map(([ruta, v]) => ({ path: ruta, after: v.after }));
  const soloGit = [...enGit].filter((f) => !bitacora.has(f));

  return {
    coinciden: soloBitacora.length === 0 && soloGit.length === 0,
    soloBitacora,
    soloGit,
  };
}
