// El aislamiento TEMPORAL del anillo — una vuelta a la vez.
//
// El sandbox resolvio el aislamiento ESPACIAL —un worktree por vuelta— y se olvido
// el temporal. Dos vueltas simultaneas no chocan en disco, pero sí en el estado
// compartido que vive fuera de sus workspaces:
//
//   .harness/runs/last-learning.json   la que cierre ultima pisa a la otra
//   .harness/learning/                 candidatos mezclados de dos corridas
//
// Y el peor caso no es perder datos: es que FT-5 dé VERDE sobre una cadena falsa.
// FT-5 comprueba que la vuelta N+1 cite lo que dejo la N; con dos vueltas
// solapadas, la que lea `last-learning.json` puede estar citando a una corrida que
// no es su predecesora. El test que demuestra que esto es un anillo pasaria sobre
// un anillo que no existe (memory/failures/dos-anillos-a-la-vez.md).
//
// El plan nombraba `Claim` en Sandbox desde el principio. Esto es esa pieza.
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { redactarSecretos } from './secretos.mjs';
import { RUNTIME } from './capabilities.mjs';

export const CLAIM = join(RUNTIME, 'claim.json');

/**
 * EL CERROJO SE PARAMETRIZA, y no por elegancia: `claim.test.mjs` escribia y
 * BORRABA el cerrojo de produccion. MEDIDO el 2026-08-18 -- correr la bateria del
 * harness mientras la 8a vuelta estaba en la etapa 7 dejo a la vuelta viva SIN
 * cerrojo, asi que una segunda vuelta lanzada en ese momento habria arrancado
 * encima. El test que demuestra que no hay dos anillos a la vez era el unico
 * camino conocido para que los hubiera (memory/failures/dos-anillos-a-la-vez.md).
 *
 * Los modulos ESM no se pueden parchear, asi que el fichero entra por parametro y
 * el defecto es el de produccion. El test pasa el suyo.
 */

/**
 * ¿Sigue vivo el proceso que reclamo?
 *
 * `kill(pid, 0)` no envia senal: solo pregunta. Sin esto, una vuelta que murio por
 * un Ctrl-C o un OOM dejaria el claim puesto para siempre y habria que borrarlo a
 * mano -- un cerrojo que exige intervencion humana para soltarse es peor que no
 * tenerlo, porque el harness existe para no depender de que alguien se acuerde.
 *
 * EPERM significa que el proceso existe y es de otro usuario: vivo.
 */
export function vivo(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/** El claim en disco, o `null`. Un fichero ilegible se trata como ausente. */
export function leer({ file = CLAIM } = {}) {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Reclama el anillo para esta vuelta. LANZA si ya hay una viva.
 *
 * No espera ni hace cola a proposito: dos vueltas a la vez es un error del
 * operador, no una condicion de carrera que haya que resolver con reintentos. Se
 * dice quien la tiene y desde cuando, que es lo que hace falta para decidir.
 */
export function claim(executionId, { pid = process.pid, ahora = new Date().toISOString(), file = CLAIM } = {}) {
  const previo = leer({ file });
  if (previo && vivo(previo.pid) && previo.executionId !== executionId) {
    throw new Error(
      `el anillo ya esta en curso: ${previo.executionId} (pid ${previo.pid}, desde ${previo.startedAt}). `
      + `Espera a que termine, o mátalo y borra ${file}`,
    );
  }

  // Un claim de un proceso muerto se ADOPTA, y se registra a quien se reemplazo:
  // sin ese rastro, una vuelta que murio a medias desaparece de la historia.
  const huerfano = previo && !vivo(previo.pid) ? previo.executionId : null;

  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file,
    redactarSecretos(JSON.stringify({ executionId, pid, startedAt: ahora, replaced: huerfano }, null, 2)) + '\n');
  return { executionId, pid, startedAt: ahora, replaced: huerfano };
}

/**
 * Suelta el claim si es NUESTRO.
 *
 * La comprobacion no es paranoia: si una vuelta suelta el claim de otra, el
 * cerrojo deja de significar nada justo cuando hay dos corriendo, que es el unico
 * momento en que servia.
 */
export function release(executionId, { file = CLAIM } = {}) {
  const previo = leer({ file });
  if (!previo || previo.executionId !== executionId) return false;
  unlinkSync(file);
  return true;
}
