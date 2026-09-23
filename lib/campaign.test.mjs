// node --test harness/lib/campaign.test.mjs
//
// C-6 · la lista de trabajo que sobrevive a la vuelta. Lo que fijan estos tests:
// que el anillo NO se inventa su alcance, que un item no cierra por abstencion, y
// que un techo agotado se distingue de un trabajo terminado.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { crear, siguiente, aplicar, estado, dentroDelGasto, guardar, leer, ruta } from './campaign.mjs';

const CAMPANA = () => crear({
  id: 'test-strangler',
  goal: 'partir aafa.service.ts',
  plannedBy: 'emmanuel',
  items: ['extraer emitirCarta', 'extraer buildSafeFileName', 'extraer zipDe'],
  budget: { maxRounds: 5, maxTokens: 1000 },
});

const VERDE = { pass: true, convergenceStatus: 'CONVERGED', unreviewed: 0, blockers: 0 };

test('una campana sin `plannedBy` NO existe: el anillo no decide su propio alcance', () => {
  assert.throws(
    () => crear({ id: 'x', goal: 'y', items: ['a'] }),
    /la planifica un humano/,
  );
});

test('una campana sin items no es una campana', () => {
  assert.throws(() => crear({ id: 'x', goal: 'y', plannedBy: 'e', items: [] }), /sin items/);
});

test('el siguiente item es DETERMINISTA: el primero abierto, en el orden planificado', () => {
  const c = CAMPANA();
  assert.equal(siguiente(c).goal, 'extraer emitirCarta');
  // Si el anillo escogiera por dificultad o coste, dejaria de ser la lista que se
  // planifico.
  const tras = aplicar(c, { itemId: c.items[0].id, verdict: VERDE });
  assert.equal(siguiente(tras).goal, 'extraer buildSafeFileName');
});

test('una vuelta verde cierra su item', () => {
  const c = aplicar(CAMPANA(), { itemId: 'test-strangler-1', verdict: VERDE });
  assert.equal(c.items[0].status, 'DONE');
  assert.equal(c.spent.rounds, 1);
});

test('el veredicto guarda A DONDE MIRAR, no solo que fallo', () => {
  // Un veredicto sin su traza es una opinion fechada. El item cm-4-security cerro
  // dos vueltas con «CONVERGING con 1 bloqueante(s)» y desde el tablero NO habia
  // forma de llegar a la traza de ninguna: `correrAnillo()` devuelve executionId y
  // `aplicar()` lo tiraba. Por eso la contradiccion revisor/builder de aquel item
  // quedo SIN ADJUDICAR -- el rollback limpio el workspace y el tablero no decia
  // que run mirar.
  const c = aplicar(CAMPANA(), {
    itemId: 'test-strangler-1',
    verdict: { pass: false, convergenceStatus: 'CONVERGING', blockers: 1, executionId: 'H-20260824-abc123' },
  });
  assert.equal(c.items[0].history[0].executionId, 'H-20260824-abc123',
    'el tablero perdio el puntero a la traza: un REOPENED que no dice donde mirar');

  // Y una vuelta que muere ANTES de tener executionId no inventa uno.
  const sinId = aplicar(CAMPANA(), {
    itemId: 'test-strangler-1',
    verdict: { pass: false, convergenceStatus: 'CONVERGING', blockers: 1 },
  });
  assert.equal(sinId.items[0].history[0].executionId, null);
});

test('CONVERGED con abstenciones NO cierra el item', () => {
  // `cerrar-por-abstencion-no-es-converger`, un nivel mas arriba. Una vuelta que
  // pasa porque nadie refuto no demostro nada sobre su item.
  const c = aplicar(CAMPANA(), {
    itemId: 'test-strangler-1',
    verdict: { ...VERDE, unreviewed: 2 },
  });
  assert.equal(c.items[0].status, 'REOPENED');
  assert.match(c.items[0].history[0].why, /NADIE reviso/);
});

test('OSCILLATING y SPECIFICATION_BLOCKED bloquean el item: repetir da mas de lo mismo', () => {
  for (const s of ['OSCILLATING', 'SPECIFICATION_BLOCKED']) {
    const c = aplicar(CAMPANA(), { itemId: 'test-strangler-1', verdict: { pass: false, convergenceStatus: s, blockers: 3 } });
    assert.equal(c.items[0].status, 'BLOCKED', s);
  }
});

test('el MOTIVO viaja con el item: la vuelta siguiente no lo redescubre', () => {
  const c = aplicar(CAMPANA(), {
    itemId: 'test-strangler-1',
    verdict: { pass: false, convergenceStatus: 'CONVERGING', blockers: 2 },
  });
  assert.equal(c.items[0].status, 'REOPENED');
  assert.match(c.items[0].history[0].why, /CONVERGING con 2 bloqueante/);
  assert.equal(c.items[0].rounds, 1);
});

test('un techo agotado PARA la campana, y no la da por terminada', () => {
  // Confundir «se acabo el presupuesto» con «se acabo el trabajo» es la misma
  // mentira que contaba UNDECIDED en la convergencia.
  let c = CAMPANA();
  for (let i = 0; i < 5; i++) c = aplicar(c, { itemId: 'test-strangler-3', verdict: { pass: false, convergenceStatus: 'CONVERGING', blockers: 1 } });
  assert.equal(dentroDelGasto(c).ok, false);
  const e = estado(c);
  assert.equal(e.status, 'HALTED');
  assert.match(e.why, /techo de vueltas agotado: 5\/5/);
  assert.ok(e.open > 0, 'y sigue habiendo trabajo abierto: no esta terminada');
});

test('el techo de TOKENS tambien para', () => {
  const c = aplicar(CAMPANA(), { itemId: 'test-strangler-1', verdict: VERDE, tokens: 1200 });
  assert.equal(dentroDelGasto(c).ok, false);
  assert.match(dentroDelGasto(c).why, /tokens agotado/);
});

test('CLOSED solo cuando no queda nada abierto NI bloqueado', () => {
  let c = CAMPANA();
  for (const it of c.items) c = aplicar(c, { itemId: it.id, verdict: VERDE });
  assert.equal(estado(c).status, 'CLOSED');
  assert.equal(estado(c).done, 3);

  // Uno bloqueado y el resto hecho NO es cerrada: necesita una persona.
  let d = CAMPANA();
  d = aplicar(d, { itemId: 'test-strangler-1', verdict: VERDE });
  d = aplicar(d, { itemId: 'test-strangler-2', verdict: VERDE });
  d = aplicar(d, { itemId: 'test-strangler-3', verdict: { pass: false, convergenceStatus: 'OSCILLATING', blockers: 4 } });
  assert.equal(estado(d).status, 'BLOCKED');
});

test('la lista SOBREVIVE a la vuelta: se guarda y se reanuda donde estaba', () => {
  // Es la razon de existir de C-6: `maxWallMs` agotado deja de ser empezar de cero.
  const c = aplicar(CAMPANA(), { itemId: 'test-strangler-1', verdict: VERDE });
  guardar(c);
  const vuelto = leer(c.id);
  assert.equal(vuelto.items[0].status, 'DONE');
  assert.equal(siguiente(vuelto).id, 'test-strangler-2');
  rmSync(ruta(c.id), { force: true });
  assert.equal(leer(c.id), null, 'una campana ausente es null, no una excepcion');
});

test('un item que NO converge guarda el motivo exacto, no un interrogante', () => {
  // Una vuelta que muere antes de Convergence no tiene ni estado ni bloqueantes, y
  // esto escribia «UNKNOWN con ? bloqueante(s)» teniendo delante el motivo real.
  // Un REOPENED sin razon obliga a la vuelta siguiente a redescubrir por que volvio.
  // MEDIDO en la primera campana (anillo-cinco-manifiestos, item cm-3-por-simbolo).
  const c = crear({
    id: 'k', goal: 'g', plannedBy: 'una persona',
    items: [{ id: 'k-1', goal: 'lo que sea' }],
  });

  const r = aplicar(c, {
    itemId: 'k-1',
    verdict: {
      pass: false,
      convergenceStatus: 'UNKNOWN',
      reason: "ROLLBACK en 'Execution': 3 respuestas seguidas sin JSON reconocible",
    },
  });

  const it = r.items[0];
  assert.equal(it.status, 'REOPENED');
  assert.match(it.history.at(-1).why, /3 respuestas seguidas sin JSON reconocible/);
  assert.doesNotMatch(it.history.at(-1).why, /\? bloqueante/, 'ya no se pierde el motivo');
});

test('y sin motivo se sigue diciendo lo que hay, no se inventa', () => {
  const c = crear({ id: 'k2', goal: 'g', plannedBy: 'una persona', items: [{ id: 'k2-1', goal: 'x' }] });
  const r = aplicar(c, { itemId: 'k2-1', verdict: { pass: false, convergenceStatus: 'DIVERGED', blockers: 3 } });
  assert.match(r.items[0].history.at(-1).why, /DIVERGED con 3 bloqueante/);
});
