// El motor del anillo — recorre las 16 etapas de un manifiesto.
//
// MECANICA. El motor NO SABE que hace cada etapa: lee el manifiesto y llama al
// handler registrado para cada una. Cambiar el anillo es cambiar el JSON, no
// este fichero.
//
// Ninguna etapa avanza "por defecto": cada una declara su `gate` y su `onFail`,
// y hay exactamente tres respuestas -- STOP, ROLLBACK+STOP, REWORK (max 2).
// El tope de reintentos no es arbitrario: diez rondas manuales sobre esta rama
// y ninguna salio limpia. Un bucle sin tope reproduce el problema que el harness
// existe para resolver.
import { randomUUID } from 'node:crypto';
import { envelope, writeArtifact, artifactPath } from './artifact.mjs';

/**
 * Reintentos de un REWORK. 2 -> 4 el 2026-08-17.
 *
 * NO es aflojar el liston: el umbral sigue siendo CERO hallazgos confirmados en
 * TODA la escala, y ninguna severidad se declara tolerable (ADR-007). Lo que se
 * compra es tiempo para llegar a ese cero.
 *
 * POR QUE, con la medida delante. H-20260817-f00dd8f2 murio con los REWORK
 * agotados y sus bloqueantes bajando 5 -> 3 -> 3, todos P4/P5. Las tres rondas
 * funcionaron: el builder corrigio, y de los arrastrados 4 de 5 y luego 2 de 3
 * salieron REFUTED contra el codigo nuevo. Lo que impidio cerrar no fue que algo
 * no se arreglara, sino que **cada correccion escribe codigo nuevo y el revisor
 * encuentra hallazgos nuevos en el**: ~2 por ronda, sostenido. Con 2 reintentos
 * la vuelta se corta mientras todavia esta convergiendo.
 *
 * Y dos causas de esa corrida ya no existen: el builder no tenia `run_gate` -se
 * le exigia una evidencia que ninguna herramienta producia- y el arrastre ya no
 * fosiliza. El presupuesto nuevo se gasta en hallazgos vivos, no en zombis, que
 * era la objecion de `el-arrastre-crea-zombis` a subir este numero.
 *
 * Sigue habiendo tope, y por lo mismo de siempre: diez rondas manuales sobre esta
 * rama y ninguna salio limpia. Un bucle sin tope reproduce el problema que el
 * harness existe para resolver.
 */
export const MAX_REWORK = 4;

/**
 * Que hacer cuando una etapa falla: lo que dice el manifiesto, salvo que la
 * propia etapa lo ENDUREZCA.
 *
 * Una etapa puede saber algo que el manifiesto no puede: que este fallo no
 * mejora reintentando. Convergence lo sabe cuando detecta un CICLO --los mismos
 * hallazgos yendo y viniendo-- y Plan lo sabe cuando la especificacion se
 * contradice. En los dos casos, `REWORK` gasta el presupuesto entero para llegar
 * al mismo sitio, que es como H-20260817-009c7621 consumio cuatro reintentos y
 * 76 minutos.
 *
 * SOLO HACIA ARRIBA. Una etapa nunca puede ablandar su `onFail`: si pudiera
 * convertir un `STOP` en un `REWORK`, la puerta la estaria abriendo justo quien
 * no la pasa. La direccion del permiso es toda la garantia.
 */
export const DUREZA = { REWORK: 0, STOP: 1, ROLLBACK: 2 };
const clase = (a) => {
  const s = String(a ?? 'STOP').toUpperCase();
  return s.startsWith('REWORK') ? 'REWORK' : s.startsWith('ROLLBACK') ? 'ROLLBACK' : 'STOP';
};

export function accionDeFallo(spec, env) {
  const delManifiesto = clase(spec?.onFail);
  const deLaEtapa = env?.onFail ? clase(env.onFail) : null;
  return deLaEtapa && DUREZA[deLaEtapa] > DUREZA[delManifiesto] ? deLaEtapa : delManifiesto;
}

export const newExecutionId = (prefix = 'H') =>
  `${prefix}-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${randomUUID().slice(0, 8)}`;

/**
 * @param manifest  el h-001.json
 * @param handlers  { [stage]: async (ctx) => ({payload, status?, reason?, producedBy?}) }
 * @param onStage   callback de progreso (opcional)
 */
export async function runRing(manifest, handlers, { executionId = newExecutionId(), onStage, log = () => {} } = {}) {
  const startedAt = new Date().toISOString();
  const artifacts = {};                  // stage -> sobre VIGENTE (lo que consume la etapa siguiente)
  const attempts = {};                   // stage -> [sobres], la serie completa con sus reworks
  const intentos = {};                   // stage -> cuantas veces se ha corrido
  const stages = [];                     // registro para el ExecutionTrace
  let rework = 0;
  let i = 0;

  while (i < manifest.stages.length) {
    const spec = manifest.stages[i];
    const t0 = Date.now();
    // `artifacts` es lo que YA ocurrio; `next`/`remaining`, lo que viene. Una
    // etapa que solo ve hacia atras no puede declarar lo que NO esta en
    // condiciones de resumir, y ese silencio es lo que hizo pasar por completa
    // una traza escrita a mitad de vuelta.
    //
    // `next === null` solo en la ultima: no es un caso borde, es el cierre del
    // anillo. Quien devuelve el control a Knowledge esta fuera del anillo.
    const ctx = {
      executionId, manifest, spec, artifacts, log, rework,
      next: manifest.stages[i + 1] ?? null,
      remaining: manifest.stages.slice(i + 1),
    };
    let env;

    try {
      const h = handlers[spec.stage];
      if (!h) throw new Error(`sin handler para la etapa '${spec.stage}'`);

      const r = await h(ctx);
      env = envelope({
        executionId, n: spec.n, stage: spec.stage, contract: spec.output,
        payload: r.payload, status: r.status ?? 'OK', reason: r.reason, producedBy: r.producedBy,
        onFail: r.onFail,
      });
    } catch (e) {
      env = envelope({
        executionId, n: spec.n, stage: spec.stage, contract: spec.output,
        payload: null, status: 'FAIL', reason: e.message,
      });
    }

    // UN FICHERO POR INTENTO. Un REWORK repite la etapa, y escribir siempre en la
    // misma ruta BORRA lo que hizo el intento anterior: sus tool calls, sus
    // mutaciones y el motivo por el que no convergio. La traza acababa diciendo
    // «1 rework, 0 mutaciones» sobre una vuelta que habia escrito cinco ficheros.
    //
    // El primero conserva el nombre del manifiesto -- los consumidores que lo
    // nombran siguen encontrandolo -- y los reintentos van con sufijo.
    intentos[spec.stage] = (intentos[spec.stage] ?? 0) + 1;
    const k = intentos[spec.stage];
    const base = artifactPath(spec.artifact, executionId);
    const path = k === 1 ? base : base.replace(/\.json$/, `-r${k - 1}.json`);
    try {
      writeArtifact(path, env);
    } catch (e) {
      // El artefacto incumple su contrato: la etapa NO paso, diga lo que diga.
      env = envelope({
        executionId, n: spec.n, stage: spec.stage, contract: spec.output,
        payload: null, status: 'FAIL', reason: e.message,
      });
      writeArtifact(path, env);
    }

    artifacts[spec.stage] = env;
    // TODOS los intentos, no solo el ultimo. `artifacts` guarda el vigente porque
    // es lo que consumen las etapas siguientes; `attempts` guarda la serie, que es
    // lo que necesita la traza para no perder lo que hizo cada pasada.
    (attempts[spec.stage] ??= []).push(env);
    stages.push({
      n: spec.n, stage: spec.stage, status: env.status, contract: spec.output,
      artifact: path, ms: Date.now() - t0,
      ...(env.reason ? { reason: env.reason } : {}),
      ...(env.producedBy ? { producedBy: env.producedBy } : {}),
    });
    onStage?.(stages.at(-1));

    if (env.status !== 'FAIL') { i++; continue; }

    // ── onFail ───────────────────────────────────────────────────────────────
    const accion = accionDeFallo(spec, env);

    if (accion.startsWith('REWORK')) {
      if (++rework > MAX_REWORK) {
        return finish({ verdict: 'FAILED', reason: `REWORK agotado en '${spec.stage}' tras ${MAX_REWORK} reintentos` });
      }
      log(`  rework ${rework}/${MAX_REWORK} desde '${spec.stage}'`);
      i = manifest.stages.findIndex((s) => s.stage === 'Execution');
      continue;
    }

    if (accion.startsWith('ROLLBACK')) {
      await handlers.__rollback?.(ctx);
      return finish({ verdict: 'FAILED', reason: `ROLLBACK en '${spec.stage}': ${env.reason}` });
    }

    return finish({ verdict: 'FAILED', reason: `STOP en '${spec.stage}': ${env.reason}` });
  }

  return finish({ verdict: 'PASSED' });

  function finish({ verdict, reason }) {
    return {
      executionId, verdict, reason: reason ?? null,
      startedAt, endedAt: new Date().toISOString(),
      stages, artifacts, attempts,
      // UNICAS, no totales: con REWORK una etapa se repite y `stages` crece por
      // encima del tamano del anillo. Contar entradas daba 18/16 y "completo" era
      // falso justo cuando el mecanismo de reintento habia funcionado.
      completed: new Set(stages.map((s) => s.stage)).size === manifest.stages.length,
    };
  }
}
