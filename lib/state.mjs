// State — el tablero vivo. Lo EFIMERO.
//
// Vive en .harness/state/, NO en memory/. La memoria durable son hechos que
// siguen siendo ciertos la semana que viene; el tablero caduca en la ronda
// siguiente. Mezclarlos es como memory/README.md dejo de ser fiable la ultima
// vez (invariante 6 de harness/README.md).
//
// Es lo que sobrevive a /compact: PreCompact lo escribe, SessionStart lo
// reinyecta. Automatiza el "prompt de arranque" que hoy se escribe a mano.
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { redactarSecretos } from './secretos.mjs';
import { ROOT, RUNTIME } from './capabilities.mjs';
import { ENV_LIMPIO } from './sandbox.mjs';

const BOARD = join(RUNTIME, 'state', 'board.json');

const git = (...a) => {
  try {
    return execFileSync('git', a, { cwd: ROOT, env: ENV_LIMPIO(), encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
};

/**
 * La ultima evidencia POR MTIME, y nunca por el nombre.
 *
 * Antes esto era `readdirSync(...).pop()`: el orden de un directorio, que es
 * arbitrario, y encima sin ordenar. En el arranque en frio del 23-ago dio
 * `ffc58a6-2.json` -- un PASS del 14-ago, ocho dias y ~40 commits atras-- como
 * si fuera el verde de la rama. La linea que un `main` recien compactado lee
 * ANTES que ninguna otra decia verde de otra semana.
 *
 * Un sha no ordena ni fecha: no se puede sacar de `957710c7` que sea posterior
 * a `ffc58a6`, y ordenar por nombre pone la `f` delante. Lo unico que fecha una
 * evidencia es su reloj.
 */
export function ultimaEvidencia(dir = join(RUNTIME, 'evidence')) {
  if (!existsSync(dir)) return null;
  const f = readdirSync(dir)
    .filter((x) => x.endsWith('.json') && !x.endsWith('.sbom.json'))
    .map((x) => ({ x, t: statSync(join(dir, x)).mtimeMs }))
    .sort((a, b) => a.t - b.t)
    .pop();
  if (!f) return null;
  try {
    const d = JSON.parse(readFileSync(join(dir, f.x), 'utf8'));
    return { file: f.x, verdict: d.verdict, mode: d.mode, at: d.started };
  } catch {
    return { file: f.x, verdict: 'ILEGIBLE' };
  }
}

/** Cuanto hace, en la unidad mas grande que no miente. `null` si no hay fecha. */
export function edad(iso, ahora = Date.now()) {
  const t = Date.parse(iso ?? '');
  if (Number.isNaN(t)) return null;
  const m = Math.max(0, Math.round((ahora - t) / 60000));
  if (m < 60) return `hace ${m} min`;
  if (m < 60 * 48) return `hace ${Math.round(m / 60)} h`;
  return `hace ${Math.round(m / 1440)} d`;
}

/**
 * Vuelca el estado. Idempotente; conserva lo que no se recalcula.
 *
 * `board` es un parametro porque sin el la mitad que FECHA no se podia ejercer:
 * el tablero real lo escribe tambien el anillo al cerrar, asi que un test que
 * llamase dos veces aqui pisaria el estado de una vuelta viva. Sin poder
 * llamarla, lo unico pinchado era `renderState` -- al que el test le PASABA el
 * `notaAt` ya hecho. O sea el lado que pinta, con el lado que fecha suelto.
 */
export function saveState(patch = {}, { board: destino = BOARD } = {}) {
  const prev = loadState(destino) ?? {};
  const board = {
    savedAt: new Date().toISOString(),
    branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
    head: git('log', '-1', '--format=%h %s'),
    dirty: git('status', '--porcelain')
      .split('\n')
      .filter((l) => l && !/version\.json|current-version\.ts/.test(l)).length,
    gate: ultimaEvidencia(),
    // Lo que el harness no puede deducir se conserva de la corrida anterior:
    // bloque abierto, ronda y hallazgos vivos los escribe quien los conoce.
    bloque: patch.bloque ?? prev.bloque ?? null,
    ronda: patch.ronda ?? prev.ronda ?? null,
    hallazgosAbiertos: patch.hallazgosAbiertos ?? prev.hallazgosAbiertos ?? [],
    nota: patch.nota ?? prev.nota ?? null,
    // Una nota sin fecha se arrastra sin caducar: el arranque del 23-ago
    // seguia anunciando un anillo FAILED del 17-ago, seis dias y cuatro
    // vueltas 16/16 despues. Se conserva --el tablero no puede deducirla-- pero
    // se sella cuando CAMBIA, para que se pueda ver vieja.
    notaAt: patch.nota && patch.nota !== prev.nota
      ? new Date().toISOString()
      : (prev.notaAt ?? null),
  };
  mkdirSync(dirname(destino), { recursive: true });
  writeFileSync(destino, redactarSecretos(JSON.stringify(board, null, 2)) + '\n');
  return board;
}

export const loadState = (board = BOARD) =>
  existsSync(board) ? JSON.parse(readFileSync(board, 'utf8')) : null;

/** Texto para el contexto del modelo. Lo consume el hook SessionStart. */
export function renderState(board) {
  if (!board) {
    return [
      '── DoxIA Harness · sin tablero ──',
      "Corre 'node harness/bin/doxia.mjs state save' para crearlo.",
    ].join('\n');
  }
  const L = [];
  L.push('── DoxIA Harness · dónde nos quedamos ─────────────────────────');
  L.push(`rama    : ${board.branch}`);
  L.push(`HEAD    : ${board.head}`);
  L.push(`sucio   : ${board.dirty} fichero(s)`);
  L.push(
    `gate    : ${board.gate ? `${board.gate.verdict} · ${board.gate.mode} · ${board.gate.file}${edad(board.gate.at) ? ` · ${edad(board.gate.at)}` : ''}` : 'sin evidencia'}`,
  );
  if (board.bloque) L.push(`bloque  : ${board.bloque}${board.ronda ? ` · ronda ${board.ronda}` : ''}`);
  if (board.hallazgosAbiertos?.length) {
    L.push(`abiertos: ${board.hallazgosAbiertos.length}`);
    for (const h of board.hallazgosAbiertos.slice(0, 8)) {
      L.push(`          ${h.severity ?? '--'} ${h.file ?? ''}:${h.symbol ?? ''} — ${h.claim ?? ''}`);
    }
  }
  if (board.nota) L.push(`nota    : ${board.nota}${edad(board.notaAt) ? ` · ${edad(board.notaAt)}` : ''}`);
  L.push('');
  L.push('Puerta  : bash scripts/gate.sh --fast   |   --full antes de cerrar bloque');
  L.push('Reglas  : jest desde backend/ · vitest desde la raíz · NUNCA a la vez');
  L.push('          el USUARIO ejecuta commit, push y deploy');
  L.push('          la base local tiene PII real: agrega, cuenta o trunca');
  L.push(`guardado: ${board.savedAt}`);
  L.push('───────────────────────────────────────────────────────────────');
  return L.join('\n');
}
