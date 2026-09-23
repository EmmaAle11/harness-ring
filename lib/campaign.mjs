// C-6 · CAMPAÑA — el trabajo que no cabe en una vuelta.
//
// `maxWallMs` son 45 minutos. Una migracion de arquitectura son DECENAS de
// vueltas. La flecha `Learning -> Knowledge` ya lleva conocimiento de una vuelta a
// la siguiente; lo que faltaba es la LISTA DE TRABAJO: que items quedan, cuales
// cerraron, cuales reabrieron. Sin ella, un `maxWallMs` agotado no es una pausa:
// es empezar de cero.
//
// LA REGLA QUE NO SE NEGOCIA: la campana la PLANIFICA UN HUMANO y la EJECUTA EL
// ANILLO. Una campana que el propio anillo se inventa es un anillo decidiendo su
// propio alcance, y entonces «0 P0-P5» pasa a ser una afirmacion sobre el conjunto
// que el mismo eligio. Por eso aqui no hay ni una funcion que derive items de la
// salida de un modelo: no es un olvido, es la frontera.
//
// PURO salvo `leer`/`guardar`. El estado entra y sale como valor.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { redactarSecretos } from './secretos.mjs';
import { RUNTIME } from './capabilities.mjs';

export const ESTADOS = ['PENDING', 'IN_PROGRESS', 'DONE', 'BLOCKED', 'REOPENED'];

/** Los estados que siguen pidiendo una vuelta. */
export const ABIERTOS = new Set(['PENDING', 'IN_PROGRESS', 'REOPENED']);

export const ruta = (id) => join(RUNTIME, 'campaigns', `${String(id).replace(/[^\w.-]/g, '_')}.json`);

/**
 * Una campana nueva. `items` los da QUIEN LA PLANIFICA, y esta funcion no sabe
 * inventarlos: si `items` viene vacio, no hay campana.
 *
 * `budget` es el TECHO DE GASTO, y no es decorativo. Una lista de trabajo sin
 * techo sobre un anillo que se reanuda solo es una forma elegante de gastar sin
 * limite: la campana existe justamente para durar mas que la atencion de quien
 * la lanzo.
 */
export function crear({ id, goal, items, plannedBy, budget = {} } = {}) {
  if (!id || !goal) throw new Error('una campana necesita `id` y `goal`');
  if (!plannedBy) {
    throw new Error(
      'una campana necesita `plannedBy`: la planifica un humano y la ejecuta el anillo. '
      + 'Una que el anillo se inventa es un anillo decidiendo su propio alcance',
    );
  }
  const lista = (items ?? []).map((it, i) => (typeof it === 'string'
    ? { id: `${id}-${i + 1}`, goal: it, status: 'PENDING', rounds: 0, history: [] }
    : { id: it.id ?? `${id}-${i + 1}`, goal: it.goal, status: 'PENDING', rounds: 0, history: [], ...it }));
  if (!lista.length) throw new Error('una campana sin items no es una campana');

  return {
    id,
    goal,
    plannedBy,
    version: 1,
    budget: { maxRounds: budget.maxRounds ?? lista.length * 3, maxTokens: budget.maxTokens ?? null },
    spent: { rounds: 0, tokens: 0 },
    items: lista,
  };
}

/**
 * El siguiente item. DETERMINISTA -- el primero abierto en el orden en que se
 * planifico-- y no una eleccion del anillo: si el anillo escogiera por dificultad
 * o por coste, la campana dejaria de ser la lista que se planifico.
 */
export const siguiente = (c) => (c?.items ?? []).find((it) => ABIERTOS.has(it.status)) ?? null;

/**
 * ¿Queda gasto?
 *
 * Un techo agotado NO cierra la campana ni la da por buena: la PARA y lo dice.
 * Confundir «se acabo el presupuesto» con «se acabo el trabajo» seria la misma
 * mentira que `UNDECIDED` contaba en la convergencia.
 */
export function dentroDelGasto(c) {
  const b = c?.budget ?? {}, s = c?.spent ?? {};
  const rondas = b.maxRounds != null && s.rounds >= b.maxRounds;
  const tokens = b.maxTokens != null && s.tokens >= b.maxTokens;
  return {
    ok: !rondas && !tokens,
    why: rondas ? `techo de vueltas agotado: ${s.rounds}/${b.maxRounds}`
      : tokens ? `techo de tokens agotado: ${s.tokens}/${b.maxTokens}` : null,
  };
}

/**
 * Aplica el resultado de UNA vuelta al item que la motivo.
 *
 * UN ITEM SOLO CIERRA SI LA VUELTA CONVERGIO **Y** NADIE SE ABSTUVO.
 * `cerrar-por-abstencion-no-es-converger` vale igual un nivel mas arriba: una
 * vuelta que pasa porque nadie refuto no ha demostrado nada sobre su item, y
 * cerrarlo con eso propaga a la campana entera un verde que no se gano. Un item
 * asi vuelve a PENDING, no a DONE.
 *
 * @param verdict {pass, convergenceStatus, unreviewed, blockers}
 */
export function aplicar(c, { itemId, verdict = {}, tokens = 0, at = null } = {}) {
  const items = (c?.items ?? []).map((it) => {
    if (it.id !== itemId) return it;

    const abstenciones = verdict.unreviewed ?? 0;
    const convergio = verdict.pass === true && verdict.convergenceStatus === 'CONVERGED';
    const status = convergio && abstenciones === 0 ? 'DONE'
      : verdict.convergenceStatus === 'SPECIFICATION_BLOCKED' || verdict.convergenceStatus === 'OSCILLATING' ? 'BLOCKED'
        : 'REOPENED';

    return {
      ...it,
      status,
      rounds: (it.rounds ?? 0) + 1,
      history: [...(it.history ?? []), {
        at,
        // EL PUNTERO A LA EVIDENCIA, no solo el motivo. El comentario de abajo dice
        // que un REOPENED sin razon obliga a la vuelta siguiente a redescubrir por
        // que volvio -- y se arreglo el MOTIVO dejando fuera la EVIDENCIA.
        //
        // MEDIDO: el item cm-4-security cerro dos vueltas con «CONVERGING con 1
        // bloqueante(s)» y desde el tablero NO se puede llegar a la traza de ninguna
        // de las dos. `correrAnillo()` devuelve `executionId` y `aplicar()` lo tiraba.
        // Por eso la contradiccion revisor/builder de aquel item quedo sin adjudicar:
        // el rollback limpio el workspace Y el tablero no guardaba a donde mirar.
        //
        // Un veredicto sin su traza es una opinion fechada.
        executionId: verdict.executionId ?? null,
        pass: verdict.pass ?? null,
        convergenceStatus: verdict.convergenceStatus ?? 'UNKNOWN',
        unreviewed: abstenciones,
        blockers: verdict.blockers ?? null,
        // El MOTIVO de no cerrar viaja con el item. Un `REOPENED` sin razon
        // obliga a la vuelta siguiente a redescubrir por que volvio.
        // EL MOTIVO EXACTO SI LO HAY. Una vuelta que muere ANTES de Convergence no
        // tiene ni estado de convergencia ni bloqueantes, asi que esto escribia
        // «UNKNOWN con ? bloqueante(s)» -- verdadero e inutil-- teniendo delante el
        // motivo real («ROLLBACK en Execution: 3 respuestas seguidas sin JSON
        // reconocible»). Un REOPENED sin razon obliga a la vuelta siguiente a
        // redescubrir por que volvio, que es justo lo que este campo existe para
        // evitar. MEDIDO en la primera campana, item cm-3-por-simbolo.
        why: convergio && abstenciones
          ? `convergio con ${abstenciones} hallazgo(s) que NADIE reviso: no se cierra por abstencion`
          : convergio ? null
            : verdict.reason
              ? `${verdict.convergenceStatus ?? 'UNKNOWN'}: ${verdict.reason}`
              : `${verdict.convergenceStatus ?? 'UNKNOWN'} con ${verdict.blockers ?? '?'} bloqueante(s)`,
      }],
    };
  });

  return {
    ...c,
    items,
    spent: { rounds: (c?.spent?.rounds ?? 0) + 1, tokens: (c?.spent?.tokens ?? 0) + (tokens ?? 0) },
  };
}

/** El tablero de la campana. Lo que se responde cuando alguien pregunta «como va». */
export function estado(c) {
  const items = c?.items ?? [];
  const por = (s) => items.filter((it) => it.status === s).length;
  const abiertos = items.filter((it) => ABIERTOS.has(it.status)).length;
  const gasto = dentroDelGasto(c);
  return {
    total: items.length,
    done: por('DONE'),
    blocked: por('BLOCKED'),
    open: abiertos,
    rounds: c?.spent?.rounds ?? 0,
    // CERRADA no es lo mismo que TERMINADA: una campana con items BLOCKED ha
    // dejado de avanzar y necesita a una persona, no otra vuelta.
    status: abiertos === 0 && por('BLOCKED') === 0 ? 'CLOSED'
      : !gasto.ok ? 'HALTED'
        : por('BLOCKED') && abiertos === 0 ? 'BLOCKED' : 'OPEN',
    why: gasto.why,
  };
}

export function leer(id) {
  const f = ruta(id);
  if (!existsSync(f)) return null;
  try {
    return JSON.parse(readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
}

export function guardar(c) {
  const f = ruta(c.id);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, redactarSecretos(JSON.stringify(c, null, 2)) + '\n');
  return f;
}
