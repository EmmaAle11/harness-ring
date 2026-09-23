// Las seis etapas DETERMINISTAS del anillo.
//
// Compute · Sandbox · Convergence · Observability · CapabilityLayer · AdapterLayer.
// Ninguna invoca un modelo, y es deliberado: un contrato que puede cumplirse sin
// un modelo se cumple sin un modelo (ADR-004). Que `Compute` sea determinista es
// lo que hace de ADR-003 una garantia -- si un modelo eligiera al revisor, podria
// elegirse a si mismo.
import { execFileSync } from 'node:child_process';
import { loadRouter, loadCatalog, loadCapabilities, ROOT } from './capabilities.mjs';
import { resolveModel } from './router.mjs';
import { familiaDe, parteDe } from './compute.mjs';
import { converge, bloqueantes } from './converge.mjs';
import { convergencia, transiciones, fingerprint, persistentes, veredictosInestables } from './findings.mjs';
import { bloqueadaPorEspecificacion } from './spec.mjs';
import { buildTrace } from './trace.mjs';
import { toolRegistry, resolveInside } from './tools.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import * as sandbox from './sandbox.mjs';
import { contenidoDeSemilla } from './credenciales-sinteticas.mjs';
import { probeAll, aliveSet, modelSet } from '../adapters/models/index.mjs';

/**
 * Compute — QUIEN ejecuta. El router resuelve; ningun modelo elige aqui.
 * Falla DURO si builder y reviewer comparten proveedor: no se degrada a
 * "revisado por el mismo proveedor" en silencio (ADR-003).
 */
export async function compute(ctx) {
  const router = loadRouter();
  const catalog = loadCatalog();
  const caps = loadCapabilities();
  const probes = await probeAll();
  const vivos = aliveSet(probes);
  const instalados = modelSet(probes);   // un proveedor vivo no implica el modelo descargado
  const salud = { router, catalog, available: vivos, models: instalados };

  const builder = resolveModel(caps.find((c) => c.id === 'builder'), salud);
  if (builder.error) throw new Error(builder.error);

  const reviewer = resolveModel(caps.find((c) => c.id === 'reviewer'), { ...salud, avoid: [builder.id] });
  if (reviewer.error) throw new Error(reviewer.error);

  const asignaciones = {};
  const decisiones = [];
  for (const c of caps) {
    const evitar = c.id === 'reviewer' || c.id === 'security' ? [builder.id] : [];
    const m = resolveModel(c, { ...salud, avoid: evitar });
    if (m.error) {
      // Una capacidad sin modelo se DECLARA. Antes se omitia en silencio y
      // AdapterLayer la daba luego por "asignada y nunca invocada".
      decisiones.push({ capability: c.id, error: m.error, considered: m.considered ?? [] });
      continue;
    }
    asignaciones[c.id] = { provider: m.provider, model: m.model, id: m.id };
    decisiones.push(m.decision);
  }

  // LA TERCERA FUENTE, para la refutacion adversarial (Fase 11).
  //
  // Las tres pasadas de la etapa 10 corrian en el modelo del reviewer, asi que
  // eran TRES MUESTRAS DEL MISMO CRITERIO, no tres criterios. Repetir una
  // opinion no la corrobora: mide su varianza. Aqui se pide un modelo que evite
  // la familia del escritor Y la del revisor -- si existe, la refutacion pasa a
  // ser independiente de las dos.
  //
  // Y si NO existe, se DEGRADA declarandolo. Nunca en silencio: `independence`
  // viaja en el binding, y quien lea la corrida ve si la refutacion fue
  // independiente o fue el revisor votandose a si mismo.
  const adv = resolveModel(caps.find((c) => c.id === 'reviewer'), {
    ...salud, avoid: [builder.id, reviewer.id],
  });
  const independiente = !adv.error;
  asignaciones.adversarial = independiente
    ? { provider: adv.provider, model: adv.model, id: adv.id }
    : { ...asignaciones.reviewer };
  decisiones.push(independiente ? { ...adv.decision, capability: 'adversarial' } : {
    capability: 'adversarial', error: adv.error, considered: adv.considered ?? [],
  });

  const independence = {
    builder: builder.id,
    reviewer: reviewer.id,
    adversarial: asignaciones.adversarial.id,
    // LA CUENTA, no la palabra. Tres familias distintas es un hecho verificable
    // sobre el catalogo; «revisado independientemente» seria una afirmacion.
    families: [...new Set([builder.id, reviewer.id, asignaciones.adversarial.id]
      .map((id) => familiaDe(catalog, ...parteDe(id))))],
    status: independiente ? 'INDEPENDENT' : 'DEGRADED',
    selectionReason: independiente
      ? `refutacion en '${adv.id}', familia distinta de la del escritor y la del revisor`
      : `sin tercera familia viva: la refutacion recae en el revisor (${asignaciones.reviewer?.id}). ${adv.error}`,
  };

  ctx.assignments = asignaciones;         // lo consumen las etapas de modelo
  ctx.computeDecisions = decisiones;      // lo consumen Evidence y Observability (1.5)
  ctx.independence = independence;
  return {
    payload: {
      capability: 'builder',              // el contrato exige uno; el resto va en `all`
      provider: builder.provider,
      model: builder.model,
      avoid: [builder.id],
      why: `builder=${builder.id} reviewer=${reviewer.id} adversarial=${asignaciones.adversarial.id}`,
      all: asignaciones,
      independence,
      // La decision COMPLETA: que se considero, que se descarto y por que regla.
      // Sin esto, "eligio deepseek" es un dato sin auditoria posible.
      decisions: decisiones,
    },
    ...(independiente ? {} : {
      // Un WARN, no un fallo: perder la tercera fuente empeora la refutacion,
      // pero ADR-003 -- escritor != revisor -- sigue cumpliendose y esa es la
      // regla que puede detener el anillo.
      status: 'WARN',
      reason: `refutacion DEGRADADA: ${independence.selectionReason}`,
    }),
  };
}

/**
 * Sandbox — DONDE. Worktree aislado bajo .harness/workspaces/.
 *
 * Y, si el manifiesto lo declara, SIEMBRA los ficheros de `task.seed`. Es como se
 * demuestra que una puerta muerde: introduciendo a proposito lo que debe cazar.
 * Esperar a que aparezca de verdad seria demostrarlo el dia que ya es tarde.
 *
 * La siembra se registra en el artefacto con su `why`: una vulnerabilidad que
 * aparece en un workspace sin que conste quien la puso es indistinguible de una
 * de verdad, y eso es justo lo que un registro de auditoria no puede permitirse.
 */
export async function sandboxStage(ctx) {
  const ws = sandbox.create(ctx.executionId);
  ctx.workspace = ws;

  const semillas = (ctx.manifest?.task?.seed ?? []).map((s) => {
    const abs = resolveInside(ws, s.path);
    mkdirSync(dirname(abs), { recursive: true });
    // `content` literal, o `generate` -- que la spec diga el TIPO y el harness
    // ponga el valor. Sin eso, el criterio «secret scanning bloquea una
    // credencial sembrada» es INTESTABLE: `gate.sh` busca los patrones con
    // `git grep` sobre lo VERSIONADO y el pre-commit los bloquea en el staged
    // diff, asi que una spec con la credencial dentro ni se puede commitear -- y
    // si se commiteara, la puerta cazaria su propio material de pruebas.
    const contenido = contenidoDeSemilla(s, { sal: ctx.executionId });
    writeFileSync(abs, contenido);
    return {
      path: s.path,
      why: s.why ?? 'sin motivo declarado',
      bytes: contenido.length,
      // QUE se sembro, sin decir el valor: un registro de auditoria no publica
      // la credencial, ni siquiera una sintetica.
      ...(s.generate ? { generado: s.generate } : {}),
    };
  });

  return { payload: { ...ws, ...(semillas.length ? { seeded: semillas } : {}) } };
}

/**
 * Convergence — funcion pura. Deduplica, mide el CICLO y decide el veredicto.
 *
 * ADR-004 intacto: quien unifica sigue siendo `converge()` y quien decide el
 * umbral sigue siendo `bloqueantes()`. Lo que se anade no toca ninguna de las
 * dos -- es la pregunta que ningun contador de REWORK podia responder: si las
 * rondas REDUCEN el problema, lo DESPLAZAN o giran en circulos.
 *
 * DEVUELVE `FAIL`; no lanza. La diferencia no es de estilo: `runRing` captura lo
 * que lanza una etapa y escribe `payload: null`, asi que lanzar descartaba el
 * Verdict entero --bloqueantes, tasa de refutacion, ciclo de vida-- justo en la
 * ronda donde la puerta muerde. Los `11-convergence.json` de
 * H-20260817-009c7621 pesan 265 bytes: son tres bloqueos sin un solo dato. Es el
 * mismo defecto que ya se corrigio en Security, en la etapa de al lado.
 */
export async function convergence(ctx) {
  const crudos = ctx.artifacts?.Adversarial?.payload?.findings
    ?? ctx.artifacts?.Validation?.payload?.findings
    ?? [];
  const unificados = converge(crudos);
  // Bloquea lo CONFIRMADO y lo que nunca se refuto -- un hallazgo que no paso por
  // la etapa 9 no puede darse por bueno. NO bloquea `UNDECIDED`, que es el
  // veredicto explicito de «las pasadas no llegaron a decidirlo»: bloquear con un
  // hallazgo que nadie pudo evaluar es bloquear con ruido. Se registra, que es lo
  // que impide que sea un descarte silencioso.
  // NO bloquea `UNDECIDED` -- «se voto y no hubo mayoria»: bloquear con eso es
  // bloquear con ruido. SI bloquea `UNREVIEWED`, que es otra cosa: nadie se
  // pronuncio, asi que la refutacion no ocurrio y el hallazgo llega sin juzgar.
  // Es el mismo criterio que ya aplicaba al hallazgo sin veredicto -- no revisado
  // no es aprobado -- y su ausencia dejo cerrar H-20260818-50778834 en CONVERGED
  // con sus DOS hallazgos sin revisar.
  //
  // CON UNA EXCEPCION, y es la que cierra H-20260824-d897a07f: un `UNDECIDED`
  // cuyo silencio viene de una pasada que SI VOTO --y a la que el harness le tiro
  // el voto por no casar el `id`-- no es «se voto y no hubo mayoria». Es «la
  // refutacion OCURRIO y la perdimos», y eximirlo convierte un fallo de
  // instrumento en un permiso para cerrar. Aquella vuelta emitio 12 votos,
  // descarto 8, y los cuatro hallazgos salieron con un voto cada uno: `pass:
  // true` con cero bloqueantes. Tres eran falsos y el cuarto no.
  //
  // No anula la decision de H-20260818-50778834 --«un voto emitido SI es una
  // votacion sin mayoria»--: la respeta y le pone al lado el caso que aquella no
  // podia ver, porque entonces el harness no guardaba los votos que tiraba.
  const perdidoElVoto = (f) => (f.lostVotes ?? 0) > 0;
  const bloq = bloqueantes(unificados.filter(
    (f) => f.verdict !== 'REFUTED' && (f.verdict !== 'UNDECIDED' || perdidoElVoto(f)),
  ));
  const refutados = crudos.filter((f) => f.verdict === 'REFUTED').length;

  // La SERIE, que es lo unico sobre lo que se puede decir si esto converge. Vive
  // en el portador compartido: una ronda sola no sabe si es la primera o la
  // cuarta.
  ctx.rondas = [...(ctx.rondas ?? []), bloq];
  // LOS CRUDOS TAMBIEN, y no es lo mismo. `ctx.rondas` lleva BLOQUEANTES, y un
  // hallazgo REFUTADO no es bloqueante: mirar ahi no puede ver que un veredicto se
  // invirtio, justamente porque invertirlo lo saca de esa lista.
  ctx.crudosPorRonda = [...(ctx.crudosPorRonda ?? []), crudos];
  const ciclo = convergencia(ctx.rondas);
  const clasificados = transiciones(bloq, {
    previas: ctx.rondas.at(-2) ?? [],
    historia: new Set(ctx.rondas.slice(0, -2).flat().map(fingerprint)),
  });

  // ¿Es la ESPECIFICACION? Se pregunta cuando hay evidencia de que no lo es el
  // builder: el mismo hallazgo en todas las rondas Y mutaciones reales en todas
  // ellas. Dos de las cinco corridas fallidas de las fases 7-9 murieron aqui sin
  // que nada lo dijera.
  const specBlock = bloqueadaPorEspecificacion(persistentes(ctx.rondas), ctx.mutacionesPorRonda ?? []);
  const estado = specBlock ? 'SPECIFICATION_BLOCKED' : ciclo.status;

  const payload = {
    pass: bloq.length === 0,
    blockers: bloq.length,
    refutationRate: crudos.length ? +(refutados / crudos.length).toFixed(2) : 0,
    raw: crudos.length,
    unified: unificados.length,
    undecided: crudos.filter((f) => f.verdict === 'UNDECIDED').length,
    unreviewed: crudos.filter((f) => f.verdict === 'UNREVIEWED').length,
    // De esos indecisos, cuantos lo son por un fallo NUESTRO y no por falta de
    // mayoria. Al lado de `undecided` a proposito: leer uno sin el otro es lo que
    // hacia que un instrumento roto se leyera como una votacion renida.
    undecidedByLostVotes: crudos.filter((f) => f.verdict === 'UNDECIDED' && (f.lostVotes ?? 0) > 0).length,
    orphanVotes: ctx.artifacts?.Adversarial?.payload?.orphanVotes ?? 0,
    disagreements: ctx.artifacts?.Adversarial?.payload?.disagreements ?? 0,
    passes: ctx.artifacts?.Adversarial?.payload?.passes ?? 1,
    // AL LADO DE `passes`, y por eso: `passes` es cuantas VECES se pregunto y
    // `voters` cuantos DISTINTOS contestaron. Publicar solo el primero es lo que
    // hacia que `confirmed: 3` se leyera como consenso de tres cuando eran tres
    // muestras del MISMO modelo -- y del que habia escrito los hallazgos.
    // `null` = la vuelta es anterior al sellado, no «cero votantes».
    voters: ctx.artifacts?.Adversarial?.payload?.voters ?? null,
    // Fase 11 — el ciclo de vida, no solo el recuento.
    convergenceStatus: estado,
    specificationBlocked: specBlock,
    // VEREDICTOS QUE SE INVIRTIERON sobre el MISMO claim. No bloquea --con una
    // tercera familia viva un cambio de voto es reevaluacion legitima-- pero deja
    // de poder no verse. MEDIDO en H-20260824-fa058d63: los tres hallazgos pasaron
    // de CONFIRMED a REFUTED con los claims identicos byte a byte, y la vuelta
    // convergio con eso y salio PASSED.
    unstableVerdicts: veredictosInestables(ctx.crudosPorRonda),
    round: ctx.rondas.length,
    lifecycle: clasificados.counts,
    // EL VEREDICTO TIENE QUE DECIR QUE BLOQUEO. La proyeccion enumeraba seis
    // campos y `claim` no era uno: `11-convergence.json` decia «2 hallazgos
    // P0-P5 confirmados: P2, P4» y quien lo abriera no podia saber cuales. Es el
    // artefacto que decide REWORK; que no diga el motivo lo vuelve un semaforo.
    findings: clasificados.findings.map((f) => ({
      fingerprint: f.fingerprint, scope: f.scope, status: f.status,
      severity: f.severity, file: f.file, symbol: f.symbol, claim: f.claim,
    })),
    reappeared: ciclo.reappeared,
    displaced: ciclo.displaced,
    progress: ciclo.progress,
    rounds: ciclo.rounds,
  };

  if (!bloq.length) {
    ctx.pendientes = [];     // convergio: no queda nada que arrastrar
    return { payload };
  }

  // Se GUARDAN. La ronda siguiente los arrastra a su FindingSet para que haya que
  // refutarlos activamente: sin esto, no volver a reportarlos los mataba, y una
  // vuelta cerro en PASSED por ese camino (H-20260816-e2ec5f67).
  ctx.pendientes = bloq;
  ctx.lifecycle = clasificados.findings;   // lo lee el revisor de la ronda siguiente

  // MAS REINTENTOS NO ARREGLAN NI UN CICLO NI UNA SPEC INCOHERENTE. En los dos
  // casos la etapa ENDURECE su onFail a STOP: reintentar produce mas de lo
  // mismo, y el presupuesto de REWORK existe para hallazgos que una correccion
  // puede cerrar. Subir MAX_REWORK aqui seria comprar mas vueltas del ciclo.
  const detener = specBlock || ciclo.status === 'OSCILLATING';
  const motivo = specBlock
    ? `SPECIFICATION_BLOCKED en la ronda ${ctx.rondas.length}: ${specBlock.why}`
    : ciclo.status === 'OSCILLATING'
      ? `OSCILLATING en la ronda ${ctx.rondas.length}: ${ciclo.reappeared.length} hallazgo(s) `
        + `reaparecieron tras darse por cerrados (${ciclo.reappeared.join(' · ')}). `
        + 'Un reintento mas produce otra vuelta del mismo ciclo'
      : `${bloq.length} hallazgo(s) P0-P5 confirmados: ${bloq.map((f) => f.severity).join(', ')}`
        + ` — ${ciclo.status}, ronda ${ctx.rondas.length}`;

  return {
    payload,
    status: 'FAIL',
    ...(detener ? { onFail: 'STOP' } : {}),
    reason: motivo,
  };
}

/**
 * Observability — el CAMINO. Consolida lo recorrido HASTA AQUI.
 *
 * Ninguna etapa puede resumir lo que todavia no ha ocurrido, y esta es la que mas
 * lo aparenta. Por eso publica `pendientes`: las etapas que quedan por detras
 * suyo y que su traza NO cubre. Declararlo es la diferencia entre un snapshot
 * honesto y una traza que se lee como completa sin serlo -- el orquestador
 * sustituye este payload al cerrar, cuando ya conoce el recorrido entero.
 */
export async function observability(ctx) {
  const recorridas = Object.values(ctx.artifacts).map((a) => ({
    n: a.n, stage: a.stage, status: a.status, contract: a.contract,
    artifact: `.harness/runs/${ctx.executionId}/${String(a.n).padStart(2, '0')}-${a.stage.toLowerCase()}.json`,
    ms: 0, ...(a.reason ? { reason: a.reason } : {}), ...(a.producedBy ? { producedBy: a.producedBy } : {}),
  }));
  const trace = buildTrace({
    executionId: ctx.executionId,
    startedAt: ctx.startedAt ?? new Date().toISOString(),
    endedAt: new Date().toISOString(),
    verdict: 'IN_PROGRESS',
    stages: recorridas,
  }, { invocations: 1 });
  return { payload: { ...trace, pendientes: (ctx.remaining ?? []).map((s) => s.stage) } };
}

/**
 * CapabilityLayer — que capacidades participaron de verdad.
 *
 * `tools` eran los nombres de las tools de un IDE (Read, Edit, Bash…) copiados
 * del frontmatter: correctos para generar el agente de Kiro, y engañosos aqui,
 * porque leidos en el artefacto parecian herramientas que el harness ejecuta. Se
 * separan: `ideTools` es la superficie del IDE, `harnessTools` es el registro
 * real (policy/tools.json) y `toolsUsed` son las que la vuelta INVOCO.
 *
 * Declarado != ejecutado, y este artefacto tiene que poder distinguirlos.
 */
export async function capabilityLayer(ctx) {
  const llamadas = ctx.artifacts?.Execution?.payload?.toolCalls ?? [];
  return {
    payload: {
      capabilities: Object.keys(ctx.assignments ?? {}),
      ideTools: [...new Set(loadCapabilities().flatMap((c) => c.tools ?? []))],
      harnessTools: [...toolRegistry().keys()],
      toolsUsed: [...new Set(llamadas.filter((c) => c.allowed).map((c) => c.tool))].sort(),
      toolsDenied: [...new Set(llamadas.filter((c) => !c.allowed).map((c) => `${c.tool}:${c.rule}`))].sort(),
      skills: [], plugins: [],
    },
  };
}

/**
 * AdapterLayer — que proveedor sirvio REALMENTE cada capacidad.
 * `invocations` cuenta llamadas hechas, no asignaciones: un proveedor declarado
 * y no invocado no cuenta, y FT-4 lo mide.
 */
export async function adapterLayer(ctx) {
  const bindings = Object.entries(ctx.assignments ?? {}).map(([capability, a]) => ({
    capability,
    provider: a.provider,
    model: a.model,
    invocations: ctx.invocations?.[capability] ?? 0,
  }));
  return { payload: { bindings } };
}

/** Rollback: se llama cuando Execution falla. Descarta el worktree entero. */
export async function rollbackAll(ctx) {
  const ws = ctx.workspace ?? ctx.artifacts?.Sandbox?.payload;
  if (ws?.path) sandbox.remove(ws);
}

// `env` limpio: dentro de un hook, GIT_DIR heredado haria que este git leyera el
// arbol principal en vez del workspace. Mismo defecto que en sandbox.mjs.
export const gitIn = (cwd, ...args) =>
  execFileSync('git', args, {
    cwd: cwd ?? ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, env: sandbox.ENV_LIMPIO(),
  }).trim();
