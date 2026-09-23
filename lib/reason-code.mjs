/**
 * POR QUE PARO LA VUELTA — un codigo, no un parrafo.
 *
 * EL DEFECTO, medido sobre las 22 vueltas con traza del histórico: `trace.json`
 * cierra con `verdict` (FAILED/PASSED) y `reason`, que es PROSA LIBRE — y encima
 * en tres idiomas, porque la frase del builder se concatena tal cual:
 *
 *   «ROLLBACK en 'Execution': el builder termino en FAILED tras 90 iteraciones…»
 *   «ROLLBACK en 'Execution': el builder termino en BLOCKED tras 2 iteraciones: I stopp…»
 *
 * Trece de esas vueltas pararon en `Execution` por TRES causas que no se parecen
 * en nada: el tope de iteraciones agotado, el presupuesto de superficie excedido
 * y el builder auto-bloqueandose porque la spec era falsa. La ultima NO es un
 * fallo del anillo: es el anillo funcionando.
 *
 * Contarlas juntas es lo que produjo el error de `varianza-cero-no-era-determinismo`:
 * tres vueltas con vector de etapas identico parecian reproducibles y habian
 * fallado por motivos distintos. La posicion de parada no es la causa.
 *
 * ESTE MODULO NO INVENTA DATO: clasifica el `reason` que ya se escribe. Es
 * retroactivo a proposito — las 28 vueltas del histórico se etiquetan sin volver
 * a correrlas, y de ahi sale el conjunto con el que medir.
 *
 * PURO: texto -> codigo. Sin fs, sin red.
 */

/**
 * Las familias. `culpa` dice DE QUIEN es el fallo, que es lo que separa una
 * regresion de un exito:
 *   'harness'  el anillo se quedo corto (topes, presupuesto)
 *   'spec'     la peticion era imposible o falsa -> el anillo hizo bien en parar
 *   'modelo'   el LLM no produjo algo que el contrato admite
 *   'entorno'  red, cuota, proveedor
 */
export const CODIGOS = {
  TOPE_ITERACIONES:       { culpa: 'harness', etapa: 'Execution', desc: 'el builder agoto maxIterations' },
  TOPE_LLAMADAS:          { culpa: 'harness', etapa: 'Execution', desc: 'el builder agoto maxToolCalls' },
  PRESUPUESTO_SUPERFICIE: { culpa: 'harness', etapa: 'Execution', desc: 'el cambio excede surface.json' },
  BUILDER_SE_AUTOBLOQUEA: { culpa: 'spec',    etapa: 'Execution', desc: 'el builder midio y se nego: la spec no se sostiene' },
  BASELINE_INVALIDA:      { culpa: 'modelo',  etapa: 'Knowledge',  desc: 'el researcher no produjo un ArchitectureBaseline valido' },
  CITA_INVENTADA:         { culpa: 'modelo',  etapa: 'Knowledge',  desc: 'cita rutas que no existen' },
  CUOTA_AGOTADA:          { culpa: 'entorno', etapa: null,         desc: '429 o credito agotado' },
  PROVEEDOR_CAIDO:        { culpa: 'entorno', etapa: null,         desc: '5xx, timeout o modelo inexistente' },
  CONVERGENCIA_NO_ALCANZADA: { culpa: 'modelo', etapa: 'Convergence', desc: 'quedan hallazgos sin resolver' },
  CONTRATO_NO_JSON:       { culpa: 'modelo',  etapa: null,         desc: 'el modelo respondio prosa donde el contrato exige JSON' },
  // Nace de H-20260917-75135851 y -c53885df: el builder agoto el tope peleando
  // con 18 fallos que ya estaban en el arbol. `TOPE_ITERACIONES` lo describia
  // bien en la forma --se acabaron las iteraciones-- y mentia en el fondo: la
  // culpa no era del presupuesto, era de un runner que responde por el arbol
  // cuando se le pregunta por un cambio. Distinguirlos importa porque la
  // respuesta es opuesta: subir el tope no arregla un rojo ajeno.
  ROJO_PREEXISTENTE:      { culpa: 'entorno', etapa: 'Execution',  desc: 'el builder gasto el presupuesto en fallos que ya estaban en el arbol' },
  // H-20260917-fef6f11b: el builder toco `public/version.json`, que NO esta en
  // su frontera de escritura. Y no lo escribio el: lo REGENERA vite al correr
  // `run_test`/`run_typecheck` (vite.config.ts lo hornea antes de construir).
  // La frontera es correcta -- el builder no debe tocar artefactos de build--
  // pero la vuelta muere por un efecto colateral de sus propias herramientas.
  FRONTERA_VIOLADA:       { culpa: 'harness', etapa: 'Execution',  desc: 'se escribio fuera de la frontera declarada, a veces por efecto de las tools' },
  // H-20260921-26bf176e: la vuelta llego a 15/16 con Convergence en `pass: true,
  // blockers: 0, CONVERGED` --cero hallazgos P0-P5-- y murio porque `gate --full`
  // salio rojo dentro del workspace. El rojo era un test cuyo ancla a un commit
  // habia muerto al reescribir la historia: nada que ver con el cambio.
  //
  // SIN_CLASIFICAR significa «no se a que familia pertenece». Aqui SI se sabe, y
  // la distincion es la que mas importa de todo el catalogo: el trabajo del
  // modelo estaba TERMINADO. No hay nada que reintentar ni que corregirle --
  // reintentar la vuelta la volveria a matar en el mismo sitio.
  // H-20260918-bc2160bb: «reviewer no produjo un FindingSet valido: findings[0]
  // incumple Finding: falta 'severity'». No es CONTRATO_NO_JSON --devolvio JSON
  // perfectamente parseable-- sino JSON que incumple el ESQUEMA. La diferencia
  // decide la respuesta: ante prosa se reintenta pidiendo JSON; ante un esquema
  // incompleto hay que enseñarle el campo que falto.
  CONTRATO_INCOMPLETO:    { culpa: 'modelo',  etapa: null,         desc: 'devolvio JSON valido que NO cumple el esquema del contrato' },
  PUERTA_EN_ROJO:         { culpa: 'entorno', etapa: 'Evidence2',  desc: 'la vuelta convergio y la puerta del proyecto salio roja por el estado del arbol' },
  SIN_CLASIFICAR:         { culpa: null,      etapa: null,         desc: 'el reason no casa con ninguna familia conocida' },
};

/**
 * Orden DELIBERADO: lo mas especifico primero. «tope de 90 iteraciones agotado»
 * tambien contiene «termino en FAILED», y si BUILDER_SE_AUTOBLOQUEA ganara, las
 * cuatro vueltas del tope se contarian como culpa de la spec — que es justo el
 * borrado de informacion que este modulo existe para impedir.
 *
 * NO HAY REGLA PARA `ROJO_PREEXISTENTE`, y es a proposito: el `reason` dice
 * «tope de 90 iteraciones agotado» tanto si el builder razono de mas como si
 * peleo con un rojo ajeno. La diferencia NO esta en el texto — esta en comparar
 * los fallos de `run_test` contra los del arbol limpio, que es una medicion y no
 * un regex. Inventar aqui un patron que adivine seria exactamente el defecto que
 * este repo ya pago tres veces: afirmar sobre lo que no se midio.
 * Lo clasifica `clasificarConBaseline()`, que si recibe esa medicion.
 */
const REGLAS = [
  [/cita rutas de memory\/ que NO EXISTEN|cita inventada/i, 'CITA_INVENTADA'],
  [/tope de \d+ iteraciones agotado|maxIterations/i,        'TOPE_ITERACIONES'],
  [/tope de \d+ llamadas|maxToolCalls/i,                    'TOPE_LLAMADAS'],
  [/superficie de cambio fuera de presupuesto|lines \d+ > \d+/i, 'PRESUPUESTO_SUPERFICIE'],
  [/\b(429|cuota|quota|rate.?limit|credit)\b/i,             'CUOTA_AGOTADA'],
  [/\b5\d{2}\b|timeout|ECONNRESET|model not found|does not exist/i, 'PROVEEDOR_CAIDO'],
  [/ArchitectureBaseline/i,                                 'BASELINE_INVALIDA'],
  // Antes de BLOCKED: el modelo que pide aclaracion en vez de devolver JSON no
  // se auto-bloqueo por la spec, incumplio el CONTRATO. Caso real de agosto:
  // «no devolvio JSON reconocible; devolvio: "Necesito claridad: ¿cual es…"».
  [/no devolvio JSON reconocible|no produjo un \w+ valido: no devolvio/i, 'CONTRATO_NO_JSON'],
  // DESPUES de CONTRATO_NO_JSON: aquel exige «no devolvio», este cubre el resto
  // de «no produjo un X valido» -- el que SI devolvio JSON y le falta un campo.
  [/no produjo un \w+ valido: incumple|incumple \w+: \w+\[\d+\] incumple|falta '\w+'/i, 'CONTRATO_INCOMPLETO'],
  [/frontera violada|esta fuera de \[/i,                     'FRONTERA_VIOLADA'],
  [/termino en BLOCKED/i,                                   'BUILDER_SE_AUTOBLOQUEA'],
  [/convergenc/i,                                           'CONVERGENCIA_NO_ALCANZADA'],
  // DESPUES de `convergenc` a proposito: una vuelta que NO converge y ademas
  // tiene la puerta roja es culpa del modelo, no del entorno. Si esta regla
  // ganara, esos casos se contarian como ajenos y nadie volveria a mirarlos.
  [/gate --(full|fast) en rojo|gate en rojo dentro del workspace/i, 'PUERTA_EN_ROJO'],
];

/** @returns {string} una clave de CODIGOS. Nunca null: SIN_CLASIFICAR es un dato. */
export function codigoDe(reason) {
  const t = String(reason ?? '');
  if (!t.trim()) return 'SIN_CLASIFICAR';
  for (const [re, cod] of REGLAS) if (re.test(t)) return cod;
  return 'SIN_CLASIFICAR';
}

/** La etapa donde paró, leída del propio reason (`STOP en 'X'` / `ROLLBACK en 'X'`). */
export function etapaDe(reason) {
  return String(reason ?? '').match(/(?:STOP|ROLLBACK|FAIL) en '([^']+)'/)?.[1] ?? null;
}

/**
 * `TOPE_ITERACIONES` con medicion: ¿el builder se quedo corto, o peleaba con un
 * rojo que no era suyo?
 *
 * La pregunta no se responde leyendo el `reason` --dice lo mismo en los dos
 * casos-- pero si comparando cuantos tests fallaban DESPUES de su cambio contra
 * cuantos fallaban ANTES, en el arbol limpio. Si el delta es <= 0 no rompio nada:
 * gasto el presupuesto en deuda ajena.
 *
 * MEDIDO en h-008 v2: `18 failed | 1877 passed` durante la vuelta y `18 failed |
 * 1859 passed` en el arbol limpio. Delta de fallos = 0, con 18 tests suyos nuevos
 * que ademas pasaron.
 *
 * @param {object} trace
 * @param {{fallosDespues?: number, fallosAntes?: number}} medicion
 *        Los dos numeros o ninguno: con uno solo no hay comparacion, y un dato a
 *        medias no reclasifica nada.
 */
export function clasificarConBaseline(trace, medicion = {}) {
  const base = trace?.verdict === 'PASSED' ? 'OK' : codigoDe(trace?.reason);
  if (base !== 'TOPE_ITERACIONES') return base;
  const { fallosDespues, fallosAntes } = medicion;
  if (!Number.isFinite(fallosDespues) || !Number.isFinite(fallosAntes)) return base;
  return fallosDespues <= fallosAntes ? 'ROJO_PREEXISTENTE' : base;
}

/**
 * El veredicto estructurado de una vuelta. Es la FILA del conjunto de
 * entrenamiento: una vuelta, una etiqueta, con su procedencia.
 */
export function veredicto(trace) {
  const reason = trace?.reason ?? null;
  const code = trace?.verdict === 'PASSED' ? 'OK' : codigoDe(reason);
  const meta = CODIGOS[code] ?? {};
  return {
    executionId: trace?.executionId ?? null,
    verdict: trace?.verdict ?? null,
    reason_code: code,
    culpa: code === 'OK' ? null : (meta.culpa ?? null),
    etapa: etapaDe(reason) ?? meta.etapa ?? null,
    etapasRecorridas: (trace?.stages ?? []).filter((s) => s.status === 'OK').length,
    reason,
  };
}

/**
 * Determinismo POR CAUSA. La metrica vieja comparaba el vector de 16 bits y daba
 * s²=0 a tres vueltas que fallaron por motivos distintos.
 *
 * `reproducible` exige (etapa, reason_code) identicos, no solo la posicion.
 */
export function determinismo(traces) {
  const vs = traces.map(veredicto);
  const clave = (v) => `${v.etapa ?? '-'}|${v.reason_code}`;
  const grupos = new Map();
  for (const v of vs) grupos.set(clave(v), (grupos.get(clave(v)) ?? 0) + 1);
  const mayor = Math.max(0, ...grupos.values());
  return {
    n: vs.length,
    clases: grupos.size,
    reproducible: grupos.size === 1 && vs.length > 1,
    // 1 = todas iguales; 1/n = todas distintas. Con n<2 no hay nada que medir.
    acuerdo: vs.length > 1 ? mayor / vs.length : null,
    distribucion: Object.fromEntries([...grupos].sort((a, b) => b[1] - a[1])),
  };
}
