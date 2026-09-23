// C-7 · FAN-OUT — un cambio masivo se reparte, no se concentra.
//
// 200 ficheros no caben en una transcripcion de 60 000 chars. 200 transcripciones
// de un fichero, si. Es map-reduce, y es la unica forma de que «masivo» y el tope
// de transcripcion convivan.
//
// EL MAPA lo hace este fichero: repartir el trabajo en trozos coherentes.
// LA REDUCCION no la hace un modelo: la hace la PUERTA. Los shards escriben en el
// MISMO workspace y al final hay un solo `git diff`, un solo analisis de
// superficie sobre la UNION y un solo gate. Un merge por consenso de modelos
// habria sido la varianza de vuelta por la puerta de atras.
//
// LA TENSION QUE SE RESPETA: `claim.json` impone UN ANILLO A LA VEZ y eso no se
// toca (memory/failures/dos-anillos-a-la-vez.md). El fan-out va DENTRO de una
// vuelta -- shards secuenciales sobre un workspace-- no en dos vueltas paralelas.
// Lo que se reparte es la TRANSCRIPCION, que es el recurso escaso; no el reloj.
//
// PURO: sin E/S. La politica entra como argumento.
import { moduloDe } from './surface.mjs';

/**
 * Reparte los ficheros en shards.
 *
 * POR MODULO, y no por orden alfabetico: un shard que mezcla `backend/src/aafa`
 * con `src/app/admin` obliga a su transcripcion a sostener dos contextos, que es
 * justo el coste que el fan-out existe para evitar. Los modulos se empaquetan
 * enteros mientras quepan.
 *
 * DEBAJO DEL UMBRAL NO SE REPARTE, y devuelve UN shard con todo: el fan-out cuesta
 * una invocacion por trozo, y pagarla para cuatro ficheros que caben de sobra es
 * gasto puro. Es la misma forma que `NO_CHANGE_REQUIRED`: la respuesta correcta a
 * veces es no hacer nada.
 */
export function repartir(files, { minFiles = 8, maxFilesPerShard = 6 } = {}) {
  const fs = [...new Set((files ?? []).map((f) => String(f).replace(/^\.\//, '')))];
  if (!fs.length) return [];
  if (fs.length < minFiles) return [fs];

  const porModulo = new Map();
  for (const f of fs) {
    const m = moduloDe(f);
    porModulo.set(m, [...(porModulo.get(m) ?? []), f]);
  }

  // Se ORDENAN por modulo y se trocea la lista resultante. Agrupar y luego
  // empaquetar por separado dejaba un shard de UN fichero cada vez que un modulo
  // pequeno caia antes de uno grande: trozos desiguales cuestan la misma
  // invocacion y aprovechan menos transcripcion.
  const orden = [...porModulo]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .flatMap(([, grupo]) => grupo);

  const shards = [];
  for (let i = 0; i < orden.length; i += maxFilesPerShard) {
    shards.push(orden.slice(i, i + maxFilesPerShard));
  }
  return shards;
}

/** Los estados con los que un shard puede terminar sin tumbar la vuelta. */
export const CIERRES = new Set(['DONE', 'NO_CHANGE_REQUIRED']);

/**
 * ¿Cerraron TODOS los shards?
 *
 * CADA SHARD DECLARA SU PROPIO `done`. Sin esto, un fan-out de 20 trozos donde
 * 19 cierran y uno se queda a medias produce un ChangeSet que parece completo
 * -- git ve cambios, la puerta pasa-- y una parte del trabajo sin hacer que nadie
 * nombra. Es `cerrar-por-abstencion-no-es-converger` aplicado al reparto: 19 de 20
 * no es converger, es converger en el 95 % y callar el 5 %.
 */
export function cierre(resultados) {
  const abiertos = (resultados ?? [])
    .map((r, i) => ({ shard: i + 1, status: r?.status ?? 'SIN_RESULTADO', stop: r?.stop ?? null }))
    .filter((r) => !CIERRES.has(r.status));
  return {
    ok: abiertos.length === 0,
    total: (resultados ?? []).length,
    cerrados: (resultados ?? []).length - abiertos.length,
    abiertos,
    why: abiertos.length
      ? `${abiertos.length} de ${(resultados ?? []).length} shard(s) sin cerrar: `
        + abiertos.map((a) => `#${a.shard} ${a.status}${a.stop ? ` (${a.stop})` : ''}`).join(' · ')
      : null,
  };
}

/** Une lo que cada shard produjo. Determinista, y sin que ningun modelo opine. */
export function fusionar(resultados) {
  const rs = (resultados ?? []).filter(Boolean);
  return {
    shards: rs.length,
    iterations: rs.reduce((n, r) => n + (r.iterations ?? 0), 0),
    toolCalls: rs.flatMap((r, i) => (r.toolCalls ?? []).map((c) => ({ shard: i + 1, ...c }))),
    mutations: rs.flatMap((r) => r.mutations ?? []),
    // El resumen se CONCATENA por shard en vez de pedirle a un modelo que resuma
    // los resumenes: eso seria una lectura mas donde ya hay una respuesta.
    summary: rs.map((r, i) => `#${i + 1}: ${r.final?.summary ?? r.final?.reason ?? r.stop ?? '(sin resumen)'}`).join('\n'),
    // El uso se suma cuando TODOS lo publican. Si uno no, el total seria una
    // estimacion disfrazada de medida.
    usage: rs.every((r) => r.usage?.totalTokens != null)
      ? { totalTokens: rs.reduce((n, r) => n + r.usage.totalTokens, 0) }
      : null,
  };
}
