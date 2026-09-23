// Observability — el CAMINO de una corrida, no solo su veredicto.
//
// El BASELINE de DoxIA midio esto sobre la plataforma (§18): "que es observable:
// el ESTADO del negocio. Que es opaco: el CAMINO de una peticion". El harness
// nacia con el mismo defecto -- sabia el veredicto de una corrida y no como
// llego a el.
//
// `executionId` es lo que enlaza traza, artefactos, workspace y evidencia del
// gate. Sin el, cuatro registros de la misma corrida no se pueden juntar.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { RUNTIME } from './capabilities.mjs';
import { readArtifact } from './artifact.mjs';
import { hashDe } from './mutation.mjs';
import { resumir } from './telemetry.mjs';
import { codigoDe, CODIGOS } from './reason-code.mjs';

export const runDir = (executionId) => join(RUNTIME, 'runs', executionId);

/**
 * Consolida el ExecutionTrace desde el resultado del motor.
 *
 * `invocations` cuenta las ordenes HUMANAS que lanzaron la corrida: es 1 si una
 * sola orden la arranco entera. FT-2 lo evalua, y por eso lo pone quien invoca,
 * no el motor -- el motor no puede saber cuantas veces lo llamaron.
 */
export function buildTrace(result, {
  invocations = 1, awaitingHuman = [], parentExecutionId = null, telemetry = [],
} = {}) {
  const stages = result.stages.map((s) => ({
    n: s.n,
    stage: s.stage,
    status: s.status,
    contract: s.contract,
    artifact: s.artifact,
    ms: s.ms,
    ...(s.reason ? { reason: s.reason } : {}),
    ...(s.producedBy ? { producedBy: s.producedBy } : {}),
  }));

  const eid = result.executionId;
  const A = result.artifacts ?? {};
  const p = (etapa) => A[etapa]?.payload ?? null;

  // TODOS los intentos de Execution, no solo el ultimo. Con un REWORK, leer solo
  // el vigente daba «1 rework, 0 mutaciones» sobre una vuelta que habia escrito
  // cinco ficheros: el reintento verifico sin mutar y borro la historia del
  // primero. `attempts` conserva la serie; si no viene, se cae al vigente.
  const intentosEjec = (result.attempts?.Execution ?? [result.artifacts?.Execution]).filter(Boolean);
  const ejecucion = p('Execution') ?? {};
  const acumular = (campo) => intentosEjec.flatMap((a) => a?.payload?.[campo] ?? []);
  const conv = p('Convergence');
  const sec = p('Security');
  // `Evidence2` a secas, SIN caer a `Evidence`. Son dos contratos distintos: la
  // etapa 2 produce un `FactSet` y la 15 un `EvidencePackage`. El fallback venia
  // de cuando la etapa 15 se llamaba `Evidence`, y al renombrarla paso a recoger
  // el artefacto de la 2 -- asi que una vuelta que no llega a la 15 rendia
  // `evidencia undefined (undefined) @ undefined` en vez de decir que no hubo.
  // Medido sobre H-20260818-d161dc60. Un fallback que sobrevive a su renombrado
  // no falla: MIENTE en voz baja.
  const ev = p('Evidence2');

  // Cada cosa con su ID, prefijado por el executionId. Sin eso, «el hallazgo 3»
  // no significa nada fuera de su fichero, y correlacionar dos corridas obliga a
  // acarrear el contexto de cual era cual.
  const toolCalls = acumular('toolCalls').map((c, i) => ({ toolCallId: `${eid}:tc:${i + 1}`, ...c }));
  const mutations = acumular('mutations').map((m, i) => ({ mutationId: `${eid}:mu:${i + 1}`, ...m }));

  // Los hallazgos, con su veredicto adversarial ya aplicado y enlazados a la
  // llamada que los produjo cuando se puede: el revisor cita `file`, y la unica
  // mutacion sobre ese fichero es su origen probable. Se marca como `probable`
  // -- inventar una correlacion exacta que no se midio seria peor que no darla.
  const findings = (p('Adversarial')?.findings ?? p('Validation')?.findings ?? []).map((f, i) => ({
    findingId: `${eid}:f:${i + 1}`,
    ...f,
    relatedMutations: mutations.filter((m) => m.path === f.file).map((m) => m.mutationId),
  }));

  return {
    executionId: eid,
    // La flecha del anillo, explicita en la traza y no solo en el prompt de
    // Knowledge: sin ella, reconstruir una serie de vueltas obliga a leer los
    // artefactos de todas para descubrir cual siguio a cual.
    parentExecutionId,
    startedAt: result.startedAt,
    endedAt: result.endedAt,
    stages,
    invocations,
    awaitingHuman,                       // FT-2: debe quedar vacio
    verdict: result.verdict,
    ...(result.reason ? { reason: result.reason } : {}),
    // POR QUE paro, en un codigo y no en un parrafo. El `reason` es prosa libre
    // --y encima en tres idiomas, porque la frase del modelo se concatena tal
    // cual--, asi que trece vueltas del histórico pararon en 'Execution' por TRES
    // causas incomparables entre si. Contarlas juntas es lo que hizo llamar
    // «determinismo» a s²=0 (ver memory/failures/varianza-cero-no-era-determinismo.md).
    // `culpa` es el campo que separa una regresion de un exito: BUILDER_SE_AUTOBLOQUEA
    // es culpa de la SPEC, y significa que el anillo funciono.
    reason_code: result.verdict === 'PASSED' ? 'OK' : codigoDe(result.reason),
    ...(result.verdict === 'PASSED' ? {} : { culpa: CODIGOS[codigoDe(result.reason)]?.culpa ?? null }),
    totalMs: stages.reduce((a, s) => a + (s.ms ?? 0), 0),

    // ── Lo que paso DENTRO de las etapas ───────────────────────────────────
    plan: p('Plan') ? { id: p('Plan').id ?? null, goal: p('Plan').goal ?? null } : null,
    planHash: p('Plan') ? hashDe(JSON.stringify(p('Plan'))) : null,
    models: p('AdapterLayer')?.bindings ?? [],
    tools: p('CapabilityLayer')?.harnessTools ?? [],
    // De los toolCalls ACUMULADOS, no del artefacto de CapabilityLayer: esa etapa
    // corre una sola vez y solo ve el ultimo intento, asi que la traza decia «11
    // llamadas · usadas: —» cuando el reintento no habia llamado a nada.
    toolsUsed: [...new Set(toolCalls.filter((c) => c.allowed).map((c) => c.tool))].sort(),
    toolCalls,
    mutations,
    findings,
    // La SUPERFICIE, de todos los intentos: es la variable que la Fase 11 ata a
    // la convergencia, y una que solo apareciera en el artefacto de Execution no
    // seria observable desde la traza.
    changeSurface: intentosEjec.map((a, i) => ({ attempt: i + 1, ...(a?.payload?.changeSurface ?? {}) }))
      .filter((s) => s.files !== undefined),
    convergence: conv
      ? {
        pass: conv.pass, blockers: conv.blockers, raw: conv.raw, unified: conv.unified,
        refutationRate: conv.refutationRate,
        // Sin esto, «4 reworks» seguiria siendo todo lo que la traza sabe decir
        // sobre por que una vuelta no cerro.
        status: conv.convergenceStatus ?? null,
        rounds: conv.rounds ?? [],
        progress: conv.progress ?? null,
        reappeared: conv.reappeared ?? [],
        displaced: conv.displaced ?? [],
        specificationBlocked: conv.specificationBlocked ?? null,
      }
      : null,
    securityResults: sec ? { sca: sec.sca, sbom: sec.sbom, sast: sec.sast, owasp: sec.owasp, findings: (sec.findings ?? []).length } : null,
    // De `gateChecks`, NO de `checks`: `checks` son los estados de las 16 etapas
    // del anillo y `gateChecks` es lo que la puerta midio de verdad.
    tests: (ev?.gateChecks ?? []).filter((c) => /^(unit_tests|integration|build)/.test(String(c.check))),
    finalEvidence: ev ? { verdict: ev.verdict, mode: ev.mode, sha: ev.sha, path: ev.evidencePath ?? null } : null,

    // TELEMETRIA POR PROVEEDOR (Fase 11). Duracion siempre -- la mide el harness;
    // tokens donde el proveedor los publica; coste MISSING con su motivo. Sin
    // esto no se pueden comparar dos proveedores sobre la misma tarea, que es lo
    // que la Fase 12 necesita medir.
    providers: resumir(telemetry),
    metrics: metricas({ stages, toolCalls, mutations, findings, ejecucion, intentosEjec, sec, conv, telemetry }),

    // ADR-006: Graphify es evidencia derivada y entra con fase propia. Sus campos
    // existen y se declaran MISSING, igual que SAST y OWASP. Declarados, nunca
    // aprobados -- un hueco con nombre es auditable; uno sin nombre no.
    graph: {
      snapshotBefore: 'MISSING', queries: 'MISSING', impactAnalysis: 'MISSING',
      snapshotAfter: 'MISSING', diff: 'MISSING', findings: 'MISSING',
      why: 'ADR-006: entra con fase y criterio propios, no como efecto secundario de Observability',
    },
  };
}

/**
 * Las metricas SALEN DEL HARNESS, no de lo que declare un modelo.
 *
 * `tokens` y `cost` van a null cuando el proveedor no los publica, y se dice cual
 * es el motivo. Un cero seria mentira y una estimacion seria peor: pareceria
 * medida. Los CLI (claude, opencode) no reportan uso; deepseek y ollama si, y por
 * eso el campo existe.
 */
function metricas({ stages, toolCalls, mutations, findings, ejecucion, intentosEjec = [], sec, conv, telemetry = [] }) {
  const uso = (ejecucion.usage ?? null);
  const porProveedor = resumir(telemetry);
  const conTokens = porProveedor.filter((x) => x.totalTokens !== null);
  const sinTokens = porProveedor.filter((x) => x.totalTokens === null);
  const cs = ejecucion.changeSurface ?? null;
  return {
    // Fase 11 — lo que decide si esto converge, junto a lo que costo.
    convergenceStatus: conv?.convergenceStatus ?? null,
    rounds: conv?.round ?? 0,
    findingsFixed: conv?.progress?.fixed ?? null,
    findingsRegressed: conv?.progress?.regressed ?? null,
    surfaceFiles: cs?.files ?? null,
    surfaceLines: cs && cs.linesAdded !== null ? cs.linesAdded + cs.linesRemoved : null,
    surfaceRisk: cs?.risk ?? null,
    durationMs: stages.reduce((a, s) => a + (s.ms ?? 0), 0),
    stages: stages.length,
    uniqueStages: new Set(stages.map((s) => s.stage)).size,
    reworks: Math.max(0, stages.filter((s) => s.stage === 'Execution').length - 1),
    // Las del ULTIMO intento y las de la vuelta entera. Solo la primera cifra
    // hacia parecer barata una Execution que se repitio tres veces.
    iterations: ejecucion.iterations ?? 0,
    iterationsTotal: intentosEjec.reduce((a, x) => a + (x?.payload?.iterations ?? 0), 0),
    executionAttempts: intentosEjec.length,
    toolCalls: toolCalls.length,
    toolCallsDenied: toolCalls.filter((c) => !c.allowed || c.rule === 'mutation').length,
    mutations: mutations.length,
    mutationsApplied: mutations.filter((m) => m.changed).length,
    findings: findings.length,
    findingsConfirmed: findings.filter((f) => f.verdict !== 'REFUTED').length,
    securityFindings: (sec?.findings ?? []).length,
    failedStages: stages.filter((s) => s.status === 'FAIL').length,
    modelCalls: porProveedor.reduce((a, x) => a + x.calls, 0),
    modelMs: porProveedor.reduce((a, x) => a + x.durationMs, 0),
    // De la TELEMETRIA, no de `ejecucion.usage`: aquel solo veia el bucle del
    // builder, asi que el revisor y las tres pasadas de refutacion -- que son la
    // mayoria de las invocaciones -- no contaban.
    tokens: conTokens.length ? conTokens.reduce((a, x) => a + x.totalTokens, 0) : (uso?.totalTokens ?? null),
    tokensBy: Object.fromEntries(conTokens.map((x) => [x.id, x.totalTokens])),
    // Que proveedores NO lo publican, por su nombre. Un total sin esta lista se
    // lee como el gasto entero de la vuelta y solo es el de una parte.
    tokensMissing: sinTokens.map((x) => x.id),
    cost: null,
    costNote: !porProveedor.length
      ? 'sin telemetria de invocacion: esta vuelta no llamo a ningun proveedor, o no reportan uso'
      : sinTokens.length
        ? `sin tokens de ${sinTokens.map((x) => x.id).join(', ')}: los CLI no reportan uso y no se estima`
        : 'hay tokens, pero el catalogo declara el coste por tier y no por precio: no se estima',
  };
}

/**
 * Comprueba la traza contra el manifiesto. Es el `gate` de Observability y FT-1.
 * Se nombra la etapa, no su posicion: la posicion ya cambio una vez.
 * @returns [] si esta sana, o los problemas encontrados.
 */
export function checkTrace(trace, manifest) {
  const p = [];
  const esperadas = manifest.stages.map((s) => s.stage);
  const vistas = (trace.stages ?? []).map((s) => s.stage);

  // REWORK vuelve atras, asi que una etapa PUEDE repetirse y el recorrido ser
  // mas largo que el anillo. Comparar posicion a posicion daba "recorrio 18 de
  // 16" y "etapa 11: se esperaba Security y se recorrio Execution" -- Security
  // estaba entonces en la 11 -- sobre una
  // vuelta perfectamente valida: el modelo de traza asumia un paso lineal y el
  // anillo tiene un salto hacia atras DECLARADO desde el principio.
  //
  // Se comprueba lo que de verdad importa: que no aparezca ninguna etapa ajena,
  // que estén todas, y que el orden solo retroceda donde el motor lo permite.
  const reworkA = manifest.stages.findIndex((s) => s.stage === 'Execution');
  const idx = new Map(esperadas.map((s, i) => [s, i]));

  const ajenas = [...new Set(vistas.filter((s) => !idx.has(s)))];
  if (ajenas.length) p.push(`etapas que no existen en el anillo: ${ajenas.join(', ')}`);

  const faltan = esperadas.filter((s) => !vistas.includes(s));
  if (faltan.length) p.push(`no recorrio ${faltan.length} de ${esperadas.length} etapas: ${faltan.join(', ')}`);

  let anterior = -1;
  for (let i = 0; i < vistas.length; i++) {
    const actual = idx.get(vistas[i]);
    if (actual === undefined) continue;                 // ya reportada como ajena
    if (actual < anterior && actual !== reworkA) {
      p.push(`etapa ${i + 1}: '${vistas[i]}' retrocede sin ser un REWORK a 'Execution'`);
      break;                                            // un desfase invalida el resto
    }
    anterior = actual;
  }
  const reworks = vistas.filter((s) => s === 'Execution').length - 1;
  if (reworks > 0) trace.reworks = reworks;
  for (const s of trace.stages ?? []) {
    // Una etapa saltada en silencio es la version de anillo del `describe.only`:
    // el recorrido parece completo y no lo fue.
    if ((s.status === 'SKIPPED' || s.status === 'FAIL') && !s.reason) {
      p.push(`etapa '${s.stage}': ${s.status} sin motivo declarado`);
    }
    if (!s.artifact) p.push(`etapa '${s.stage}': sin artefacto`);
    else if (!readArtifact(s.artifact)) p.push(`etapa '${s.stage}': artefacto ausente o ilegible`);
  }
  if (!trace.executionId) p.push('sin executionId: la corrida no se puede enlazar con su evidencia');
  return p;
}

/** Lee una corrida del disco: la traza mas todos sus artefactos. */
export function loadRun(executionId) {
  const dir = runDir(executionId);
  if (!existsSync(dir)) return null;

  const artifacts = {};
  // `.sort()` NO es cosmetico: `readdirSync` no garantiza orden, y de este orden
  // sale el de `Object.values(artifacts)`, que es lo que dice DONDE murio una
  // vuelta abortada. Sin el, 'murio despues de X' puede nombrar otra etapa.
  //
  // Lexicografico == numerico SOLO porque el filtro exige DOS digitos exactos:
  // `01-`..`16-`. Y ese filtro DESCARTA CALLANDO lo que no los tenga -- un `9-` o
  // un `100-` no se ordenarian mal: desaparecerian del listado. Hoy no puede pasar
  // (16 etapas), y queda escrito porque un filtro que descarta en silencio ya
  // mordio una vez en la consolidacion. Aviso de third.
  for (const f of readdirSync(dir).filter((f) => /^\d\d-/.test(f)).sort()) {
    const a = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    artifacts[a.stage] = a;
  }
  // La traza AUTORITATIVA es trace.json, que el orquestador escribe al cerrar.
  // El artefacto de Observability es un SNAPSHOT legitimo: corre DENTRO del anillo
  // y no puede ver las etapas que van detras suyo -- las declara en `pendientes`.
  // Leer el snapshot como si fuera la traza completa hacia que FT-1 reportara
  // "10 de 16" en una vuelta que recorrio las 16.
  let trace = null;
  const final = join(dir, 'trace.json');
  if (existsSync(final)) {
    try { trace = JSON.parse(readFileSync(final, 'utf8')); } catch { /* ilegible */ }
  }
  trace ??= artifacts.Observability?.payload ?? null;
  return { executionId, dir, artifacts, trace };
}

// ── Fase 9 · que la corrida se pueda reconstruir sin memoria humana ─────────

/**
 * Patrones de secreto. Los mismos que vigila el gate, mas los formatos de las
 * claves que este harness usa de verdad.
 *
 * No se busca la palabra "password": aparece legitimamente en cualquier diff de
 * un formulario de login, y un detector que grita con eso se acaba ignorando.
 * Se buscan FORMAS de credencial.
 */
// Los patrones y la redaccion viven en `secretos.mjs`: UNA autoridad sobre «que
// parece un secreto». Estaban aqui, y para redactar al escribir hacia falta que
// `artifact.mjs` los usara -- pero este modulo importa `artifact.mjs`, asi que
// habria sido un ciclo o una copia. Se reexporta para no romper a quien ya lo
// importaba de aqui.
export { sinSecretos } from './secretos.mjs';


/**
 * RECONSTRUYE una corrida leyendo SOLO `.harness/runs/<id>/`.
 *
 * Es la prueba de la Fase 9, y por eso no acepta nada mas que el id: si hiciera
 * falta un dato que solo esta en la cabeza de quien lanzo la vuelta, o en el log
 * de la terminal, la corrida no seria reconstruible y el trace estaria mintiendo
 * por omision.
 *
 * @returns {{ok, executionId, lines[], problems[]}}
 */
/**
 * Lo que SI se sabe de una vuelta que murio antes de escribir `trace.json`.
 *
 * Sin traza consolidada, `reconstruct` decia «no se reconstruye entera» y no
 * ensenaba nada -- teniendo los artefactos POR ETAPA en disco. Esa es la otra
 * mitad de lo que dejo sin adjudicar la contradiccion del item `cm-4`: el tablero
 * no decia a donde mirar (arreglado en campaign.mjs) y `trace` no ensenaba lo que
 * habia cuando se miraba.
 *
 * Una vuelta abortada no es una vuelta sin evidencia: es una vuelta cuya evidencia
 * esta repartida y a la que nadie junto.
 */
export function resumenAbortada(artifacts) {
  const etapas = Object.values(artifacts ?? {});
  if (!etapas.length) return [];
  const L = [`ABORTADA — sin trace.json. ${etapas.length} etapa(s) dejaron artefacto:`];
  for (const a of etapas) {
    L.push(`  ${String(a.stage ?? '?').padEnd(16)} ${String(a.status ?? '?').padEnd(6)} `
      + String(a.reason ?? a.payload?.summary ?? '').slice(0, 80));
  }
  L.push(`  murio DESPUES de '${etapas[etapas.length - 1].stage ?? '?'}'`);
  return L;
}

export function reconstruct(executionId) {
  const run = loadRun(executionId);
  if (!run) return { ok: false, executionId, lines: [], problems: [`no existe .harness/runs/${executionId}/`] };

  const t = run.trace ?? {};
  const m = t.metrics ?? {};
  const problems = [];
  const falta = (campo) => problems.push(`el trace no lleva '${campo}': la corrida no se reconstruye entera`);

  for (const k of ['executionId', 'stages', 'startedAt', 'endedAt', 'verdict']) if (t[k] === undefined) falta(k);
  for (const k of ['toolCalls', 'mutations', 'findings', 'models', 'metrics', 'finalEvidence']) if (t[k] === undefined) falta(k);
  if (t.parentExecutionId === undefined) falta('parentExecutionId');

  const fugas = sinSecretos(t);
  for (const f of fugas) problems.push(`SECRETO en el trace: ${f.kind} (${f.sample})`);

  // LA GUARDA DEL ORDEN. El artefacto consolidado de AdapterLayer lleva los
  // conteos definitivos; la traza los copia. Si difieren, la traza se construyo
  // ANTES de consolidar y esta describiendo mitad de vuelta -- que es justo lo que
  // paso la primera vez que se uso `doxia trace`: decia `release=0 trigger=0` en
  // una corrida donde las dos se invocaron.
  //
  // Va aqui y no en un test unitario a proposito: el defecto no estaba en ninguna
  // funcion, estaba en el ORDEN en que el orquestador las llama, y eso solo se ve
  // sobre una corrida real.
  const consolidado = run.artifacts?.AdapterLayer?.payload?.bindings;
  if (Array.isArray(consolidado) && Array.isArray(t.models)) {
    for (const b of consolidado) {
      const enTrace = t.models.find((x) => x.capability === b.capability);
      if (enTrace && enTrace.invocations !== b.invocations) {
        problems.push(
          `'${b.capability}': el trace dice ${enTrace.invocations} invocaciones y el artefacto ${b.invocations}`
          + ' — la traza se construyo antes de consolidar',
        );
      }
    }
  }

  const L = [];
  L.push(`corrida     ${t.executionId ?? executionId}`);
  if (t.stages === undefined) for (const l of resumenAbortada(run.artifacts)) L.push(l);
  L.push(`viene de    ${t.parentExecutionId ?? '(primera de la serie)'}`);
  L.push(`veredicto   ${t.verdict ?? '?'}${t.reason_code && t.reason_code !== 'OK' ? ` [${t.reason_code}${t.culpa ? `/${t.culpa}` : ''}]` : ''}${t.reason ? ` — ${t.reason}` : ''}`);
  L.push(`duracion    ${((m.durationMs ?? t.totalMs ?? 0) / 60000).toFixed(1)} min · ${m.uniqueStages ?? '?'}/${(t.stages ?? []).length ? new Set(t.stages.map((s) => s.stage)).size : '?'} etapas unicas · ${m.reworks ?? 0} rework(s)`);
  L.push(`objetivo    ${t.plan?.goal ? String(t.plan.goal).slice(0, 90) : '(sin plan en el trace)'}`);
  L.push(`planHash    ${t.planHash ?? '—'}`);
  L.push('');
  L.push(`quien       ${(t.models ?? []).map((b) => `${b.capability}=${b.provider}:${b.model}(${b.invocations})`).join(' · ') || '—'}`);
  L.push(`herramientas ${m.toolCalls ?? 0} llamadas, ${m.toolCallsDenied ?? 0} rechazadas · usadas: ${(t.toolsUsed ?? []).join(', ') || '—'}`);
  L.push(`mutaciones  ${m.mutations ?? 0} (${m.mutationsApplied ?? 0} cambiaron algo)`);
  for (const x of t.mutations ?? []) {
    L.push(`  ${x.mutationId}  ${String(x.op).padEnd(12)} ${(x.baseHash ?? '--').slice(0, 8)} -> ${String(x.after).slice(0, 8)}  ${x.path}`);
  }
  L.push('');
  L.push(`hallazgos   ${m.findings ?? 0}, ${m.findingsConfirmed ?? 0} confirmados · seguridad: ${m.securityFindings ?? 0}`);
  for (const f of t.findings ?? []) {
    L.push(`  ${f.findingId}  ${f.severity ?? '--'} ${f.verdict ?? 'SIN VEREDICTO'}  ${f.file ?? '?'} — ${String(f.claim ?? '').slice(0, 70)}`);
  }
  L.push('');
  L.push(`convergencia ${t.convergence ? `${t.convergence.raw} crudos -> ${t.convergence.unified} unificados, ${t.convergence.blockers} bloqueantes (refutacion ${t.convergence.refutationRate})` : '—'}`);
  if (t.convergence?.status) {
    const p = t.convergence.progress;
    L.push(`  ciclo     ${t.convergence.status} · ${(t.convergence.rounds ?? []).length} ronda(s)`
      + (p ? ` · ${p.first} -> ${p.last} bloqueantes, ${p.fixed} cerrados / ${p.new} nuevos / ${p.regressed} regresados` : '')
      + (t.convergence.reappeared?.length ? ` · reaparecidos: ${t.convergence.reappeared.length}` : ''));
  }
  for (const s of t.changeSurface ?? []) {
    L.push(`  superficie intento ${s.attempt}: ${s.files} fichero(s) · ${s.linesAdded ?? '?'}+/${s.linesRemoved ?? '?'}-`
      + ` · ${s.modulesTouched} modulo(s) · ${s.domainsTouched} dominio(s) · riesgo ${s.risk}`);
  }
  L.push(`seguridad   ${t.securityResults ? `sca=${t.securityResults.sca} sbom=${t.securityResults.sbom} sast=${t.securityResults.sast} owasp=${t.securityResults.owasp}` : '—'}`);
  L.push(`tests       ${(t.tests ?? []).map((c) => `${c.check}=${c.status}`).join(' · ') || '—'}`);
  L.push(`evidencia   ${t.finalEvidence ? `${t.finalEvidence.verdict} (${t.finalEvidence.mode}) @ ${t.finalEvidence.sha} -> ${t.finalEvidence.path ?? 'sin ruta'}` : '—'}`);
  L.push(`coste       ${m.tokens ?? 'sin dato'} tokens — ${m.costNote ?? ''}`);
  for (const x of t.providers ?? []) {
    L.push(`  ${x.id.padEnd(28)} ${String(x.calls).padStart(3)} llamada(s) · ${(x.durationMs / 1000).toFixed(1)}s`
      + ` (${x.msPerCall}ms/llamada) · tokens ${x.totalTokens ?? x.tokensStatus} · coste ${x.costStatus}`
      + (x.failed ? ` · ${x.failed} fallida(s)` : ''));
  }
  L.push(`grafo       ${t.graph ? Object.entries(t.graph).filter(([k]) => k !== 'why').map(([k, v]) => `${k}=${v}`).join(' ') : '—'}`);

  return { ok: problems.length === 0, executionId, lines: L, problems, trace: t };
}
