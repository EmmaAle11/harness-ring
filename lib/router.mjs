// Router — (agente, salud, evitar[]) -> modelo | error.
//
// Ya NO implementa la seleccion. Es la fachada estrecha sobre `compute.decide()`,
// que es la unica autoridad: dos algoritmos de seleccion que se parecen es como
// se llega a que doctor diga una cosa y la etapa Compute haga otra.
//
// Un agente declara `model_class`, NUNCA un proveedor. Eso es lo que permite
// cambiar de proveedor sin tocar ni un agente (ADR-001).
//
// La funcion PUEDE quedarse sin candidatos, y eso es una funcionalidad, no un
// fallo: es como se cumple ADR-003 ("el revisor nunca usa el modelo del
// builder") a nivel de codigo en vez de a nivel de prompt. Una regla escrita
// solo en un prompt es una regla que nadie hace cumplir -- el defecto de
// memory/failures/el-fix-que-no-existe.md.
//
// Puro: sin E/S. Quien averigua que proveedores estan vivos es `doctor`.
import { computeRequest, decide, modelKey } from './compute.mjs';

export const modelId = (c) => `${c.provider}:${c.model}`;

/**
 * @param agent      {model_class, id}
 * @param router     contenido de policy/router.json
 * @param catalog    contenido de policy/catalog.json
 * @param available  Set de proveedores VIVOS (lo dice doctor, no el JSON)
 * @param models     Map proveedor -> Set de modelos servidos, para quien lo publica
 * @param avoid      ids de modelo a excluir, p.ej. el que uso el builder.
 *                   Se excluye la FAMILIA entera, no solo ese modelo: dos
 *                   modelos de la misma familia comparten punto ciego, asi que
 *                   `claude:opus` escribiendo y `claude:sonnet` revisando NO
 *                   cumple ADR-003 -- ni `deepseek` escribiendo y `opencode`
 *                   revisando, porque opencode sirve deepseek por debajo.
 * @returns {provider, model, id, why, decision} | {error}
 */
export function resolveModel(agent, { router, catalog, available, models, avoid = [] } = {}) {
  const req = computeRequest(agent, { router, avoid });
  const d = decide(req, { catalog, router, health: { alive: available, models } });
  if (d.error) return { error: d.error, considered: d.considered };
  return { provider: d.provider, model: d.model, id: d.id, why: d.reason, decision: d };
}

/** Proveedores declarados con clave/endpoint pero cuya disponibilidad la confirma `doctor`. */
export const declaredProviders = (router) => Object.keys(router.providers ?? {});

export { computeRequest, decide, modelKey };
