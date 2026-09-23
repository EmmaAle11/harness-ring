// Ejecuta los scanners DENTRO del workspace y normaliza lo que devuelven.
//
// Lo que NO se puede ejecutar se declara `MISSING`, nunca `PASS`. Es la regla #0
// aplicada a seguridad: un control que no corrio no es un control aprobado, y un
// informe que los confunde es peor que no tener informe -- porque se firma.
//
// El SCOPE por defecto son los ficheros que la vuelta MODIFICO. Escanear el
// arbol entero en cada vuelta convierte el hallazgo de esta corrida en una aguja
// dentro de la deuda historica, y la deuda historica ya la mide el gate.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { HARNESS, ROOT } from './capabilities.mjs';
import { ENV_LIMPIO } from './sandbox.mjs';
import { sinSecretos } from './trace.mjs';
import { deSemgrep, deNpmAudit, deSecretos } from './security.mjs';

const run = promisify(execFile);

export const loadSecurityPolicy = () =>
  JSON.parse(readFileSync(join(HARNESS, 'policy', 'security.json'), 'utf8'));

export const REGLAS = join(HARNESS, 'security', 'rules.yaml');

/** Un control que no se pudo ejecutar. Se DECLARA, con el motivo. */
const ausente = (control, why) => ({ control, status: 'MISSING', why, findings: [] });

/**
 * SAST sobre los ficheros que la vuelta toco.
 *
 * semgrep con reglas LOCALES: `--config auto` las baja de un registro remoto, y
 * una puerta cuyo criterio cambia sin que nadie lo commitee no es una puerta.
 * `--metrics=off` porque el codigo de un cliente no viaja a un servidor ajeno.
 */
export async function sast(ws, ficheros, policy) {
  const objetivos = (ficheros ?? []).filter((f) => /\.(ts|tsx|js|jsx|mjs)$/.test(f));
  if (!objetivos.length) return ausente('sast', 'la vuelta no modifico ningun fichero de codigo');
  if (!existsSync(REGLAS)) return ausente('sast', `sin reglas en ${REGLAS}`);

  try {
    const { stdout } = await run(
      'semgrep',
      ['--config', REGLAS, '--json', '--quiet', '--metrics=off', '--no-git-ignore', ...objetivos],
      { cwd: ws.path, env: ENV_LIMPIO(), timeout: 600000, maxBuffer: 64 * 1024 * 1024 },
    ).catch((e) => {
      // semgrep sale != 0 cuando ENCUENTRA algo. Eso no es un fallo del control:
      // es el control funcionando, y tratarlo como error lo apagaria justo
      // cuando sirve.
      if (e.stdout) return { stdout: e.stdout };
      throw e;
    });
    const j = JSON.parse(stdout);

    // UN FICHERO QUE NO SE PUEDE PARSEAR NO ES UN FICHERO LIMPIO.
    //
    // Lo midio la primera corrida de H-002: la semilla vulnerable estaba en un
    // `.ts` con JSX dentro, semgrep no la parseo, y el control devolvio CERO
    // hallazgos sobre un fichero deliberadamente inseguro. Cero por no mirar y
    // cero por no haber nada se leen igual, y esa es la forma exacta del defecto
    // que la Fase 9 cerro en la revision: el silencio pasando por respuesta.
    //
    // Se emite un hallazgo por fichero no cubierto. No bloquea -- es una laguna
    // de cobertura, no una vulnerabilidad -- pero deja de ser invisible.
    // La ruta no esta donde parece: semgrep la anida dentro de
    // `type: ["PartialParsing", [{path, start, end}]]`, y en otras versiones la
    // pone en `e.path`. Se busca por ESTRUCTURA en vez de por campo, que es lo
    // unico estable entre versiones de una herramienta que no controlamos.
    const rutaDe = (x) => {
      if (!x || typeof x !== 'object') return [];
      if (typeof x.path === 'string') return [x.path];
      return Object.values(x).flatMap(rutaDe);
    };
    const rotos = [...new Set((j.errors ?? [])
      .filter((e) => /syntax|parsing|parse/i.test(JSON.stringify(e.type ?? e.message ?? '')))
      .flatMap(rutaDe))];

    return {
      control: 'sast', status: 'RAN', tool: 'semgrep',
      scanned: objetivos.length,
      unparsed: rotos.length,
      unparsedPaths: rotos,
      findings: [
        ...deSemgrep(j, policy),
        ...rotos.map((p, i) => ({
          id: `sast-cobertura:${i + 1}`,
          source: 'sast', tool: 'semgrep', rule: 'fichero-no-analizado',
          severity: 'P4', rawSeverity: 'low', confidence: 'CONFIRMED',
          path: p, location: '-',
          evidence: 'semgrep no pudo parsear el fichero',
          impact: 'este fichero NO esta cubierto por el SAST: cero hallazgos aqui no significa que este limpio',
          remediation: 'comprueba la extension (JSX exige .tsx) o excluyelo explicitamente',
          status: 'OPEN',
        })),
      ],
    };
  } catch (e) {
    return ausente('sast', `semgrep no se pudo ejecutar: ${String(e.message).slice(0, 160)}`);
  }
}

/**
 * SCA — `npm audit` en el ambito que la vuelta toco.
 *
 * No se instala nada: npm ES el inventario de dependencias de este repo y su
 * base de avisos es la misma que consulta cualquier herramienta encima.
 */
export async function sca(ws, policy, { scope = 'fe' } = {}) {
  const dir = scope === 'be' ? join(ws.path, 'backend') : ws.path;
  if (!existsSync(join(dir, 'package.json'))) return ausente(`sca:${scope}`, `sin package.json en ${scope}`);

  try {
    const { stdout } = await run('npm', ['audit', '--json'], {
      cwd: dir, env: ENV_LIMPIO(), timeout: 300000, maxBuffer: 64 * 1024 * 1024,
    }).catch((e) => (e.stdout ? { stdout: e.stdout } : Promise.reject(e)));
    return {
      control: `sca:${scope}`, status: 'RAN', tool: 'npm audit',
      findings: deNpmAudit(JSON.parse(stdout), policy, { scope }),
    };
  } catch (e) {
    return ausente(`sca:${scope}`, `npm audit fallo: ${String(e.message).slice(0, 160)}`);
  }
}

/** Los ficheros que, si cambian, cambian el grafo de dependencias. */
export const MANIFIESTOS = [
  'package.json', 'package-lock.json',
  'backend/package.json', 'backend/package-lock.json',
];

/**
 * Los manifiestos que la vuelta tocó. PURO, y exportado para poder probarlo: es la
 * decision de la que depende que el SBOM del arbol principal siga describiendo
 * este cambio, y probarla exigiendo `npm sbom` seria un test de tres minutos.
 */
export const manifiestosTocados = (files) =>
  (files ?? []).filter((f) => MANIFIESTOS.includes(f));

const generarSbom = (cwd) =>
  run('npm', ['sbom', '--sbom-format', 'cyclonedx'], {
    cwd, env: ENV_LIMPIO(), timeout: 300000, maxBuffer: 64 * 1024 * 1024,
  }).then(({ stdout }) => JSON.parse(stdout));

/**
 * SBOM — CycloneDX, y con su ALCANCE declarado.
 *
 * `npm sbom` NO puede correr dentro del workspace, y la causa esta medida: el
 * worktree enlaza `node_modules` del arbol principal en vez de copiar 1 GB, y npm
 * no reconstruye su arbol virtual a traves de ese enlace --
 * `ESBOMPROBLEMS: missing @asamuzakjp/generational-cache`, sobre un paquete que
 * esta ahi. No lo arregla ningun flag: `--omit=optional`, `--omit=dev` y
 * `--package-lock-only` fallan igual, y el ultimo falla TAMBIEN en un directorio
 * limpio con solo los dos manifiestos, porque el propio lockfile declara
 * opcionales de plataforma (`@tailwindcss/oxide-wasm32-wasi`) que npm cuenta como
 * ausentes.
 *
 * EL RAZONAMIENTO, que es lo que hace honesto el fallback: un SBOM describe el
 * GRAFO DE DEPENDENCIAS, y ese grafo es funcion de `package.json` +
 * `package-lock.json` -- no del `node_modules` de quien lo genera. Si la vuelta no
 * toco esos ficheros, el del arbol principal es el mismo POR CONSTRUCCION, y decir
 * de donde salio es lo que impide que sea una segunda autoridad.
 *
 * Si la vuelta SI los toco, el del arbol principal ya no la describe y sale
 * `MISSING` con ese motivo. Un SBOM del arbol equivocado firmado como si fuera el
 * de la vuelta seria peor que no tenerlo.
 */
export async function sbom(ws, { files = [] } = {}) {
  const tocados = manifiestosTocados(files);

  const ok = (j, scope, why) => ({
    control: 'sbom', status: 'RAN', tool: 'npm sbom',
    format: `${j.bomFormat} ${j.specVersion}`,
    components: (j.components ?? []).length,
    scope, ...(why ? { why } : {}), findings: [],
  });

  try {
    return ok(await generarSbom(ws.path), 'workspace');
  } catch (eWs) {
    if (tocados.length) {
      return ausente('sbom', `npm sbom no corre en el workspace (${String(eWs.message).slice(0, 90)}) `
        + `y la vuelta modifico ${tocados.join(', ')}: el SBOM del arbol principal ya NO describe este cambio`);
    }
    try {
      return ok(await generarSbom(ROOT), 'main-tree',
        'generado en el arbol principal: npm sbom no corre bajo el node_modules enlazado del worktree. '
        + `Valido para esta vuelta porque NO toco ninguno de ${MANIFIESTOS.join(', ')}, `
        + 'asi que su grafo de dependencias es identico.');
    } catch (eRoot) {
      return ausente('sbom', `npm sbom fallo en el workspace y en el arbol principal: ${String(eRoot.message).slice(0, 120)}`);
    }
  }
}

/** Secretos, sobre el DIFF de la vuelta: es lo que esta corrida anadio. */
export function secretos(diff, policy) {
  const h = sinSecretos(String(diff ?? ''));
  return { control: 'secrets', status: 'RAN', tool: 'harness', findings: deSecretos(h, policy) };
}

/** Container scanning — no aplica: el harness no construye ni despliega imagenes. */
export const container = () =>
  ausente('container', 'el harness no construye imagenes; declarar un escaneo de contenedor seria firmar un control que no existe');

/**
 * Corre todo lo que se puede correr y devuelve controles + hallazgos.
 * NO decide: eso es `aplicarPolitica`. Aqui solo se mide.
 */
export async function escanear(ws, { files = [], diff = '', policy = loadSecurityPolicy(), scopes = ['fe'] } = {}) {
  const controles = await Promise.all([
    sast(ws, files, policy),
    ...scopes.map((s) => sca(ws, policy, { scope: s })),
    sbom(ws, { files }),
    Promise.resolve(secretos(diff, policy)),
    Promise.resolve(container()),
  ]);
  return { controles, findings: controles.flatMap((c) => c.findings ?? []) };
}

/** Resumen por control para el SecurityReport, con `MISSING` bien visible. */
export const resumen = (controles) =>
  Object.fromEntries(controles.map((c) => [c.control, c.status === 'RAN' ? 'RAN' : 'MISSING']));

export { ROOT };
