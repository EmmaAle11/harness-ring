// SecurityFinding — la severidad NO la decide el scanner, y NO la decide un modelo.
//
// Un scanner dice `high` con su propio criterio, que no conoce este sistema. Un
// modelo dice lo que le parece. Aqui se traduce todo a la escala del repo
// (P0-P5) con `policy/security.json`, que es un fichero versionado y revisable.
//
// LA REGLA: `scanner output -> PASS` no existe. Todo hallazgo pasa por la
// politica, y la politica dice si bloquea. Sin este paso, el gate seria una copia
// del criterio de un tercero que puede cambiar sin que nadie lo commitee.
//
// PURO: sin E/S y sin ejecutar scanners. Quien los corre es security-scan.mjs.

/** El contrato. Un hallazgo al que le falte algo de esto no es un hallazgo. */
export const CAMPOS = [
  'id', 'source', 'rule', 'severity', 'confidence',
  'path', 'location', 'evidence', 'impact', 'remediation', 'status',
];

const SEV = ['P0', 'P1', 'P2', 'P3', 'P4', 'P5'];
export const peorQueOIgual = (a, b) => SEV.indexOf(a) <= SEV.indexOf(b);

/**
 * Severidad del repo a partir de la del scanner. `unknown` cae en P3 a
 * proposito: lo que no se sabe clasificar no se archiva como leve.
 */
export const severidadDe = (bruta, policy) =>
  policy.severity[String(bruta ?? '').toLowerCase()] ?? policy.severity.unknown ?? 'P3';

/** Identidad estable de un hallazgo, para poder deduplicar entre corridas. */
export const securityKey = (f) => `${f.source}|${f.rule}|${f.path}|${f.location ?? ''}`;

// ── Normalizadores, uno por fuente ──────────────────────────────────────────
// Cada scanner habla lo suyo; nada cruza la frontera sin la forma comun. Es la
// misma decision que el contrato de los adaptadores de modelo: mientras cada uno
// tuviera su propia forma, el harness no podia tratarlos igual.

/** semgrep --json -> SecurityFinding[] */
export function deSemgrep(salida, policy) {
  return (salida?.results ?? []).map((r, i) => {
    const meta = r.extra?.metadata ?? {};
    return {
      id: `sast:${i + 1}`,
      source: 'sast',
      tool: 'semgrep',
      rule: String(r.check_id ?? '').split('.').pop(),
      severity: severidadDe(r.extra?.severity, policy),
      rawSeverity: r.extra?.severity ?? null,
      confidence: meta.confidence ?? 'CONFIRMED',
      path: r.path,
      location: `${r.start?.line ?? '?'}:${r.start?.col ?? '?'}`,
      evidence: String(r.extra?.lines ?? '').trim().slice(0, 300),
      impact: String(r.extra?.message ?? '').trim().replace(/\s+/g, ' '),
      remediation: meta.seguro ?? 'ver el mensaje de la regla',
      owasp: meta.owasp ?? null,
      status: 'OPEN',
    };
  });
}

/**
 * `npm audit --json` -> SecurityFinding[].
 *
 * Se emite UNO por paquete vulnerable, no uno por CVE: npm reporta la misma
 * cadena transitiva muchas veces y un hallazgo por aparicion convierte el
 * informe en ruido.
 */
export function deNpmAudit(salida, policy, { scope = 'fe' } = {}) {
  return Object.entries(salida?.vulnerabilities ?? {})
    .filter(([, v]) => v?.severity && v.severity !== 'info')
    .map(([nombre, v], i) => ({
      id: `sca-${scope}:${i + 1}`,
      source: 'sca',
      tool: 'npm audit',
      rule: nombre,
      severity: severidadDe(v.severity, policy),
      rawSeverity: v.severity,
      confidence: 'CONFIRMED',
      path: scope === 'be' ? 'backend/package.json' : 'package.json',
      location: nombre,
      evidence: `${nombre}@${v.range ?? '?'} · via ${(Array.isArray(v.via) ? v.via : [])
        .map((x) => (typeof x === 'string' ? x : x?.title ?? x?.name)).filter(Boolean).slice(0, 2).join(', ') || 'directa'}`,
      impact: `dependencia ${v.isDirect ? 'directa' : 'transitiva'} con vulnerabilidad ${v.severity}`,
      remediation: v.fixAvailable
        ? (typeof v.fixAvailable === 'object' ? `npm i ${v.fixAvailable.name}@${v.fixAvailable.version}` : 'npm audit fix')
        : 'sin arreglo publicado todavia',
      fixAvailable: Boolean(v.fixAvailable),
      status: 'OPEN',
    }));
}

/** El barrido de secretos del propio harness -> SecurityFinding[] */
export function deSecretos(hallazgos, policy, { path = '(diff de la vuelta)' } = {}) {
  return (hallazgos ?? []).map((h, i) => ({
    id: `secret:${i + 1}`,
    source: 'secrets',
    tool: 'harness',
    rule: h.kind,
    // Un secreto NO se gradua: la politica le da la maxima y el gate de
    // `secrets` bloquea a cualquier severidad. No hay credencial leve.
    severity: 'P0',
    rawSeverity: 'critical',
    confidence: 'CONFIRMED',
    path: h.path ?? path,
    location: h.sample ?? '',
    evidence: `patron de ${h.kind} detectado`,
    impact: 'una credencial en el arbol es una credencial comprometida',
    remediation: 'retirar del codigo, rotar la clave y moverla a .env',
    status: 'OPEN',
  }));
}

// ── La politica ─────────────────────────────────────────────────────────────

/**
 * ¿Aplica alguna excepcion a este hallazgo?
 *
 * Una excepcion NO es un silencio: lleva motivo, caducidad y dueno. Caducada,
 * vuelve a bloquear -- que es lo unico que impide que una deuda aceptada se
 * convierta en una deuda olvidada.
 */
export function excepcionPara(f, policy, hoy) {
  return (policy.exceptions ?? []).find((e) =>
    e.scope === f.source
    // El hallazgo no puede ser MAS grave que el techo de la excepcion. Una
    // excepcion sin techo perdonaria tambien lo que aparezca manana, que es como
    // una deuda aceptada se convierte en una politica desactivada.
    && (!e.severityAtMost || peorQueOIgual(e.severityAtMost, f.severity))
    && String(e.expires) >= String(hoy)) ?? null;
}

export const GATES = ['BLOCK', 'WARN', 'ALLOW'];

/**
 * El veredicto de UN hallazgo. Tres respuestas y ninguna por defecto.
 *
 * El umbral va por FUENTE porque el coste del error no es el mismo: un patron
 * que esta vuelta acaba de escribir se corrige en esta vuelta; una CVE heredada
 * en una dependencia transitiva no la puede resolver el builder desde
 * `task.files`, y bloquear con ella seria detener el anillo por algo ajeno.
 */
export function decidirHallazgo(f, policy, { hoy = '1970-01-01' } = {}) {
  const gate = policy.gates?.[f.source];
  if (!gate) return { gate: 'WARN', why: `sin umbral declarado para la fuente '${f.source}'` };

  const bloquea = peorQueOIgual(f.severity, gate.block);
  if (!bloquea) return { gate: 'WARN', why: `${f.severity} no alcanza el umbral ${gate.block} de '${f.source}'` };

  const exc = excepcionPara(f, policy, hoy);
  if (exc) {
    return { gate: 'WARN', why: `excepcion ${exc.id}, caduca ${exc.expires}`, exception: exc.id, expires: exc.expires };
  }
  return { gate: 'BLOCK', why: `${f.severity} alcanza el umbral ${gate.block} de '${f.source}'` };
}

/**
 * El veredicto del conjunto. Devuelve los hallazgos ya decididos y el resumen.
 * NUNCA convierte «el scanner no dijo nada» en PASS por si solo: eso lo decide
 * quien sabe si el scanner llego a ejecutarse.
 */
export function aplicarPolitica(findings, policy, { hoy = '1970-01-01' } = {}) {
  const decididos = (findings ?? []).map((f) => ({ ...f, decision: decidirHallazgo(f, policy, { hoy }) }));
  const de = (g) => decididos.filter((f) => f.decision.gate === g);
  return {
    findings: decididos,
    blocked: de('BLOCK'),
    warned: de('WARN'),
    gate: de('BLOCK').length ? 'BLOCK' : de('WARN').length ? 'WARN' : 'ALLOW',
    counts: {
      total: decididos.length,
      block: de('BLOCK').length,
      warn: de('WARN').length,
      porFuente: decididos.reduce((a, f) => ({ ...a, [f.source]: (a[f.source] ?? 0) + 1 }), {}),
      conExcepcion: decididos.filter((f) => f.decision.exception).length,
    },
  };
}

/** Excepciones caducadas: dejan de proteger y hay que verlo venir. */
export const excepcionesCaducadas = (policy, hoy) =>
  (policy.exceptions ?? []).filter((e) => String(e.expires) < String(hoy));
