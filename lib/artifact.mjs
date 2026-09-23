// Serializacion de artefactos — el sobre comun de toda etapa del anillo.
//
// MECANICA, no contrato: que campos lleva cada contrato lo dice
// harness/contracts/contracts.json. Aqui solo COMO se escribe en disco y la
// comprobacion de que lo escrito cumple lo declarado.
//
// La regla que lo hace util: un artefacto que no satisface los `required` de su
// contrato NO SE ESCRIBE. Si se escribiera, la etapa siguiente fallaria mas
// lejos de la causa -- o peor, no fallaria.
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ROOT, HARNESS } from './capabilities.mjs';
import { redactarSecretos } from './secretos.mjs';

export const CONTRACTS = JSON.parse(
  readFileSync(join(HARNESS, 'contracts', 'contracts.json'), 'utf8'),
);

/** SKIPPED y FAIL EXIGEN motivo. */
export const STATUS = ['OK', 'WARN', 'SKIPPED', 'FAIL'];

/**
 * UN CAMPO REQUERIDO QUE ES CADENA VACIA NO ESTA. Y esto no es purismo: la
 * comprobacion decia «presente salvo undefined o null», asi que `claim: ""`
 * pasaba, y paso.
 *
 * MEDIDO en H-20260819-68ac6919: el revisor del rework devolvio cuatro
 * hallazgos, y los dos FRESCOS traian `claim` vacio con `evidence` lleno --los
 * arrastrados si lo conservaban, porque `arrastrar` no lo toca--. La etapa 9
 * declara «cada hallazgo trae file, symbol, claim y evidence citable» y no
 * disparo.
 *
 * Lo que rompe no es la estetica: `fingerprint` es `(file, symbol, esqueleto del
 * claim)`. Con el claim vacio dos hallazgos DISTINTOS sobre el mismo fichero y
 * simbolo producen la MISMA huella y se funden en uno. La deduplicacion --que es
 * determinista a proposito, para que no la haga un modelo-- deja de distinguir.
 *
 * Solo se aplica a CADENAS. Un array vacio es una respuesta legitima
 * (`unknowns: []` es «no hay incognitas») y `false` es un valor, no una ausencia.
 */
const ausente = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

/** @returns [] si cumple, o los campos que faltan. */
export function validate(contract, payload) {
  const def = CONTRACTS.contracts[contract];
  if (!def) return [`contrato desconocido: '${contract}'`];
  if (payload == null || typeof payload !== 'object') return ['payload no es un objeto'];
  const faltan = (def.required ?? [])
    .filter((k) => ausente(payload[k]))
    .map((k) => `falta '${k}'`);

  // LOS ELEMENTOS TAMBIEN TIENEN CONTRATO, y no se comprobaba ninguno. El
  // contrato `Finding` ya declaraba `claim` como requerido desde el principio:
  // lo que faltaba no era la regla, era que alguien la mirara. `elements` lo
  // declara en contracts.json para que la autoridad siga siendo UNA -- cablear
  // aqui `if (contract === 'FindingSet')` habria creado la segunda.
  for (const [campo, sub] of Object.entries(def.elements ?? {})) {
    const lista = payload[campo];
    if (!Array.isArray(lista)) continue;
    lista.forEach((el, i) => {
      const req = CONTRACTS.contracts[sub]?.required ?? [];
      for (const k of req) {
        if (ausente(el?.[k])) faltan.push(`${campo}[${i}] incumple ${sub}: falta '${k}'`);
      }
    });
  }
  return faltan;
}

/**
 * El sobre. Igual para las 16 etapas; lo que cambia es `payload`.
 *
 * `onFail` es la unica pieza que una etapa puede decir sobre el MOTOR, y solo
 * para ENDURECER lo que el manifiesto ya declara (ring.mjs lo hace cumplir).
 * Existe porque hay fallos que un reintento no arregla y la etapa es la unica
 * que lo sabe: un ciclo de hallazgos detectado, o una especificacion
 * incoherente. Reintentar sobre eso es gastar presupuesto en producir el mismo
 * resultado.
 */
export function envelope({ executionId, n, stage, contract, payload, status = 'OK', reason, producedBy, onFail }) {
  if (!STATUS.includes(status)) throw new Error(`status invalido: '${status}'`);
  if ((status === 'SKIPPED' || status === 'FAIL') && !reason) {
    // Sin esto, una etapa saltada en silencio pasa por recorrida: la version de
    // anillo del `describe.only`. FT-1 existe para detectarla.
    throw new Error(`etapa '${stage}': status ${status} EXIGE reason`);
  }
  return {
    executionId, n, stage, contract, status,
    ...(reason ? { reason } : {}),
    ...(onFail ? { onFail } : {}),
    producedBy: producedBy ?? null,
    producedAt: new Date().toISOString(),
    payload: payload ?? null,
  };
}

/** Falla ANTES de escribir si el payload incumple: un fichero es una afirmacion. */
export function writeArtifact(path, env) {
  if (env.status === 'OK' || env.status === 'WARN') {
    const faltan = validate(env.contract, env.payload);
    if (faltan.length) {
      throw new Error(
        `etapa '${env.stage}' declara ${env.status} pero su ${env.contract} incumple: ${faltan.join(', ')}`,
      );
    }
  }
  const abs = path.startsWith('/') ? path : join(ROOT, path);
  mkdirSync(dirname(abs), { recursive: true });
  // SE REDACTA AL ESCRIBIR, no antes. El objeto que viaja entre etapas se queda
  // intacto: Security tiene que VER la credencial para cazarla. Lo que no tiene que
  // hacer el artefacto es GUARDARLA -- `.harness/` la sube CI, y la semilla de h-007
  // aparecia 19 veces en 3 artefactos de una sola vuelta.
  writeFileSync(abs, redactarSecretos(JSON.stringify(env, null, 2)) + '\n');
  return abs;
}

export function readArtifact(path) {
  const abs = path.startsWith('/') ? path : join(ROOT, path);
  if (!existsSync(abs)) return null;
  try {
    return JSON.parse(readFileSync(abs, 'utf8'));
  } catch {
    return { status: 'FAIL', reason: `artefacto ilegible: ${path}` };
  }
}

/** Sustituye el id de plantilla del manifiesto por el executionId real. */
/**
 * La ruta del artefacto con el executionId REAL.
 *
 * Se sustituye el segmento que va bajo `runs/`, sea cual sea: llevaba el literal
 * `'H-001'` y funcionaba mientras solo existio ese manifiesto. Al anadir
 * `h-002-security-gate`, cuyos artefactos declaran `runs/H-002/`, el `replace`
 * no encontro nada, las 16 etapas escribieron en `.harness/runs/H-002/` -- un
 * directorio literal, compartido por todas las corridas de ese spec -- y el
 * orquestador reventó buscando un `trace.json` en el directorio de la vuelta.
 *
 * Misma familia que la consolidacion que apuntaba a las posiciones viejas: un
 * literal que asume que solo hay un caso, y que deja de ser cierto en cuanto hay
 * dos (la-reordenacion-dejo-atras-a-sus-consumidores.md).
 */
export const artifactPath = (tpl, executionId) =>
  tpl.replace(/(^|\/)runs\/[^/]+\//, `$1runs/${executionId}/`);

/**
 * Ruta del manifiesto de una spec. UNA autoridad, dos consumidores.
 *
 * `run --ring` lo derivaba y `fitness` lo tenia escrito a mano como 'h-001.json':
 * evaluar los fitness de H-002 reventaba con ENOENT sobre
 * `.kiro/specs/h-002-security-gate/h-001.json`. Solo se noto al existir un segundo
 * manifiesto -- exactamente como el `artifactPath` con 'H-001' dentro, y como los
 * dos literales que la reordenacion dejo apuntando a posiciones viejas.
 *
 * La convencion: el fichero se llama como la spec sin el sufijo `-ring…`, asi que
 * `h-001-ring-execution` -> `h-001.json` y `h-002-security-gate` ->
 * `h-002-security-gate.json`.
 */
export const specManifestPath = (root, specId) =>
  join(root, '.kiro', 'specs', specId, `${specId.split('-ring')[0]}.json`);

/**
 * Basename del artefacto de una etapa, LEIDO DEL MANIFIESTO.
 *
 * El manifiesto es la unica autoridad del orden y del nombre. Copiar ese nombre
 * a mano a un consumidor es lo que rompio el cierre de la vuelta anterior: la
 * reordenacion en dos mitades movio Observability a la 14 y AdapterLayer a la
 * 13, el orquestador siguio consolidando `11-observability.json` y
 * `14-adapterlayer.json`, y como la consolidacion callaba ante un fichero
 * ausente, el fix parecia aplicado durante una vuelta entera.
 *
 * Lanza si la etapa no existe: un nombre que no se puede derivar es un error de
 * programacion, no un caso a tolerar.
 */
export const stageArtifactName = (manifest, stage) => {
  const s = manifest.stages?.find((x) => x.stage === stage);
  if (!s) throw new Error(`sin etapa '${stage}' en el manifiesto`);
  return s.artifact.split('/').pop();
};
