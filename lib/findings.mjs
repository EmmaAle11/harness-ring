// Identidad de un hallazgo A TRAVES de las rondas, y que le pasa entre ellas.
//
// EL DEFECTO QUE CIERRA. `findingKey` -- (fichero, simbolo, claim) -- identifica
// un hallazgo DENTRO de una ronda: dos lentes que dicen lo mismo con el mismo
// texto colapsan, y eso es exactamente lo que necesita la deduplicacion
// (ADR-004). Entre rondas no sirve. Cada ronda es OTRA invocacion, el revisor
// reformula, y el mismo defecto sobre el mismo simbolo sale con otro `claim`.
// Con la clave exacta ese hallazgo es NUEVO cada vez -- y entonces «3 corregidos
// y 3 nuevos» y «los mismos 3, tres veces» son el mismo dato.
//
// H-20260817-009c7621 lo midio: 5 vueltas de Execution, 3 bloqueos de
// Convergence, y ningun mecanismo capaz de decir si el problema se estaba
// reduciendo, desplazando o repitiendo. El contador de REWORK cuenta INTENTOS;
// no sabe nada del PROBLEMA.
//
// NO ES UNA SEGUNDA AUTORIDAD SOBRE LA IDENTIDAD, y esa distincion es la que
// hace legitimo que existan las dos claves:
//
//   findingKey    identidad DENTRO de una ronda   -> deduplicar (converge.mjs)
//   fingerprint   identidad ENTRE rondas          -> ciclo de vida (aqui)
//
// Es la MISMA tupla con menos resolucion: todo `findingKey` cae en exactamente
// un `fingerprint`, nunca al reves. Una jerarquia, no dos opiniones.
//
// Y el texto del modelo NO manda: `file` y `symbol` son coordenadas del codigo
// --estructuradas, no redactadas-- y el esqueleto del claim solo desempata
// cuando hay varios hallazgos sobre el MISMO simbolo.
//
// Puro: sin E/S. Su test vive al lado.
import { norm } from './converge.mjs';

/**
 * Palabras que no distinguen un hallazgo de otro. Lista corta a proposito: cada
 * entrada de mas es una forma de que dos defectos distintos colapsen en uno.
 */
// Las largas son las que importan: el filtro tira lo de menos de 4 letras, asi
// que un conector CORTO ya no llega aqui. Los que estan en la lista son los que
// SOBREVIVEN al filtro por longitud y luego ganan sitio en el esqueleto sin
// aportar nada -- `resulta` (7) desplazaba a `indice` (6) y dos redacciones del
// mismo defecto dejaban de reconocerse. Lo midio el test, no la lectura.
const VACIAS = new Set([
  'ademas', 'ante', 'aunque', 'como', 'con', 'cuando', 'desde', 'donde', 'entonces', 'esta',
  'este', 'esto', 'hace', 'hacia', 'mientras', 'para', 'pero', 'porque', 'que', 'resulta',
  'segun', 'sin', 'sobre', 'tambien', 'tiene', 'todo', 'sus', 'una', 'uno',
  'and', 'are', 'but', 'for', 'from', 'has', 'have', 'into', 'not', 'that', 'the', 'then',
  'this', 'when', 'where', 'which', 'with', 'without',
]);

/** Cuantos terminos forman el esqueleto. Ver `claimStem`. */
export const TERMINOS = 4;

/**
 * El ESQUELETO de un claim: sus terminos mas largos, ordenados.
 *
 * Los LARGOS, no los primeros: el vocabulario de dominio --`formatfilesize`,
 * `undefined`, `tautologica`-- es largo, y el relleno que cambia entre
 * reformulaciones es corto. Ordenados, porque el orden de las palabras es lo
 * primero que cambia al reformular y no dice nada del defecto.
 *
 * Topado en cuatro: un claim que anade detalle sigue teniendo los mismos cuatro
 * terminos largos. Sin tope, cada frase extra crearia un hallazgo nuevo, que es
 * justo el defecto.
 */
export function claimStem(claim, { tope = TERMINOS } = {}) {
  return [...new Set(norm(claim).split(' '))]
    .filter((w) => w.length >= 4 && !VACIAS.has(w))
    .sort((a, b) => b.length - a.length || a.localeCompare(b))
    .slice(0, tope)
    .sort()
    .join(' ');
}

/**
 * Donde vive el hallazgo. SOLO coordenadas de codigo: ni una palabra del modelo.
 * Es lo que permite preguntar «¿sigue abierto algo en este simbolo?» aunque el
 * revisor haya cambiado de tema.
 */
export const scopeKey = (f) =>
  [String(f?.file ?? '').replace(/^\.\//, ''), norm(f?.symbol)].join('|');

/**
 * La identidad entre rondas. LEGIBLE, no un hash: una fusion que no se puede
 * explicar es peor que un duplicado, y la misma regla que gobierna la
 * convergencia gobierna esto.
 *
 * ponytail: TECHO CONOCIDO. Si el revisor describe el MISMO defecto con otro
 * vocabulario -- no otro orden: otras palabras-- el esqueleto cambia y el
 * hallazgo cuenta como NEW. No se persigue con sinonimos ni con un modelo que
 * decida la identidad: la red de seguridad es `displaced`, que compara por
 * `scopeKey` -- puramente estructural-- y caza justo ese caso. Si esa senal
 * empieza a aparecer en vueltas reales sin desplazamiento real, entonces si toca
 * subir la resolucion del esqueleto.
 */
export const fingerprint = (f) => `${scopeKey(f)}|${claimStem(f?.claim)}`;

/**
 * Los ids que VIAJAN al refutador, uno por hallazgo y alineados por indice.
 *
 * SON ORDINALES --'1', '2', '3'-- y eso se decidio MIDIENDO, despues de probar
 * con `fingerprint`.
 *
 * MEDIDO el 21-ago con `qwen2.5-coder:14b` y el FindingSet real de
 * H-20260821-54e6667b: enviandole ids como
 * `src/lib/parseFechaDDMMYYYY.cableado.spec.ts|declaralocal|anotacion
 * comprobacion declaracion parsefechaddmmyyyy` --mas de cien caracteres opacos--
 * el modelo NO los copio. Se los invento con otro formato entero
 * (`H-20260819-68ac6919-00000001`), los 6 votos salieron huerfanos y los 3
 * hallazgos quedaron UNREVIEWED. Y la tercera pasada degenero en
 * `0000000000000…` hasta reventar la salida: una cadena larga y sin estructura
 * invita a esa clase de bucle.
 *
 * El contrato ya era correcto --el modelo devolvia `{votes:[{id,vote,reason}]}` y
 * validaba-- y aun asi el mecanismo no funcionaba, porque la parte que se le
 * pedia copiar era demasiado cara. La respuesta no es un modelo mejor: es un id
 * mas barato de copiar. Es el mismo principio que C-3 aplicado a la ENTRADA en
 * vez de a la salida.
 *
 * LA IDENTIDAD DURABLE SIGUE SIENDO `fingerprint`, y no se toca: sirve para
 * reconocer un hallazgo ENTRE RONDAS. El ordinal solo identifica dentro de UNA
 * peticion, que es todo lo que la votacion necesita -- las tres pasadas reciben
 * exactamente la misma lista, asi que el ordinal es estable donde tiene que
 * serlo.
 *
 * UNA SOLA AUTORIDAD, y por eso vive aqui: quien construye la entrada del modelo
 * y quien casa los votos tienen que calcular lo mismo. Si cada uno lo derivara
 * por su cuenta, bastaria con que uno cambiara para que TODOS los votos salieran
 * huerfanos -- y eso se lee como «el modelo no contesto».
 */
export function idsDe(findings) {
  return (findings ?? []).map((_, i) => String(i + 1));
}

export const ESTADOS = ['NEW', 'UNCHANGED', 'CARRIED', 'REGRESSED', 'FIXED'];

/**
 * Que le paso a cada hallazgo entre dos rondas.
 *
 *   NEW        no se habia visto nunca
 *   UNCHANGED  el revisor lo VOLVIO a reportar
 *   CARRIED    sobrevive solo por el arrastre: nadie lo re-reporto ni lo refuto
 *   REGRESSED  estuvo, desaparecio, y ha vuelto
 *   FIXED      estaba en la ronda anterior y ya no aparece
 *
 * CARRIED y UNCHANGED se separan porque significan cosas distintas: uno es un
 * hallazgo que el revisor sigue viendo, el otro es uno que solo sigue vivo
 * porque el mecanismo de arrastre no deja que muera en silencio
 * (`adversarial.arrastrar`). Confundirlos hace pasar por revision lo que es
 * inercia.
 *
 * @param actuales   hallazgos de esta ronda
 * @param previas    hallazgos de la ronda inmediatamente anterior
 * @param historia   Set de fingerprints vistos en CUALQUIER ronda anterior
 */
export function transiciones(actuales, { previas = [], historia = new Set() } = {}) {
  const enPrevia = new Set((previas ?? []).map(fingerprint));
  const enActual = new Set((actuales ?? []).map(fingerprint));

  const clasificados = (actuales ?? []).map((f) => {
    const fp = fingerprint(f);
    let status;
    if (enPrevia.has(fp)) status = f.carried ? 'CARRIED' : 'UNCHANGED';
    else if (historia.has(fp)) status = 'REGRESSED';
    else status = 'NEW';
    return { ...f, fingerprint: fp, scope: scopeKey(f), status };
  });

  const fixed = (previas ?? [])
    .filter((f) => !enActual.has(fingerprint(f)))
    .map((f) => ({ ...f, fingerprint: fingerprint(f), scope: scopeKey(f), status: 'FIXED' }));

  return { findings: clasificados, fixed, counts: contar([...clasificados, ...fixed]) };
}

const contar = (fs) => Object.fromEntries(
  ESTADOS.map((e) => [e.toLowerCase(), fs.filter((f) => f.status === e).length]),
);

export const ESTADOS_CONVERGENCIA = [
  'CONVERGED', 'CONVERGING', 'DISPLACING', 'OSCILLATING', 'SPECIFICATION_BLOCKED', 'UNKNOWN',
];

/**
 * Los que estan en TODAS las rondas. Un hallazgo que sobrevive a cada
 * correccion no se comporta como un defecto: se comporta como un criterio que
 * no se puede satisfacer. Quien lo interpreta es `spec.mjs`.
 */
export function persistentes(rondas) {
  const R = (rondas ?? []).map((r) => new Set((r ?? []).map(fingerprint)));
  if (!R.length) return [];
  return [...R[0]].filter((fp) => R.every((s) => s.has(fp)));
}

/**
 * La serie completa de rondas -> ¿esto converge?
 *
 * Responde las tres preguntas que un contador de REWORK no puede responder:
 *
 *   ¿estoy reduciendo el problema?    CONVERGING
 *   ¿estoy desplazandolo?             DISPLACING   se cierran unos y se abren otros
 *   ¿estoy girando en circulos?       OSCILLATING  vuelve lo que ya se habia ido
 *
 * OSCILLATING lo decide la REAPARICION: un fingerprint presente, luego ausente,
 * luego presente otra vez. No es «el revisor cambio de opinion» -- es que el
 * conjunto alterna sin reduccion estructural, y ninguna ronda mas lo arregla.
 * Por eso NO se responde subiendo MAX_REWORK: mas intentos sobre un ciclo dan
 * mas ciclo.
 *
 * @param rondas [[hallazgo…]] los BLOQUEANTES de cada ronda, en orden
 */
/**
 * VEREDICTOS QUE SE INVIERTEN SOBRE EL MISMO CLAIM.
 *
 * `convergencia()` solo ve BLOQUEANTES, asi que un hallazgo que desaparece porque
 * lo ARREGLARON y uno que desaparece porque el refutador CAMBIO DE VOTO son
 * indistinguibles: los dos bajan el total y los dos dan CONVERGED.
 *
 * No son lo mismo. El primero es trabajo; el segundo es ruido con etiqueta.
 *
 * MEDIDO en H-20260824-fa058d63 (h-007), con la refutacion DEGRADADA declarada en
 * la etapa 5 --sin tercera familia viva, refuta el propio revisor--:
 *
 *   ronda 1   P1 CONFIRMED · P2 CONFIRMED · P3 CONFIRMED
 *   ronda 2   P1 REFUTED   · P2 REFUTED   · P3 REFUTED
 *
 * Los tres claims IDENTICOS byte a byte, y los ficheros cambiados los mismos en
 * las dos rondas. Tres de tres. La vuelta convergio con eso y salio PASSED.
 *
 * Con una tercera familia viva, un cambio de voto es reevaluacion legitima. Con el
 * refutador de la familia del revisor, no tiene base independiente ninguna. Por eso
 * esto se REPORTA siempre y quien decide que hacer con ello es la politica, no esta
 * funcion: aqui solo se deja de poder no verlo.
 *
 * @param rondas [[{...hallazgo, verdict}]] TODOS los hallazgos de cada ronda con su
 *               veredicto, no solo los bloqueantes
 */
export function veredictosInestables(rondas) {
  const porFp = new Map();
  for (const [i, r] of (rondas ?? []).entries()) {
    for (const f of r ?? []) {
      const fp = fingerprint(f);
      if (!porFp.has(fp)) porFp.set(fp, []);
      porFp.get(fp).push({ ronda: i + 1, verdict: f.verdict ?? null, claim: f.claim ?? null });
    }
  }
  return [...porFp.entries()]
    .filter(([, vs]) => new Set(vs.map((v) => v.verdict).filter(Boolean)).size > 1)
    .map(([fp, vs]) => ({
      fingerprint: fp,
      claim: vs[0].claim,
      // El MISMO claim con veredictos distintos. Si el claim cambio, el
      // fingerprint tambien, y esto no lo ve -- eso es `displaced`, otra cosa.
      votos: vs.map((v) => `r${v.ronda}:${v.verdict}`),
    }));
}

export function convergencia(rondas) {
  const R = (rondas ?? []).map((r) => r ?? []);
  if (!R.length) return { status: 'UNKNOWN', rounds: [], reappeared: [], displaced: [], progress: null };

  const historia = new Set();
  const rounds = [];
  const presencia = new Map();          // fingerprint -> [rondas en que aparecio]

  for (let i = 0; i < R.length; i++) {
    const t = transiciones(R[i], { previas: i ? R[i - 1] : [], historia: new Set(historia) });
    rounds.push({ n: i + 1, total: R[i].length, ...t.counts });
    for (const f of R[i]) {
      const fp = fingerprint(f);
      historia.add(fp);
      if (!presencia.has(fp)) presencia.set(fp, []);
      if (presencia.get(fp).at(-1) !== i) presencia.get(fp).push(i);
    }
  }

  // Reaparicion: hay un HUECO en la serie de rondas de ese fingerprint. Se fue y
  // volvio, que es la firma del ciclo.
  const reappeared = [...presencia.entries()]
    .filter(([, ns]) => ns.at(-1) - ns[0] + 1 > ns.length)
    .map(([fp]) => fp);

  // Desplazamiento: el hallazgo se movio de claim DENTRO del mismo simbolo. Es
  // la forma silenciosa de no avanzar -- el fingerprint cambia, asi que sin esto
  // parece progreso ("uno corregido, uno nuevo") cuando el simbolo sigue igual.
  const porScope = new Map();
  for (const r of R) for (const f of r) {
    const s = scopeKey(f);
    if (!porScope.has(s)) porScope.set(s, new Set());
    porScope.get(s).add(fingerprint(f));
  }
  const displaced = [...porScope.entries()].filter(([, fps]) => fps.size > 1).map(([s]) => s);

  const progress = {
    fixed: rounds.reduce((a, r) => a + r.fixed, 0),
    new: rounds.reduce((a, r) => a + r.new, 0),
    regressed: rounds.reduce((a, r) => a + r.regressed, 0),
    first: rounds[0].total,
    last: rounds.at(-1).total,
    net: rounds[0].total - rounds.at(-1).total,
  };

  const status = (() => {
    if (progress.last === 0) return 'CONVERGED';
    if (reappeared.length) return 'OSCILLATING';
    // Se cerraron cosas y el total NO bajo: el problema se movio, no se redujo.
    if (progress.fixed > 0 && progress.net <= 0) return 'DISPLACING';
    return 'CONVERGING';
  })();

  return { status, rounds, reappeared, displaced, progress };
}

/**
 * El aviso que le llega al revisor con el ciclo de vida delante.
 *
 * El revisor recibia el ChangeSet y los hallazgos, pero no si lo que esta
 * mirando ya se corrigio una vez y volvio. Un hallazgo REGRESSED merece mas
 * atencion que uno NEW, y uno CARRIED merece que se compruebe si sigue vivo
 * -- son preguntas distintas y sin esto se hacia una sola.
 *
 * PURO y exportado: comprobarlo a traves de una vuelta costaria 45 minutos.
 */
export function avisoDeCicloDeVida(clasificados) {
  const por = (e) => (clasificados ?? []).filter((f) => f.status === e);
  const lineas = [];
  for (const e of ['REGRESSED', 'CARRIED', 'UNCHANGED']) {
    const fs = por(e);
    if (fs.length) lineas.push(`- ${e}: ${fs.map((f) => `${f.file}:${f.symbol}`).join(', ')}`);
  }
  if (!lineas.length) return '';
  return '\n\nCICLO DE VIDA — estos hallazgos NO son nuevos:\n' + lineas.join('\n')
    + '\nREGRESSED estuvo cerrado y ha vuelto: eso es una regresion y pesa mas que un hallazgo nuevo.'
    + ' UNCHANGED lo volviste a ver esta ronda. CARRIED sobrevive solo porque nadie se pronuncio'
    + ' sobre el: comprueba su premisa contra el codigo de AHORA y refutalo si ya no se sostiene.';
}
