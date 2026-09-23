// Convergencia — hallazgos[] -> hallazgos unificados[].
//
// El LLM propone; esta funcion unifica. Deduplicar es determinista y un modelo
// aqui solo anade varianza: la misma entrada daria salidas distintas y no habria
// forma de auditar por que fusiono dos hallazgos (ADR-004).
//
// Puro: sin E/S. Su test vive al lado.

/**
 * Normaliza para comparar: minusculas, sin acentos, sin puntuacion, espacios
 * colapsados. Es comparacion de TEXTO, no semantica, y eso es una virtud: una
 * fusion que no se puede explicar es peor que un duplicado.
 */
export const norm = (s) =>
  String(s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Clave de identidad: (fichero, simbolo, claim).
 * NUNCA la linea -- se mueve entre rondas y dos hallazgos identicos quedarian
 * separados por un `prettier`.
 */
export const findingKey = (f) =>
  [String(f.file ?? '').replace(/^\.\//, ''), norm(f.symbol), norm(f.claim)].join('|');

const SEV = ['P0', 'P1', 'P2', 'P3', 'P4', 'P5'];
const peor = (a, b) => (SEV.indexOf(a) <= SEV.indexOf(b) ? a : b);

const CONF = ['CONFIRMED', 'PARTIAL', 'UNKNOWN'];
const mejor = (a, b) => (CONF.indexOf(a) <= CONF.indexOf(b) ? a : b);

/**
 * CUANTO BLOQUEA un registro. La severidad tiene `peor()`; el VEREDICTO no tenia
 * nada, y de el cuelga el DoD entero.
 *
 * EL DEFECTO, medido por `third` el 2026-08-25 sobre `c4ab1850` y reproducido
 * aqui antes de tocar nada:
 *
 *   converge([indeciso, confirmado])  -> UNDECIDED -> blockers 0 · pass TRUE
 *   converge([confirmado, indeciso])  -> CONFIRMED -> FAIL     · blockers 1
 *
 * **Un P0 CONFIRMED atravesaba la puerta segun el orden de llegada de dos
 * lentes.** No es hipotetico: la etapa 7 refuta ANTES de la 8, asi que dos lentes
 * que caen en la misma `findingKey` traen cada una SU veredicto. Lo mismo con
 * `UNREVIEWED`: [C,U] -> CONFIRMED, [U,C] -> UNREVIEWED.
 *
 * Se conservaba el del primero por el `{...f}` del alta -- exactamente el mismo
 * agujero que yo habia cazado en `lostVotes` esa manana, sobre el unico campo
 * donde falla ABIERTO.
 *
 * FAIL-CLOSED, y ordena sobre los DOS ejes que bloquean, no solo el veredicto:
 * un `UNDECIDED` con el voto tirado bloquea, y uno sin el no. `REFUTED` no
 * aparece porque se descarta antes de llegar a la fusion.
 */
const CUANTO_BLOQUEA = (f) => (f?.verdict === 'CONFIRMED' ? 3
  : f?.verdict === 'UNREVIEWED' ? 2
  : (f?.lostVotes ?? 0) > 0 ? 1
  : 0);

const lista = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const unir = (dest, src) => {
  for (const x of src) if (!dest.includes(x)) dest.push(x);
};

/**
 * @param findings hallazgos crudos, YA refutados (etapa 7 va antes que la 8:
 *                 deduplicar primero fusionaria uno fabricado con uno real y le
 *                 prestaria credibilidad)
 * @returns unificados, ordenados por severidad y luego por corroboracion
 */
export function converge(findings) {
  const byKey = new Map();

  for (const f of lista(findings)) {
    if (f?.verdict === 'REFUTED') continue; // un refutado no converge: se descarta

    const k = findingKey(f);
    const prev = byKey.get(k);

    if (!prev) {
      byKey.set(k, {
        ...f,
        evidence: lista(f.evidence),
        lenses: lista(f.lens ?? f.lenses),
        agents: lista(f.agent ?? f.agents),
        lostVotes: f.lostVotes ?? 0,
        seenBy: 1,
      });
      continue;
    }

    // Dos lentes que llegan al mismo sitio por caminos distintos NO son un
    // duplicado molesto: son corroboracion independiente, y es la senal mas
    // fuerte que produce el harness. Por eso la evidencia se acumula.
    prev.severity = peor(prev.severity, f.severity);
    prev.confidence = mejor(prev.confidence, f.confidence);
    prev.evidence.push(...lista(f.evidence));
    unir(prev.lenses, lista(f.lens ?? f.lenses));
    unir(prev.agents, lista(f.agent ?? f.agents));

    // EL VEREDICTO Y SU RECUENTO VIAJAN JUNTOS, del registro que MAS bloquea.
    //
    // Mi primer arreglo acumulaba `lostVotes` con `Math.max` y dejaba
    // `counts`/`why`/`votes` del primero, y eso produce un artefacto que se
    // CONTRADICE A SI MISMO -- salida real de la sonda de `third`:
    //
    //   lostVotes: 2   counts: {..., lost: 0}   why: "solo 1 voto de 2"
    //
    // Dos cifras del mismo hecho y ninguna manera de saber cual manda. Fundir un
    // recuento tampoco vale: `counts` es el escrutinio de UNA votacion sobre UN
    // registro, y sumar dos escrutinios distintos no produce un escrutinio.
    //
    // Asi que no se funden: se toma el bloque ENTERO del ganador. Coherente por
    // construccion, y fail-closed porque el ganador es el que mas bloquea.
    if (CUANTO_BLOQUEA(f) > CUANTO_BLOQUEA(prev)) {
      prev.verdict = f.verdict;
      prev.lostVotes = f.lostVotes ?? 0;
      prev.counts = f.counts;
      prev.why = f.why;
      prev.votes = f.votes;
    }
    prev.seenBy++;
  }

  return [...byKey.values()].sort(
    (a, b) => SEV.indexOf(a.severity) - SEV.indexOf(b.severity) || b.seenBy - a.seenBy,
  );
}

/**
 * El umbral del DoD: DONE = 0 hallazgos confirmados tras refutacion, en TODA la
 * escala.
 *
 * REGLA ABSOLUTA (ADR-007): ninguna severidad se declara tolerable. No hay
 * `blockAtOrAbove`, no hay lista de exentas, y no se documenta un P4 ni un P5
 * como deuda aceptada. Un hallazgo confirmado se corrige o se refuta; no hay
 * tercera salida.
 *
 * Se considero lo contrario y se descarto. H-20260817-f00dd8f2 agoto sus REWORK
 * con tres P4 vivos, y un umbral en P3 la habria cerrado en la ronda 1. Pero un
 * hallazgo archivado como deuda no vuelve a mirarse: este repositorio tiene la
 * medida de que las clases mas baratas son las que se reintroducen -- VULN-001 se
 * reintrodujo DESPUES de corregirse-- y una lista de severidades perdonadas es el
 * sitio exacto donde eso se vuelve invisible. Lo que se ajusto fue `MAX_REWORK`,
 * que compra rondas para llegar al cero; no el cero.
 *
 * `SEV.includes` no es un filtro inutil: rechaza lo que trae una severidad que no
 * esta en la escala. Un hallazgo con `severity: undefined` o `'critical'` -- la de
 * un scanner ajeno-- no cuenta como bloqueante aqui, y eso es deliberado: la
 * traduccion a la escala del repo la hace `policy/security.json` antes, no este
 * filtro por accidente.
 */
export const bloqueantes = (unificados) => unificados.filter((f) => SEV.includes(f.severity));
