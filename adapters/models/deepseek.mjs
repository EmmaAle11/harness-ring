// Puerto de SALIDA — DeepSeek. API compatible con OpenAI.
//
// Es el proveedor que RESUELVE la tension entre dos cosas que se quieren a la
// vez: usar Claude para el trabajo, y cumplir ADR-003 (el revisor no puede
// compartir proveedor con el escritor). Sin un segundo proveedor de pago, la
// unica forma de revisar era un modelo local pequeno.
//
// La clave vive en .env, que esta en .gitignore. Nunca en el codigo, nunca en
// el diff -- y desde hoy el pre-commit tambien bloquea el patron `sk-`.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../../lib/capabilities.mjs';
import { maxOutputTokensDe, reasoningEffortDe } from '../../lib/tools.mjs';
import { temperaturaDe } from '../../policy/temperatura.mjs';
import {
  AdapterError, ErrorCode, executionResult, usage, fromHttpStatus, fromNativeError, streamViaInvoke, conCausa } from './contract.mjs';

const BASE = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
export const name = 'deepseek';

/** Lee la clave del entorno o de .env. No la imprime nunca. */
function apiKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  const f = join(ROOT, '.env');
  if (!existsSync(f)) return null;
  const m = /^DEEPSEEK_API_KEY=(.+)$/m.exec(readFileSync(f, 'utf8'));
  return m ? m[1].trim() : null;
}

export const capabilities = () => ({
  tool_calling: true,
  structured_output: true,
  streaming: true,
  long_context: true,
  enumeratesModels: true,
  maxContext: 128000,
});

export const normalize = (e) =>
  e instanceof AdapterError ? e : new AdapterError(fromNativeError(e), name, conCausa(e), { cause: e });

export async function probe() {
  const key = apiKey();
  if (!key) return { alive: false, detail: 'sin DEEPSEEK_API_KEY en entorno ni .env' };
  try {
    const r = await fetch(`${BASE}/models`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return { alive: false, detail: `HTTP ${r.status}` };
    const { data = [] } = await r.json();
    return { alive: true, detail: `${data.length} modelos`, models: data.map((m) => m.id) };
  } catch (e) {
    return { alive: false, detail: e.name === 'TimeoutError' ? 'sin respuesta' : e.message };
  }
}

export async function invoke(prompt, { model = 'deepseek-v4-pro', system, timeoutMs = 600000, signal, reasoningEffort, clase } = {}) {
  const key = apiKey();
  if (!key) throw new AdapterError(ErrorCode.AUTH_FAILURE, name, 'sin DEEPSEEK_API_KEY', { model });

  const messages = system ? [{ role: 'system', content: system }] : [];
  messages.push({ role: 'user', content: prompt });
  const t0 = Date.now();

  let r;
  try {
    r = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      // Temperatura baja: aqui se busca reproducibilidad, no creatividad. Un
      // hallazgo distinto en cada corrida no es un hallazgo, es ruido.
      //
      // max_tokens es un techo de SALIDA y subio dos veces por la misma razon:
      // 8192 -> 16384 -> 32768. Se probo contra la API que acepta 32768 y 65536.
      //
      // EL NUMERO YA NO VIVE AQUI. Estaba cableado en el adaptador, que es el
      // unico sitio donde una politica de coste NO se puede leer ni cambiar sin
      // tocar codigo: ahora lo declara `policy/tools.json:output.maxOutputTokens`
      // junto a los seis limites de ENTRADA, que es de lo que era la otra mitad.
      //
      // NO se sube una tercera vez. En H-20260816-bebf4372 el revisor agoto 32768
      // con 7,5 KB de entrada: el problema dejo de ser el techo y paso a ser la
      // verbosidad, y perseguir un techo que la verbosidad siempre alcanza es
      // tratar el sintoma. Lo que se arreglo es lo otro: la respuesta cortada ya
      // no se marca CONTEXT_OVERFLOW —que es determinista y no se reintenta— sino
      // OUTPUT_TRUNCATED, que SI se reintenta con una reduccion POR CONTRATO.
      // `null` en la politica significa «este proveedor no acepta techo»: entonces no
      // se manda el campo, en vez de mandar `null` y que la API decida por su cuenta.
      //
      // Y EL TECHO DE SALIDA NO ERA LA VARIABLE QUE SE DESBORDABA. Medido en
      // H-20260819-4b5c6d6d: `32768 de salida, de los cuales 32768 de
      // razonamiento`. El modelo gasto el presupuesto ENTERO pensando y no emitio
      // ni un token de respuesta, asi que ni un contrato mas corto ni un techo
      // mas alto podian salvar esa llamada. El modo de pensamiento de DeepSeek
      // viene ACTIVADO POR DEFECTO y nadie lo habia acotado nunca.
      //
      // `reasoning_effort` sale de la politica, y el llamante puede bajarlo para
      // UN reintento (ver `invoke.mjs`): repetir el mismo esfuerzo repite el
      // mismo desbordamiento.
      // LA TEMPERATURA SALE DE LA CLASE, no de un literal. Ver
      // policy/temperatura.mjs: `read` es 0.0 --inventariar tiene UNA respuesta
      // correcta-- y `review` es 0.3, porque refutar exige ver lo que el escritor
      // no vio. Sin `clase` se cae al 0.1 de siempre, que es lo que hacia antes.
      body: JSON.stringify({
        model, messages, temperature: temperaturaDe(clase),
        ...(maxOutputTokensDe(name) == null ? {} : { max_tokens: maxOutputTokensDe(name) }),
        ...((reasoningEffort ?? reasoningEffortDe(name)) == null
          ? {}
          : { reasoning_effort: reasoningEffort ?? reasoningEffortDe(name) }),
      }),
      signal: signal ?? AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new AdapterError(fromNativeError(e), name, e.message, { model, cause: e });
  }

  if (!r.ok) {
    // El cuerpo del error puede llevar eco de la peticion: se trunca y NUNCA se
    // incluye la cabecera de autorizacion.
    const cuerpo = (await r.text()).slice(0, 300);
    throw new AdapterError(fromHttpStatus(r.status, cuerpo), name, `HTTP ${r.status} ${cuerpo}`, { model });
  }
  const d = await r.json();
  const text = d.choices?.[0]?.message?.content ?? '';
  // Una respuesta cortada por limite de tokens NO es una respuesta: se declara.
  // Y se declara como OUTPUT_TRUNCATED, no como CONTEXT_OVERFLOW: la entrada
  // cabia: lo que sobro fue la respuesta, y eso SI mejora al repetir.
  if (d.choices?.[0]?.finish_reason === 'length') {
    // SE MIDE EN QUE SE GASTO, no solo cuanto. MEDIDO en H-20260818-72a39e18: la
    // etapa 9 del rework agoto los 32.768 DOS VECES con el mismo modelo, la misma
    // entrada (+2 % de diff) y la reduccion por contrato aplicada -- «MAXIMO 3
    // hallazgos»--, mientras la ronda anterior habia pasado con un hallazgo.
    //
    // Si el gasto es RAZONAMIENTO y no respuesta, un contrato mas corto no puede
    // acotarlo: acota lo que se responde, no lo que se piensa. Y entonces el
    // arreglo no es otro numero -- la prohibicion de subir `max_tokens` una cuarta
    // vez sigue en pie-- sino cambiar de modelo o de modo para esa llamada.
    //
    // Esto NO lo afirma todavia: lo hace medible la proxima vez. Diagnosticar
    // primero es lo que evito que el fix anterior tratara el sintoma.
    const raz = d.usage?.completion_tokens_details?.reasoning_tokens;
    throw new AdapterError(ErrorCode.OUTPUT_TRUNCATED, name,
      `respuesta truncada por max_tokens (${d.usage?.completion_tokens ?? '?'} de salida`
      + `${raz == null ? ', razonamiento NO REPORTADO' : `, de los cuales ${raz} de razonamiento`})`,
      { model });
  }
  return executionResult({
    provider: name, model, text, ms: Date.now() - t0, raw: d.usage ?? null,
    // DeepSeek SI publica uso. Se traduce aqui, en la frontera del proveedor.
    usage: usage({
      tokensInput: d.usage?.prompt_tokens ?? null,
      tokensOutput: d.usage?.completion_tokens ?? null,
      totalTokens: d.usage?.total_tokens ?? null,
    }),
  });
}

export const stream = (req) => streamViaInvoke({ name, invoke, capabilities }, req);

/** Cancela via AbortController: quien invoca pasa su `signal`. */
export const cancel = (controller) => controller?.abort?.();
