// Los 16 handlers del anillo — el mapa que consume el motor.
//
// El motor no sabe que hace cada etapa: recibe este mapa. Cambiar el anillo es
// cambiar el manifiesto y anadir aqui su handler, no tocar ring.mjs.
import { writeFileSync, mkdirSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { redactarSecretos } from './secretos.mjs';
import { ROOT, RUNTIME, loadLearningPolicy } from './capabilities.mjs';
import { capture, decide, provenance } from './learning.mjs';
import { parseFrontmatter } from './frontmatter.mjs';
import { ENV_LIMPIO } from './sandbox.mjs';
import * as D from './stages-deterministic.mjs';
import * as M from './stages-model.mjs';

/** Evidence (15) — empaqueta y corre el gate con el executionId enlazado. */
async function evidencePackage(ctx) {
  const ws = ctx.workspace;
  let verdict = 'UNKNOWN';
  let checks = [];

  // El gate DEL WORKSPACE, no el del arbol principal.
  //
  // Se invocaba `join(ROOT, 'scripts', 'gate.sh')` con `cwd` en el workspace, y no
  // basta: gate.sh calcula su propio ROOT desde BASH_SOURCE y hace `cd` alli, asi
  // que ignoraba el cwd y VALIDABA EL ARBOL PRINCIPAL. La evidencia de la corrida
  // describia un arbol que no contenia el cambio -- y ademas corria vitest y jest
  // en el arbol principal, que es justo lo que el sandbox existe para evitar.
  //
  // Se detecto porque el fichero de evidencia con el executionId de la vuelta
  // aparecio en .harness/evidence/ del arbol principal y no en el del workspace.
  const gateWs = ws?.path ? join(ws.path, 'scripts', 'gate.sh') : join(ROOT, 'scripts', 'gate.sh');
  if (ws?.path && !existsSync(gateWs)) {
    throw new Error(`el workspace no tiene scripts/gate.sh: no se puede validar el cambio aislado`);
  }

  try {
    execFileSync('bash', [gateWs, '--full'], {
      cwd: ws?.path ?? ROOT,
      env: { ...ENV_LIMPIO(), DOXIA_EXECUTION_ID: ctx.executionId },
      stdio: 'pipe', maxBuffer: 32 * 1024 * 1024,
    });
    verdict = 'PASS';
  } catch {
    verdict = 'FAIL';
  }
  checks = Object.values(ctx.artifacts).map((a) => ({ check: a.stage, status: a.status }));

  if (verdict !== 'PASS') throw new Error(`gate --full en rojo dentro del workspace`);

  const sha = D.gitIn(ws?.path, 'rev-parse', '--short', 'HEAD');
  const paquete = {
    sha,
    branch: D.gitIn(ws?.path, 'rev-parse', '--abbrev-ref', 'HEAD'),
    mode: 'full',
    executionId: ctx.executionId,
    verdict,
    checks,
    // DONDE esta la evidencia, no solo que la hay.
    //
    // El gate escribe en el `.harness/evidence/` de SU raiz -- y su raiz es el
    // workspace, no el arbol principal, desde que se corrigio que Evidence2
    // validaba el arbol equivocado. El paquete no lo decia, asi que la etapa 16
    // de H-20260816-b0ae48ef fue a buscarlo al arbol principal, no lo encontro y
    // CONCLUYO que la vuelta no habia persistido nada -- con un `verdict: PASS`
    // delante. El fichero existia; lo que faltaba era el puntero.
    //
    // Regla #0 dice «sin evidencia no hay avance». Un veredicto que no dice donde
    // esta su evidencia obliga a cada consumidor a adivinar la raiz, y adivinar
    // mal se parece demasiado a no tenerla.
    evidencePath: rutaDeEvidencia(ws?.path, sha),
    // Y el CONTENIDO, no solo la ruta. `checks` son los estados de las 16 etapas;
    // el detalle del gate -- que tests corrieron, con que piso, que quedo MISSING --
    // vivia unicamente dentro del workspace, que no forma parte de
    // `.harness/runs/<id>/`. Reconstruir la corrida desde su directorio dejaba
    // `tests` vacio: cierto, y un hueco. Se embebe aqui.
    gateChecks: leerGateChecks(rutaDeEvidencia(ws?.path, sha)),
    findings: ctx.artifacts?.Convergence?.payload ?? null,
    models: ctx.artifacts?.AdapterLayer?.payload?.bindings ?? [],
  };

  // `release` es el DUENO declarado de esta etapa y no se invocaba nunca: Compute
  // le asignaba un modelo que jamas se usaba, y FT-4 lo marcaba como "asignado y
  // NUNCA invocado" -- con razon, porque un proveedor asignado y no invocado es
  // codigo que parece existir.
  //
  // Se le da su trabajo real: redactar el `summary` del paquete. El VEREDICTO no
  // se le consulta -- sale del codigo de salida del gate y se reinyecta despues
  // (ADR-004: lo que puede resolverse sin modelo se resuelve sin modelo). Si el
  // modelo falla, la etapa NO cae: la evidencia ya esta completa sin el.
  try {
    const r = await M.releaseSummary(ctx, paquete);
    if (r?.payload?.summary) paquete.summary = r.payload.summary;
  } catch (e) {
    paquete.summary = `sin resumen: ${e.message}`;
  }

  return { payload: paquete };
}

/**
 * El fichero que ACABA de escribir el gate, absoluto.
 *
 * `gate.sh` numera `<sha>-<n>.json` y va subiendo `n`, asi que el de esta corrida
 * es el de `n` mas alto para ese sha. Se devuelve absoluto a proposito: relativo
 * es justo lo ambiguo -- hay dos `.harness/evidence/`, el del workspace y el del
 * arbol principal, y confundirlos fue el defecto que este campo cierra.
 *
 * @returns la ruta, o null si el gate no llego a escribir (no se inventa una).
 */
export function rutaDeEvidencia(wsPath, sha) {
  const dir = join(wsPath ?? ROOT, '.harness', 'evidence');
  if (!wsPath || !existsSync(dir) || !sha) return null;
  const n = readdirSync(dir)
    .map((f) => new RegExp(`^${sha}-(\\d+)\\.json$`).exec(f))
    .filter(Boolean)
    .map((m) => Number(m[1]));
  return n.length ? join(dir, `${sha}-${Math.max(...n)}.json`) : null;
}

/** Los checks del gate, leidos de su fichero. `[]` si no se pudo: no se inventan. */
export function leerGateChecks(path) {
  if (!path || !existsSync(path)) return [];
  try {
    return (JSON.parse(readFileSync(path, 'utf8')).checks ?? [])
      .map((c) => ({ check: c.check, status: c.status, nota: c.nota ?? '' }));
  } catch {
    return [];
  }
}

/**
 * Aplica el veredicto de seguridad SIN perder el informe.
 *
 * `runRing` captura lo que LANZA una etapa y escribe `payload: null`. La etapa
 * Security lanzaba, asi que el SecurityReport entero -- controles, hallazgos,
 * counts, el alcance del SBOM-- se descartaba EXACTAMENTE en la vuelta donde la
 * puerta muerde. Medido en H-20260817-2962fd70: `08-security.json` quedo con
 * `payload: null` y una linea de `reason` sobre un BLOCK real, con un comentario
 * encima afirmando que el artefacto se conservaba. Es `el-fix-que-no-existe`
 * aplicado al propio harness.
 *
 * Devolver `FAIL` da el MISMO `onFail` que lanzar -- mismo REWORK -- y ademas
 * conserva el payload.
 *
 * PURO y exportado para poder probarlo: comprobarlo a traves del handler exigiria
 * escanear un workspace, y un test que reimplemente esta decision en vez de
 * llamarla no prueba nada.
 */
export function conVeredictoDeSeguridad(r) {
  try {
    M.assertSecurityGate(r.payload);
    return r;
  } catch (e) {
    return { ...r, status: 'FAIL', reason: e.message };
  }
}

export function ringHandlers() {
  return {
    Knowledge: M.knowledge,
    Evidence: M.evidence,
    Decision: M.decision,
    Plan: M.plan,
    Compute: D.compute,
    Sandbox: D.sandboxStage,
    Execution: M.execution,
    // El motor busca por NOMBRE, asi que este orden es documental -- pero un mapa
    // que se lee distinto del anillo que ejecuta es como se cuela una posicion
    // equivocada en un comentario, y de ahi a un literal hay un paso.
    //
    // Security va en la 8, DELANTE de Validation.
    //
    // DEVUELVE `FAIL`; no lanza. La diferencia no es de estilo: `runRing` captura
    // lo que lanza una etapa y escribe `payload: null`, asi que LANZAR descartaba
    // el SecurityReport entero -- controles, hallazgos, counts, el alcance del
    // SBOM-- justo en la unica vuelta donde la puerta muerde. Medido en
    // H-20260817-2962fd70: `08-security.json` quedo con `payload: null` y una
    // linea de `reason`, sobre un BLOCK real.
    //
    // El comentario que habia aqui decia que «el artefacto se escribe igual». No
    // se escribia: es `el-fix-que-no-existe` aplicado al propio harness.
    //
    // El motor trata igual un `status: FAIL` devuelto que uno lanzado -- mismo
    // `onFail`, mismo REWORK-- y ademas conserva el payload.
    Security: async (ctx) => conVeredictoDeSeguridad(await M.security(ctx)),
    Validation: M.validation,
    Adversarial: M.adversarial,
    Convergence: D.convergence,
    CapabilityLayer: D.capabilityLayer,
    AdapterLayer: D.adapterLayer,
    Observability: D.observability,
    Evidence2: evidencePackage,
    Learning: M.learning,
    __rollback: D.rollbackAll,
  };
}

/** Persiste el LearningRecord para que la vuelta siguiente lo consuma (FT-5). */
export function saveLearning(executionId, learning) {
  const p = join(RUNTIME, 'runs', 'last-learning.json');
  writeFileSync(p, redactarSecretos(JSON.stringify({ executionId, ...learning }, null, 2)) + '\n');
  return p;
}

/**
 * Los tres niveles sobre las corridas conocidas -> candidatos RESUELTOS.
 *
 * Se escriben en `.harness/learning/`, NO en `memory/`: promover es un paso
 * aparte con su propia decision. Los rechazados se guardan tambien -- un
 * candidato que desaparece sin dejar rastro no se puede auditar, y la proxima
 * vuelta volveria a proponerlo sin que nadie sepa que ya se descarto.
 *
 * `historicas` son las vueltas ANTERIORES: sin ellas la confianza no puede subir
 * de 0.5 y nada se auto-promueve nunca. La repetibilidad es una propiedad de la
 * serie, no de una corrida.
 */
export function saveLearningCandidates(executionId, run, { historicas = [], model = null, date } = {}) {
  const policy = loadLearningPolicy();
  const capturas = [...historicas.map(capture), capture(run)];
  const previas = leerMemoriaVigente();

  const resueltos = decide(capturas, policy, { previas }).map((c) => ({
    ...c,
    provenance: provenance(c, { promotedBy: 'trigger', model, date }),
  }));

  const dir = join(RUNTIME, 'learning');
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${executionId}.json`);
  writeFileSync(p, redactarSecretos(JSON.stringify({
    executionId,
    generatedAt: date,
    resumen: {
      PROMOTE: resueltos.filter((c) => c.decision.verdict === 'PROMOTE').length,
      REVIEW: resueltos.filter((c) => c.decision.verdict === 'REVIEW').length,
      REJECT: resueltos.filter((c) => c.decision.verdict === 'REJECT').length,
    },
    candidates: resueltos,
  }, null, 2)) + '\n');
  return { path: p, candidates: resueltos };
}

/**
 * Enunciados ya guardados en memory/, para que `novel` signifique algo.
 * Se lee el `title` del frontmatter: es el enunciado de la entrada.
 */
function leerMemoriaVigente() {
  const base = join(ROOT, 'memory');
  if (!existsSync(base)) return [];
  const out = [];
  for (const clase of readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory())) {
    for (const f of readdirSync(join(base, clase.name)).filter((f) => f.endsWith('.md'))) {
      const { data } = parseFrontmatter(readFileSync(join(base, clase.name, f), 'utf8'));
      if (data.title) out.push({ statement: data.title, id: data.id, type: data.type });
    }
  }
  return out;
}
