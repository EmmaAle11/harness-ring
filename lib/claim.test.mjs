// node --test harness/lib/
//
// El aislamiento temporal. Se implemento el espacial —un worktree por vuelta— y se
// dio por hecho el otro: `dos-anillos-a-la-vez.md` mide lo que costo. Dos vueltas
// solapadas comparten `last-learning.json`, y entonces FT-5 —el unico test que
// distingue un anillo de una tuberia— puede dar VERDE sobre una cadena falsa.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { claim as claimReal, release as releaseReal, leer as leerReal, vivo, CLAIM } from './claim.mjs';
import { RUNTIME } from './capabilities.mjs';

// EL CERROJO DE PRUEBA NO ES EL DE PRODUCCION.
//
// Esta bateria escribia y borraba `.harness/claim.json`, el cerrojo de verdad.
// MEDIDO el 2026-08-18: correr `node --test harness/lib/` con la 8a vuelta en la
// etapa 7 dejo a la vuelta viva sin cerrojo, y una segunda lanzada en ese momento
// habria arrancado encima. El test de «una vuelta a la vez» era el unico camino
// conocido para tener dos.
const CLAIM_TEST = join(RUNTIME, 'claim.test.json');
const claim = (id, o = {}) => claimReal(id, { ...o, file: CLAIM_TEST });
const release = (id) => releaseReal(id, { file: CLAIM_TEST });
const leer = () => leerReal({ file: CLAIM_TEST });

const limpiar = () => rmSync(CLAIM_TEST, { force: true });
beforeEach(limpiar);
after(limpiar);

const PID_MUERTO = 2147483646;   // por encima de /proc/sys/kernel/pid_max

test('sin claim previo, la vuelta lo toma', () => {
  const c = claim('H-1');
  assert.equal(c.executionId, 'H-1');
  assert.equal(c.pid, process.pid);
  assert.equal(c.replaced, null);
  assert.equal(leer().executionId, 'H-1');
});

test('con una vuelta VIVA, la segunda NO arranca', () => {
  claim('H-1');                                  // pid = este proceso, vivo
  assert.throws(() => claim('H-2'), /ya esta en curso: H-1/);
  assert.equal(leer().executionId, 'H-1', 'y la primera conserva el claim');
});

test('el mensaje dice QUIEN la tiene y desde cuando: sin eso no se puede decidir', () => {
  claim('H-1', { ahora: '2026-08-17T10:00:00.000Z' });
  assert.throws(() => claim('H-2'), (e) =>
    /H-1/.test(e.message) && /2026-08-17T10:00:00/.test(e.message) && new RegExp(String(process.pid)).test(e.message));
});

test('un claim de un proceso MUERTO se adopta, y se registra a quien reemplazo', () => {
  // Un cerrojo que exige que alguien lo borre a mano es peor que no tenerlo: el
  // harness existe para no depender de que nadie se acuerde. Un Ctrl-C o un OOM
  // dejarian el anillo bloqueado para siempre.
  mkdirSync(dirname(CLAIM_TEST), { recursive: true });
  writeFileSync(CLAIM_TEST, JSON.stringify({ executionId: 'H-MUERTA', pid: PID_MUERTO, startedAt: 'x' }));

  const c = claim('H-2');
  assert.equal(c.executionId, 'H-2');
  assert.equal(c.replaced, 'H-MUERTA', 'el huerfano queda en el rastro, no desaparece');
});

test('re-reclamar la MISMA vuelta no falla: reintentar no es competir', () => {
  claim('H-1');
  assert.doesNotThrow(() => claim('H-1'));
});

test('release lo suelta, y solo si es NUESTRO', () => {
  claim('H-1');
  assert.equal(release('H-2'), false, 'una vuelta no puede soltar el cerrojo de otra');
  assert.ok(existsSync(CLAIM_TEST));
  assert.equal(release('H-1'), true);
  assert.equal(existsSync(CLAIM_TEST), false);
  assert.equal(release('H-1'), false, 'soltar dos veces no revienta');
});

test('un claim ilegible se trata como ausente, no tumba la vuelta', () => {
  mkdirSync(dirname(CLAIM_TEST), { recursive: true });
  writeFileSync(CLAIM_TEST, '{ esto no es json');
  assert.equal(leer(), null);
  assert.doesNotThrow(() => claim('H-1'));
});

test('vivo() distingue el proceso actual de uno inexistente', () => {
  assert.equal(vivo(process.pid), true);
  assert.equal(vivo(PID_MUERTO), false);
  for (const malo of [0, -1, null, undefined, 1.5, 'x']) {
    assert.equal(vivo(malo), false, `pid invalido: ${malo}`);
  }
});

test('la bateria NO toca el cerrojo de produccion', () => {
  // El defecto que este fichero tenia: escribia en `.harness/claim.json`. Correr
  // los tests mientras una vuelta esta viva le quitaba el cerrojo, y el test de
  // «una vuelta a la vez» pasaba a ser el camino para tener dos.
  assert.notEqual(CLAIM_TEST, CLAIM, 'el cerrojo de prueba debe ser OTRO fichero');

  const antes = existsSync(CLAIM) ? readFileSync(CLAIM, 'utf8') : null;
  claim('H-AISLADA');
  release('H-AISLADA');
  const despues = existsSync(CLAIM) ? readFileSync(CLAIM, 'utf8') : null;

  assert.equal(despues, antes, 'una vuelta viva sigue teniendo su cerrojo despues de los tests');
});
