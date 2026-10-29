// EL ESCRITOR DE MEMORIA — el ultimo eslabon de la memoria autoalimentada.
//
// La cadena estaba cortada en el ultimo paso:
//
//   Evidence -> capture -> classify -> promote -> [NADIE] -> memory/
//
// `learning.mjs` produce candidatos resueltos y `stages.saveLearningCandidates()`
// los deja en `.harness/learning/<id>.json`. Pero la vuelta N+1 arranca leyendo
// `memory/`, NO `.harness/`. Resultado medido: el anillo decidia PROMOTE y a la
// vuelta siguiente volvia a proponer el mismo candidato como novedad, porque
// nadie habia escrito nada. "Aprendia" en un fichero que nadie leia.
//
// Este modulo cierra el circulo, y es el UNICO que escribe en memory/.
//
// POR QUE SEPARADO DE learning.mjs: learning es puro y sin E/S a proposito, y
// eso se queda asi. Mezclar la decision con la escritura haria que un fallo de
// disco cambiara un veredicto, y que probar la decision exigiera un disco.
//
// EL RIESGO QUE GOBIERNA EL DISENO: un anillo que escribe su propia memoria sin
// filtro puede envenenarla. Un aprendizaje falso promovido se convierte en
// PREMISA de todo lo que venga despues. De ahi las cuatro negativas duras:
//
//   1 solo PROMOTE escribe             REVIEW/REJECT se quedan en .harness/
//   2 nunca sobreescribe                reescribir memoria pasada no es aprender
//   3 nunca inventa un mecanismo        declara NINGUNO AUTOMATICO
//   4 la clave no puede escapar del dir una clave con '..' es escritura arbitraria
//
// La 3 es la que mas cuesta y la que mas vale: `memoria-mecanismo.mjs` exige que
// toda entrada `active` declare su guarda. Un escritor que omita el campo mete
// entradas que rompen el gate del propio repo; uno que escriba "cubierto por
// tests" sin comprobarlo miente en el corpus que la vuelta siguiente lee como
// verdad. Lo unico honesto que una maquina puede poner ahi es que no lo sabe.

import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { redactarSecretos } from './secretos.mjs';

/**
 * Lo que se escribe cuando el candidato no trae una guarda VERIFICADA.
 *
 * No es un placeholder: es el valor correcto. `memoria-mecanismo.mjs` cuenta las
 * entradas sin mecanismo contra un techo que solo puede bajar, asi que esto no
 * desaparece del radar -- aparece como deuda declarada, que es lo que es.
 */
export const MECANISMO_SIN_GUARDA = 'NINGUNO AUTOMATICO — promovido por el anillo sin guarda verificada';

/**
 * El `status` inicial por clase, dentro del vocabulario cerrado de ESTADOS.
 *
 * Un FAILURE recien aprendido es `active`: todavia puede pasar. Una VALIDATION es
 * `demonstrated`: es una capacidad que se probo, no un riesgo que acecha. Poner
 * `active` a todo haria que el techo de mecanismos subiera por entradas que no
 * necesitan guarda, y un techo que sube por ruido se acaba desactivando.
 */
export const ESTADO_POR_TIPO = {
  FAILURE: 'active',
  VALIDATION: 'demonstrated',
  CODING_PATTERN: 'active',
  VULNERABILITY: 'active',
  PROJECT_FACT: 'active',
  ARCHITECTURE_DECISION: 'accepted',
  MIGRATION: 'fixed',
};

/** Una clave utilizable como nombre de fichero: sin separadores, sin '..', no vacia. */
const claveUtilizable = (k) =>
  typeof k === 'string' && k.length > 0 && k.length <= 120
  && !k.includes('/') && !k.includes('\\') && !k.includes('\0')
  && k !== '.' && k !== '..' && !k.startsWith('.');

/**
 * Donde va este candidato. La ruta sale de la POLITICA (`types[tipo].dir`), no
 * de una tabla en el codigo: el repo decide donde vive su memoria.
 */
export function rutaDe(candidato, policy, raiz) {
  const dir = candidato.decision?.dir ?? policy.types?.[candidato.type]?.dir;
  if (!dir) {
    throw new Error(`clase '${candidato.type}' sin dir declarado en la politica: no se escribe en una ruta inventada`);
  }
  if (!claveUtilizable(candidato.key)) {
    throw new Error(`clave no utilizable como fichero: ${JSON.stringify(candidato.key)}`);
  }
  return join(raiz, dir, `${candidato.key}.md`);
}

/** Un valor de frontmatter en una sola linea: el parser del trinquete es de lineas planas. */
const plano = (v) => String(v ?? '').replace(/\r?\n/g, ' ').trim();

/**
 * El fichero markdown. El frontmatter esta hecho para que `memoria-mecanismo.auditar()`
 * lo acepte, y el cuerpo para que un humano pueda revisarlo y retirarlo.
 */
export function cuerpoDe(candidato, policy) {
  const p = candidato.provenance ?? {};
  const status = ESTADO_POR_TIPO[candidato.type] ?? 'active';
  const fm = [
    '---',
    `id: ${plano(candidato.key)}`,
    `title: ${plano(candidato.candidate)}`,
    `type: ${plano(candidato.type)}`,
    `status: ${status}`,
    `mecanismo: ${plano(candidato.mecanismo || MECANISMO_SIN_GUARDA)}`,
    `origin: ${plano(p.origin ?? 'harness')}`,
    `execution_id: ${plano(p.execution_id)}`,
    `confidence: ${plano(p.confidence ?? candidato.confidence)}`,
    `date: ${plano(p.date)}`,
    `agent: ${plano(p.agent)}`,
    `model: ${plano(p.model)}`,
    `promoted_by: ${plano(p.promoted_by ?? p.agent)}`,
    '---',
  ].join('\n');

  const corridas = (candidato.evidence ?? []);
  const cuerpo = [
    '',
    `# ${plano(candidato.candidate)}`,
    '',
    '> Promovida por el anillo. No la escribio una persona: salio de la evidencia de',
    '> las corridas citadas abajo. Si esta mal, se retira y se dice por que.',
    '',
    '## Que se observo',
    '',
    plano(candidato.candidate),
    '',
    '## Evidencia',
    '',
    corridas.length
      ? corridas.map((e) => `- corrida \`${plano(e)}\``).join('\n')
      : '- (sin corridas citadas)',
    '',
    `Visto en **${corridas.length} corrida(s) distintas** · confianza **${plano(p.confidence ?? candidato.confidence)}**`
    + ` (derivada de la repeticion, no declarada por un modelo)`,
    `Repetible: **${candidato.repeatable ? 'si' : 'no'}**`,
    '',
    '## Mecanismo',
    '',
    candidato.mecanismo
      ? `Guarda que lo hace cumplir: \`${plano(candidato.mecanismo)}\`.`
      : 'No hay guarda automatica que impida que vuelva a pasar. El campo `mecanismo:`\n'
        + 'lo declara asi en vez de nombrar un test que no existe: una leccion cuyo\n'
        + 'mecanismo no es consultable por una maquina es una anecdota bien escrita.',
    '',
    `## Decision de promocion`,
    '',
    `\`${plano(candidato.decision?.verdict)}\` — ${plano(candidato.decision?.reason)}`,
    '',
  ].join('\n');

  return redactarSecretos(fm + cuerpo);
}

/**
 * Escribe los PROMOTE y devuelve el parte de lo hecho y lo omitido.
 *
 * Nada de excepciones por un candidato malo: un candidato que no se puede
 * escribir se reporta como omitido con su motivo. Abortar la tanda entera por
 * uno haria que un candidato corrupto impidiera aprender lo demas.
 *
 * @param resueltos  candidatos con `.decision` ya tomada por promote()
 * @param policy     policy/learning.json
 * @param raiz       raiz del repo donde vive memory/
 * @param seco       decide y reporta sin tocar el disco
 */
export function escribir(resueltos, policy, { raiz, seco = false } = {}) {
  const escritos = [];
  const omitidos = [];

  for (const c of resueltos ?? []) {
    const v = c.decision?.verdict;

    // Falla CERRADO: cualquier cosa que no sea exactamente PROMOTE no escribe.
    if (v !== 'PROMOTE') {
      omitidos.push({ key: c.key, verdict: v ?? null, motivo: c.decision?.reason ?? 'sin veredicto PROMOTE' });
      continue;
    }
    // La exclusion del repo manda sobre el veredicto: si la clase no va en
    // memory/, no va -- aunque la decision diga PROMOTE.
    if ((policy.excluded ?? []).includes(c.type)) {
      omitidos.push({ key: c.key, verdict: v, motivo: `clase '${c.type}' excluida de memory/ por decision del repo` });
      continue;
    }

    let ruta;
    try {
      ruta = rutaDe(c, policy, raiz);
    } catch (e) {
      omitidos.push({ key: c.key, verdict: v, motivo: e.message });
      continue;
    }

    // NO SOBREESCRIBE. Reescribir una entrada pasada no es aprender: es perder el
    // registro de lo que se creia antes. Si hay que corregirla, se retira a mano.
    if (existsSync(ruta)) {
      omitidos.push({ key: c.key, verdict: v, motivo: 'ya existe', path: ruta });
      continue;
    }

    if (!seco) {
      mkdirSync(join(ruta, '..'), { recursive: true });
      writeFileSync(ruta, cuerpoDe(c, policy), 'utf8');
    }
    escritos.push({ key: c.key, type: c.type, path: ruta, confidence: c.confidence });
  }

  return { escritos, omitidos, seco };
}
