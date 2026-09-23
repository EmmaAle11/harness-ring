// Puerto de SALIDA — Claude, via su CLI.
//
// Se usa el CLI y no la API a proposito: no hay clave de API en el entorno, y
// el CLI ya esta autenticado. Cablear la API sin poder probarla seria escribir
// un adaptador que no se puede verificar (el-fix-que-no-existe.md).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  AdapterError, ErrorCode, executionResult, fromNativeError, streamViaInvoke,
} from './contract.mjs';

const run = promisify(execFile);
export const name = 'claude';

export const capabilities = () => ({
  tool_calling: true,
  structured_output: true,
  streaming: false,        // el CLI se invoca por lote: se declara, no se finge
  long_context: true,
  agentic: true,
  enumeratesModels: false, // un CLI no enumera: por eso Compute no filtra sus modelos
  maxContext: 200000,
});

/**
 * Ruido de arranque del CLI: avisos que no son la causa de nada.
 *
 * El aviso de stdin lo emite el CLI cuando su entrada no es un TTY -- es decir,
 * SIEMPRE que lo invoca el harness-- y aparece en `stderr` haya fallado lo que
 * haya fallado.
 */
const RUIDO = [/^Warning: no stdin data received/i];

/**
 * El DIAGNOSTICO, no el primer texto que aparezca.
 *
 * Decia `e.stderr || e.message`, y eso le da la palabra al primer aviso que el
 * CLI escupa por stderr. Coste medido: H-20260818-e2d1204e y -a1e53ddb murieron
 * en las etapas 3 y 4 informando «Warning: no stdin data received in 3s», que es
 * un aviso inocuo -- y el fallo REAL (dos llamadas a opus caidas en ~205 s cada
 * una) quedo invisible. Se diagnostico stdin dos veces y se arreglo algo que no
 * era la causa: veinte minutos de modelo gastados en la pista falsa que el propio
 * adaptador ofrecia.
 *
 * Un mensaje de error que antepone un aviso a su causa no es un mensaje pobre:
 * es una pista falsa, y cuesta mas que no tener ninguno.
 *
 * Ahora manda el ESTADO DEL PROCESO -- codigo de salida, senal, si lo matamos --
 * que es lo unico que dice de verdad que paso, y el stderr va detras y sin el
 * ruido conocido. `e.message` de `execFile` NO se usa: empieza por «Command
 * failed: claude -p <el prompt entero>» y volcaria el prompt en el artefacto.
 */
export function detalleDeFallo(e) {
  const estado = [
    `exit=${e?.code ?? '?'}`,
    e?.signal ? `signal=${e.signal}` : null,
    e?.killed ? 'killed' : null,
  ].filter(Boolean).join(' ');

  const err = String(e?.stderr ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !RUIDO.some((re) => re.test(l)))
    .join(' ')
    .slice(0, 240);

  return `${estado}${err ? ` — ${err}` : ' — sin stderr util'}`;
}

export const normalize = (e) =>
  e instanceof AdapterError ? e : new AdapterError(fromNativeError(e), name, detalleDeFallo(e), { cause: e });

export async function probe() {
  try {
    // Misma razon que en `invoke`: sin esto, cada `doctor` y cada Compute pagan
    // los 3 s de espera de stdin antes de saber si el CLI existe.
    const { stdout } = await run('claude', ['--version'], opcionesCLI({ timeoutMs: 10000 }));
    return { alive: true, detail: stdout.trim() };
  } catch (e) {
    return { alive: false, detail: e.code === 'ENOENT' ? 'CLI no instalado' : e.message };
  }
}

export async function invoke(prompt, { model, system, timeoutMs = 600000, signal, cwd } = {}) {
  // El prompt va como ARGUMENTO, no por stdin. `promisify(execFile)` no soporta
  // la opcion `input` -- es de execFileSync -- asi que la version anterior dejaba
  // stdin vacio y el CLI respondia "Input must be provided". Salio en la primera
  // invocacion real de este adaptador: hasta entonces era codigo sin ejecutar.
  const args = ['-p', prompt, '--output-format', 'text'];
  if (model) args.push('--model', model);
  if (system) args.push('--append-system-prompt', system);
  const t0 = Date.now();

  // `cwd`: el CLI de Claude trae sus propias tools y se invocaba desde el
  // directorio del proceso -- el arbol principal. Contener al modelo por la via
  // del harness y dejarle el repositorio entero por la via de su CLI no es
  // contenerlo. Cuando hay sandbox, se corre DENTRO.
  const { stdout } = await run('claude', args, opcionesCLI({ timeoutMs, signal, cwd }))
    .catch((e) => { throw normalize(e); });

  if (!stdout.trim()) throw new AdapterError(ErrorCode.INVALID_OUTPUT, name, 'respuesta vacia', { model });
  return executionResult({ provider: name, model: model ?? 'default', text: stdout, ms: Date.now() - t0 });
}

/**
 * Las opciones del proceso. STDIN EN 'ignore', y no es un detalle.
 *
 * El prompt va por argumento (`-p`), asi que stdin no se usa nunca -- pero
 * `execFile` lo deja abierto como pipe, y el CLI ESPERA 3 SEGUNDOS por si llega
 * algo antes de seguir. Dos consecuencias medidas:
 *
 *  · 3 s de espera pura por invocacion. Con 30 llamadas por vuelta
 *    (H-20260818-2b842dba) son ~90 s tirados en cada corrida.
 *  · Y en contexto NO INTERACTIVO deja de ser un aviso: H-20260818-e2d1204e
 *    murio en la etapa 4 con `[PROVIDER_FAILURE] Warning: no stdin data received
 *    in 3s`, es decir, con el propio CLI diciendo el remedio en el mensaje de
 *    error -- «redirect stdin explicitly».
 *
 * LO PEOR: el arreglo YA ESTABA ESCRITO en `opencode.mjs`, con su comentario
 * explicando este mismo fallo («execFile dejaba stdin abierto como pipe y
 * opencode se quedaba esperando... con stdin en 'ignore' funciona»). Se encontro
 * para un adaptador y no se llevo al de al lado. Tercera vez del mismo patron:
 * la regla existia y no cubria a su hermana
 * (memory/failures/gate-cambiado-consumidores-olvidados.md).
 *
 * Un harness autonomo corre SIEMPRE sin terminal. Que el camino de verdad sea
 * justo el que no se probaba a mano es la forma habitual de este defecto.
 *
 * PURO y exportado para poder fijarlo con un test: comprobarlo a traves de
 * `invoke()` exigiria un CLI y una sesion autenticada.
 */
export const opcionesCLI = ({ timeoutMs = 600000, signal, cwd } = {}) => ({
  timeout: timeoutMs,
  maxBuffer: 32 * 1024 * 1024,
  stdio: ['ignore', 'pipe', 'pipe'],
  ...(signal ? { signal } : {}),
  ...(cwd ? { cwd } : {}),
});

export const stream = (req) => streamViaInvoke({ name, invoke, capabilities }, req);
export const cancel = (controller) => controller?.abort?.();
