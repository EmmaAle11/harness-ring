// ── Quorum de auditoria: logica pura ────────────────────────────────────────
//
// Decide si un conjunto de votos autoriza a proceder. NO habla con ningun
// modelo: eso es `harness/bin/votar.mjs`. La separacion permite probar el
// veredicto sin cargar 13 GB de modelo.

export const VEREDICTOS = Object.freeze({
  APROBADO: 'APROBADO',
  RECHAZADO: 'RECHAZADO',
  SIN_QUORUM: 'SIN_QUORUM',
});

/**
 * Extrae el puntaje de la respuesta de un votante.
 *
 * CASE-INSENSITIVE A PROPOSITO: un regex que exigia `PUNTAJE` en mayusculas
 * anulo dos veces el voto de deepseek, que responde `Puntaje:`. El voto era
 * valido; el instrumento no lo leia. Un votante no se descarta por como escribe
 * -- y ese votante fue justo el que encontro el hallazgo mas valioso.
 *
 * NO INVENTA: sin linea de puntaje el voto es NULO. Deducirlo del tono es
 * exactamente la clase de medicion que falla.
 */
export function parsearVoto(texto) {
  const t = typeof texto === 'string' ? texto : '';
  const m = /puntaje\s*:\s*(-?\d+)/i.exec(t);
  const n = m ? Number(m[1]) : null;
  const puntaje = Number.isInteger(n) && n >= 0 && n <= 10 ? n : null;
  const cap = (re) => { const x = re.exec(t); return x ? x[1].trim().slice(0, 200) : null; };
  return {
    puntaje,
    fortaleza: cap(/fortaleza\s*:\s*(.+)/i),
    debilidad: cap(/debilidad\s*:\s*(.+)/i),
  };
}

/**
 * La via de escape, que existe para que la puerta no sea un SPOF.
 *
 * Si el quorum bloqueante es el unico camino y un votante cae, el repositorio
 * entero queda sin poder commitear. Pero un escape sin motivo deja de ser
 * escape y pasa a ser interruptor: exige un motivo de longitud suficiente, que
 * despues queda ESCRITO en la evidencia con su fecha.
 *
 * @returns {string|null} el motivo saneado, o null si no procede omitir
 */
export function motivoDeOmision(valor, reglas = {}) {
  const min = Number.isInteger(reglas.motivoMinimoCaracteres) ? reglas.motivoMinimoCaracteres : 12;
  if (typeof valor !== 'string') return null;
  const m = valor.trim();
  return m.length >= min ? m : null;
}

/**
 * @param {{modelo:string, familia:string, puntaje:number|null}[]} votos
 * @param {{regla?:string, votosMinimos:number, puntajeMinimo:number,
 *          minimoTolerado?:number, familiasDistintas:boolean}} reglas
 */
export function evaluarQuorum(votos, reglas) {
  const lista = Array.isArray(votos) ? votos : [];
  const validos = lista.filter((v) => Number.isInteger(v?.puntaje));
  const nulos = lista.filter((v) => !Number.isInteger(v?.puntaje));
  const familias = new Set(validos.map((v) => v.familia));
  const puntajes = validos.map((v) => v.puntaje);

  const minimo = puntajes.length ? Math.min(...puntajes) : null;
  const maximo = puntajes.length ? Math.max(...puntajes) : null;
  const base = {
    regla: reglas.regla ?? 'estricta',
    votosValidos: validos.length,
    votosNulos: nulos.length,
    familias: familias.size,
    minimo,
    maximo,
    // EL RANGO ES EL DATO QUE DECIDE LA REGLA. Sin el no se puede saber si un
    // juez oscila, y sin saberlo no se puede elegir entre estricta y mixta.
    rango: puntajes.length ? maximo - minimo : null,
    media: puntajes.length
      ? Number((puntajes.reduce((a, b) => a + b, 0) / puntajes.length).toFixed(2))
      : null,
    votos: lista.map((v) => ({
      modelo: v?.modelo ?? '?', familia: v?.familia ?? '?', puntaje: v?.puntaje ?? null,
    })),
  };

  // ATOMICIDAD: sin los votos exigidos no hay veredicto, ni bueno ni malo.
  if (validos.length < reglas.votosMinimos) {
    return { ...base, veredicto: VEREDICTOS.SIN_QUORUM,
      razon: `${validos.length} de ${reglas.votosMinimos} votos validos`
        + (nulos.length
          ? ` · ${nulos.length} nulo(s) sin puntaje: ${nulos.map((v) => v.modelo).join(', ')}`
          : '') };
  }
  if (reglas.familiasDistintas && familias.size < reglas.votosMinimos) {
    return { ...base, veredicto: VEREDICTOS.SIN_QUORUM,
      razon: `${familias.size} familia(s) distintas para ${reglas.votosMinimos} votos:`
        + ' dos modelos del mismo linaje comparten sesgos, su acuerdo es correlacion' };
  }

  // REGLA MIXTA: media >= puntajeMinimo Y nadie por debajo del tolerado.
  // No es una rebaja de la estricta: es el criterio correcto cuando la medicion
  // demuestra que un juez oscila +-1, porque entonces exigir que los CUATRO
  // superen el umbral en la MISMA corrida convierte el muestreo en loteria.
  if (base.regla === 'mixta') {
    const tolerado = Number.isInteger(reglas.minimoTolerado) ? reglas.minimoTolerado : reglas.puntajeMinimo;
    const suspensos = validos.filter((v) => v.puntaje < tolerado);
    if (suspensos.length) {
      return { ...base, veredicto: VEREDICTOS.RECHAZADO,
        razon: `por debajo del tolerado ${tolerado}: `
          + suspensos.map((v) => `${v.modelo}=${v.puntaje}`).join(', ')
          + ' · una media alta no compensa un suspenso' };
    }
    if (base.media < reglas.puntajeMinimo) {
      return { ...base, veredicto: VEREDICTOS.RECHAZADO,
        razon: `media ${base.media} < ${reglas.puntajeMinimo} (minimo ${base.minimo}, rango ${base.rango})` };
    }
    return { ...base, veredicto: VEREDICTOS.APROBADO,
      razon: `mixta: media ${base.media} >= ${reglas.puntajeMinimo}, minimo ${base.minimo} >= ${tolerado}`
        + ` · ${familias.size} familias · rango ${base.rango}` };
  }

  // REGLA ESTRICTA (por defecto): los CUATRO tienen que llegar.
  const bajos = validos.filter((v) => v.puntaje < reglas.puntajeMinimo);
  if (bajos.length) {
    return { ...base, veredicto: VEREDICTOS.RECHAZADO,
      razon: `no alcanzan ${reglas.puntajeMinimo}: `
        + bajos.map((v) => `${v.modelo}=${v.puntaje}`).join(', ') };
  }
  return { ...base, veredicto: VEREDICTOS.APROBADO,
    razon: `estricta: ${validos.length} votos de ${familias.size} familias,`
      + ` minimo ${base.minimo}, rango ${base.rango}` };
}

/**
 * ¿Le alcanza el presupuesto de tokens a este votante para llegar a responder?
 *
 * UN RAZONADOR GASTA ANTES DE HABLAR. `deepseek-flash` y `deepseek-v4-pro`
 * emiten `reasoning_content` primero; si `max_tokens` se agota ahi, la respuesta
 * llega VACIA con finish_reason='length'. Medido: con 30 tokens los dos
 * devolvieron content='' -- voto nulo por el INSTRUMENTO, no por el modelo.
 *
 * Es una funcion y no un numero suelto porque el defecto es facil de reintroducir
 * al anadir un votante: `razonador: true` sin `maxTokens` DEBE fallar.
 */
export function presupuestoSuficiente(votante, minimo) {
  if (!votante?.razonador) return true;          // no razona: le sobra
  return Number.isInteger(votante.maxTokens) && votante.maxTokens >= minimo;
}
