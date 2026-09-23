/**
 * EL PRIMER CONTEXTO — las reglas de ingenieria que el modelo recibe ANTES de
 * la tarea, no despues en forma de hallazgo.
 *
 * EL HUECO, medido el 2026-09-17 sobre harness/capabilities/*.md:
 *
 *   reviewer    12/12 lentes    (la tabla completa: ACID, CIA, Zero Trust, CTQ, BPM…)
 *   security     3/12
 *   researcher   2/12   trigger  2/12
 *   architect    1/12   release  1/12
 *   builder      0/12   <-- QUIEN ESCRIBE EL CODIGO
 *
 * El unico que sabe con que se le va a juzgar es el que juzga. El builder recibe
 * los criterios DESPUES, convertidos en hallazgos de la etapa 09, y para entonces
 * ya escribio. Un revisor que aplica doce lentes contra un escritor que no conoce
 * ninguno no es rigor: es un reproceso caro y evitable.
 *
 * ESTO NO ES ENTRENAMIENTO. `router.json` declara `noTraining: enforced` y aqui
 * no se tocan pesos: son reglas en el contexto de entrada, la unica forma de
 * "transmitir" que el harness tiene permitida. El modelo no aprende entre
 * vueltas; el ANILLO si, porque las reglas viven en git y se corrigen.
 *
 * POR CLASE Y NO GLOBAL: meterle los doce lentes a todos infla el contexto de
 * quien no los necesita --y el contexto que se infla es el que se ignora. Un
 * `read` que inventaria no necesita AMEF; un `edit` que toca dinero, si.
 *
 * PURO: no lee ficheros ni red. Entra una clase, sale texto.
 */

/**
 * Los lentes, con su forma OPERATIVA: no el nombre de la sigla, sino la pregunta
 * que obliga a mirar algo concreto. «Aplica ACID» no cambia una linea de codigo;
 * «¿que pasa si esto falla a la mitad?» si.
 */
export const LENTES = {
  funcional:     'el requisito declarado, los casos limite y los flujos alternos — no solo el camino feliz',
  acid:          'si esto falla a la mitad, ¿queda a medias? atomicidad, rollback, idempotencia, condiciones de carrera',
  cia:           'confidencialidad, integridad, disponibilidad: secretos fuera del codigo, nada que registre PII, nada que se pierda en silencio',
  zeroTrust:     'quien es el dueño del dato, que valida la entrada, que pasa con el minimo privilegio: NUNCA confies en la variable que controla el atacado',
  arquitectonico:'acoplamiento y cohesion. YAGNI: no escribas la abstraccion que hoy nadie pide — el codigo que no existe no falla ni se mantiene',
  performance:   'N+1, indices, memoria, latencia: el coste en el tamaño REAL del dato, no en el de la prueba',
  topologia:     'que modulos toca, que eventos dispara, que contratos rompe aguas abajo',
  compatibilidad:'APIs, DTOs, migraciones y consumidores existentes: quien depende de esto y no se entera',
  ctq:           'lo critico para la calidad: exactitud, trazabilidad, SLA. Que se mide para saber que funciono',
  bpm:           'el proceso de punta a punta: estados huerfanos y transiciones imposibles',
  amef:          'modo de falla, causa, efecto, control actual y riesgo residual',
};

/**
 * Que lentes son PERTINENTES por clase de tarea. Las clases son las de
 * `router.json` (read, plan, design, edit, review), que es donde ya vive el
 * coste-de-error: no se inventa una taxonomia nueva al lado.
 */
export const POR_CLASE = {
  read:       ['funcional', 'topologia'],
  plan:       ['funcional', 'arquitectonico', 'topologia', 'compatibilidad'],
  design:     ['funcional', 'arquitectonico', 'topologia', 'compatibilidad', 'acid', 'bpm'],
  edit:       ['funcional', 'acid', 'cia', 'zeroTrust', 'arquitectonico', 'compatibilidad', 'performance'],
  extraction: ['funcional', 'arquitectonico', 'topologia', 'compatibilidad'],
  review:     Object.keys(LENTES),
  security:   ['cia', 'zeroTrust', 'acid', 'amef', 'ctq'],
};

/**
 * Las reglas que NO son un lente sino una forma de trabajar, y que este repo ya
 * pago por aprender. Cada una cita el fallo que la origino: una regla sin
 * procedencia es una opinion, y las opiniones no sobreviven a una discusion con
 * un modelo que argumenta bien.
 */
export const METODO = [
  'MIDE ANTES DE AFIRMAR. Si dices «N ficheros» o «N importadores», el comando que lo midio va en la respuesta. Medir una cosa y hablar de otra es el fallo mas repetido de este repo: contar las lineas de un fichero NO dice quien importa un simbolo.',
  'LA AUTORIDAD NO ES LA PROSA. Un enum lo define el codigo que el gate ejecuta, no el comentario que lo describe. Antes de escribir un parser para medir algo, busca si ya existe la herramienta: dos medidores son dos verdades.',
  'NO PUDE MIRAR NO ES ESTA BIEN. Si una comprobacion no se pudo hacer, se dice «NO COMPROBADO». Un vacio devuelto como exito es como se cuelan los fallos.',
  'PARAR ES UN RESULTADO VALIDO. Si la peticion no se sostiene contra lo que mides en el arbol, NO la fuerces: reporta que no se sostiene y por que, con la cita. Vale mas que un cambio que pasa el gate y rompe aguas abajo.',
];

/**
 * @param {string} clase           clase de router.json
 * @param {{capacidad?: string, lentes?: string[]}} opts
 * @returns {string} el preludio, o '' si la clase no tiene lentes declarados
 *          (mejor nada que un encabezado vacio que solo gasta contexto).
 */
export function preludio(clase, { capacidad = null, lentes = null } = {}) {
  const claves = lentes ?? POR_CLASE[clase] ?? [];
  const usables = claves.filter((k) => LENTES[k]);
  if (!usables.length) return '';

  const L = ['## Como se juzga este trabajo', ''];
  L.push(
    capacidad
      ? `Eres \`${capacidad}\` y tu salida la revisa un modelo de OTRA familia (ADR-003) con estos criterios.`
      : 'Tu salida la revisa un modelo de otra familia (ADR-003) con estos criterios.',
  );
  L.push('Conocerlos antes evita el reproceso: el revisor los aplicara igual.', '');
  for (const k of usables) L.push(`- **${nombre(k)}** — ${LENTES[k]}`);
  L.push('', '### Metodo, no estilo', '');
  for (const r of METODO) L.push(`- ${r}`);
  return L.join('\n');
}

const NOMBRES = {
  acid: 'ACID', cia: 'CIA', zeroTrust: 'Zero Trust', ctq: 'CTQ', bpm: 'BPM', amef: 'AMEF',
  arquitectonico: 'Arquitectonico', funcional: 'Funcional', performance: 'Performance',
  topologia: 'Topologia', compatibilidad: 'Compatibilidad',
};
const nombre = (k) => NOMBRES[k] ?? k;
