// node --test harness/adapters/models/
//
// El contrato del puerto, probado SIN red y SIN modelo. Lo que se comprueba es
// que los cuatro adaptadores sean intercambiables para quien decide: misma forma
// de entrada, misma de salida y mismos codigos de fallo. Un harness que trata
// distinto a cada proveedor no tiene puertos, tiene cuatro casos particulares.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PROVIDERS } from './index.mjs';
import {
  AdapterError, ErrorCode, OPERACIONES, REINTENTABLES,
  assertConforms, executionRequest, executionResult, usage, negotiate, sinEcoDelComando,
  fromHttpStatus, fromNativeError, conCausa,
} from './contract.mjs';

// ── 3.1 · Contrato unico ────────────────────────────────────────────────────
test('los cinco adaptadores implementan las SEIS operaciones', () => {
  // La lista es EXACTA a proposito: dar de alta un proveedor sin pasar por aqui
  // es como se cuela un adaptador que no cumple el contrato. `gemini` entro el
  // 2026-08-27 como TERCERA FAMILIA -- sin ella la refutacion adversarial no
  // puede existir, porque quien refuta no puede compartir familia con quien
  // escribio los hallazgos y el revisor los escribe.
  assert.deepEqual(Object.keys(PROVIDERS).sort(), ['claude', 'deepseek', 'gemini', 'ollama', 'opencode']);
  for (const [id, p] of Object.entries(PROVIDERS)) {
    assert.doesNotThrow(() => assertConforms(p), `'${id}' no cumple el contrato`);
    for (const op of OPERACIONES) {
      assert.equal(typeof p[op], 'function', `'${id}' no expone '${op}()'`);
    }
  }
});

test('un adaptador incompleto se rechaza al usarlo, no al fallar', () => {
  const cojo = { name: 'cojo', probe: () => {}, invoke: () => {} };
  assert.throws(() => assertConforms(cojo), (e) =>
    e instanceof AdapterError && e.code === ErrorCode.PROVIDER_FAILURE && /falta stream, cancel/.test(e.message));
});

test('capabilities() declara lo mismo para todos: forma comun, valores propios', () => {
  const claves = ['tool_calling', 'structured_output', 'streaming', 'long_context', 'maxContext'];
  for (const [id, p] of Object.entries(PROVIDERS)) {
    const c = p.capabilities();
    for (const k of claves) assert.notEqual(c[k], undefined, `'${id}' no declara '${k}'`);
    assert.equal(typeof c.maxContext, 'number', `'${id}': maxContext debe ser un numero`);
  }
});

test('quien no sabe transmitir lo DECLARA en vez de fingirlo', () => {
  assert.equal(PROVIDERS.claude.capabilities().streaming, false, 'el CLI va por lote');
  assert.equal(PROVIDERS.opencode.capabilities().streaming, false);
  assert.equal(PROVIDERS.ollama.capabilities().streaming, true);
});

// ── 3.2 · Entrada y salida normalizadas ─────────────────────────────────────
test('ExecutionRequest exige prompt: una peticion vacia no llega al proveedor', () => {
  assert.throws(() => executionRequest({ model: 'x' }), (e) => e.code === ErrorCode.INVALID_OUTPUT);
  const r = executionRequest({ prompt: 'hola', model: 'x' });
  assert.equal(r.timeoutMs, 600000);
  assert.deepEqual(r.requires, []);
});

test('ExecutionResult tiene la misma forma venga de donde venga', () => {
  const r = executionResult({ provider: 'ollama', model: 'q', text: 'ok', ms: 12 });
  assert.deepEqual(Object.keys(r).sort(), ['model', 'ms', 'provider', 'raw', 'text', 'usage']);
  assert.equal(r.raw, null, 'sin datos crudos, el campo existe igual: la forma no depende del proveedor');
  assert.equal(r.usage, null, 'y `usage` tambien: no publicarlo es un estado, no la ausencia del campo');
});

// El USO lo traduce el ADAPTADOR. Si lo tradujera la telemetria habria una tabla
// `if (provider === 'deepseek')` fuera de la frontera, que es exactamente lo que
// este contrato existe para impedir.
test('usage() normaliza y NUNCA convierte "no lo publica" en cero', () => {
  assert.deepEqual(usage(), { tokensInput: null, tokensOutput: null, totalTokens: null });
  assert.equal(usage({ tokensInput: 100, tokensOutput: 20 }).totalTokens, 120, 'el total se deriva si falta');
  assert.equal(usage({ totalTokens: 7 }).totalTokens, 7, 'y no se recalcula si viene');
  assert.equal(usage({ tokensInput: 0, tokensOutput: 0 }).totalTokens, 0, 'cero medido SI es cero');
});

// ── 3.3 · Errores normalizados ──────────────────────────────────────────────
test('HTTP se traduce a los codigos del harness', () => {
  assert.equal(fromHttpStatus(401), ErrorCode.AUTH_FAILURE);
  assert.equal(fromHttpStatus(403), ErrorCode.AUTH_FAILURE);
  assert.equal(fromHttpStatus(404), ErrorCode.MODEL_UNAVAILABLE);
  assert.equal(fromHttpStatus(429), ErrorCode.RATE_LIMIT);
  assert.equal(fromHttpStatus(500), ErrorCode.PROVIDER_FAILURE);
  assert.equal(fromHttpStatus(400, 'context length exceeded'), ErrorCode.CONTEXT_OVERFLOW);
});

test('un 400 por modelo inexistente NO es reintentable', () => {
  // Cuerpo REAL de DeepSeek, capturado el 2026-08-14. Responde 400 y no 404, asi
  // que sin mirar el cuerpo caia en PROVIDER_FAILURE y se reintentaba un fallo
  // determinista. Se descubrio provocandolo, no leyendo la documentacion.
  const real = '{"error":{"message":"The supported API model names are deepseek-v4-pro or '
    + 'deepseek-v4-flash, but you passed no-existe.","type":"invalid_request_error"}}';
  assert.equal(fromHttpStatus(400, real), ErrorCode.MODEL_UNAVAILABLE);
  assert.equal(new AdapterError(fromHttpStatus(400, real), 'deepseek', 'x').retryable, false);
  // Un 400 cualquiera sigue siendo fallo de proveedor: no se generaliza de mas.
  assert.equal(fromHttpStatus(400, 'bad request'), ErrorCode.PROVIDER_FAILURE);
});

test('entrada demasiado grande y salida cortada son sucesos OPUESTOS', () => {
  // Se marcaban los dos CONTEXT_OVERFLOW, que no se reintenta. Correcto para la
  // entrada —repetir un prompt que no cabe da lo mismo— y falso para la salida:
  // ahi el prompt cabia, y el reintento puede pedir una respuesta mas corta.
  // Medido en H-20260816-bebf4372: 7,5 KB de diff, vuelta muerta en Validation
  // sin segundo intento.
  assert.equal(new AdapterError(ErrorCode.CONTEXT_OVERFLOW, 'x', 'no cabe').retryable, false);
  assert.equal(new AdapterError(ErrorCode.OUTPUT_TRUNCATED, 'x', 'se corto').retryable, true);
  assert.notEqual(ErrorCode.OUTPUT_TRUNCATED, ErrorCode.CONTEXT_OVERFLOW);
});

test('los fallos de proceso y de red se traducen igual que los HTTP', () => {
  assert.equal(fromNativeError({ name: 'TimeoutError' }), ErrorCode.TIMEOUT);
  assert.equal(fromNativeError({ killed: true }), ErrorCode.TIMEOUT);
  assert.equal(fromNativeError({ code: 'ENOENT' }), ErrorCode.MODEL_UNAVAILABLE);
  assert.equal(fromNativeError({ stderr: 'Invalid API key' }), ErrorCode.AUTH_FAILURE);
  assert.equal(fromNativeError({ message: 'rate limit reached' }), ErrorCode.RATE_LIMIT);
  assert.equal(fromNativeError({ message: 'unknown model foo' }), ErrorCode.MODEL_UNAVAILABLE);
  assert.equal(fromNativeError({ message: 'algo raro' }), ErrorCode.PROVIDER_FAILURE);
});

test('normalize() de CADA adaptador produce un AdapterError con code', () => {
  for (const [id, p] of Object.entries(PROVIDERS)) {
    const e = p.normalize(new Error('boom'));
    assert.ok(e instanceof AdapterError, `'${id}' no normaliza`);
    assert.ok(Object.values(ErrorCode).includes(e.code), `'${id}': code '${e.code}' fuera del catalogo`);
    assert.equal(e.provider, id);
  }
});

test('normalize() no re-envuelve lo que ya viene normalizado', () => {
  const ya = new AdapterError(ErrorCode.TIMEOUT, 'ollama', 'x');
  assert.equal(PROVIDERS.ollama.normalize(ya), ya);
});

test('solo se reintenta lo NO determinista', () => {
  // Reintentar una clave mala es gastar tiempo en un fallo que no cambia.
  assert.equal(new AdapterError(ErrorCode.TIMEOUT, 'x', 'd').retryable, true);
  assert.equal(new AdapterError(ErrorCode.RATE_LIMIT, 'x', 'd').retryable, true);
  assert.equal(new AdapterError(ErrorCode.AUTH_FAILURE, 'x', 'd').retryable, false);
  assert.equal(new AdapterError(ErrorCode.MODEL_UNAVAILABLE, 'x', 'd').retryable, false);
  assert.equal(new AdapterError(ErrorCode.CONTEXT_OVERFLOW, 'x', 'd').retryable, false);
  assert.ok(!REINTENTABLES.has(ErrorCode.INVALID_OUTPUT));
});

test('el error NUNCA lleva la clave, solo el codigo y un detalle truncado', () => {
  const e = new AdapterError(ErrorCode.AUTH_FAILURE, 'deepseek', 'HTTP 401 unauthorized', { model: 'v4-pro' });
  assert.ok(!/sk-|Bearer|authorization/i.test(e.message));
  assert.match(e.message, /\[AUTH_FAILURE\]/);
});

// ── 3.5 · Negociacion de capacidades ────────────────────────────────────────
test('NEGOCIACION: se rechaza ANTES de invocar, no se espera al fallo', () => {
  const req = executionRequest({ prompt: 'x', model: 'default', requires: ['structured_output'] });
  assert.throws(() => negotiate(PROVIDERS.opencode, req), (e) =>
    e.code === ErrorCode.MODEL_UNAVAILABLE && /no soporta structured_output/.test(e.message));
  // El mismo requisito con un proveedor que si lo soporta pasa.
  assert.equal(negotiate(PROVIDERS.deepseek, req), true);
});

test('NEGOCIACION: un contexto mayor del que cabe se rechaza como CONTEXT_OVERFLOW', () => {
  const req = { ...executionRequest({ prompt: 'x', model: 'haiku' }), contextTokens: 500000 };
  assert.throws(() => negotiate(PROVIDERS.claude, req), (e) => e.code === ErrorCode.CONTEXT_OVERFLOW);
  // ollama declara 262144: cabe lo que a claude no.
  assert.doesNotThrow(() => negotiate(PROVIDERS.ollama, { ...req, contextTokens: 200000 }));
});

test('NEGOCIACION: sin requisitos, nadie se rechaza por capacidad', () => {
  const req = executionRequest({ prompt: 'x', model: 'default' });
  for (const p of Object.values(PROVIDERS)) assert.equal(negotiate(p, req), true);
});

// ── El punto de entrada unico ───────────────────────────────────────────────
test('un proveedor sin adaptador falla con codigo, no con un Error suelto', async () => {
  const { invoke } = await import('./index.mjs');
  await assert.rejects(() => invoke({ provider: 'inventado', model: 'x' }, 'hola'), (e) =>
    e instanceof AdapterError && e.code === ErrorCode.MODEL_UNAVAILABLE);
});

// ── El camino no interactivo, que es el ÚNICO que usa un harness autonomo ────
//
// MEDIDO EN H-20260818-e2d1204e: la vuelta murio en la etapa 4 con
// `[PROVIDER_FAILURE] Warning: no stdin data received in 3s, proceeding without
// it. If piping from a slow command, redirect stdin explicitly` -- el propio CLI
// diciendo el remedio dentro del mensaje de error. El prompt va por argumento,
// asi que stdin no se usa NUNCA, pero `execFile` lo deja abierto como pipe y el
// CLI espera 3 s por invocacion: ~90 s tirados por vuelta de 30 llamadas.
//
// Y el arreglo ya estaba escrito en `opencode.mjs`, para este mismo fallo. Se
// encontro para un adaptador y no se llevo al de al lado.
test('claude invoca su CLI con stdin cerrado, como ya hacia opencode', async () => {
  const { opcionesCLI } = await import('./claude.mjs');
  const o = opcionesCLI({ timeoutMs: 1234 });
  assert.deepEqual(o.stdio, ['ignore', 'pipe', 'pipe'], 'sin esto el CLI espera 3 s a un stdin que no usa');
  assert.equal(o.timeout, 1234);
  assert.equal(o.cwd, undefined, 'sin sandbox no se inventa un cwd');
  assert.equal(opcionesCLI({ cwd: '/ws' }).cwd, '/ws', 'con sandbox, DENTRO del sandbox');
});

test('los dos adaptadores de CLI cierran stdin: el defecto no vuelve por el otro lado', () => {
  for (const f of ['claude.mjs', 'opencode.mjs']) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.match(src, /stdio: \['ignore', 'pipe', 'pipe'\]/, `'${f}' deja stdin abierto`);
  }
});

// ── El clasificador NO lee el prompt ────────────────────────────────────────
//
// `execFile` compone `e.message` como «Command failed: <linea de comando>», y
// para un CLI de modelo la linea de comando ES EL PROMPT. La clasificacion
// decide si se REINTENTA, asi que un prompt que mencione «timeout» convertia un
// `exit=1` determinista en TIMEOUT reintentable.
//
// MEDIDO en H-20260818-e2d1204e y -a1e53ddb: dos vueltas informaron TIMEOUT
// sobre un exit=1 sin stderr y gastaron 209 s por intento persiguiendo un techo
// de tiempo que nunca se toco.
test('un prompt que HABLA de timeouts no convierte el fallo en TIMEOUT', () => {
  const prompt = 'El harness tiene maxWallMs y una llamada puede timed out; revisa la api key';
  const e = { code: 1, stderr: '', message: `Command failed: claude -p ${prompt}` };
  assert.equal(fromNativeError(e), ErrorCode.PROVIDER_FAILURE,
    'lo que escribimos nosotros no puede decidir si se reintenta');
  assert.equal(new AdapterError(fromNativeError(e), 'claude', 'x').retryable, true,
    'PROVIDER_FAILURE si se reintenta, pero por ser del proveedor, no por el texto del prompt');
});

test('el stderr SI se lee: eso lo escribe el proveedor', () => {
  const e = { code: 1, stderr: 'rate limit exceeded', message: 'Command failed: claude -p hola\nrate limit exceeded' };
  assert.equal(fromNativeError(e), ErrorCode.RATE_LIMIT);
});

test('sinEcoDelComando conserva los mensajes que NO son eco', () => {
  assert.equal(sinEcoDelComando('spawn claude ENOENT'), 'spawn claude ENOENT');
  assert.equal(sinEcoDelComando('Command failed: claude -p x'), '', 'sin salto de linea no queda nada util');
  assert.equal(sinEcoDelComando('Command failed: claude -p x\nboom'), 'boom');
  assert.equal(sinEcoDelComando(undefined), '');
});

test('el truncado dice EN QUE se gasto la salida, o declara que no se sabe', () => {
  // MEDIDO en H-20260818-72a39e18: la etapa 9 del rework agoto los 32.768 dos
  // veces con la reduccion por contrato aplicada y la misma entrada que la ronda
  // anterior, que habia pasado. Si el gasto es razonamiento y no respuesta, un
  // contrato mas corto no puede acotarlo -- y sin medirlo no se distingue.
  const src = readFileSync(new URL('./deepseek.mjs', import.meta.url), 'utf8');
  assert.match(src, /completion_tokens_details\?\.reasoning_tokens/);
  // `null` se DECLARA, no se rellena con un cero que se leeria como «no penso».
  assert.match(src, /razonamiento NO REPORTADO/);
});

// ── El techo de tiempo que se clasificaba como proveedor caido ────────────────
//
// MEDIDO en H-20260821-54e6667b: tres pasadas de refutacion, tres veces
// «[PROVIDER_FAILURE] fetch failed», diez minutos de vuelta perdidos y ollama
// VIVO todo el rato --`doctor` lo vio con sus cuatro modelos 21 s despues--.
// `fetch` de node no pone el fallo en el mensaje: lo pone en `e.cause`.

test('un techo de tiempo de undici es TIMEOUT, no PROVIDER_FAILURE', () => {
  const e = new TypeError('fetch failed');
  e.cause = Object.assign(new Error('Headers Timeout Error'), { code: 'UND_ERR_HEADERS_TIMEOUT' });
  assert.equal(fromNativeError(e), ErrorCode.TIMEOUT,
    'sin leer la causa, un techo de tiempo se clasifica como proveedor caido: '
    + 'se diagnostica lo que no es y se trata como lo que no es');
});

test('el mensaje que llega al humano NOMBRA la causa, no dice solo `fetch failed`', () => {
  const e = new TypeError('fetch failed');
  e.cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), { code: 'ECONNREFUSED' });
  const dicho = conCausa(e);
  assert.match(dicho, /ECONNREFUSED/,
    'un mensaje que describe mal su causa mantiene abierto el defecto que nombra');
  assert.match(dicho, /fetch failed/, 'y sin perder lo que ya decia');
});

test('sin causa, `conCausa` no inventa nada', () => {
  assert.equal(conCausa(new Error('se acabo')), 'se acabo');
});
