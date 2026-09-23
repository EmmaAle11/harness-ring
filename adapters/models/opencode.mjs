// Puerto de SALIDA — OpenCode, via su CLI.
//
// Aportaba un TERCER proveedor, y eso importaba mas de lo que parece: ADR-003
// exige que el revisor use un proveedor distinto del que escribio.
//
// MEDIDO el 2026-08-14: su backend real es `deepseek-v4-flash-free`. Para ADR-003
// NO es independiente de deepseek -- por eso `catalog.json` lo pone en la familia
// `deepseek` y Compute lo veta cuando el escritor ya uso esa familia. Sigue aqui
// porque como CLI agentico si aporta algo distinto; como diversidad, no.
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import {
  AdapterError, ErrorCode, executionResult, fromNativeError, streamViaInvoke,
} from './contract.mjs';

const run = promisify(execFile);
export const name = 'opencode';

export const capabilities = () => ({
  tool_calling: true,
  // Escribe para una terminal: limpiamos ANSI, pero no se puede garantizar forma.
  // Declararlo false es lo que hace que Compute lo rechace para `review` ANTES de
  // invocarlo, en vez de descubrirlo al parsear.
  structured_output: false,
  streaming: false,
  long_context: true,
  agentic: true,
  enumeratesModels: false,
  maxContext: 128000,
});

export const normalize = (e) =>
  e instanceof AdapterError ? e : new AdapterError(fromNativeError(e), name, (e?.stderr || e?.message || String(e)).slice(0, 300), { cause: e });

export async function probe() {
  try {
    const { stdout } = await run('opencode', ['--version'], { timeout: 10000 });
    return { alive: true, detail: stdout.trim() };
  } catch (e) {
    return { alive: false, detail: e.code === 'ENOENT' ? 'CLI no instalado' : e.message };
  }
}

/**
 * `execFile` dejaba stdin abierto como pipe y opencode se quedaba esperando
 * entrada que nunca llegaba: la invocacion colgaba hasta el timeout aunque el
 * mismo comando funcionara desde una shell. Con `spawn` y stdin en 'ignore' el
 * CLI ve su entrada cerrada y responde.
 *
 * Se limpian ademas los codigos ANSI: opencode escribe para una terminal, y un
 * revisor que devuelve JSON con secuencias de escape dentro produce un parseo
 * que falla por una razon que no tiene nada que ver con el contenido.
 */
export async function invoke(prompt, { model, timeoutMs = 600000, signal, cwd } = {}) {
  const args = ['run'];
  if (model && model !== 'default') args.push('--model', model);
  args.push(prompt);
  const t0 = Date.now();

  return new Promise((resolve, reject) => {
    // `cwd`: opencode es agentico y trae sus propias tools. Mismo motivo que en
    // claude.mjs -- si hay sandbox, se corre dentro de el.
    const p = spawn('opencode', args, { stdio: ['ignore', 'pipe', 'pipe'], signal, ...(cwd ? { cwd } : {}) });
    let out = '', err = '';
    const t = setTimeout(() => {
      p.kill('SIGKILL');
      reject(new AdapterError(ErrorCode.TIMEOUT, name, `sin respuesta en ${timeoutMs}ms`, { model }));
    }, timeoutMs);

    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => { clearTimeout(t); reject(normalize(e)); });
    p.on('close', (code) => {
      clearTimeout(t);
      if (code !== 0) {
        return reject(new AdapterError(fromNativeError({ stderr: err }), name, `exit ${code} ${err.slice(0, 300)}`, { model }));
      }
      const text = out.replace(/?\[[0-9;]*m/g, '').trim();
      if (!text) return reject(new AdapterError(ErrorCode.INVALID_OUTPUT, name, 'respuesta vacia', { model }));
      resolve(executionResult({ provider: name, model: model ?? 'default', text, ms: Date.now() - t0 }));
    });
  });
}

export const stream = (req) => streamViaInvoke({ name, invoke, capabilities }, req);
export const cancel = (controller) => controller?.abort?.();
