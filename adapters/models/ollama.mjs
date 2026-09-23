// Puerto de SALIDA — Ollama. HTTP a :11434.
//
// Es el destino por defecto de todo lo que puede resolverse sin salir de la
// maquina, y no por ahorro: la base local contiene PII REAL de produccion
// (134 de 137 expedientes). `localFirstForReads` es contencion, no preferencia.
//
// Contrato del puerto, igual para todos: las seis operaciones de contract.mjs.
import { maxOutputTokensDe } from '../../lib/tools.mjs';
import {
  AdapterError, ErrorCode, executionResult, usage, fromHttpStatus, fromNativeError, streamViaInvoke, conCausa } from './contract.mjs';

const BASE = process.env.OLLAMA_HOST || 'http://localhost:11434';

export const name = 'ollama';

export const capabilities = () => ({
  tool_calling: true,
  structured_output: true,
  streaming: true,
  long_context: true,
  offline: true,          // lo unico que ningun otro proveedor tiene
  enumeratesModels: true,
  maxContext: 262144,     // el techo del mayor modelo servido (qwen3.8:27b)
});

export const normalize = (e) =>
  e instanceof AdapterError ? e : new AdapterError(fromNativeError(e), name, conCausa(e), { cause: e });

export async function probe() {
  try {
    const r = await fetch(`${BASE}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return { alive: false, detail: `HTTP ${r.status}` };
    const { models = [] } = await r.json();
    return { alive: true, detail: `${models.length} modelos`, models: models.map((m) => m.name) };
  } catch (e) {
    return { alive: false, detail: e.name === 'TimeoutError' ? 'sin respuesta' : e.message };
  }
}

// 600s, no 300s: con 8 GB de VRAM un modelo de 18 GB corre mayormente en CPU y
// una revision real pasa de cinco minutos. El limite viejo cortaba la respuesta
// y una respuesta truncada es JSON invalido, que ningun parser arregla.
// ponytail: 600s medido en CPU; bajarlo si algun dia el modelo entra en VRAM.
export async function invoke(prompt, { model, system, timeoutMs = 600000, keepAlive = '30s', signal } = {}) {
  const t0 = Date.now();
  let r;
  try {
    r = await fetch(`${BASE}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt,
        system,
        stream: false,
        // Descarga en cuanto la etapa termina, en vez de retener el modelo los 5
        // minutos por defecto. Con 30 GB de RAM, dos modelos grandes residentes a
        // la vez son el fallo ya documentado, no una hipotesis.
        keep_alive: keepAlive,
        // Temperatura baja: aqui se busca reproducibilidad, no creatividad. Un
        // hallazgo distinto en cada corrida no es un hallazgo, es ruido.
        //
        // `num_predict` es el techo de SALIDA de ollama, y sale de la MISMA
        // politica que el de deepseek (`policy/tools.json:output.maxOutputTokens`).
        // Declararlo alli y no aplicarlo aqui habria sido una afirmacion escrita:
        // ollama sin `num_predict` responde hasta que quiere.
        options: {
          temperature: 0.1,
          ...(maxOutputTokensDe(name) == null ? {} : { num_predict: maxOutputTokensDe(name) }),
        },
      }),
      signal: signal ?? AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new AdapterError(fromNativeError(e), name, e.message, { model, cause: e });
  }

  if (!r.ok) {
    const cuerpo = (await r.text()).slice(0, 300);
    throw new AdapterError(fromHttpStatus(r.status, cuerpo), name, `HTTP ${r.status} ${cuerpo}`, { model });
  }
  const d = await r.json();
  const text = d.response ?? '';
  if (!text) throw new AdapterError(ErrorCode.INVALID_OUTPUT, name, 'respuesta vacia', { model });
  return executionResult({
    provider: name, model, text, ms: Date.now() - t0,
    raw: { evalCount: d.eval_count ?? null, promptEvalCount: d.prompt_eval_count ?? null },
    // ollama publica los DOS contadores y solo se leia uno: `eval_count` es la
    // salida y `prompt_eval_count` la entrada. Con la mitad, el total de una
    // vuelta local salia sistematicamente por debajo de lo gastado.
    usage: usage({
      tokensInput: d.prompt_eval_count ?? null,
      tokensOutput: d.eval_count ?? null,
    }),
  });
}

export const stream = (req) => streamViaInvoke({ name, invoke, capabilities }, req);
export const cancel = (controller) => controller?.abort?.();
