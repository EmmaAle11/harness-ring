// El tablero es la PRIMERA línea que lee un `main` recién compactado, antes que
// ninguna otra. El 23-ago le dijo `PASS · fast · ffc58a6-2.json`: un verde del
// 14-ago, ocho días y ~40 commits atrás, presentado como el verde de la rama.
//
// La causa: `readdirSync(dir).pop()` — el orden de un directorio, que es
// arbitrario, y encima sin ordenar. Un sha no ordena ni fecha: de `957710c7` no
// se deduce que sea posterior a `ffc58a6`, y por nombre la `f` va delante.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ultimaEvidencia, edad, renderState, saveState } from './state.mjs';

/** Un directorio de evidencia donde el nombre y el tiempo NO coinciden. */
function conEvidencias(files) {
  const dir = mkdtempSync(join(tmpdir(), 'doxia-ev-'));
  for (const [name, { verdict, minutos }] of Object.entries(files)) {
    const p = join(dir, name);
    writeFileSync(p, JSON.stringify({ verdict, mode: 'fast', started: new Date(Date.now() - minutos * 60000).toISOString() }));
    const t = (Date.now() - minutos * 60000) / 1000;
    utimesSync(p, t, t);
  }
  return dir;
}

test('la última evidencia es la más RECIENTE, no la última del directorio', () => {
  // `ffc58a6` gana por nombre y pierde por reloj: es el caso REAL del 23-ago.
  const dir = conEvidencias({
    'ffc58a6-2.json': { verdict: 'PASS', minutos: 60 * 24 * 8 },
    '957710c7-2.json': { verdict: 'FAIL', minutos: 3 },
  });
  try {
    assert.equal(ultimaEvidencia(dir).file, '957710c7-2.json',
      'eligió por nombre: un verde de otra semana se lee como el verde de la rama');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('el SBOM no cuenta como evidencia', () => {
  const dir = conEvidencias({
    '936d1ae5-1.json': { verdict: 'PASS', minutos: 10 },
    '936d1ae5-1.sbom.json': { verdict: 'PASS', minutos: 1 },
  });
  try {
    assert.equal(ultimaEvidencia(dir).file, '936d1ae5-1.json');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('sin directorio de evidencia se dice que no hay, no se inventa', () => {
  assert.equal(ultimaEvidencia(join(tmpdir(), 'doxia-no-existe-nunca')), null);
});

test('la edad se dice en la unidad que no miente', () => {
  const ahora = Date.parse('2026-08-23T20:00:00Z');
  assert.equal(edad('2026-08-23T19:57:00Z', ahora), 'hace 3 min');
  assert.equal(edad('2026-08-23T15:00:00Z', ahora), 'hace 5 h');
  assert.equal(edad('2026-08-14T21:10:52Z', ahora), 'hace 9 d');
  assert.equal(edad(undefined, ahora), null, 'sin fecha no se inventa una edad');
});

test('el verde viejo se delata en la línea del gate', () => {
  const txt = renderState({
    branch: 'feat/harness', head: 'x', dirty: 0,
    gate: { verdict: 'PASS', mode: 'fast', file: 'ffc58a6-2.json', at: '2026-08-14T21:10:52Z' },
    nota: 'anillo H-20260817-95193afa: FAILED (18/16)', notaAt: '2026-08-17T10:00:00Z',
    savedAt: new Date().toISOString(),
  });
  assert.match(txt, /gate .*ffc58a6-2\.json · hace \d+ d/, 'el PASS se lee sin su edad: parece de hoy');
  assert.match(txt, /nota .*· hace \d+ d/, 'la nota se arrastra sin caducar');
});

// ── El lado que FECHA, que es el que estaba suelto ───────────────────────────
//
// El test de arriba le PASA `notaAt` a `renderState` y comprueba lo que pinta.
// Quien decide CUÁNDO se sella no lo ejercía nadie: se podía revertir el sellado
// entero y la suite seguía 5/5 en verde. Lo cazó third revirtiendo sólo esa
// línea.
//
// Y el modo de fallo es peor que el que arreglé: con el sellado roto `notaAt` se
// congela en la primera nota, así que una nota escrita hace un minuto se pinta
// `· hace 8 d`. No es un dato sin edad — es una edad que MIENTE.

const VIEJA = '2026-08-17T10:00:00.000Z';

/** Un tablero de usar y tirar, con una nota ya fechada hace días. */
function tableroCon(nota) {
  const dir = mkdtempSync(join(tmpdir(), 'doxia-board-'));
  const board = join(dir, 'board.json');
  writeFileSync(board, JSON.stringify({ nota, notaAt: VIEJA }));
  return { board, limpiar: () => rmSync(dir, { recursive: true, force: true }) };
}

test('la MISMA nota no se vuelve a sellar: sigue siendo igual de vieja', () => {
  const { board, limpiar } = tableroCon('anillo H-20260817-95193afa: FAILED (18/16)');
  try {
    const b = saveState({ nota: 'anillo H-20260817-95193afa: FAILED (18/16)' }, { board });
    assert.equal(b.notaAt, VIEJA, 'se resella sola: una nota de hace seis días se leería como de ahora');
  } finally { limpiar(); }
});

test('una nota NUEVA se sella hoy: si no, la edad miente al revés', () => {
  const { board, limpiar } = tableroCon('anillo H-20260817-95193afa: FAILED (18/16)');
  try {
    const b = saveState({ nota: 'anillo H-20260823-0dc1e178: PASSED (16/16)' }, { board });
    assert.notEqual(b.notaAt, VIEJA, 'la nota cambió y la fecha no: se pintaría `hace 6 d` sobre algo de hace un minuto');
    assert.ok(Date.parse(b.notaAt) > Date.parse(VIEJA));
  } finally { limpiar(); }
});

test('sin nota en el patch se conservan las dos, nota y fecha', () => {
  const { board, limpiar } = tableroCon('lo que sea');
  try {
    const b = saveState({}, { board });
    assert.equal(b.nota, 'lo que sea', 'el tablero no puede deducir la nota: si no se conserva, se pierde');
    assert.equal(b.notaAt, VIEJA, 'conservar la nota y no su fecha la deja otra vez sin edad');
  } finally { limpiar(); }
});
