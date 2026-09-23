// Los cinco fitness tests — demuestran que el anillo cerro SOLO.
//
// No son tests de unidad: se evaluan sobre una CORRIDA en .harness/runs/<id>/.
// Cada uno devuelve {id, pass, detail[]}, y `detail` dice por que, tanto si pasa
// como si no. Un fitness test que solo dice "FAIL" obliga a reconstruir a mano
// lo que ya sabia.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, RUNTIME } from './capabilities.mjs';
import { loadRun, checkTrace } from './trace.mjs';
import { mainTreeFingerprint } from './sandbox.mjs';

const T = (pass, ...detail) => ({ pass, detail });

/** FT-1 · El anillo recorrio las 16 etapas. */
export function ft1(run, manifest) {
  if (!run?.trace) return T(false, 'sin ExecutionTrace: la etapa Observability no produjo nada');
  const p = checkTrace(run.trace, manifest);
  return p.length
    ? T(false, ...p)
    : T(true, `${run.trace.stages.length}/${manifest.stages.length} etapas, en orden, con artefacto`);
}

/** FT-2 · Cero intervencion humana. */
export function ft2(run) {
  const t = run?.trace;
  if (!t) return T(false, 'sin traza');
  const d = [];
  if (t.awaitingHuman?.length) d.push(`${t.awaitingHuman.length} pausas esperando a una persona`);
  if (t.invocations !== 1) d.push(`${t.invocations} invocaciones humanas; una vuelta autonoma es 1`);
  // Commit y Deploy NO estan en el anillo (regla #16): su ausencia no cuenta.
  return d.length ? T(false, ...d) : T(true, 'una sola orden, cero pausas humanas');
}

/** FT-3 · El arbol principal no cambio. */
export function ft3(run, manifest, { fingerprintAntes } = {}) {
  const ws = run?.artifacts?.Sandbox?.payload;
  const cs = run?.artifacts?.Execution?.payload;
  if (!ws) return T(false, 'sin Workspace: la etapa Sandbox no produjo nada');

  const d = [];
  if (fingerprintAntes !== undefined && mainTreeFingerprint() !== fingerprintAntes) {
    d.push('el arbol principal CAMBIO durante la corrida');
  }
  for (const f of cs?.files ?? []) {
    const abs = f.startsWith('/') ? f : join(ws.path, f);
    if (!abs.startsWith(ws.path)) d.push(`'${f}' se escribio FUERA del workspace`);
    const prohibido = (manifest.task?.forbiddenPaths ?? [])
      .some((g) => f.startsWith(g.replace('/**', '/')));
    if (prohibido) d.push(`'${f}' esta en forbiddenPaths`);
    // NO se comprueba `existsSync(ROOT/f)`: la mayoria de los ficheros que toca
    // el builder YA existen en el arbol principal -- los modifica, no los crea.
    // Esa comprobacion marcaba `scripts/gate.sh` como fuga siendo una edicion
    // legitima. Quien detecta una fuga real es la huella de arriba, que compara
    // el arbol ANTES y DESPUES; esto era redundante y ademas falso.
  }
  return d.length
    ? T(false, ...d)
    : T(true, `${(cs?.files ?? []).length} fichero(s), todos dentro del workspace`);
}

/**
 * FT-4 · Diversidad de proveedor, y todo lo asignado se invocó de verdad.
 *
 * NO lleva una lista de proveedores fija: la política del router cambia (el
 * 2026-08-14 pasó de local-first a Claude-first con DeepSeek para revisar) y un
 * fitness test con la lista hardcodeada mide la política de ayer. Lo que se
 * comprueba es invariante: ≥2 proveedores distintos, builder ≠ reviewer, y cero
 * asignaciones sin invocar.
 */
export function ft4(run) {
  const b = run?.artifacts?.AdapterLayer?.payload?.bindings;
  if (!b) return T(false, 'sin AdapterBinding: no se registro que proveedor sirvio cada capacidad');

  const lista = Array.isArray(b) ? b : Object.values(b);
  const usados = lista.filter((x) => (x.invocations ?? 0) > 0);
  const proveedores = new Set(usados.map((x) => x.provider));
  const d = [];

  // Un proveedor asignado y nunca invocado es codigo que parece existir.
  for (const x of lista) {
    if (!(x.invocations > 0)) d.push(`'${x.capability}' asignado a ${x.provider} y NUNCA invocado`);
  }
  if (proveedores.size < 2) {
    d.push(`solo ${proveedores.size} proveedor(es) invocado(s): ${[...proveedores].join(', ') || 'ninguno'}`);
  }

  const prov = (cap) => lista.find((x) => x.capability === cap)?.provider;
  const [pb, pr] = [prov('builder'), prov('reviewer')];
  if (!pb || !pr) d.push('falta el binding de builder o de reviewer');
  else if (pb === pr) d.push(`builder y reviewer compartieron proveedor '${pb}' (ADR-003)`);

  // La INDEPENDENCIA del refutador (Fase 11) se REPORTA, no se exige. ADR-003 es
  // «el revisor no comparte modelo con el escritor» y eso ya se comprueba arriba;
  // que ademas exista una TERCERA familia para refutar es una mejora, y su
  // ausencia es un estado declarado (`DEGRADED`), no un incumplimiento. Hacerlo
  // fallar aqui convertiria una degradacion honesta en un rojo, y el incentivo
  // pasaria a ser no declararla.
  const ind = run?.artifacts?.Compute?.payload?.independence ?? null;
  const nota = ind
    ? ` · refutacion ${ind.status} en ${ind.adversarial} (${ind.families.length} familias: ${ind.families.join(', ')})`
    : ' · sin registro de independencia: la vuelta es anterior a la Fase 11';

  return d.length
    ? T(false, ...d)
    : T(true, `${proveedores.size} proveedores: ${[...proveedores].join(', ')} · builder=${pb} reviewer=${pr}${nota}`);
}

/**
 * FT-5 · La vuelta N+1 empieza donde termino la N.
 * EXIGE una segunda corrida: es el unico que un flujo lineal NO pasaria.
 */
export function ft5(run, _manifest, { next } = {}) {
  const lr = run?.artifacts?.Learning?.payload;
  if (!lr) return T(false, 'sin LearningRecord: el anillo no cerro, quedo un arco');
  if (lr.worthKeeping === undefined) return T(false, 'LearningRecord sin decidir `worthKeeping`');

  // Una entrada puede venir como ruta suelta o como el objeto entero de la
  // entrada de memory (con `path`, `id`, `title`…). El test asumia string y
  // lanzaba `The "path" argument must be of type string` al recibir un objeto:
  // FT-5 no fallaba, se ROMPIA, que es peor -- un test que revienta no dice si la
  // propiedad se cumple. El contrato no obliga a una forma, asi que se aceptan
  // las dos y se normaliza aqui.
  const rutaDe = (e) => (typeof e === 'string' ? e : e?.path ?? e?.ruta ?? e?.id ?? null);
  const entradas = (lr.memoryEntries ?? []).map(rutaDe).filter(Boolean);

  // Lo que se exige es que el aprendizaje quede REGISTRADO de forma auditable, no
  // que ya este en memory/.
  //
  // Learning NO escribe en memory/ por diseno (policy/learning.json:
  // learningNeverWritesMemoryDirectly): produce candidatos y la promocion es un
  // paso aparte con su propia decision. Exigir el fichero en memory/ contradecia
  // esa regla y volvia FT-5 imposible de pasar salvo escribiendo a mano lo que el
  // anillo tiene prohibido escribir solo.
  //
  // Sirve cualquiera de los dos rastros: la entrada YA promovida en memory/, o el
  // candidato resuelto en .harness/learning/<id>.json. Lo que no sirve es que no
  // haya rastro de ninguno.
  const candidatos = join(RUNTIME, 'learning', `${run.executionId}.json`);
  const registrado = existsSync(candidatos) ? readFileSync(candidatos, 'utf8') : '';

  const d = [];
  if (lr.worthKeeping) {
    for (const e of entradas) {
      const enMemory = existsSync(join(ROOT, e));
      const enCandidatos = registrado.includes(e) || registrado.includes(e.split('/').pop().replace(/\.md$/, ''));
      if (!enMemory && !enCandidatos) {
        d.push(`declara '${e}' y no hay rastro ni en memory/ ni en los candidatos de la vuelta`);
      }
    }
    if (!entradas.length) d.push('worthKeeping=true pero no nombra ninguna entrada');
  }

  if (!next) {
    return T(false, ...d, 'falta la SEGUNDA corrida: sin ella no se demuestra que sea un anillo');
  }
  const cita = JSON.stringify(next.artifacts?.Knowledge?.payload ?? {});
  if (!cita.includes(run.executionId) && !entradas.some((e) => cita.includes(e))) {
    d.push(`la corrida ${next.executionId} no cita nada de ${run.executionId}: la flecha Learning->Knowledge no existe`);
  }
  return d.length ? T(false, ...d) : T(true, `${next.executionId} consume lo que ${run.executionId} aprendio`);
}

const TESTS = [
  ['FT-1', 'El anillo recorrio las 16 etapas', ft1],
  ['FT-2', 'Cero intervencion humana', ft2],
  ['FT-3', 'El arbol principal no cambio', ft3],
  // El nombre decia "Tres proveedores" y la comprobacion exige DOS desde que la
  // politica paso a Claude-first (ver ft4). Un rotulo que promete mas que su
  // asercion es la misma clase de defecto que el fix que no existe: se lee el
  // nombre y se cree cubierto algo que nadie comprueba.
  ['FT-4', 'Diversidad de proveedor, y nada asignado sin invocar', ft4],
  ['FT-5', 'La vuelta N+1 empieza donde termino la N', ft5],
];

export function runFitness(executionId, manifest, opts = {}) {
  const run = loadRun(executionId);
  if (!run) return { executionId, pass: false, results: [], error: `corrida no encontrada: ${executionId}` };

  const next = opts.nextId ? loadRun(opts.nextId) : null;
  const results = TESTS.map(([id, name, fn]) => {
    let r;
    try {
      r = fn(run, manifest, { ...opts, next });
    } catch (e) {
      r = T(false, `el fitness test lanzo: ${e.message}`);
    }
    return { id, name, pass: r.pass, detail: r.detail };
  });

  return { executionId, pass: results.every((r) => r.pass), results };
}
