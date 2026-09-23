// SPECIFICATION_BLOCKED — cuando la tarea no se puede hacer.
//
// EL DATO QUE ABRE ESTE FICHERO. De las cinco corridas que fallaron entre las
// fases 7 y 9, DOS murieron por la especificacion y no por el harness
// (memory/failures/la-especificacion-es-hoy-la-causa-dominante-de-parada.md):
//
//   52af3889  la aceptacion exigia un test y `task.files` no tenia donde ponerlo
//   6b16c1a5  la aceptacion prohibia el fix que el revisor exigia
//
// Las dos agotaron sus REWORK. Y un `REWORK agotado` se lee siempre igual --«el
// modelo no supo»-- cuando en estos dos casos significaba «la tarea no se podia
// hacer». Ningun contador de reintentos distingue esas dos cosas, y por eso
// subir MAX_REWORK no arregla ninguna: compra mas intentos de lo imposible.
//
// DOS MOMENTOS:
//
//   ANTES   `revisar(task)` — lo comprobable sobre el manifiesto, sin gastar una
//           sola invocacion. Aqui el error cuesta segundos.
//   DESPUES `bloqueadaPorEspecificacion()` — el mismo hallazgo sobreviviendo a
//           correcciones REALES ronda tras ronda. Esa es la firma de un criterio
//           que no se puede satisfacer.
//
// Puro: sin E/S.

/** La tabla de comprobaciones. Cada una nombra la corrida que la justifica. */
const PIDE_TEST = /\bspec\b|\btest\b|falla por asercion|failing test/i;
const ES_TEST = /\.(spec|test)\.[cm]?[jt]sx?$/;
const CONSERVA = /conserva.{0,20}exactamente|exactamente el comportamiento|sin cambiar el comportamiento/i;
// `corr[ei]g` y no `corrig`: «corregirlo» no contiene «corrig», asi que la regla
// que este fichero existe para hacer cumplir no se disparaba nunca sobre la
// redaccion REAL de la corrida que la motivo. Lo encontro el test.
const CORRIGE = /corr[ei]g|correcc|hay que arreglar|esta roto|bug\b/i;
const ACOTA_DOMINIO = /\bdominio\b|dentro de ese|fuera de(l| ese)|para entradas/i;

/**
 * Las preguntas que se pueden responder leyendo el manifiesto.
 *
 * Son las tres del failure, y solo se mecanizan las dos que se pueden mecanizar
 * sin adivinar. La tercera --«¿el goal describe esta vuelta o el problema
 * entero?»-- exige entender la intencion y NO se finge aqui: fingirla daria
 * falsos bloqueos sobre tareas correctas, que es peor que no comprobarla.
 *
 * @returns [] si la spec se sostiene, o los problemas encontrados.
 */
export function revisar(task) {
  const p = [];
  const acc = task?.acceptance ?? [];
  const files = task?.files ?? [];

  // 1. ¿Existe un fichero permitido donde quepa el test que la aceptacion exige?
  //    Medido en H-20260816-52af3889: el builder cerro TRES vueltas con un P5
  //    vivo que era estructuralmente imposible de corregir desde dentro de
  //    `task.files`. Nadie hizo nada mal; la tarea no tenia solucion.
  if (acc.some((c) => PIDE_TEST.test(c)) && !files.some((f) => ES_TEST.test(f))) {
    p.push(
      'la aceptacion exige un test y `task.files` no incluye ningun fichero de spec: '
      + 'no hay donde escribirlo (H-20260816-52af3889)',
    );
  }

  // 2. ¿Puede el builder satisfacer TODOS los criterios a la vez?
  //    Medido en H-20260816-6b16c1a5: la aceptacion decia «conserva EXACTAMENTE
  //    el comportamiento» y ese comportamiento incluia el bug que el revisor
  //    exigia corregir. Subio la severidad tres rondas -- P5, P4, P3-- y tenia
  //    razon las tres. El builder tambien. El manifiesto les pedia cosas
  //    incompatibles.
  //
  //    La salida NO es elegir un bando: es ACOTAR EL DOMINIO. Decir dentro de
  //    que entradas se conserva y fuera de cuales hay que corregir. Por eso la
  //    incompatibilidad solo se declara cuando NINGUN criterio acota nada.
  if (acc.some((c) => CONSERVA.test(c)) && acc.some((c) => CORRIGE.test(c))
      && !acc.some((c) => ACOTA_DOMINIO.test(c))) {
    p.push(
      'la aceptacion exige conservar el comportamiento EXACTAMENTE y ademas corregirlo, '
      + 'sin acotar el dominio: son incompatibles salvo que se diga dentro de que entradas '
      + 'se conserva y fuera de cuales se corrige (H-20260816-6b16c1a5)',
    );
  }

  // 3. ¿Puede el builder RETIRAR lo que la spec siembra?
  //    Desde h-007 una semilla que sigue en el arbol al cerrar Execution es un
  //    hallazgo P0 de `secrets` y la politica BLOQUEA. Eso es lo que h-007
  //    existe para demostrar y esta bien -- pero abre un camino sin salida que
  //    ANTES no existia:
  //
  //      seed fuera de task.files -> el builder no puede tocar el fichero
  //      -> no la retira -> sigueEnElArbol true -> P0 -> BLOCK
  //      -> onFail REWORK -> vuelve el builder -> SIGUE sin poder tocarlo -> BLOCK
  //
  //    Hasta agotar MAX_REWORK, sin que nadie haya hecho nada mal. Antes de
  //    h-007 esa misma spec salia ALLOW: mal, pero avanzaba. Es exactamente la
  //    forma de la regla 1 --el manifiesto exige algo que la allowlist no
  //    permite satisfacer-- y su segunda instancia. Hallazgo de `third`,
  //    auditando el arreglo de h-007 antes de que se empujara.
  //
  //    A DIFERENCIA de las dos de arriba, esta no viene de una corrida que ya
  //    ocurrio: viene de una que el propio arreglo vuelve alcanzable, y la
  //    cadena se comprueba leyendo. Se declara asi a proposito. El mensaje dice
  //    CUAL de los dos hay que ampliar, porque quien lo lea no va a saberlo.
  // PERTENENCIA EXACTA, Y NO ES UNA ELECCION DE ESTA REGLA: es la del sistema.
  // Los otros DOS sitios que deciden «esto esta en task.files» comparan igual --
  // `assertPlanDentroDelAlcance` (etapa 4) y el cierre de Execution
  // (stages-model.mjs, `permitidos.has(f)`)--. Asi que una CARPETA en task.files
  // ya esta rota en el planificador y en el ejecutor antes de llegar aqui: el
  // builder no podria escribir dentro de ella tampoco.
  //
  // La asimetria con `forbiddenPaths` es deliberada y esta al lado: aquel SI usa
  // prefijo (`f.startsWith(g.replace('/**', '/'))`). Permitir es exacto; prohibir
  // es por prefijo. Al reves --permitir por prefijo-- una allowlist de carpeta
  // abriria a la vez todo lo que cuelga.
  //
  // MEDIDO hoy: 209 rutas de `task.files` en los 7 ficheros de spec, 0 terminadas
  // en «/» y 0 sin extension. El formato se cumple; nada lo obliga.
  //
  // SI ALGUN DIA SE ADMITEN CARPETAS, hay que cambiar LOS TRES A LA VEZ. Cambiar
  // solo este daria un falso SPECIFICATION_BLOCKED --lo que el comentario de mas
  // abajo llama el peor fallo de un preflight--; cambiar solo los otros dos
  // dejaria pasar una semilla que el builder no puede retirar, que es el bucle
  // que esta regla existe para evitar. Latente levantado por `third`; no es
  // alcanzable hoy y por eso NO se anade un cuarto sitio que asevere el formato:
  // un guard mas seria una cuarta autoridad sobre el mismo hecho.
  const permitidos = new Set(files);
  const sembradosFuera = (task?.seed ?? []).map((s) => s?.path).filter((f) => f && !permitidos.has(f));
  if (sembradosFuera.length) {
    p.push(
      `\`task.seed\` siembra fuera de \`task.files\`: ${sembradosFuera.join(', ')}. `
      + 'Desde h-007 una semilla que sobrevive a Execution BLOQUEA, y el builder no puede '
      + 'retirar lo que no tiene permiso para tocar: la vuelta entra en REWORK sin salida. '
      + `Anade ${sembradosFuera.length === 1 ? 'esa ruta' : 'esas rutas'} a \`task.files\`, `
      + 'o retira la semilla',
    );
  }

  // NO HAY UNA TERCERA REGLA, y el hueco es deliberado. Habia una: «un criterio
  // que nombra una ruta prohibida». Bloqueaba H-001, cuya aceptacion CITA
  // `memory/failures/el-fix-que-no-existe.md` como referencia -- nombrar un
  // fichero y exigir modificarlo no son lo mismo, y una expresion regular no
  // distingue una cita de un requisito.
  //
  // No estaba respaldada por ninguna corrida: las dos de arriba lo estan. Una
  // regla especulativa que da un falso SPECIFICATION_BLOCKED sobre la unica
  // tarea que el harness sabe ejecutar es el peor fallo posible en un preflight,
  // porque bloquea antes de que nada pueda desmentirla.
  return [...new Set(p)];
}

/**
 * ponytail: heuristica sobre texto, con su techo declarado. No entiende la
 * aceptacion: reconoce las DOS formas que ya costaron una vuelta cada una. Una
 * spec incoherente de una forma nueva pasa por aqui sin ruido, y esta bien que
 * asi sea -- lo alternativo es un modelo juzgando specs, que es una autoridad
 * nueva sobre algo que el harness no puede verificar. Cuando aparezca una
 * tercera forma medida, se anade su linea con su corrida delante.
 */
export function assertEspecificacion(task) {
  const p = revisar(task);
  if (p.length) {
    throw new Error(`SPECIFICATION_BLOCKED antes de empezar — ${p.join(' · ')}`);
  }
  return task;
}

/**
 * DESPUES: ¿el mismo criterio esta bloqueando pese a correcciones reales?
 *
 * La firma es doble y hacen falta las dos mitades:
 *
 *  · un hallazgo PERSISTE en todas las rondas -- nadie lo refuto ni lo corrigio
 *  · y el builder MUTO en todas ellas -- no es que no lo intentara
 *
 * Sin la segunda, esto acusaria a la spec de lo que en realidad es un builder
 * pasivo; y el `done` contractual ya cierra ese otro caso por su lado.
 *
 * `minRondas` en 3 no es arbitrario: con MAX_REWORK 4, la ronda 3 son 2
 * reintentos, que es justo el techo que la fase se pone. Cruzarlo obliga a
 * justificarse en vez de seguir gastando.
 *
 * @param persistentes fingerprints presentes en TODAS las rondas
 * @param mutacionesPorRonda cuantas mutaciones aplico el builder en cada una
 */
export function bloqueadaPorEspecificacion(persistentes, mutacionesPorRonda, { minRondas = 3 } = {}) {
  const rondas = mutacionesPorRonda ?? [];
  if (rondas.length < minRondas || !(persistentes ?? []).length) return null;
  if (!rondas.every((m) => m > 0)) return null;
  return {
    verdict: 'SPECIFICATION_BLOCKED',
    persistent: persistentes,
    rounds: rondas.length,
    why: `${persistentes.length} hallazgo(s) sobrevivieron a ${rondas.length} rondas de correcciones `
      + `REALES (${rondas.join('+')} mutaciones). El builder corrigio y el hallazgo sigue: `
      + 'o el criterio no se puede satisfacer, o dos criterios se contradicen. '
      + 'Mas reintentos producen mas de lo mismo',
  };
}
