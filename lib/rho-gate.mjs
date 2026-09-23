// ── rho-gate · parada temprana por densidad de accion ────────────────────────
//
// rho(t) = C(t) / t   --  llamadas a herramienta acumuladas sobre iteraciones.
//
// Responde a una sola pregunta: ¿el builder sigue TOCANDO el repositorio, o
// lleva rato razonando en circulo? Cuando deja de tocarlo, no vuelve.
//
// POR QUE ESTA SENAL Y NO OTRA. El intento anterior de predecir el desenlace usó
// el vector `changeSurface` [files, modulesTouched, domainsTouched, testsTouched]
// y fracaso: 29 vueltas ocupaban 5 posiciones distintas del espacio y el techo de
// cualquier clasificador era +0,0% sobre el baseline. La leccion registrada fue
// «el vector describe lo que la spec PIDE, no lo que la ejecucion ENCUENTRA».
// rho solo existe DURANTE la ejecucion: no se puede calcular leyendo la spec.
//
// LA SEPARACION, MEDIDA SOBRE 29 INTENTOS CON TELEMETRIA (2026-09-22):
//
//   grupo         n    rho                      que le pasa al builder
//   ───────────  ──   ──────────────────        ─────────────────────────────
//   OK           14   [0.900 .. 0.958]          toca el repo casi cada iteracion
//   AGOTAMIENTO   6   [0.156 .. 0.375]          gasta 40-90 iteraciones sin tocar
//   BLOQUEO       8   [0.500 .. 0.857]          para solo en 2-7 iteraciones
//
//   Hueco entre el peor OK (0.900) y el mejor agotamiento (0.375): +0.525.
//
// TRAS h-009 (179 lineas, 4,4x mayor) la nube se ensancho:
//   OK           15   [0.900 .. 0.958]
//   AGOTAMIENTO   7   [0.156 .. 0.725]   <- el techo subio de 0.375 a 0.725
//   hueco: +0.525 -> +0.175. Sigue separando, con un tercio del margen.
//
// QUE CAZA Y QUE NO. Solo el AGOTAMIENTO. Los bloqueos son el problema
// CONTRARIO --no llegan a empezar-- y ya paran por si solos sin gastar
// presupuesto; su rho invade la banda del umbral, asi que un gate que quisiera
// cazarlos tambien tendria que subir theta hasta rozar el 0.900 del peor OK y
// empezaria a matar vueltas buenas. W=8 los deja pasar sin juzgarlos.
//
// LO QUE AHORRA: de 663 iteraciones de Execution en el historico, 342 (51,6%)
// son cola posterior al punto en que rho ya habia delatado el final.
//
// LO QUE ESTO NO ES: no predice si una vuelta saldra bien. Detecta un estado del
// que no se vuelve. Un rho alto no promete exito -- H-20260915-aa9f21c7 tenia
// 0.909 y murio por presupuesto de superficie, que es otra cosa.

/**
 * RECALIBRADO el 2026-09-22 tras h-009. Antes 0.6, punto medio del hueco
 * 0.375..0.900 que daban las tasks de hasta 41 lineas.
 *
 * QUE LO ROMPIO: la vuelta H-20260922-db22e905 (h-009, 179 lineas) murio por
 * agotamiento --40 iteraciones, tope agotado-- con rho=0.725, MUY por encima del
 * umbral. El gate no disparo ni una vez: su rho venia de 1.000 en t=25 y solo
 * cayo a 0.725 en t=40. Corria en SOMBRA, asi que el fallo se midio en vez de
 * pasar inadvertido; con el gate activo habria sido un falso negativo silencioso.
 *
 * POR QUE 0.75 Y NO OTRO: se barrio el rango 0.600..0.900 en pasos de 0.025
 * sobre las 32 vueltas con telemetria. 0.750 es el PRIMERO que consigue recall
 * 1.00 sobre los 7 agotamientos manteniendo CERO falsos positivos, y deja +0.150
 * de margen al OK mas bajo (0.900). El criterio se fijo antes de mirar la tabla:
 * cero falsos positivos es innegociable, y entre los que cumplen, el de mayor
 * margen.
 *
 * LO QUE NO SE PUEDE AFIRMAR: el margen al agotamiento mas alto es +0.025, y ese
 * dato viene de UNA sola vuelta del regimen grande. Podria haber tasks grandes
 * que agoten con rho aun mayor y este umbral tambien se quedaria corto. Por eso
 * `sombraPorDefecto` existe: en las clases nuevas se mide antes de cortar.
 */
export const RHO_THETA = 0.75;

/**
 * Iteraciones de calentamiento antes de juzgar. 8 porque el bloqueo mas largo
 * del historico son 7 iteraciones: por debajo de eso no hay evidencia de
 * «dejo de tocar el repositorio», solo de que aun no lo ha tocado.
 */
export const RHO_W = 8;

/**
 * Funcion PURA: mismas entradas, mismo veredicto. Sin reloj, sin E/S, sin azar.
 * Asi el test puede fijar vueltas historicas por sus cifras exactas.
 *
 * @param {object}  o
 * @param {number}  o.iterations  iteraciones consumidas
 * @param {number}  o.toolCalls   llamadas a herramienta acumuladas
 * @param {boolean} [o.sombra]    medir sin decidir (estreno sin riesgo)
 * @returns {{parar, rho, iterations, habriaParado, onFail?, reason}}
 */
export function veredictoRho({
  iterations = 0, toolCalls = 0, sombra = false,
  W = RHO_W, theta = RHO_THETA,
} = {}) {
  const it = Number(iterations) || 0;
  const tc = Number(toolCalls) || 0;
  // Sin iteraciones no hay densidad que medir. rho=1 es el valor inocente:
  // nunca dispara, que es lo correcto cuando no se sabe nada todavia.
  const rho = it > 0 ? tc / it : 1;

  if (it < W) {
    return {
      parar: false, rho, iterations: it, habriaParado: false,
      reason: `rho=${rho.toFixed(3)} en calentamiento (${it}/${W}=W): aun no se juzga`,
    };
  }

  // FRONTERA ESTRICTA: rho == theta NO corta. Ante la duda se deja correr,
  // porque matar una vuelta buena cuesta mas que una cola desperdiciada.
  const disparo = rho < theta;
  if (!disparo) {
    return {
      parar: false, rho, iterations: it, habriaParado: false,
      reason: `rho=${rho.toFixed(3)} >= ${theta}: el builder sigue tocando el repositorio`,
    };
  }

  const reason = `rho=${rho.toFixed(3)} < ${theta} tras ${it} iteraciones y ${tc} llamadas: `
    + 'el builder dejo de tocar el repositorio y sigue iterando';

  // EN SOMBRA MIDE PERO NO DECIDE. El umbral se calibro con tasks de hasta 41
  // lineas; una mucho mayor podria necesitar mas lectura legitima antes de
  // escribir. `habriaParado` deja constancia para poder calibrar con datos del
  // regimen nuevo en vez de adivinar.
  if (sombra) return { parar: false, rho, iterations: it, habriaParado: true, reason: `[sombra] ${reason}` };

  return {
    parar: true, rho, iterations: it, habriaParado: true,
    // STOP, no RETRY: reintentar gasta otro presupuesto entero para llegar al
    // mismo sitio. Mismo criterio que un ciclo detectado en Convergence.
    onFail: 'STOP',
    reason,
  };
}

/**
 * Contador incremental para el bucle del builder. O(1) por iteracion: dos
 * enteros. No guarda historial -- si un dia hace falta la curva completa de
 * rho(t), sale de `toolCalls[].iteration`, que ya se persiste en el artefacto.
 */
export function crearGuardiaRho({ W = RHO_W, theta = RHO_THETA, sombra = false } = {}) {
  let iterations = 0;
  let toolCalls = 0;
  return {
    alIterar() { iterations += 1; },
    alLlamarHerramienta() { toolCalls += 1; },
    rho() { return iterations > 0 ? toolCalls / iterations : 1; },
    veredicto() { return veredictoRho({ iterations, toolCalls, sombra, W, theta }); },
  };
}
