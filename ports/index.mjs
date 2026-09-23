// ── Los puertos del anillo, y su negociacion ─────────────────────────────────
//
// `assertRing(ports)` comprueba TODOS los puertos al arrancar. Es la respuesta
// al modo de fallo que mato tres vueltas de h-009: `stages.mjs` descubria que
// faltaba `scripts/gate.sh` en la ETAPA 15, tras 14 etapas y todas las
// invocaciones de modelo, cuando se sabia en el segundo cero.
//
// MCP negocia capacidades en el `initialize` y ambas partes respetan lo
// declarado durante toda la sesion. Mismo principio: la vuelta no empieza si
// falta un puerto.
//
// ESTADO DE LA MIGRACION (2026-09-23). Tres puertos escritos de los trece que
// el diseno identifica. Los diez restantes siguen resueltos en linea dentro del
// motor. Se dice aqui y no en un README para que quien lea el codigo sepa que
// esto es un puente a medio construir, no una arquitectura terminada:
//
//   HECHO      anfitrion (el bloqueante 0), quality-gate, model-provider*
//   PENDIENTE  memory-store, spec-locator, test-runner, workspace,
//              source-taxonomy, security-scanner, runtime-env, repository,
//              project-context, trace-sink
//
//   * model-provider YA EXISTIA y es correcto: `adapters/models/contract.mjs`
//     declara OPERACIONES, assertConforms y negotiate, con cinco adaptadores
//     vivos. No habia que disenarlo, habia que reconocerlo.
export { crearAnfitrion, anfitrionPorDefecto, assertAnfitrion } from './host.mjs';
export { puertaNula, assertPuerta } from './quality-gate.mjs';
// El ADAPTADOR no se reexporta desde `ports/`: un puerto no conoce a sus
// implementaciones. Quien compone el anillo importa de `adapters/doxia/`.

import { assertAnfitrion } from './host.mjs';
import { assertPuerta } from './quality-gate.mjs';

const REQUERIDOS = {
  anfitrion: assertAnfitrion,
  puertaDeCalidad: assertPuerta,
};

/**
 * Negocia los puertos ANTES de la primera etapa.
 *
 * @param {object} ports        objeto con un adaptador por puerto
 * @param {object} [opciones]
 * @param {string} [opciones.workspace] si se da, se pregunta `disponible()`
 * @returns {{ok, fallos:[], informe:{}}}
 */
export function assertRing(ports = {}, { workspace } = {}) {
  const fallos = [];
  const informe = {};

  for (const [nombre, comprobar] of Object.entries(REQUERIDOS)) {
    const p = ports[nombre];
    if (!p) { fallos.push(`falta el puerto '${nombre}'`); continue; }
    try {
      comprobar(p, `puerto '${nombre}'`);
      informe[nombre] = p.describe?.() ?? { id: nombre };
    } catch (e) {
      fallos.push(String(e.message ?? e)); continue;
    }
    // Disponibilidad REAL, no solo forma: un adaptador puede cumplir el
    // contrato y aun asi no tener con que trabajar.
    if (workspace && typeof p.disponible === 'function') {
      const d = p.disponible(workspace);
      informe[nombre] = { ...informe[nombre], disponible: d };
      if (!d?.ok) fallos.push(`puerto '${nombre}' no disponible: ${d?.porque ?? 'sin motivo'}`);
    }
  }
  return { ok: fallos.length === 0, fallos, informe };
}
