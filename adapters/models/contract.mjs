// El CONTRATO del puerto de salida. Compute decide; Adapter ejecuta la decision.
//
//   Compute   "Usa ollama/qwen3.8:27b"
//      ↓
//   Adapter   "Asi se invoca ollama/qwen3.8:27b"
//
// No deben mezclarse. Mientras cada adaptador tuviera su propia forma de fallar,
// el harness NO podia tratarlos igual: un `fetch failed` de ollama, un `exit 1`
// de un CLI y un `HTTP 401` de una API son el mismo suceso para quien decide
// —«este proveedor no sirve»— y tres sucesos distintos para quien lee el codigo.
//
// Aqui viven las tres normalizaciones: la ENTRADA (ExecutionRequest), la SALIDA
// (ExecutionResult) y el FALLO (ErrorCode).

/**
 * Los nueve fallos que el harness sabe distinguir. Un adaptador traduce lo suyo
 * a uno de estos; nada mas cruza la frontera.
 *
 * La distincion que importa no es cosmetica: `TIMEOUT` y `RATE_LIMIT` se
 * reintentan, `AUTH_FAILURE` y `MODEL_UNAVAILABLE` NO —reintentar una clave mala
 * es gastar tiempo en un fallo determinista— y `CONTEXT_OVERFLOW` obliga a
 * cambiar de modelo, no a repetir.
 *
 * `OUTPUT_TRUNCATED` es el noveno, y existe porque la tabla de ocho mezclaba dos
 * sucesos opuestos bajo `CONTEXT_OVERFLOW`:
 *
 *   ENTRADA demasiado grande   determinista; repetir da lo mismo -> NO reintentar
 *   SALIDA cortada por max_tokens   el prompt cabia; lo que sobro fue la respuesta
 *
 * El segundo SI mejora al repetir, porque el reintento le dice al modelo lo que
 * paso y puede responder mas corto. Medido en H-20260816-bebf4372: el diff eran
 * 7,5 KB —cabia de sobra— y la vuelta murio en Validation sin segundo intento,
 * porque el codigo comun decia «no reintentable».
 */
export const ErrorCode = {
  AUTH_FAILURE: 'AUTH_FAILURE',
  MODEL_UNAVAILABLE: 'MODEL_UNAVAILABLE',
  TIMEOUT: 'TIMEOUT',
  RATE_LIMIT: 'RATE_LIMIT',
  CONTEXT_OVERFLOW: 'CONTEXT_OVERFLOW',
  OUTPUT_TRUNCATED: 'OUTPUT_TRUNCATED',
  TOOL_FAILURE: 'TOOL_FAILURE',
  PROVIDER_FAILURE: 'PROVIDER_FAILURE',
  INVALID_OUTPUT: 'INVALID_OUTPUT',
};

/** Reintentar lo que no depende de nosotros; nunca lo determinista. */
export const REINTENTABLES = new Set([
  ErrorCode.TIMEOUT, ErrorCode.RATE_LIMIT, ErrorCode.PROVIDER_FAILURE, ErrorCode.OUTPUT_TRUNCATED,
]);

export class AdapterError extends Error {
  constructor(code, provider, detail, { model, cause } = {}) {
    super(`${provider}${model ? ` ${model}` : ''}: [${code}] ${detail}`);
    this.name = 'AdapterError';
    this.code = code;
    this.provider = provider;
    this.model = model ?? null;
    this.detail = detail;
    this.retryable = REINTENTABLES.has(code);
    if (cause) this.cause = cause;
  }
}

/** ENTRADA normalizada. Todos los adaptadores reciben esto. */
export function executionRequest({
  prompt, model, system = null, capability = null,
  requires = [], timeoutMs = 600000, signal = null, cwd = null, clase = null,
} = {}) {
  if (!prompt) throw new AdapterError(ErrorCode.INVALID_OUTPUT, 'harness', 'ExecutionRequest sin prompt');
  // `cwd` no es una comodidad: los proveedores CLI traen SUS PROPIAS tools y se
  // invocaban desde el directorio del proceso, es decir, el arbol principal. Un
  // modelo al que el harness contiene por un lado y que por el otro puede leer el
  // repositorio entero a traves de su CLI no esta contenido. Cuando hay sandbox,
  // se invoca DENTRO de el.
  // `clase` decide la TEMPERATURA (policy/temperatura.mjs). Va en el contrato y
  // no como extra suelto: un campo que se cae al normalizar es un campo que el
  // adaptador nunca ve, y la politica quedaria escrita sin gobernar nada.
  return { prompt, model, system, capability, requires, timeoutMs, signal, cwd, clase };
}

/**
 * USO normalizado. Cada proveedor lo publica con otro nombre --`prompt_tokens`,
 * `prompt_eval_count`-- o no lo publica.
 *
 * Lo traduce el ADAPTADOR, que es su trabajo: si lo tradujera la telemetria,
 * habria una tabla `if (provider === 'deepseek')` fuera de la frontera, que es
 * exactamente lo que este contrato existe para impedir.
 *
 * `null` en un campo significa NO LO PUBLICA. Cero significa cero, y no es lo
 * mismo.
 */
export const usage = ({ tokensInput = null, tokensOutput = null, totalTokens = null } = {}) => ({
  tokensInput,
  tokensOutput,
  totalTokens: totalTokens ?? (tokensInput == null && tokensOutput == null ? null : (tokensInput ?? 0) + (tokensOutput ?? 0)),
});

/** SALIDA normalizada. Todos los adaptadores devuelven esto. */
export const executionResult = ({ provider, model, text, ms, raw = null, usage: uso = null }) => ({
  provider, model, text, ms, raw, usage: uso,
});

/** Las seis operaciones del puerto. Un adaptador que no las tenga NO es un adaptador. */
export const OPERACIONES = ['probe', 'invoke', 'stream', 'cancel', 'capabilities', 'normalize'];

export function assertConforms(adapter) {
  const faltan = OPERACIONES.filter((op) => typeof adapter?.[op] !== 'function');
  if (faltan.length) {
    throw new AdapterError(
      ErrorCode.PROVIDER_FAILURE, adapter?.name ?? '(anonimo)',
      `no implementa el contrato del puerto: falta ${faltan.join(', ')}`,
    );
  }
}

/**
 * NEGOCIACION (3.5). Se comprueba ANTES de invocar.
 *
 * Ejecutar esperando que falle despues es peor que no ejecutar: gasta tiempo, deja
 * el sandbox a medias y produce un error de proveedor donde en realidad habia un
 * error de asignacion. Compute ya rechaza por capacidad del MODELO; esto es la
 * otra mitad: lo que el TRANSPORTE puede hacer.
 */
export function negotiate(adapter, req) {
  const caps = adapter.capabilities();
  const faltan = (req.requires ?? []).filter((k) => !caps[k]);
  if (faltan.length) {
    throw new AdapterError(
      ErrorCode.MODEL_UNAVAILABLE, adapter.name,
      `no soporta ${faltan.join(', ')} — se rechaza antes de invocar`,
      { model: req.model },
    );
  }
  if (req.contextTokens && caps.maxContext && req.contextTokens > caps.maxContext) {
    throw new AdapterError(
      ErrorCode.CONTEXT_OVERFLOW, adapter.name,
      `necesita ${req.contextTokens} tokens y el maximo es ${caps.maxContext}`,
      { model: req.model },
    );
  }
  return true;
}

// ── Traductores comunes ─────────────────────────────────────────────────────
// Las mismas senales aparecen en los tres transportes con otra ropa. Tenerlas
// aqui evita que cada adaptador invente su propia tabla y que dos discrepen.

/** HTTP -> ErrorCode. Lo usan las APIs (deepseek) y ollama. */
export function fromHttpStatus(status, cuerpo = '') {
  if (status === 401 || status === 403) return ErrorCode.AUTH_FAILURE;
  if (status === 404) return ErrorCode.MODEL_UNAVAILABLE;
  if (status === 429) return ErrorCode.RATE_LIMIT;
  if (status === 413 || /context.{0,20}(length|window|overflow)|too many tokens/i.test(cuerpo)) {
    return ErrorCode.CONTEXT_OVERFLOW;
  }
  // Un 400 por modelo inexistente NO es un fallo del proveedor: es determinista y
  // reintentarlo es gasto puro. DeepSeek responde 400 —no 404— con
  // "The supported API model names are ... but you passed X", asi que sin mirar el
  // cuerpo se clasificaba como PROVIDER_FAILURE y se reintentaba. Medido, no supuesto.
  if (status === 400 && /model names? are|unknown model|model.{0,15}(not found|does not exist)|you passed/i.test(cuerpo)) {
    return ErrorCode.MODEL_UNAVAILABLE;
  }
  if (status >= 500) return ErrorCode.PROVIDER_FAILURE;
  return ErrorCode.PROVIDER_FAILURE;
}

/**
 * Quita el ECO DEL COMANDO del mensaje de `execFile`.
 *
 * EL DEFECTO, y es de los peores que ha tenido este puerto. `execFile` compone
 * `e.message` como «Command failed: <la linea de comando entera>» -- y para un
 * CLI de modelo, la linea de comando ES EL PROMPT. Asi que `fromNativeError`
 * estaba clasificando el fallo leyendo el prompt.
 *
 * No es cosmetico: la clasificacion decide si se REINTENTA. Un prompt que
 * mencione «timeout» convierte un `exit=1` determinista en TIMEOUT, que si se
 * reintenta -- y uno que mencione «api key» convertiria un fallo transitorio en
 * AUTH_FAILURE, que no. El harness escribe prompts SOBRE timeouts, claves y
 * modelos ausentes: la clase de texto que peor se puede meter en este regex.
 *
 * MEDIDO en H-20260818-e2d1204e y -a1e53ddb: dos vueltas informaron TIMEOUT
 * sobre un `exit=1` sin stderr, gastaron los dos intentos (209 s cada uno) y
 * mandaron a diagnosticar un techo de tiempo que nunca se toco.
 *
 * El `stderr` SI se lee: eso lo escribe el proveedor. Lo que no se lee es lo que
 * escribimos nosotros.
 */
export function sinEcoDelComando(mensaje) {
  const m = String(mensaje ?? '');
  if (!m.startsWith('Command failed:')) return m;
  const i = m.indexOf('\n');
  return i < 0 ? '' : m.slice(i + 1);
}

/** Error de proceso/red -> ErrorCode. Lo usan los CLIs y fetch. */
/**
 * `fetch` de node NO deja el fallo en el mensaje: envuelve todo error de
 * conexion en un `TypeError: fetch failed` generico y pone la causa real en
 * `e.cause` -- `UND_ERR_HEADERS_TIMEOUT`, `ECONNREFUSED`, `ECONNRESET`.
 *
 * MEDIDO en H-20260821-54e6667b: las tres pasadas de refutacion murieron y la
 * etapa 10 registro «fallo al invocar ollama: [PROVIDER_FAILURE] fetch failed»
 * TRES VECES. Ni el codigo ni el mensaje nombraban un techo de tiempo, y el
 * techo de tiempo era exactamente la causa. Diez minutos de vuelta perdidos y
 * un diagnostico que apuntaba a un proveedor caido que estaba vivo.
 *
 * Es el mismo modo de fallo que ya esta en memoria: un mensaje que describe mal
 * su causa mantiene abierto el defecto que nombra.
 */
export const conCausa = (e) => {
  const c = e?.cause;
  if (!c) return e?.message ?? String(e);
  const partes = [c.name, c.code, c.message].filter(Boolean).join(' ');
  return partes ? `${e.message} (causa: ${partes})` : (e?.message ?? String(e));
};

export function fromNativeError(e) {
  // TAMBIEN aqui `sinEcoDelComando`. Estaba en la comprobacion de abajo y no en
  // esta, que es justo la que decide TIMEOUT -- el codigo que SI se reintenta.
  // Arreglar una de las dos lecturas del mensaje y no la otra dejaba el defecto
  // exactamente donde mas caro era. Lo encontro el test, no la relectura.
  const msg = sinEcoDelComando(e?.message);
  // LA CAUSA SE LEE. Sin esto un techo de tiempo de undici se clasifica
  // PROVIDER_FAILURE, que es otra cosa y se trata distinto.
  const c = e?.cause;
  const causa = `${c?.name ?? ''} ${c?.code ?? ''} ${c?.message ?? ''}`;
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError' || e?.killed
      || /ETIMEDOUT|timed? ?out/i.test(msg)
      || /UND_ERR_(HEADERS|BODY)_TIMEOUT|ETIMEDOUT|timed? ?out/i.test(causa)) {
    return ErrorCode.TIMEOUT;
  }
  if (e?.code === 'ENOENT') return ErrorCode.MODEL_UNAVAILABLE;
  // `msg` ya viene sin el eco: sin eso, el clasificador lee el PROMPT. Ver arriba.
  const t = `${e?.stderr ?? ''} ${msg}`;
  if (/unauthorized|forbidden|api key|not authenticated|login/i.test(t)) return ErrorCode.AUTH_FAILURE;
  if (/rate.?limit|too many requests/i.test(t)) return ErrorCode.RATE_LIMIT;
  if (/context.{0,20}(length|window)|too many tokens/i.test(t)) return ErrorCode.CONTEXT_OVERFLOW;
  if (/not found|unknown model|no such model/i.test(t)) return ErrorCode.MODEL_UNAVAILABLE;
  return ErrorCode.PROVIDER_FAILURE;
}

/**
 * `stream()` por defecto para quien no sabe transmitir: invoca y emite una sola
 * vez. Es honesto —`capabilities().streaming` dice false— y evita que cada
 * adaptador reimplemente el mismo apaño.
 */
export async function* streamViaInvoke(adapter, req) {
  yield (await adapter.invoke(req.prompt, req)).text ?? '';
}
