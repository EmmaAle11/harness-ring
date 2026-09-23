// Learning — los TRES niveles: Capture, Classification, Promotion.
//
// La deuda que cierra: el anillo dependia de una persona para aprender.
//
//   Evidence -> Learning -> [HUMANO] -> memory/
//
// Pero lo contrario tampoco vale. Un anillo que puede reescribir su propia
// memoria sin filtro puede tambien envenenarla, y la vuelta N+1 arranca leyendo
// memory/: un aprendizaje falso promovido se convierte en PREMISA de todo lo que
// venga despues. Por eso hay tres niveles y no uno.
//
//   1 Capture         que ocurrio, en crudo, sin juzgarlo
//   2 Classification  de que clase es y si vale la pena
//   3 Promotion       PROMOTE | REJECT | REVIEW, decidido por politica
//
// Learning NUNCA escribe en memory/. Produce candidatos; promover es un paso
// aparte, con su propia decision y su propio registro.
//
// PURO: sin E/S. Quien lee el disco es el llamante.

/** Un aprendizaje se identifica por su ENUNCIADO normalizado, no por su texto. */
export const claveDe = (texto) =>
  String(texto).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);

// ── Nivel 1 · CAPTURE ───────────────────────────────────────────────────────

/**
 * Extrae las SENALES de una corrida. No decide nada: solo recoge lo que paso.
 *
 * Mirar la traza y no solo el LearningRecord es deliberado: lo que una vuelta
 * enseña casi nunca es lo que el modelo dice que aprendio. Una etapa que fallo
 * dos veces es una senal aunque nadie la mencione.
 */
export function capture(run) {
  if (!run?.trace) return { executionId: run?.executionId ?? null, signals: [] };
  const eid = run.executionId;
  const signals = [];
  const push = (kind, statement, extra = {}) => signals.push({ kind, statement, executionId: eid, ...extra });

  for (const s of run.trace.stages ?? []) {
    if (s.status === 'FAIL') {
      push('failure', `la etapa '${s.stage}' fallo: ${s.reason ?? 'sin motivo'}`, { stage: s.stage });
    }
    if (s.status === 'SKIPPED') {
      push('gap', `la etapa '${s.stage}' se salto: ${s.reason ?? 'sin motivo'}`, { stage: s.stage });
    }
  }

  const conv = run.artifacts?.Convergence?.payload;
  if (conv) {
    push('validation', `convergencia: ${conv.raw ?? 0} hallazgos crudos, ${conv.unified ?? 0} unificados, `
      + `${conv.blockers ?? 0} bloqueantes (refutacion ${conv.refutationRate ?? 0})`);
  }

  const sec = run.artifacts?.Security?.payload;
  for (const f of sec?.findings ?? []) {
    push('vulnerability', f.claim ?? f.title ?? 'hallazgo de seguridad', { severity: f.severity });
  }

  const ev = run.artifacts?.Evidence2?.payload ?? run.artifacts?.Evidence?.payload;
  if (ev?.verdict) push('evidence', `gate ${ev.mode ?? ''} = ${ev.verdict}`.trim());

  // Lo que el modelo DICE que aprendio entra como una senal mas, no como la
  // conclusion: se clasifica con el mismo rasero que las medidas.
  const lr = run.artifacts?.Learning?.payload;
  if (lr?.worthKeeping && lr.lesson) push('lesson', lr.lesson, { declared: true });
  if (lr?.adr) push('decision', lr.adr, { declared: true });

  // Las entradas que Learning propone para memory/ TAMBIEN son senales. Se
  // capturaban `lesson` y `adr` pero no `memoryEntries`, asi que lo que la etapa
  // 16 declaraba digno de guardar no llegaba a ser candidato de nada: quedaba
  // nombrado en el LearningRecord y sin rastro en la tuberia que decide si se
  // promueve. La entrada puede venir como ruta o como el objeto entero.
  for (const e of lr?.memoryEntries ?? []) {
    const texto = typeof e === 'string' ? e : (e?.title ?? e?.path ?? e?.id);
    if (!texto) continue;
    const tipo = typeof e === 'string' ? null : e?.type;
    push(tipo === 'ARCHITECTURE_DECISION' ? 'decision' : 'lesson', texto, {
      declared: true,
      ...(typeof e === 'string' ? { path: e } : { path: e?.path ?? null }),
    });
  }

  return { executionId: eid, signals };
}

// ── Nivel 2 · CLASSIFICATION ────────────────────────────────────────────────

const KIND_A_TIPO = {
  failure: 'FAILURE',
  gap: 'FAILURE',
  validation: 'VALIDATION',
  vulnerability: 'VULNERABILITY',
  evidence: 'VALIDATION',
  lesson: 'CODING_PATTERN',
  decision: 'ARCHITECTURE_DECISION',
};

/**
 * Agrupa senales de VARIAS corridas y decide clase, repetibilidad y confianza.
 *
 * La confianza se DERIVA del numero de corridas distintas que mostraron lo
 * mismo; no la declara el modelo. Un modelo que puntua su propio hallazgo se
 * puntua alto, que es el problema que ADR-004 ya resuelve en Convergence.
 *
 * @param capturas  [{executionId, signals}]  una o mas vueltas
 * @param policy    policy/learning.json
 * @param previas   entradas de memory/ vigentes, para detectar novedad y contradiccion
 */
export function classify(capturas, policy, { previas = [] } = {}) {
  const porClave = new Map();

  for (const c of capturas) {
    for (const s of c.signals) {
      const clave = claveDe(s.statement);
      const y = porClave.get(clave) ?? {
        key: clave, type: KIND_A_TIPO[s.kind] ?? 'PROJECT_FACT',
        statement: s.statement, runs: new Set(), signals: [], paths: new Set(),
      };
      // La ruta propuesta viaja con el candidato: es lo que la promocion
      // necesitara para escribir, y sin ella el candidato no se puede enlazar con
      // la entrada que Learning declaro en `memoryEntries`.
      if (s.path) y.paths.add(s.path);
      y.runs.add(s.executionId);
      y.signals.push(s);
      porClave.set(clave, y);
    }
  }

  const vistos = new Map(previas.map((p) => [claveDe(p.statement ?? p.title ?? ''), p]));

  return [...porClave.values()].map((y) => {
    const nRuns = y.runs.size;
    const conf = Math.min(
      policy.confidenceByRuns[String(Math.min(nRuns, 3))] ?? policy.confidenceByRuns['1'],
      policy.maxConfidence,
    );
    const previo = vistos.get(y.key);
    // Contradiccion = ya existe una entrada con el mismo enunciado y signo opuesto.
    const contradiccion = Boolean(previo) && previo.negated !== undefined && previo.negated !== false;

    return {
      type: y.type,
      key: y.key,
      candidate: y.statement,
      confidence: conf,
      repeatable: nRuns >= 2,
      novel: !previo,
      contradiction: contradiccion,
      evidence: [...y.runs].sort(),
      paths: [...y.paths].sort(),
      // `worthKeeping` es una PROPUESTA; quien decide es la politica de promocion.
      worthKeeping: !policy.excluded.includes(y.type),
    };
  });
}

// ── Nivel 3 · PROMOTION ─────────────────────────────────────────────────────

export const VEREDICTOS = ['PROMOTE', 'REJECT', 'REVIEW'];

/**
 * Resuelve un candidato. NO escribe: devuelve el veredicto y su motivo.
 *
 * REVIEW no es un empate ni un "no se": es el resultado correcto cuando la
 * pregunta no la puede contestar un umbral. Un ADR o una contradiccion necesitan
 * criterio, y fingir que un numero lo sustituye es como se promueve una premisa
 * falsa a la vuelta siguiente.
 */
export function promote(candidato, policy) {
  const t = policy.types[candidato.type];

  if (policy.excluded.includes(candidato.type)) {
    return { verdict: 'REJECT', reason: `clase '${candidato.type}' excluida de memory/ por decision del repo` };
  }
  if (!t) {
    return { verdict: 'REVIEW', reason: `clase '${candidato.type}' sin politica declarada` };
  }
  if (candidato.contradiction) {
    return { verdict: 'REVIEW', reason: 'contradice una entrada vigente: o la vieja estaba mal, o esta lo esta' };
  }
  if (!candidato.worthKeeping) {
    return { verdict: 'REJECT', reason: 'el propio candidato se declara no conservable' };
  }
  if (!candidato.novel) {
    return { verdict: 'REJECT', reason: 'ya existe una entrada con este enunciado' };
  }
  if (candidato.confidence < t.minConfidence) {
    return {
      verdict: 'REVIEW',
      reason: `confianza ${candidato.confidence} < ${t.minConfidence} exigido para ${candidato.type}`
        + ` (visto en ${candidato.evidence.length} corrida(s))`,
    };
  }
  if (!t.autoPromote) {
    return { verdict: 'REVIEW', reason: t.why };
  }
  return { verdict: 'PROMOTE', reason: `${candidato.type} con confianza ${candidato.confidence}`, dir: t.dir };
}

/**
 * PROVENANCE. Sin esto memory/ es documentacion; con esto es memoria basada en
 * evidencia: se sabe de que corrida salio, con que, quien la promovio y cuando.
 * Una entrada sin origen no se puede revisar ni retirar.
 */
export function provenance(candidato, { promotedBy, model = null, date }) {
  return {
    origin: 'harness',
    execution_id: candidato.evidence[candidato.evidence.length - 1] ?? null,
    evidence: candidato.evidence,
    date,
    agent: promotedBy,
    model,
    confidence: candidato.confidence,
    promoted_by: promotedBy,
  };
}

/** Un candidato resuelto, listo para escribir o para archivar como rechazado. */
export function decide(capturas, policy, opts = {}) {
  return classify(capturas, policy, opts).map((c) => ({ ...c, decision: promote(c, policy) }));
}
