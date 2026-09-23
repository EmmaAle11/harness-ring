// Registro de puertos de SALIDA.
//
// Solo se registran los proveedores que se pueden PROBAR. `codex` sigue
// declarado en policy/router.json como `unavailable` y NO tiene adaptador:
// escribir codigo para algo que no se puede ejecutar produce un mecanismo que
// parece existir y no existe.
//
// `gemini` se dio de alta el 2026-08-27, y no por completismo: sin una TERCERA
// familia la refutacion adversarial no puede existir -- quien refuta no puede
// compartir familia con quien escribio los hallazgos, y el revisor los escribe.
// Medido en tres corridas del anillo, la etapa 5 paraba en `refutacion
// DEGRADADA · sin tercera familia viva`.
//
// Darlos de alta = poner la clave y anadir ~30 lineas con este mismo contrato.
import * as ollama from './ollama.mjs';
import * as claude from './claude.mjs';
import * as opencode from './opencode.mjs';
import * as deepseek from './deepseek.mjs';
import * as gemini from './gemini.mjs';
import {
  AdapterError, ErrorCode, assertConforms, executionRequest, negotiate,
} from './contract.mjs';
import { registrar } from '../../lib/telemetry.mjs';

export const PROVIDERS = { claude, deepseek, gemini, ollama, opencode };

/** Prueba todos en paralelo. La disponibilidad la dice la maquina, no el JSON. */
export async function probeAll() {
  const entries = await Promise.all(
    Object.entries(PROVIDERS).map(async ([id, p]) => [id, await p.probe()]),
  );
  return Object.fromEntries(entries);
}

export const aliveSet = (probes) =>
  new Set(Object.entries(probes).filter(([, r]) => r.alive).map(([id]) => id));

// ollama reporta `x:latest` para lo que se pidio como `x`. Las dos formas son el
// mismo modelo y el router puede nombrarlo de cualquiera de las dos.
const variantes = (n) => (n.endsWith(':latest') ? [n, n.slice(0, -':latest'.length)] : [n, `${n}:latest`]);

/**
 * Inventario de modelos por proveedor, para los que lo publican.
 *
 * `probe()` de ollama y deepseek ya devolvia `models` y nadie lo miraba: el
 * router daba por bueno cualquier modelo mientras el PROVEEDOR respondiera, asi
 * que una entrada nueva en router.json podia prometer un modelo sin descargar y
 * el fallo aparecia como un 404 en mitad de la vuelta.
 *
 * claude y opencode son CLIs y no enumeran. No aparecen aqui, y por tanto sus
 * modelos NO se filtran: no poder comprobarlo no es lo mismo que saber que falta.
 */
export const modelSet = (probes) => new Map(
  Object.entries(probes)
    .filter(([, r]) => r.alive && Array.isArray(r.models))
    .map(([id, r]) => [id, new Set(r.models.flatMap(variantes))]),
);

/**
 * UNICO punto de entrada a un proveedor. Aqui pasa todo: se comprueba que el
 * adaptador cumple el contrato, se NEGOCIA antes de invocar y se normaliza el
 * fallo. Que un llamante pueda saltarse esto invocando `PROVIDERS.x.invoke()`
 * directamente es exactamente como se cuelan comportamientos por proveedor.
 *
 * Devuelve un ExecutionResult; lanza siempre un AdapterError con `code`.
 */
export async function invoke({ provider, model, modelClass }, prompt, opts = {}) {
  const p = PROVIDERS[provider];
  if (!p) {
    throw new AdapterError(
      ErrorCode.MODEL_UNAVAILABLE, provider ?? '(sin proveedor)',
      'proveedor sin adaptador. Declarado != cableado.', { model },
    );
  }
  assertConforms(p);

  // LA CLASE VIAJA CON LA ASIGNACION. Compute ya la resolvio (`modelClass`), y
  // sin pasarla aqui `policy/temperatura.mjs` no puede gobernar nada: el
  // adaptador caeria siempre al valor por defecto. `opts.clase` gana, para que
  // un llamante pueda forzarla en una llamada suelta.
  const req = executionRequest({ clase: modelClass, ...opts, prompt, model });
  negotiate(p, req);                       // rechaza ANTES de gastar la invocacion

  // LA TELEMETRIA SE TOMA AQUI porque aqui pasa TODO. Ponerla en cada llamante
  // -- el bucle agentico, `invokeCapability`, las tres pasadas adversariales --
  // daria tres contabilidades que discrepan, y la primera que alguien olvide
  // hace que un proveedor parezca gratis.
  //
  // Se registran tambien los FALLOS: una invocacion que revienta tras 90
  // segundos ha costado esos 90 segundos, y contarla como cero es justo lo que
  // hace parecer barato a un proveedor que falla.
  const t0 = Date.now();
  try {
    const r = await p.invoke(prompt, { ...opts, model });
    registrar({ provider, model, ms: r.ms ?? Date.now() - t0, usage: r.usage ?? null, ok: true });
    return r;
  } catch (e) {
    const err = p.normalize(e);            // nada cruza la frontera sin `code`
    registrar({ provider, model, ms: Date.now() - t0, ok: false, code: err.code });
    throw err;
  }
}

/** Reintenta SOLO lo que no es determinista. Una clave mala no mejora al repetirla. */
export async function invokeWithRetry(asignacion, prompt, opts = {}, intentos = 2) {
  let ultimo;
  for (let i = 0; i < intentos; i++) {
    try {
      return await invoke(asignacion, prompt, opts);
    } catch (e) {
      ultimo = e;
      if (!e.retryable) throw e;
    }
  }
  throw ultimo;
}
