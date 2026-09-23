// Refutacion por MAYORIA — el veredicto deja de ser una muestra de un proceso
// ruidoso.
//
// EL DEFECTO MEDIDO. En H-20260816-b0ae48ef el mismo hallazgo P5, sobre el MISMO
// codigo sin cambiar una linea, salio CONFIRMED, CONFIRMED y REFUTED en tres
// rondas consecutivas. El anillo paso en la tercera. Un anillo que pasa porque le
// toco la pasada blanda no ha convergido: ha tenido suerte.
//
// La convergencia (etapa 10) SI es determinista -- ADR-004 -- pero lo que le
// llegaba no lo era. Deduplicar de forma reproducible unos veredictos que cambian
// entre corridas produce un resultado reproduciblemente arbitrario.
//
// LA RECETA es la que Learning ya usa para derivar confianza: repetir y contar.
// N pasadas INDEPENDIENTES sobre el mismo FindingSet, y el veredicto por mayoria.
//
// Independientes de verdad: ninguna pasada ve el veredicto de otra. Si la segunda
// leyera a la primera no estaria votando, estaria anclando, y tres votos anclados
// valen lo que uno. Como deben ser independientes, ademas pueden correr en
// paralelo -- el requisito de correccion y la optimizacion son la misma cosa.
//
// PURO: sin E/S y sin invocar nada. Quien llama a los modelos es la etapa.
import { findingKey } from './converge.mjs';
import { idsDe } from './findings.mjs';

/** Impar a proposito: con N par hay empates y un empate no es un veredicto. */
export const PASADAS = 3;

/**
 * Si las pasadas van EN SERIE. Depende de donde corra el modelo, no de quien sea.
 *
 * El comentario de arriba decia: «como deben ser independientes, ademas pueden
 * correr en paralelo -- el requisito de correccion y la optimizacion son la misma
 * cosa». La primera mitad es cierta; la segunda es FALSA en local, y medirla dio
 * la vuelta a la suposicion.
 *
 * MEDIDO el 21-ago con `qwen2.5-coder:14b` y un prompt de 14.621 chars, el tamano
 * real de una refutacion:
 *
 *   PARALELO   117,7 / 72,6 / 99,7 s   ->  pared 117,7 s
 *   SERIE        5,6 / 17,5 / 10,7 s   ->  pared  33,9 s
 *
 * Tres inferencias concurrentes en la misma CPU se estorban: la pared es 3,5x
 * PEOR y cada peticion dura entre 7 y 21 veces mas. Y eso ultimo es lo que mata:
 * `fetch` de node corta a los 300 s --`headersTimeout` de undici, que ningun
 * `AbortSignal` alarga-- asi que la contencion no ralentiza la vuelta, la MATA.
 * Es lo que paso en H-20260821-575882c8: dos de tres pasadas en [TIMEOUT].
 *
 * La independencia es sobre lo que cada pasada VE, no sobre cuando corre. En
 * serie siguen sin conocerse.
 *
 * Se decide por `offline` del CATALOGO, no por `provider === 'ollama'`: lo que
 * importa es que el modelo corra en esta maquina, y eso el catalogo ya lo
 * declara. Fijar el nombre del proveedor seria fijar el literal de hoy.
 */
export function enSerie(catalog, { provider, model } = {}) {
  const ms = catalog?.models ?? catalog ?? [];
  const lista = Array.isArray(ms) ? ms : Object.values(ms);
  const e = lista.find((m) => m?.provider === provider && (m?.model_id === model || m?.model === model));
  return Boolean(e?.offline);
}

export const VEREDICTOS = ['CONFIRMED', 'REFUTED', 'UNDECIDED', 'UNREVIEWED'];

/**
 * Cuenta los votos de UN hallazgo.
 *
 * `UNDECIDED` no es un empate: es «no hubo votos suficientes para decidir». Pasa
 * cuando una pasada falla o cuando omite el hallazgo, y las dos cosas son
 * abstenciones, no opiniones.
 *
 * SALVO UNA. Un silencio marcado `lost: true` viene de una pasada que SI emitio
 * votos y a la que el harness le tiro alguno por no casar el `id`: esa pasada
 * hablo. Tratarlo como abstencion es lo que dejo cerrar H-20260824-d897a07f en
 * `CONVERGED` con doce votos emitidos y OCHO descartados -- y ahi murio el unico
 * hallazgo verdadero de la vuelta, por el mismo camino que los tres falsos.
 *
 * No cambia el veredicto: un voto que no se tiene no se puede contar. Lo que
 * cambia es que el veredicto sale ETIQUETADO con su causa, para que la etapa 11
 * pueda distinguir «se voto y no hubo mayoria» de «la refutacion ocurrio y la
 * perdimos». Las dos salian con la misma etiqueta y el mismo efecto.
 *
 * @param votos [{pass, verdict, reason, lost}] — solo los emitidos
 * @param minVotos cuantos hacen falta para que la mayoria signifique algo
 */
export function tally(votos, { minVotos = 2 } = {}) {
  const emitidos = (votos ?? []).filter((v) => v?.verdict === 'CONFIRMED' || v?.verdict === 'REFUTED');
  const refutados = emitidos.filter((v) => v.verdict === 'REFUTED').length;
  const confirmados = emitidos.length - refutados;
  // Silencios que NO son abstencion: la pasada voto y el harness tiro el voto.
  const perdidos = (votos ?? []).filter((v) => v?.lost).length;
  const counts = {
    confirmed: confirmados, refuted: refutados,
    abstained: (votos ?? []).length - emitidos.length - perdidos,
    lost: perdidos,
  };

  // NADIE SE PRONUNCIO != NO HUBO MAYORIA, y confundirlos deja pasar una vuelta
  // entera sin revisar.
  //
  // MEDIDO en H-20260818-50778834: las TRES pasadas corrieron bien
  // (`passesOk: 3`) y se abstuvieron en los DOS hallazgos. Los dos salieron
  // UNDECIDED, Convergence no bloquea UNDECIDED -- y el anillo declaro
  // `CONVERGED` con cero bloqueantes. Cerro por ABSTENCION, no por convergencia.
  //
  // `UNDECIDED` significa «se voto y no hubo mayoria»: bloquear con eso seria
  // bloquear con ruido, y por eso no bloquea. `UNREVIEWED` significa otra cosa
  // -- la refutacion NO OCURRIO para este hallazgo -- y es exactamente el caso
  // que Convergence ya trata como bloqueante cuando un hallazgo llega sin
  // veredicto: no revisado no es aprobado.
  if (!emitidos.length) {
    return {
      verdict: 'UNREVIEWED',
      votes: votos ?? [],
      counts,
      why: perdidos
        ? `${perdidos} de ${(votos ?? []).length} pasadas VOTARON y el harness tiro el voto: `
          + 'este hallazgo no se refuto porque no supimos leer la refutacion'
        : `las ${(votos ?? []).length} pasadas se abstuvieron: este hallazgo NO se refuto`,
      lostVotes: perdidos,
    };
  }

  if (emitidos.length < minVotos) {
    return {
      verdict: 'UNDECIDED',
      votes: votos ?? [],
      counts,
      why: perdidos
        ? `solo ${emitidos.length} voto(s) de ${minVotos}, y ${perdidos} pasada(s) votaron y el `
          + 'harness tiro el voto: NO es que nadie pudiera decidirlo'
        : `solo ${emitidos.length} voto(s) de ${minVotos} necesarios: nadie pudo decidirlo`,
      lostVotes: perdidos,
    };
  }
  return {
    // Mayoria estricta de refutaciones para MATAR un hallazgo. Con 3 pasadas:
    // 1 refutacion de 3 -> sobrevive; 2 de 3 -> muere. Es deliberadamente asi y
    // no al reves: una sola voz que refuta no debe poder retirar un hallazgo,
    // porque es exactamente la varianza que esto viene a corregir.
    verdict: refutados > confirmados ? 'REFUTED' : 'CONFIRMED',
    votes: votos ?? [],
    counts,
    why: `${confirmados} confirman / ${refutados} refutan`,
    lostVotes: perdidos,
  };
}

/**
 * ARRASTRE — un hallazgo que provoco un REWORK no muere por no volver a salir.
 *
 * El defecto medido en H-20260816-e2ec5f67: la ronda 1 confirmo un P5 por 2 de 3
 * votos, Convergence bloqueo, y en la ronda 2 `Validation` simplemente NO volvio
 * a reportarlo. La vuelta acabo en PASSED. Nadie lo refuto, nadie lo arreglo: se
 * cayo de la lista.
 *
 * Es el mismo error de razonamiento que `el-fix-que-no-existe`, un nivel mas
 * arriba: alli el fix no hacia nada y su comentario decia que si; aqui el
 * hallazgo desaparece y su ausencia se lee como resolucion. **La ausencia de
 * evidencia no es evidencia de ausencia**, y menos cuando ya se midio que la
 * generacion de hallazgos varia entre rondas.
 *
 * Arrastrado, el hallazgo vuelve a la urna: si el builder lo arreglo, las pasadas
 * lo REFUTARAN porque la premisa ya no se sostiene en el codigo -- que es una
 * afirmacion comprobable. Si nadie se pronuncia, sigue vivo y vuelve a bloquear.
 *
 * Pierde su veredicto anterior a proposito: se vota de nuevo, no se hereda.
 */
export function arrastrar(nuevos, pendientes = []) {
  const yaEstan = new Set((nuevos ?? []).map(findingKey));
  const heredados = (pendientes ?? [])
    .filter((f) => !yaEstan.has(findingKey(f)))
    .map(({ verdict, votes, counts, why, findingId, ...f }) => ({
      ...f,
      carried: true,
      carriedFrom: findingId ?? null,
      carriedReason: 'bloqueo una ronda anterior y esta no volvio a reportarlo',
    }));
  return [...(nuevos ?? []), ...heredados];
}

/**
 * El aviso que convierte el arrastre en algo refutable.
 *
 * EL DEFECTO MEDIDO (H-20260817-95193afa): el builder elimino el
 * `dangerouslySetInnerHTML` sembrado -- `grep -c` sobre el fichero devolvia 0 --
 * y las tres pasadas siguieron confirmando el hallazgo. Los cinco bloqueantes
 * finales eran arrastrados y ninguno nuevo: la vuelta murio pidiendole al builder
 * que corrigiera algo ya corregido.
 *
 * Un hallazgo heredado que llega SIN ETIQUETA se trata como fresco, y entonces el
 * mecanismo que lo conserva es el que lo fosiliza. `carried: true` ya viajaba en
 * el dato; lo que faltaba era que la pasada supiera que significa.
 *
 * PURO y exportado a proposito: sin esto, la unica forma de comprobar que la
 * pasada distingue lo heredado seria correr una vuelta de 30 minutos.
 */
export function avisoDeArrastre(findings) {
  const n = (findings ?? []).filter((f) => f?.carried).length;
  if (!n) return '';
  return `\n\nATENCION -- ${n} de estos hallazgos llegan con \`carried: true\`. Vienen de una RONDA `
    + 'ANTERIOR y el builder ya ha trabajado desde entonces, asi que su premisa puede haber dejado '
    + 'de sostenerse. NO los re-confirmes por su texto: comprueba cada premisa contra el ChangeSet '
    + 'de AHORA, que tienes delante. Si el codigo que denuncian ya no aparece en el diff actual, el '
    + 'hallazgo es REFUTED, y esa es la respuesta correcta: significa que quedo corregido.';
}

/**
 * Une N FindingSets de refutacion en UNO, con los votos de cada hallazgo.
 *
 * La identidad es `findingKey` -- (fichero, simbolo, claim) -- que ya existe y es
 * la misma que usa la convergencia. Reimplementarla aqui habria creado dos
 * nociones de «el mismo hallazgo», y entonces dos pasadas que hablan del mismo
 * defecto se contarian como hallazgos distintos con un voto cada uno: todos
 * UNDECIDED, y el mecanismo entero no serviria para nada.
 *
 * @param base      el FindingSet de Validation: define QUE se vota
 * @param pasadas   [{ok, findings}|null] una por pasada; `null` o `ok:false` = fallo
 */
export function unificarVotos(base, pasadas) {
  // LA IDENTIDAD VIAJA, no se recalcula. Antes se casaba el voto reconstruyendo
  // `findingKey`/`fingerprint` sobre lo que el MODELO devolvia, y eso obligaba a
  // que reprodujera `file`, `symbol`, `claim`, `severity` y `evidence` de cada
  // hallazgo solo para poder identificarlo.
  //
  // Dos costes, los dos medidos. En H-20260818-50778834 --primera vuelta con
  // refutador de otra familia-- reformulo el claim, la clave dejo de coincidir y
  // se tiraron los 6 votos emitidos. En H-20260821-575882c8 la unica pasada que
  // contesto devolvio 6 elementos SIN esos campos y el contrato la rechazo
  // entera: el modelo hacia su trabajo --votar-- y se le pedia el de otro.
  //
  // Ahora el harness CALCULA el `fingerprint`, lo ENVIA como `id` y el modelo lo
  // copia. Una identidad que viaja no se puede perder al reformular.
  const votadas = (pasadas ?? []).map((p, i) => ({
    pass: i + 1,
    ok: Boolean(p?.ok !== false && p),
    porId: new Map((p?.votes ?? []).map((v) => [String(v?.id ?? ''), v])),
  }));

  // MISMA autoridad que la que construyo la entrada (`findings.idsDe`). Derivarla
  // aqui por separado seria la segunda autoridad sobre el mismo hecho: bastaria
  // que una de las dos cambiara para que TODOS los votos salieran huerfanos, y
  // eso se lee como «el modelo no contesto».
  const ids = idsDe(base);
  const idsBase = new Set(ids);

  // VOTOS HUERFANOS: los que traen un `id` que no corresponde a ningun hallazgo
  // enviado. Es la senal de que el modelo se invento la identidad en vez de
  // copiarla, y SIN CONTARLA el fallo es invisible -- los votos desaparecen y
  // todo sale UNDECIDED, que se lee como «no hubo mayoria» cuando lo que hubo
  // fue un emparejamiento roto. Es el mismo defecto que costo 6 votos en agosto,
  // y lo que faltaba entonces era exactamente este numero.
  //
  // Y SE GUARDAN, no solo se cuentan. Un contador dice CUANTOS se perdieron y no
  // CUALES, asi que no puede diagnosticar la causa que existe para senalar: si el
  // modelo se invento el id, si contesto sobre otro conjunto, o si la identidad
  // que enviamos y la que casamos dejaron de ser la misma. La respuesta cruda no
  // se guardaba en ningun sitio, y sin ella `orphanVotes: 8` es un numero del que
  // no se puede hacer nada.
  const orphans = votadas
    .filter((v) => v.ok)
    .flatMap((v) => [...v.porId.entries()]
      .filter(([k]) => !idsBase.has(k))
      .map(([k, voto]) => ({
        pass: v.pass,
        id: k,
        vote: voto?.vote ?? null,
        reason: String(voto?.reason ?? '').slice(0, 200),
      })));
  const huerfanos = orphans.length;

  // Que pasadas hablaron y no se les entendio. Su silencio sobre un hallazgo de
  // la base NO es una abstencion.
  const hablaronSinCasar = new Set(orphans.map((o) => o.pass));

  const findings = (base ?? []).map((f, idx) => {
    const id = ids[idx];
    const votos = votadas.map((v) => {
      if (!v.ok) return { pass: v.pass, verdict: null, reason: 'la pasada no produjo resultado' };
      const emitido = v.porId.get(id);
      return emitido
        ? { pass: v.pass, verdict: emitido.vote ?? null, reason: String(emitido.reason ?? '').slice(0, 200) }
        : {
            pass: v.pass, verdict: null,
            // La distincion que el diseno no hacia. Una pasada que emitio votos
            // huerfanos no se abstuvo: voto y no supimos a que.
            lost: hablaronSinCasar.has(v.pass),
            reason: hablaronSinCasar.has(v.pass)
              ? 'la pasada VOTO y el harness descarto el voto por no casar el id'
              : 'la pasada no se pronuncio sobre este hallazgo',
          };
    });
    return { ...f, ...tally(votos) };
  });

  return {
    findings,
    passes: votadas.length,
    passesOk: votadas.filter((v) => v.ok).length,
    // La varianza, MEDIDA. Es el dato que convierte «lo vi pasar tres veces» en
    // una metrica que el harness produce en cada vuelta.
    disagreements: findings.filter((f) => f.counts.confirmed > 0 && f.counts.refuted > 0).length,
    undecided: findings.filter((f) => f.verdict === 'UNDECIDED').length,
    // Cuantos hallazgos NO llego a juzgar nadie. Es la senal de que la etapa de
    // refutacion no hizo su trabajo, y sin publicarla el fallo es invisible: una
    // vuelta puede cerrar en verde con todos sus hallazgos sin revisar.
    unreviewed: findings.filter((f) => f.verdict === 'UNREVIEWED').length,
    // Y cuantos votos no casaron con nada. Ver arriba.
    orphanVotes: huerfanos,
    // LOS VOTOS EN SI, que es lo que faltaba para poder decidir algo con ellos.
    orphans,
    // LA DECISION PROPIA DEL HARNESS. No la toma el modelo -- no puede: el fallo
    // es que no le entendimos. Cuenta los hallazgos que se quedaron sin veredicto
    // TENIENDO una pasada que si voto. Cero significa que los indecisos de esta
    // ronda son indecisos de verdad.
    lostVoteFindings: findings.filter((f) => (f.lostVotes ?? 0) > 0
      && (f.verdict === 'UNDECIDED' || f.verdict === 'UNREVIEWED')).length,
  };
}
