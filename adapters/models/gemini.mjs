// Puerto de SALIDA — Gemini (Google Generative Language API).
//
// POR QUE EXISTE, Y POR QUE HASTA HOY NO. Con `edit` en Claude y `review` en
// DeepSeek, ADR-003 se cumple para el par escritor/revisor. Lo que NO se cumplia
// era la REFUTACION: quien refuta no puede compartir familia con quien escribio
// los hallazgos, y el revisor los escribe. Medido en tres corridas del 27-ago,
// la etapa 5 paraba con `refutacion DEGRADADA · sin tercera familia viva`:
//
//   deepseek-v4-pro / v4-flash / deepseek-coder-v2  familia 'deepseek', ya usada
//   ollama:qwen2.5-coder:14b   el proveedor responde pero NO SIRVE ese modelo
//   opencode:default           no soporta structured_output
//
// El router documentaba qwen como «LA TERCERA FAMILIA», medida el 21-ago. Hoy no
// esta servida: una capacidad declarada y no re-comprobada. Gemini es la tercera
// familia REAL — google, ni anthropic ni deepseek.
//
// LA CLAVE, Y LO QUE ARRASTRA. Es la MISMA que usa el backend para extraccion
// documental (`backend/src/common/services/ai.service.ts`), con su panel en
// `admin/gemini-billing.service.ts`. Autorizado por el usuario el 2026-08-27.
// Consecuencia declarada, no escondida: el gasto de los agentes y el de los
// documentos de clientes caen en la misma cuenta, asi que ese panel deja de
// medir solo lo que cree medir. Si eso estorba, la separacion es una clave nueva
// en `.env` -- este adaptador ya la prefiere si existe.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../../lib/capabilities.mjs';
import { maxOutputTokensDe } from '../../lib/tools.mjs';
import {
  AdapterError, ErrorCode, executionResult, usage, fromHttpStatus, fromNativeError,
  streamViaInvoke, conCausa } from './contract.mjs';

const BASE = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta';
export const name = 'gemini';

/**
 * Lee la clave. Nunca la imprime, y NUNCA la manda en la URL de un mensaje de
 * error: va en la cabecera `x-goog-api-key`, no en la query, precisamente para
 * que un `HTTP 400 <url>` no la transcriba a un log ni a un artefacto.
 *
 * Orden deliberado: una clave PROPIA del harness gana sobre la del backend. Asi
 * separar las cuentas manana es anadir una linea a `.env`, no tocar codigo.
 */
function apiKey() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
  for (const f of [join(ROOT, '.env'), join(ROOT, 'backend', '.env.local')]) {
    if (!existsSync(f)) continue;
    const m = /^GEMINI_API_KEY=(.+)$/m.exec(readFileSync(f, 'utf8'));
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  }
  return null;
}

export const capabilities = () => ({
  tool_calling: true,
  // `responseMimeType: application/json` obliga al modelo a emitir JSON. Es lo
  // que la clase `review` exige por `requires`, y sin ello un refutador que
  // conteste en prosa se cuenta como voto tirado.
  structured_output: true,
  streaming: true,
  long_context: true,
  enumeratesModels: true,
  maxContext: 1000000,
});

export const normalize = (e) =>
  e instanceof AdapterError ? e : new AdapterError(fromNativeError(e), name, conCausa(e), { cause: e });

export async function probe() {
  const key = apiKey();
  if (!key) return { alive: false, detail: 'sin GEMINI_API_KEY en entorno, .env ni backend/.env.local' };
  try {
    const r = await fetch(`${BASE}/models`, {
      headers: { 'x-goog-api-key': key },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return { alive: false, detail: `HTTP ${r.status}` };
    const { models = [] } = await r.json();
    // SOLO los que sirven `generateContent`. La lista trae embeddings y TTS, y
    // contarlos infla el inventario con modelos que esta operacion no puede usar
    // -- el mismo defecto por el que el router prometia un qwen sin descargar.
    const ids = models
      .filter((m) => (m.supportedGenerationMethods ?? []).includes('generateContent'))
      .map((m) => String(m.name).split('/').pop());
    return { alive: true, detail: `${ids.length} modelos`, models: ids };
  } catch (e) {
    return { alive: false, detail: e.name === 'TimeoutError' ? 'sin respuesta' : e.message };
  }
}

export async function invoke(prompt, { model = 'gemini-2.5-flash', system, timeoutMs = 600000, signal } = {}) {
  const key = apiKey();
  if (!key) throw new AdapterError(ErrorCode.AUTH_FAILURE, name, 'sin GEMINI_API_KEY', { model });
  const t0 = Date.now();

  let r;
  try {
    r = await fetch(`${BASE}/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        generationConfig: {
          // Baja por lo mismo que en DeepSeek: aqui se busca reproducibilidad.
          // Un hallazgo distinto en cada corrida no es un hallazgo, es ruido.
          temperature: 0.1,
          ...(maxOutputTokensDe(name) == null ? {} : { maxOutputTokens: maxOutputTokensDe(name) }),
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
  const c = d.candidates?.[0];
  const text = (c?.content?.parts ?? []).map((p) => p.text ?? '').join('');

  // UNA RESPUESTA CORTADA NO ES UNA RESPUESTA, y se declara con el codigo que
  // SI se reintenta. Gemini lo dice en `finishReason`, y `MAX_TOKENS` es el
  // equivalente del `finish_reason: length` de DeepSeek.
  if (c?.finishReason === 'MAX_TOKENS') {
    throw new AdapterError(ErrorCode.OUTPUT_TRUNCATED, name,
      `respuesta truncada por maxOutputTokens (${d.usageMetadata?.candidatesTokenCount ?? '?'} de salida)`,
      { model });
  }
  // Y el silencio TIENE MOTIVO: si el filtro de seguridad corta, `text` viene
  // vacio y sin esto se leeria como «el modelo no encontro nada» -- que es la
  // clase que este repo lleva el dia entero cazando.
  if (!text && c?.finishReason && c.finishReason !== 'STOP') {
    throw new AdapterError(ErrorCode.PROVIDER_FAILURE, name,
      `sin texto: finishReason=${c.finishReason}. NO es «no encontro nada»`, { model });
  }

  return executionResult({
    provider: name, model, text, ms: Date.now() - t0, raw: d.usageMetadata ?? null,
    usage: usage({
      tokensInput: d.usageMetadata?.promptTokenCount ?? null,
      tokensOutput: d.usageMetadata?.candidatesTokenCount ?? null,
      totalTokens: d.usageMetadata?.totalTokenCount ?? null,
    }),
  });
}

export const stream = (req) => streamViaInvoke({ name, invoke, capabilities }, req);

/** Cancela via AbortController: quien invoca pasa su `signal`. */
export const cancel = (controller) => controller?.abort?.();
