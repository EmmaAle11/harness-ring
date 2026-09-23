// Las nueve etapas DE MODELO del anillo.
//
// Knowledge · Evidence · Decision · Plan · Execution · Validation · Adversarial ·
// Security · Learning.
//
// Todas pasan por `invokeCapability`, que arma el prompt con el cuerpo del .md de
// la capacidad + las entradas + la forma exacta del contrato, y RECHAZA lo que no
// cumpla. Si tras el reintento sigue sin cumplir, la etapa FALLA: no se inventa
// un payload para que el anillo avance.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { ROOT, loadCapabilities, loadSurfacePolicy } from './capabilities.mjs';
import { invokeCapability } from './invoke.mjs';
import { assertWithinBoundary } from './capability-contract.mjs';
import { sinArtefactosDeBuild, diffSinArtefactosDeBuild } from './artefactos-de-build.mjs';
import { toolLoop, presupuestoDe } from './agentic.mjs';
import { loadToolPolicy } from './tools.mjs';
import { ENV_LIMPIO } from './sandbox.mjs';
import { PASADAS, unificarVotos, arrastrar, avisoDeArrastre, enSerie } from './adversarial.mjs';
import { avisoDeCicloDeVida, idsDe } from './findings.mjs';
import { analizar, assertSuperficie, claseDe } from './surface.mjs';
import { repartir, fusionar, cierre } from './fanout.mjs';
import { aplicarPolitica, excepcionesCaducadas } from './security.mjs';
import { destinoDeSemillas, resumenDeSemillas, veredictoDeSemillas } from './semillas.mjs';
import { escanear, resumen, loadSecurityPolicy } from './security-scan.mjs';
import * as sandbox from './sandbox.mjs';
import { carearConGit, hashDe } from './mutation.mjs';

const cap = (id) => loadCapabilities().find((c) => c.id === id);

/** Cuenta invocaciones reales por capacidad: es lo que AdapterLayer registra. */
function contar(ctx, id, n = 1) {
  ctx.invocations ??= {};
  ctx.invocations[id] = (ctx.invocations[id] ?? 0) + n;
}

/**
 * Resuelve el modelo de una capacidad.
 *
 * Compute (etapa 5) decide quien ejecuta LA TASK -- es decir, la pareja
 * builder/reviewer y su diversidad obligatoria (ADR-003). Las etapas
 * preparatorias (1-4) corren ANTES y resuelven su modelo por si mismas: son
 * lectura y diseno, no ejecucion, y no hay diversidad que imponer.
 *
 * Esto salio al correr el anillo por primera vez: el manifiesto daba dueno de
 * modelo a las etapas 1-4 y Compute era la 5, asi que Knowledge fallaba pidiendo
 * una asignacion que aun no existia. Leer el anillo no lo revelo; ejecutarlo si.
 */
async function resolverModelo(ctx, capId) {
  if (ctx.assignments?.[capId]) return ctx.assignments[capId];

  const { loadRouter, loadCatalog } = await import('./capabilities.mjs');
  const { resolveModel } = await import('./router.mjs');
  const { probeAll, aliveSet, modelSet } = await import('../adapters/models/index.mjs');

  // `catalog` y `models` no son opcionales: sin catalogo, Compute no puede
  // razonar sobre capacidades del modelo. Este llamante se quedo atras cuando la
  // seleccion paso a ser una tuberia, y la vuelta murio en la etapa 1 con
  // "Cannot read properties of undefined (reading 'models')" -- otra vez un
  // consumidor olvidado, y otra vez lo encontro EJECUTAR, no leer.
  if (!ctx.__probes) {
    ctx.__probes = await probeAll();
    ctx.__vivos = aliveSet(ctx.__probes);
    ctx.__instalados = modelSet(ctx.__probes);
  }
  const m = resolveModel(cap(capId), {
    router: loadRouter(), catalog: loadCatalog(),
    available: ctx.__vivos, models: ctx.__instalados,
  });
  if (m.error) throw new Error(m.error);
  return { provider: m.provider, model: m.model, id: m.id };
}


// ── C-4 · toda frontera hacia un modelo es lista blanca ──────────────────────
/**
 * LA TABLA DE PROYECCIONES, y el motivo de que exista una tabla en vez de cinco
 * helpers sueltos.
 *
 * `paraRevisar` y `paraIntencion` se invirtieron a lista blanca cuando el
 * `changeSurface` de la Fase 11 se colo entero hacia el revisor y tumbo la vuelta
 * H-20260818-040baf77. Pero el arreglo cubria DOS de las trece entradas: las
 * otras once seguian pasando el artefacto COMPLETO -- `ctx.artifacts.Evidence`,
 * `ctx.artifacts.Convergence`-- porque nadie habia mirado ahi.
 *
 * Una frontera que hay que acordarse de invocar no es una frontera. Aqui la
 * aplica `pedir`, que es el UNICO camino hacia un modelo, y una entrada sin
 * proyeccion declarada LANZA en vez de viajar entera. Falla en cerrado.
 *
 * Lo que se quita no es capricho:
 *   - `graph` / `hotspots` del baseline son Graphify, que ADR-006 declara
 *     evidencia derivada y NO autoridad: un hallazgo que se apoya ahi se apoya
 *     en nada.
 *   - `sbom` del EvidencePackage son cientos de KB de dependencias para una
 *     etapa que escribe un aprendizaje de una linea.
 *   - `raw`, `unified` y `lifecycle` del Verdict son el material de trabajo de
 *     la convergencia, no su conclusion.
 */
export const PROYECCIONES = {
  // Construidos en el sitio, no son artefactos: la lista es su forma entera.
  RepoRef: ['repo', 'commit'],
  Contexto: ['rondaAnterior', 'seguridadBloqueo'],

  Controles: ['controles', 'gate', 'counts'],

  ArchitectureBaseline: ['scope', 'facts', 'unknowns'],
  FactSet: ['facts'],
  // `alternatives` fuera: al que planifica le sirve lo que se DECIDIO, no lo que
  // se descarto.
  DecisionRecord: ['id', 'title', 'context', 'decision', 'consequences'],
  EvidencePackage: ['sha', 'branch', 'mode', 'verdict', 'checks', 'summary'],
  Verdict: ['pass', 'blockers', 'refutationRate', 'convergenceStatus', 'round'],
  // La refutacion ve los hallazgos y NADA de la contabilidad de la ronda que los
  // produjo: `counts`, `passes` o `unreviewed` le dirian cuantos ya cayeron, y una
  // pasada que sabe el marcador no es independiente.
  FindingSet: ['findings'],
  SecurityReport: ['sca', 'sbom', 'sast', 'owasp', 'findings'],

  // Las dos que no son una lista de campos sino un calculo: `toolCallCount` en
  // vez de `toolCalls`, `files` derivado de `contents`. Viven abajo, con su
  // historia.
  Intencion: (art) => paraIntencion(art),
  ChangeSet: (art) => paraRevisar(art),
};

/** Aplica la proyeccion declarada. Sin entrada en la tabla, no pasa. */
/**
 * El contenido de un fichero en HEAD, hasheado IGUAL que lo hace la bitacora.
 *
 * `carearConGit` lo usa para distinguir una RESTAURACION de un fantasma: si el
 * `after` de una mutacion coincide con esto, el modelo escribio y dejo el
 * fichero como estaba, que es exactamente lo que se le pidio en una vuelta
 * sembrada. Comparar contra el blob de git NO servia: git hashea con su propia
 * cabecera y la bitacora hashea el contenido crudo, asi que nunca coincidirian.
 *
 * Devuelve null --y entonces el careo se mantiene conservador y reporta-- si el
 * fichero no existe en HEAD o git falla.
 */
function lectorDeHead(ws) {
  return (ruta) => {
    try {
      // ENV_LIMPIO NO ES OPCIONAL. Dentro de un hook de git, GIT_DIR y
      // GIT_INDEX_FILE estan exportados y apuntan al repo PRINCIPAL: sin
      // limpiarlos, este `git show` leeria el HEAD equivocado y el careo
      // compararia contra el arbol de otro. Lo caza `stages.test.mjs`:
      // «nada del harness llama a git sin ENV_LIMPIO», y me cazo a mi.
      const buf = execFileSync('git', ['show', `HEAD:${ruta}`], {
        cwd: ws?.path ?? ROOT, maxBuffer: 64 * 1024 * 1024, env: ENV_LIMPIO(),
      });
      return hashDe(buf);
    } catch { return null; }
  };
}

export function proyectar(nombre, art) {
  const regla = PROYECCIONES[nombre];
  if (!regla) {
    throw new Error(
      `entrada '${nombre}' sin proyeccion declarada en PROYECCIONES: `
      + 'una frontera hacia un modelo es lista blanca, y lo no declarado no viaja',
    );
  }
  if (typeof regla === 'function') return regla(art);
  const cuerpo = art?.payload ?? art;
  if (cuerpo == null || typeof cuerpo !== 'object') return art;
  const visto = Object.fromEntries(regla.filter((k) => k in cuerpo).map((k) => [k, cuerpo[k]]));
  return art?.payload ? { ...art, payload: visto } : visto;
}

async function pedir(ctx, capId, { stage, contract, inputs, extra, exige }) {
  const asign = await resolverModelo(ctx, capId);

  contar(ctx, capId);
  // TODA entrada pasa por su proyeccion declarada. No es un recorte opcional que
  // cada etapa recuerda aplicar: es la unica puerta, y lo no declarado lanza.
  const proyectados = Object.fromEntries(
    Object.entries(inputs ?? {}).map(([k, v]) => [k, proyectar(k, v)]),
  );

  // Sin `reduccion`: la resuelve invokeCapability desde el CONTRATO
  // (policy/tools.json:output.reduccion). Aqui era una excepcion de la etapa 8.
  const r = await invokeCapability(cap(capId), asign, { stage, contract, inputs: proyectados, extra, exige });
  if (!r.ok) throw new Error(`${capId} no produjo un ${contract} valido: ${r.error}`);

  return { payload: r.payload, producedBy: { capability: capId, ...asign, intento: r.intento } };
}

/**
 * Lo que un ArchitectureBaseline tiene que CITAR, no solo contener.
 *
 * PURO y exportado: comprobarlo a traves de la etapa exigiria una vuelta de veinte
 * minutos, y es exactamente la clase de regla que se rompe en silencio.
 */
export function exigenciasDeKnowledge(previo, rutas = null) {
  return (payload) => {
    const texto = JSON.stringify(payload ?? {});
    const faltan = [];
    const citadas = [...new Set(texto.match(/memory\/[\w./-]+\.md/g) ?? [])];
    if (!citadas.length) {
      faltan.push('no cita ninguna entrada de memory/ POR SU RUTA (p.ej. memory/architecture/current-state.md): sin cita, no leyo nada');
    } else if (rutas === null) {
      // SIN ARBOL DELANTE no se puede comprobar el hecho, solo la forma. Es
      // deliberado y esta declarado: hay llamadas --tests, herramientas-- que no
      // tienen el repositorio a mano. Lo que NO vale es confundirlo con el caso
      // de abajo.
    } else if (!rutas.length) {
      // COMPROBE Y NO HAY NADA. Distinto de «no habia con que comprobar», y la
      // diferencia es justo la que se pierde cuando un control falla abierto: sin
      // esta rama, un arbol SIN memory/ aceptaba cualquier cita inventada y salia
      // igual de verde que uno donde la cita es correcta.
      faltan.push('no hay NINGUNA entrada de memory/ en el arbol: la etapa 1 no puede leer '
        + 'conocimiento durable, asi que la cita no se puede comprobar contra nada');
    } else {
      // LA RUTA TIENE QUE EXISTIR, y esto comprobaba solo su FORMA.
      //
      // `/memory\/[\w./-]+\.md/` se satisface con `memory/inventada/no-existe.md`.
      // O sea que la puerta que existe para demostrar que el modelo LEYO se podia
      // pasar escribiendo algo con pinta de ruta -- y una cita inventada en un
      // artefacto de auditoria es peor que ninguna: la siguiente etapa la lee como
      // un hecho comprobado.
      //
      // Salio al centralizar `memory/`: un espejo con 85 entradas de 101 no es un
      // indice pequeno, es un indice desde el que se puede citar una ruta que en
      // otro arbol no existe.
      const inventadas = citadas.filter((c) => !rutas.includes(c));
      if (inventadas.length) {
        faltan.push(`cita rutas de memory/ que NO EXISTEN: ${inventadas.join(', ')}. `
          + 'Una cita inventada no demuestra lectura: la desmiente');
      }
    }
    if (previo?.executionId && !texto.includes(previo.executionId)) {
      faltan.push(`no cita '${previo.executionId}', la vuelta anterior, en \`facts\`: `
        + 'esa cita es la flecha Learning->Knowledge y es lo que hace de esto un anillo. '
        + 'Si aquella cerro con worthKeeping=false, dilo -- no tener leccion es un resultado');
    }
    return faltan;
  };
}

// ── 1. Knowledge ─────────────────────────────────────────────────────────────
export const knowledge = (ctx) => {
  // Consume el LearningRecord de la vuelta anterior si existe: es la flecha que
  // convierte el recorrido en anillo, y FT-5 comprueba que se use.
  const previo = ctx.previousLearning ?? null;
  // EL INDICE ENTERO, y si no cabe se DICE.
  //
  // Estaba en `.slice(0, 12000)` con un README que el 2026-08-23 media 26 389
  // chars y sigue creciendo con cada entrada: el modelo veia
  // menos de la MITAD del indice que la puerta de esta etapa le exige citar, y el
  // recorte no aparecia en ninguna parte. La etapa 1 es la unica lectura de
  // conocimiento durable que hace una vuelta, asi que lo que se pierde aqui no se
  // recupera en ninguna de las quince siguientes.
  const TOPE_INDICE = 30000;
  const crudo = existsSync(join(ROOT, 'memory', 'README.md'))
    ? readFileSync(join(ROOT, 'memory', 'README.md'), 'utf8') : '';
  const indice = crudo.length <= TOPE_INDICE ? crudo
    : `${crudo.slice(0, TOPE_INDICE)}\n\n[INDICE RECORTADO: faltan ${crudo.length - TOPE_INDICE} `
      + 'caracteres. Lo que no ves existe: cita solo rutas que aparezcan arriba]';
  // Las rutas REALES, y de HEAD -- no del arbol de trabajo.
  //
  // La etapa 1 corre ANTES que Sandbox (la 6), asi que no hay workspace contra el
  // que validar: no existe todavia. Pero el workspace se creara desde HEAD, asi
  // que HEAD es el unico arbol que garantiza que una cita aceptada aqui exista
  // DONDE el builder trabaja. El arbol de trabajo puede tener `memory/` sucio y
  // entonces la puerta aceptaria una ruta que la vuelta no va a ver.
  //
  // Es `fichero-linea-sin-rama-no-es-una-referencia` una capa mas arriba: se paso
  // de comprobar la FORMA al HECHO, y faltaba el hecho EN QUE ARBOL.
  const rutasDeMemoria = (() => {
    try {
      return execFileSync('git', ['ls-tree', '-r', '--name-only', 'HEAD', '--', 'memory/'],
        { cwd: ROOT, env: ENV_LIMPIO(), encoding: 'utf8' })
        .split('\n').filter((f) => f.endsWith('.md'));
    } catch {
      // Sin git no se puede saber que vera el workspace: se declara, no se aprueba.
      return existsSync(join(ROOT, 'memory'))
        ? readdirSync(join(ROOT, 'memory'), { recursive: true, encoding: 'utf8' })
          .filter((f) => f.endsWith('.md')).map((f) => `memory/${f}`)
        : [];
    }
  })();

  return pedir(ctx, 'researcher', {
    stage: 'Knowledge', contract: 'ArchitectureBaseline',
    // LA PUERTA DE LA ETAPA 1, EJECUTABLE. El manifiesto la describe desde el
    // principio -- «el artefacto cita al menos una entrada de memory/ por su ruta;
    // sin cita, no leyo nada»-- y el prompt marca la del executionId anterior como
    // OBLIGATORIA. Ninguna de las dos se comprobaba: el contrato solo exige `scope`,
    // `facts` y `unknowns`, asi que las dos eran prosa. `el-fix-que-no-existe`
    // aplicado a una puerta de etapa.
    //
    // MEDIDO en H-20260820-cd46f093: la vuelta cerro 16/16 y FT-5 fallo porque su
    // Knowledge no citaba a H-20260820-55a25dae. El cableado estaba bien -- el
    // LearningRecord llegaba al prompt y `parentExecutionId` lo registraba-- pero
    // la cita dependia de que el modelo se acordara. La flecha Learning->Knowledge
    // es lo UNICO que distingue un anillo de una tuberia de 16 pasos: no puede
    // depender de un recordatorio.
    exige: exigenciasDeKnowledge(previo, rutasDeMemoria),
    inputs: { RepoRef: { repo: 'doxia-platform', commit: ctx.commit ?? 'HEAD' } },
    extra: [
      '## Indice de memory/\n\n', indice,
      previo ? `\n\n## Lo aprendido en la vuelta anterior (${previo.executionId})\n\n${JSON.stringify(previo, null, 2)}` : '',
      '\n\nCita al menos una entrada de memory/ POR SU RUTA en `facts`.',
      // La cita del executionId anterior es OBLIGATORIA, no condicional.
      //
      // Decia "si su leccion aplica", y FT-5 exige la cita SIEMPRE: el prompt y el
      // test median cosas distintas. La vuelta H-20260815-0b5e1031 cerro con
      // `worthKeeping: false` -un resultado valido- asi que no habia leccion que
      // aplicar, el modelo no cito nada y la flecha Learning->Knowledge no existio.
      //
      // Que la vuelta anterior NO dejara nada tambien es continuidad: lo que FT-5
      // mide es que la N+1 sepa donde termino la N, no que haya aprendido algo.
      previo
        ? `\n\nOBLIGATORIO: cita '${previo.executionId}' en \`facts\` como la vuelta anterior,`
          + ` diciendo que dejo. Si cerro con worthKeeping=false, dilo: no tener leccion`
          + ` es un resultado, y citarlo es lo que demuestra que esto es un anillo.`
        : '',
    ].join(''),
  });
};

// ── 2. Evidence ──────────────────────────────────────────────────────────────
export const evidence = (ctx) => pedir(ctx, 'researcher', {
  stage: 'Evidence', contract: 'FactSet',
  inputs: { ArchitectureBaseline: ctx.artifacts.Knowledge },
  extra: 'Todo hecho lleva `evidence` con un COMANDO reproducible. Sin comando es una suposicion.',
});

// ── 3. Decision ──────────────────────────────────────────────────────────────
export const decision = (ctx) => pedir(ctx, 'architect', {
  stage: 'Decision', contract: 'DecisionRecord',
  inputs: { FactSet: ctx.artifacts.Evidence },
  extra: `Objetivo: ${ctx.manifest.task.goal}\nPorque: ${ctx.manifest.task.why}\n`
       + 'Nombra al menos una alternativa descartada: sin alternativas no es una decision.',
});

// ── 4. Plan ──────────────────────────────────────────────────────────────────
/**
 * El `gate` de esta etapa lo EJECUTA alguien.
 *
 * El manifiesto lleva escrito desde el principio «sus ficheros estan dentro de
 * task.files», y era prosa: nadie lo comprobaba. En H-20260817-35ad84ae el
 * architect planifico sobre `src/shared/lib/sanitize-html.spec.ts` y
 * `scripts/gate.sh` -- uno fuera de la lista y el otro PROHIBIDO -- y el builder
 * llego a Execution con un paquete imposible. Uso `blocked` correctamente y
 * explico por que, pero la vuelta ya estaba perdida cuatro etapas antes.
 *
 * Un plan que sale de su alcance declarado es el que rompe cosas, y eso lo dice
 * el propio `onFail` de la etapa. Ahora falla aqui, que es donde el error es
 * barato.
 */
export function assertPlanDentroDelAlcance(wp, task) {
  const permitidos = new Set(task.files);
  const fuera = (wp?.files ?? []).filter((f) => !permitidos.has(f));
  if (fuera.length) {
    throw new Error(
      `el plan nombra ficheros fuera de task.files: ${fuera.join(', ')}. `
      + `Permitidos: ${task.files.join(', ')}`,
    );
  }
  return wp;
}

export async function plan(ctx) {
  const r = await pedir(ctx, 'architect', {
    stage: 'Plan', contract: 'WorkPackage',
    inputs: { DecisionRecord: ctx.artifacts.Decision },
    extra: `Ficheros permitidos: ${ctx.manifest.task.files.join(', ')}\n`
         + `PROHIBIDOS: ${ctx.manifest.task.forbiddenPaths.join(', ')}\n`
         + 'El campo `files` del WorkPackage SOLO puede contener rutas de esa lista. '
         + 'Si crees que el objetivo necesita tocar otra, NO la planifiques: dilo en `goal` '
         + 'como limitacion. Un plan que sale de su alcance llega a Execution y muere alli.\n'
         + `Aceptacion:\n- ${ctx.manifest.task.acceptance.join('\n- ')}`,
  });
  assertPlanDentroDelAlcance(r.payload, ctx.manifest.task);

  // CHANGE SURFACE, mitad PLANIFICADA. Aqui todavia no hay lineas -- se declaran
  // PENDING, no se aprueban-- pero ficheros, modulos y dominios ya se pueden
  // medir, y son los tres que dicen si esto es la tarea que se pidio o se ha
  // convertido en otra. Bloquear ANTES de Execution es todo el punto: despues
  // ya se pago el bucle agentico entero.
  const analisis = analizar(r.payload?.files ?? [], {
    task: ctx.manifest.task, policy: loadSurfacePolicy(),
  });
  assertSuperficie(analisis, loadSurfacePolicy());
  ctx.surfacePlanned = analisis;
  return { ...r, payload: { ...r.payload, changeSurface: analisis } };
}

// ── 7. Execution ─────────────────────────────────────────────────────────────
/**
 * La frontera EFECTIVA de esta vuelta: la de la capacidad, estrechada por la de
 * la tarea.
 *
 * Son DOS fronteras y hacen falta las dos:
 *  · la de la TAREA (`task.files`, `forbiddenPaths`) acota esta vuelta y cambia
 *    en cada una;
 *  · la de la CAPACIDAD (`permissions.write` / `denyPaths`) es permanente.
 *
 * Una tarea mal escrita puede permitir lo que el builder no debe tocar jamas, y
 * sin la segunda bastaria un manifiesto descuidado para que escribiera en
 * harness/policy. Aqui se COMPONEN en un manifiesto sintetico para que la
 * autorizacion de cada tool call las aplique juntas -- sin reimplementar el
 * predicado: quien decide sigue siendo `checkWriteBoundary`.
 *
 * La permanente se vuelve a comprobar DESPUES del bucle sobre lo realmente
 * cambiado, con el manifiesto de verdad: componer no es sustituir.
 */
export function fronteraDeVuelta(cap, task) {
  return {
    ...cap,
    permissions: { ...cap.permissions, write: task.files },
    denyPaths: [
      ...(Array.isArray(cap.denyPaths) ? cap.denyPaths : []),
      ...(task.forbiddenPaths ?? []).map((g) => g.replace(/\/\*\*$/, '')),
    ],
  };
}

/**
 * Lo que hizo volver al builder, en su propio prompt.
 *
 * Se separa para poder probarlo sin correr una vuelta, y porque es la unica
 * parte del prompt de Execution que cambia entre rondas.
 */
export function motivoDelRework(ctx) {
  if (!ctx.rework) return '';

  const conv = (ctx.pendientes ?? []).map((f) =>
    `- [${f.severity}] ${f.file}:${f.symbol} — ${String(f.claim).slice(0, 220)}`);
  const sec = (ctx.artifacts?.Security?.payload?.blocked ?? []).map((f) =>
    `- [${f.severity}] ${f.rule} en ${f.path}:${f.location} — ${String(f.impact).slice(0, 180)}`
    + `\n      arreglo: ${f.remediation}`);

  if (!conv.length && !sec.length) {
    return `## Vuelves por un REWORK (${ctx.rework})\n\nNo hay hallazgos registrados; revisa la aceptacion punto por punto.\n\n`;
  }
  return [
    `## POR QUE VUELVES — rework ${ctx.rework}\n\n`,
    'Esto es lo que BLOQUEO la ronda anterior. Corrigelo; no rehagas lo que ya estaba bien:\n\n',
    conv.length ? `### Hallazgos de revision\n${conv.join('\n')}\n\n` : '',
    sec.length ? `### Seguridad — la politica BLOQUEA\n${sec.join('\n')}\n\n` : '',
    'Si crees que alguno es falso, NO lo ignores: responde `blocked` con el motivo.\n\n',
  ].join('');
}

/**
 * LO QUE EL ANILLO SEMBRO, DICHO AL QUE TIENE QUE ARREGLARLO.
 *
 * EL HUECO, medido el 2026-09-15 sobre las tres vueltas de h-007
 * (H-20260915-ea48479b · c986064a · fefcd0bc): las tres pararon en Execution
 * con `blocked`, y las tres dieron el MISMO motivo --
 *
 *   «ConnectionStatus.tsx ya tiene cambios sin commitear QUE NO SON MIOS»
 *   «Revertir un cambio de otra persona no me toca»
 *
 * -- sobre un fichero que el propio harness acababa de sembrar en la etapa 6.
 *
 * El dato existia: `Sandbox.payload.seeded` lo registra con su motivo. Pero solo
 * lo leia Security (etapa 8), y para llegar a la 8 hay que pasar por la 7. El
 * builder juzgaba la semilla a ciegas y hacia lo correcto con la informacion que
 * tenia: negarse a tocar lo ajeno. Su prudencia era acertada y el resultado
 * falso -- el ciclo BLOCK -> FIX -> PASS que h-007 existe para demostrar no
 * podia pasar de BLOCK.
 *
 * No se le dice que la arregle: se le dice DE DONDE VIENE. Que la corrija o no
 * sigue siendo su juicio, que es lo que h-007 mide.
 *
 * PURA: recibe el contexto, devuelve texto. Se prueba sin correr una vuelta.
 */
export function avisoDeSemillas(ctx) {
  const seeded = ctx?.artifacts?.Sandbox?.payload?.seeded ?? [];
  if (!seeded.length) return '';
  const lineas = seeded.map((s) =>
    `- ${s.path}${s.why ? ` — ${String(s.why).slice(0, 200)}` : ''}`);
  return [
    '## EL ANILLO SEMBRO ESTO A PROPOSITO\n\n',
    'Los cambios sin commitear en estos ficheros los planto la etapa Sandbox de ESTA',
    ' vuelta. NO son de otra persona y no estaban antes en el arbol:\n\n',
    lineas.join('\n'),
    '\n\nEstan dentro de tu alcance de escritura. Tratarlos como contaminacion ajena',
    ' y negarte a tocarlos deja la vuelta bloqueada sobre un hecho falso.\n',
    'Lo que se mide es tu JUICIO sobre ellos: si el cambio es un defecto, arreglalo',
    ' y di por que; si crees que no lo es, responde `blocked` explicando el motivo.\n\n',
  ].join('');
}

/**
 * EL ROJO QUE YA ESTABA. `run_test` sin ruta corre los 1.895 tests del repo, y
 * ahi dentro los que el builder escribio son ruido.
 *
 * MEDIDO en H-20260917-75135851 y -c53885df (h-008 v2, vueltas 1 y 3): el builder
 * creo el modulo, lo parcheo, saco `run_typecheck` en VERDE y luego llamo a
 * `run_test` cuatro veces, siempre exit=1 con `18 failed | 1877 passed`. El arbol
 * limpio, sin nada suyo, daba los MISMOS 18 fallos --en `expedienteBackup.spec.ts`
 * e `identidad-domicilio.test.ts`, que la spec no toca. Sus 18 tests pasaron: el
 * delta de fallos era CERO. Agoto las 90 iteraciones arreglando un rojo ajeno.
 *
 * No es un fallo de juicio: desde dentro del bucle un exit=1 es indistinguible de
 * «rompiste algo», y ante eso insistir es la conducta correcta. Lo que faltaba es
 * decirle QUE YA ESTABA ROJO y como preguntar solo por lo suyo.
 *
 * Es la tercera vez que este runner cuesta una vuelta entera: `run_test_backend`
 * nacio de H-20260819-e62bf69e, donde el builder lo llamo 40 veces contra specs de
 * jest que vitest no ve. El patron no es el modelo: es un runner que responde por
 * el arbol cuando se le pregunta por un cambio.
 */
export function avisoDeRojoPrevio(ctx) {
  const rutas = (ctx?.manifest?.task?.files ?? [])
    .filter((f) => /\.(test|spec)\.[tj]sx?$/.test(f));
  return [
    '## ANTES DE CREER UN `run_test` EN ROJO\n\n',
    '`run_test` SIN ruta corre la suite ENTERA del repo, y este arbol tiene fallos',
    ' PREEXISTENTES que no son tuyos y que no te toca arreglar.\n\n',
    '**Pasa siempre la ruta de lo que escribiste**',
    rutas.length ? ` — en esta tarea: \`${rutas.join('`, `')}\`` : '',
    '. Asi el verde o el rojo hablan de TU cambio.\n\n',
    'Si aun asi ves rojo en ficheros que la spec no declara: NO los arregles. Anota',
    ' cuales son, di que son preexistentes y sigue. Gastar el presupuesto en un rojo',
    ' ajeno ya costo dos vueltas enteras.\n\n',
  ].join('');
}

export async function execution(ctx) {
  const ws = ctx.workspace ?? ctx.artifacts?.Sandbox?.payload;
  if (!ws) throw new Error('Execution sin Workspace: la etapa Sandbox no corrio');

  const task = ctx.manifest.task;
  const builderCap = cap('builder');
  const asign = await resolverModelo(ctx, 'builder');

  // EL BUCLE, no un disparo.
  //
  // Antes se le pedia al modelo el contenido COMPLETO de cada fichero resultante
  // dentro del JSON. Dos consecuencias medidas: un fichero de 37 KB agotaba
  // `max_tokens` y tumbaba la vuelta, y el builder no podia ejecutar los tests
  // que escribia -- asi que "los tests pasan" era siempre una afirmacion suya.
  // Lo detecto el revisor adversarial, no nosotros.
  //
  // Ahora lee, busca, parchea, ejecuta y OBSERVA dentro del sandbox. Lo que
  // cambio no lo dice el modelo: lo dice git.
  // C-7 · EL REPARTO. Debajo del umbral devuelve UN shard con todo, que es el
  // comportamiento de siempre: el fan-out cuesta una invocacion por trozo y
  // pagarla para cuatro ficheros que caben de sobra es gasto puro.
  //
  // UN `move` NO SE REPARTE, y esto se aprendio partiendolo. MEDIDO en
  // H-20260819-5d44080c: el reparto puso los cinco DESTINOS en el shard #1 y los
  // ORIGENES en los shards #2 y #3, asi que ninguno tenia las dos mitades de un
  // mismo renombrado. Cada shard podia hacer MEDIA mudanza; el #1 gasto sus 40
  // iteraciones haciendo `run_typecheck` sobre un arbol que otro shard le movia
  // por debajo -- tres veces en rojo-- y la vuelta murio con ROLLBACK.
  //
  // El reparto supone que los ficheros son SEPARABLES. Un renombrado no lo es de
  // su propio destino: las dos rutas son un solo hecho. Y no se arregla
  // ensenandole a `repartir` a emparejarlas -- adivinar pares por el nombre es
  // una heuristica que falla el dia que alguien mueve y renombra a la vez--: se
  // arregla no repartiendo lo que no es separable.
  const clase = claseDe(task, loadSurfacePolicy());
  const shards = clase === 'move'
    ? [task.files]
    : repartir(task.files, loadToolPolicy().fanout);
  const resultados = [];

  for (const [i, mios] of shards.entries()) {
    const esReparto = shards.length > 1;
    // CADA SHARD ESTRENA TRANSCRIPCION. Es todo el mecanismo: lo que se reparte
    // es el recurso escaso -- 60 000 chars-- no el reloj ni el workspace.
    //
    // ponytail: la frontera de escritura sigue siendo `task.files` ENTERO, no el
    // shard. Un trozo puede tocar el fichero de otro y, como van en orden, el
    // ultimo gana sin que nadie lo diga. El techo se acepta porque el reparto es
    // secuencial y la puerta juzga el arbol final; si algun dia dos shards se
    // pisan de verdad, el escalon es `fronteraDeVuelta(builderCap, {...task,
    // files: mios})` -- una linea-- y no un protocolo de bloqueo.
    // eslint-disable-next-line no-await-in-loop
    resultados.push(await toolLoop({
    policy: presupuestoDe(loadToolPolicy(), clase),
    cap: fronteraDeVuelta(builderCap, task),
    assignment: asign,
    workspace: ws,
    log: ctx.log,
    task: [
      `Trabajas en un workspace git AISLADO. Todas las rutas son relativas a su raiz.\n\n`,
      `## Objetivo\n\n${task.goal}\n\n## Por que\n\n${task.why}\n\n`,
      `## Ficheros que puedes tocar\n\n- ${task.files.join('\n- ')}\n\n`,
      `Cualquier otra ruta se rechaza. PROHIBIDO: ${task.forbiddenPaths.join(', ')}\n\n`,
      `## Aceptacion — se comprueba una por una\n\n- ${task.acceptance.join('\n- ')}\n\n`,
      `## WorkPackage\n\n\`\`\`json\n${JSON.stringify(ctx.artifacts.Plan?.payload ?? {}, null, 2).slice(0, 12000)}\n\`\`\`\n\n`,
      // POR QUE VUELVES. El builder no lo sabia.
      //
      // En un REWORK se le reenviaba el mismo WorkPackage y nada mas: ni los
      // hallazgos que bloquearon, ni el veredicto de seguridad. Corregia a
      // ciegas, y eso explica buena parte de los reintentos que se agotaron sin
      // converger -- se le pedia arreglar algo que no se le habia dicho.
      motivoDelRework(ctx),
      // DE DONDE VIENE LO QUE YA ESTA EN EL ARBOL. Ver `avisoDeSemillas`: sin
      // esto el builder lee la siembra de Sandbox como un diff ajeno y se niega
      // a tocarlo -- correcto con lo que sabe, falso de hecho.
      avisoDeSemillas(ctx),
      avisoDeRojoPrevio(ctx),
      `Empieza LEYENDO los ficheros que vas a tocar. Antes de \`done\`, ejecuta`,
      ` \`run_test\` sobre el spec que escribas: es lo unico que convierte "deberia pasar" en un hecho.`,
      // El shard sabe que es un trozo, y de que. Sin decirselo, cada uno leeria
      // la aceptacion entera y la daria por incumplida al no ver los ficheros de
      // los demas -- que es un `blocked` fabricado por el reparto.
      esReparto
        ? `\n\n## ESTE ES EL TROZO ${i + 1} DE ${shards.length}\n\n`
          + `Otros trozos se ocupan del resto de \`task.files\`, en el MISMO workspace y `
          + `antes o despues que tu. Toca SOLO:\n- ${mios.join('\n- ')}\n\n`
          + `De la aceptacion, cumple la parte que dependa de ESTOS ficheros. Lo que dependa `
          + `de los otros NO es tuyo y no es motivo de \`blocked\`. Declara \`done\` cuando `
          + `los tuyos esten, o \`no_change_required\` si ya estaban bien.`
        : '',
    ].join(''),
    }));
  }

  // LA REDUCCION ES DETERMINISTA. Ningun modelo fusiona nada: se concatenan las
  // bitacoras y la puerta juzga el arbol resultante.
  const fusion = fusionar(resultados);
  const veredicto = cierre(resultados);
  // CADA shard declara su propio cierre. 19 de 20 no es converger: es converger
  // en el 95 % y callar el 5 %.
  if (shards.length > 1 && !veredicto.ok) throw new Error(veredicto.why);

  // `let`: la rama de NO_CHANGE_REQUIRED lo reconvierte a DONE cuando el workspace
  // ya trae el trabajo de una pasada anterior.
  let r = shards.length > 1
    ? {
      ...resultados[0],
      // Si TODOS dijeron NO_CHANGE_REQUIRED, el conjunto tampoco cambio nada.
      // Basta uno que escriba para que el conjunto sea un DONE.
      status: resultados.every((x) => x.status === 'NO_CHANGE_REQUIRED') ? 'NO_CHANGE_REQUIRED' : 'DONE',
      stop: veredicto.why ?? `${veredicto.cerrados}/${veredicto.total} shard(s)`,
      iterations: fusion.iterations,
      toolCalls: fusion.toolCalls,
      mutations: fusion.mutations,
      usage: fusion.usage,
      final: { summary: fusion.summary },
      fanout: { shards: shards.length, files: shards.map((x) => x.length) },
    }
    : resultados[0];

  // Cada iteracion es una invocacion real del proveedor, y es lo que AdapterLayer
  // debe registrar. Contar 1 por etapa era exacto cuando la etapa era un disparo;
  // ahora seria mentir a la baja sobre lo que se gasto.
  contar(ctx, 'builder', r.iterations);

  // NO_CHANGE_REQUIRED es una respuesta legitima, y por eso hay que decidir si
  // ESTA tarea la admitia. Una tarea cuya aceptacion exige modificar ficheros no
  // se satisface afirmando que ya estaba bien: eso es un `done` vacio con otro
  // nombre. Una que solo pide comprobar, si.
  //
  // `requiresChange` por defecto es TRUE: el harness existe para tareas que
  // cambian codigo, y el defecto seguro es exigir la evidencia, no perdonarla.
  //
  // Y SE JUZGA CONTRA EL WORKSPACE, no contra la declaracion. La pregunta no es
  // «esta tarea exige cambio» -- eso ya lo dice `task`-- sino «sigue faltando».
  // En un REWORK el workspace YA trae lo que aplico la pasada anterior, asi que
  // «no queda nada que mutar» es la respuesta correcta y no un `done` hueco. La
  // diferencia entre las dos es observable en un sitio: si git ve cambios.
  //
  // MEDIDO en H-20260820-481ff307. La vuelta llego a Convergence, que pidio un
  // rework por un P2 -- «el gate --full no se ha ejecutado», que es una EJECUCION
  // que falta, no una mutacion--. El builder volvio, corrio `run_gate` con
  // resultado PASS y declaro NO_CHANGE_REQUIRED porque no quedaba una sola
  // mutacion pendiente. La etapa lo tumbo citando los 17 ficheros de la
  // aceptacion, con esos 17 ficheros YA cambiados delante.
  //
  // Es `una-autoridad-por-hecho`: el hecho «se modifico algo» lo tenia git, y esta
  // rama lo estaba deduciendo del manifiesto.
  // FILTRADO tambien aqui: el hecho «se modifico algo» lo tiene git, pero git ve
  // los dos artefactos que vite regenera al correr las tools del builder. Sin
  // descontarlos, una vuelta que NO cambio nada parece haber cambiado dos
  // ficheros y deja de ser NO_CHANGE_REQUIRED.
  r = conVeredictoSinCambio(r, { task, yaAplicado: sinArtefactosDeBuild(sandbox.changedFiles(ws)) });

  if (r.status === 'NO_CHANGE_REQUIRED') {
    return {
      payload: {
        files: [], diff: '', status: 'NO_CHANGE_REQUIRED', summary: r.final?.reason ?? r.stop,
        iterations: r.iterations, toolCalls: r.toolCalls, mutations: [], usage: r.usage,
        changeSurface: analizar([], { task, policy: loadSurfacePolicy(), diff: '' }),
      },
      status: 'WARN',
      reason: `sin cambios por declaracion del builder: ${r.stop}`,
      producedBy: { capability: 'builder', ...asign, iterations: r.iterations, mutations: 0 },
    };
  }

  // UN PRESUPUESTO AGOTADO NO ES UNA FUGA DE CONTENCION, y por eso no se lanza.
  //
  // Esto LANZABA, y `runRing` escribe `payload: null` cuando una etapa lanza: las
  // cuarenta llamadas se perdian enteras, con el mensaje de error de cada `git
  // apply` dentro. La corrida que falla era justo la unica cuya evidencia se
  // tiraba -- la inversion exacta de la regla #0--, asi que la causa de cada
  // caida habia que INFERIRLA del resumen de una linea por llamada.
  //
  // Es el mismo defecto que `conVeredictoDeSuperficie` documenta cuatro funciones
  // mas abajo, en la puerta de al lado y con el mismo remedio. Se corrigio en
  // Security, en Convergence y en el presupuesto de superficie; esta era la cuarta
  // puerta. `gate-cambiado-consumidores-olvidados` aplicado a un patron.
  //
  // MEDIDO en H-20260820-477b813c: 15 `apply_patch`, 5 en verde. El motivo de los
  // otros diez estaba en `toolCalls` y no llego a disco.
  //
  // El anillo FALLA IGUAL -- `status: 'FAIL'` dispara el ROLLBACK de Execution--,
  // pero falla enseñando el trabajo. Lo que NO se convierte es la frontera: salir
  // del sandbox o de `task.files` sigue lanzando, porque ahi el rollback es la
  // respuesta que se quiere.
  if (r.status !== 'DONE') {
    return sinPresupuesto(r, {
      asign,
      // Mismo criterio: el informe de una vuelta fallida tampoco cuenta como del
      // builder lo que regenero vite.
      files: sinArtefactosDeBuild(sandbox.changedFiles(ws)),
      // El revisor no lee la lista, lee el diff: el mismo descuento.
      diff: diffSinArtefactosDeBuild(sandbox.diff(ws)),
      // Aqui SI hay workspace en scope, asi que el careo de una vuelta fallida
      // tambien distingue una restauracion de un fantasma.
      blobDeHead: lectorDeHead(ws),
    });
  }

  // Cuantas mutaciones REALES por ronda. Es la mitad de la firma de una
  // especificacion imposible: sin esto, «el hallazgo sobrevivio a tres rondas»
  // no distingue una spec incoherente de un builder que no toco nada.
  ctx.mutacionesPorRonda = [
    ...(ctx.mutacionesPorRonda ?? []),
    r.mutations.filter((m) => m.changed !== false).length,
  ];

  // Lo que cambio lo dice GIT, no el modelo. Es la diferencia entre un ChangeSet
  // declarado y uno observado, y la razon de que el resumen del builder sea
  // `summary` y no `files`.
  // UNA SOLA FUENTE DE VERDAD POR VUELTA. `changedFiles` incluye los dos
  // artefactos que regenera vite al correr `run_test`/`run_typecheck`
  // (vite.config.ts -> scripts/generate-version-manifest.mjs), y esos NO los
  // escribe el builder. Se descuentan AQUI, una vez, y los cinco consumidores de
  // abajo reciben la misma lista: el primer arreglo filtro dos de cinco y una
  // auditoria lo cazo con «718 PASA, 721 LANZA».
  const propios = sinArtefactosDeBuild(sandbox.changedFiles(ws));
  if (!propios.length) {
    // Una ejecucion que no cambia nada NO es una ejecucion con exito. Sin esta
    // comprobacion, el anillo recorre 16 etapas sobre un diff vacio.
    throw new Error(`el builder declaro DONE y el workspace no registra ningun cambio`);
  }

  // Aqui YA NO hace falta comprobar «rework sin mutaciones». Lo hacia esta etapa
  // --y solo para `ctx.rework > 0`, mirando el workspace, que en un reintento ya
  // trae los cambios del intento anterior-- desde H-20260816-e2ec5f67. Ahora el
  // contrato de `done` (agentic.faltaParaDone) exige mutacion Y ejecucion en
  // TODA pasada, incluida la primera, y devuelve el rechazo al modelo en vez de
  // tumbar la etapa. Repetirlo aqui seria una segunda autoridad sobre el mismo
  // hecho, y ademas una que ya no puede dispararse nunca.

  // La frontera PERMANENTE, con el manifiesto real y sobre lo que de verdad se
  // escribio. El bucle ya rechaza en el momento de pedir; esto cierra el caso de
  // que algo llegue al disco por otra via.
  // Los artefactos que regenera vite al correr `run_test`/`run_typecheck` no son
  // escrituras del builder: se descuentan ANTES de juzgar la frontera. Medido en
  // H-20260917-fef6f11b, que murio a 12 etapas por `public/version.json`. Ver
  // harness/lib/artefactos-de-build.mjs y
  // memory/failures/la-herramienta-escribe-fuera-de-la-frontera.md
  assertWithinBoundary(builderCap, propios);
  const permitidos = new Set(task.files);
  for (const f of propios) {
    if (!permitidos.has(f)) throw new Error(`quedo modificado '${f}', fuera de task.files`);
    if (task.forbiddenPaths.some((g) => f.startsWith(g.replace('/**', '/')))) {
      throw new Error(`quedo modificado '${f}', en forbiddenPaths`);
    }
  }

  // CHANGE SURFACE, mitad MEDIDA. Sobre el diff de GIT, no sobre lo que declare
  // el modelo: es la mitad que aporta las lineas, que es el limite que la fase
  // ata a la convergencia.
  // FILTRADO igual que la lista: 2 de 5 bloques eran de vite en
  // H-20260918-9a093b28 (1.523 de 15.321 chars) y el revisor los leia como
  // trabajo del builder. No cambia veredictos; cambia lo que el modelo lee.
  const diff = diffSinArtefactosDeBuild(sandbox.diff(ws));
  const surface = analizar(propios, { task, policy: loadSurfacePolicy(), diff });

  return conVeredictoDeSuperficie({
    payload: {
      files: propios,
      diff,
      changeSurface: surface,
      summary: r.final?.summary ?? null,
      iterations: r.iterations,
      toolCalls: r.toolCalls,
      // Las mutaciones APLICADAS, con hash antes y despues medidos por el
      // harness. `files` dice que quedo tocado; `mutations` dice como se llego a
      // eso y contra que version se aplico cada paso.
      mutations: r.mutations,
      // Y EL CAREO ENTRE LAS DOS, que es el campo que faltaba. Publicar dos
      // autoridades sobre el mismo hecho sin decir si concuerdan deja la
      // comparacion para quien lea el artefacto -- y la hicieron dos, con
      // resultados opuestos, en H-20260820-c9a55e79. Va SIEMPRE, tambien cuando
      // coinciden: un campo ausente se lee como «no se comprobo», que en este
      // repo es la forma de silencio que no se acepta como resultado.
      careo: carearConGit(r.mutations, propios, { blobDeHead: lectorDeHead(ws) }),
      // Uso REPORTADO por el proveedor. `null` cuando no lo publica, que es el
      // caso de los CLI: se declara, no se estima (Fase 9, metricas verificables).
      usage: r.usage,
    },
    producedBy: {
      capability: 'builder', ...asign,
      iterations: r.iterations, toolCalls: r.toolCalls.length, mutations: r.mutations.length,
    },
  }, loadSurfacePolicy());
}

/**
 * Aplica el veredicto de SUPERFICIE sin perder el ChangeSet.
 *
 * MEDIDO EN H-20260818-d161dc60, la primera vuelta en que el presupuesto mordio
 * de verdad. `assertSuperficie` LANZABA, y `runRing` escribe `payload: null`
 * cuando una etapa lanza: se perdieron el diff, las 19 llamadas a herramientas,
 * las mutaciones y el propio analisis de superficie. Y como el `onFail` de
 * Execution es ROLLBACK, el workspace se destruyo detras. El harness bloqueo con
 * un numero -- «lines 105 > 80»-- y borro las 105 lineas que lo justificaban:
 * quedo un veredicto imposible de auditar y un presupuesto imposible de
 * recalibrar.
 *
 * Es EXACTAMENTE el defecto que ya se habia corregido en Security
 * (`conVeredictoDeSeguridad`) y en Convergence, no llevado a la tercera puerta
 * -- escrita el mismo dia que las otras dos. `gate-cambiado-consumidores-
 * olvidados` aplicado a un patron en vez de a un script.
 *
 * NO se aplica a las comprobaciones de FRONTERA (escribir fuera del sandbox o de
 * `task.files`): ahi lanzar es correcto, porque el ROLLBACK que lo sigue es la
 * respuesta que se quiere. Salirse del presupuesto no es una fuga de contencion.
 *
 * PURO y exportado, por lo mismo que su hermana: comprobarlo a traves del
 * handler exigiria una vuelta de 15 minutos.
 */
/**
 * El ChangeSet de un builder que se quedo sin presupuesto: FALLA, pero ensena.
 *
 * PURO y exportado por lo mismo que `conVeredictoDeSuperficie`: comprobarlo a
 * traves del handler exigiria una vuelta de veinte minutos.
 */
/**
 * Un `NO_CHANGE_REQUIRED` se juzga contra el WORKSPACE, no contra el manifiesto.
 *
 * La pregunta no es «esta tarea exige cambio» -- eso ya lo dice `task`-- sino
 * «sigue faltando». En un REWORK el workspace YA trae lo que aplico la pasada
 * anterior, asi que «no queda nada que mutar» es la respuesta correcta y no un
 * `done` hueco con otro nombre. La diferencia entre las dos es observable en un
 * solo sitio: si git ve cambios.
 *
 * MEDIDO en H-20260820-481ff307. La vuelta llego a Convergence, que pidio un
 * rework por un P2 -- «el gate --full no se ha ejecutado», que es una EJECUCION
 * que falta, no una mutacion--. El builder volvio, corrio `run_gate` con resultado
 * PASS y declaro NO_CHANGE_REQUIRED porque no quedaba una sola mutacion pendiente.
 * La etapa lo tumbo citando los 17 ficheros de la aceptacion, con esos 17 ficheros
 * YA cambiados delante y el gate en verde.
 *
 * Es `una-autoridad-por-hecho`: el hecho «se modifico algo» lo tiene git, y esta
 * rama lo estaba deduciendo del manifiesto.
 *
 * PURO y exportado, como sus dos hermanas de este fichero.
 */
export function conVeredictoSinCambio(r, { task, yaAplicado }) {
  if (r.status !== 'NO_CHANGE_REQUIRED') return r;

  // El trabajo esta hecho: sigue por el camino normal, que mide el ChangeSet sobre
  // git. Lo unico que esta pasada no aporto son mutaciones NUEVAS, y eso se dice en
  // el `summary` en vez de descartar un cambio real y verificado.
  if (yaAplicado.length) {
    return { ...r, status: 'DONE', final: { ...(r.final ?? {}), summary: r.final?.reason ?? r.stop } };
  }

  // Y el hueco de verdad se sigue rechazando: nada en el workspace, nada que
  // ensenar. `requiresChange` por defecto es TRUE -- el harness existe para tareas
  // que cambian codigo, y el defecto seguro es exigir la evidencia, no perdonarla.
  if (task.requiresChange !== false) {
    throw new Error(
      `el builder declaro NO_CHANGE_REQUIRED («${r.stop}») y esta tarea EXIGE modificacion: `
      + `su aceptacion nombra ${task.files.length} fichero(s) a cambiar, y el workspace no `
      + 'registra NINGUN cambio. '
      + 'Si el hallazgo que lo trajo aqui es falso, la respuesta es `blocked` con el motivo',
    );
  }
  return r;
}

// `blobDeHead` viaja como PARAMETRO y no se construye aqui: esta funcion no
// tiene workspace en su scope --lo descubri poniendo `lectorDeHead(ws)` dentro y
// viendo «ReferenceError: ws is not defined» en stages.test.mjs-- y ademas es
// pura: recibe lo que necesita. Sin lector, el careo se mantiene conservador.
export function sinPresupuesto(r, { asign, files, diff, blobDeHead = null }) {
  return {
    payload: {
      files, diff,
      status: r.status,
      summary: r.final?.summary ?? null,
      iterations: r.iterations,
      // LO QUE IMPORTA. Cada llamada lleva su `output`, y ahi dentro esta el
      // mensaje de git que dice POR QUE no aplico un parche. Sin esto la unica
      // pista era `exit=1` en el resumen de consola.
      toolCalls: r.toolCalls,
      mutations: r.mutations,
      // La corrida que FALLA es la que mas necesita el careo: es donde se busca
      // por que, y donde el workspace ya no esta para mirarlo.
      careo: carearConGit(r.mutations, files, { blobDeHead }),
      usage: r.usage,
      // Nunca se midio: la superficie se analiza sobre un cambio TERMINADO.
      // Declararla `null` es distinto de declararla vacia.
      changeSurface: null,
    },
    status: 'FAIL',
    reason: `el builder termino en ${r.status} tras ${r.iterations} iteraciones y `
      + `${r.toolCalls.length} llamadas: ${r.stop ?? 'sin motivo'}`,
    producedBy: {
      capability: 'builder', ...asign,
      iterations: r.iterations, toolCalls: r.toolCalls.length, mutations: r.mutations.length,
    },
  };
}

export function conVeredictoDeSuperficie(r, policy) {
  try {
    assertSuperficie(r.payload?.changeSurface, policy);
    return r;
  } catch (e) {
    return { ...r, status: 'FAIL', reason: e.message };
  }
}

// ── 8. Validation ────────────────────────────────────────────────────────────
/**
 * El ChangeSet que ve un revisor: el DIFF, no los ficheros enteros ni la bitacora.
 *
 * `contents` llevaba el contenido COMPLETO de cada fichero resultante junto al
 * `diff`: mandar los dos duplicaba el cambio y con un fichero de 37 KB el revisor
 * agotaba `max_tokens` y devolvia JSON truncado -- CONTEXT_OVERFLOW, que no se
 * reintenta porque repetir un prompt demasiado grande da el mismo resultado.
 *
 * `toolCalls` es la version Fase 7 del mismo riesgo: cuarenta llamadas con su
 * salida son mas volumen que el diff que describen. Es evidencia para el trace,
 * no material de revision. Lo que un revisor necesita es QUE CAMBIO.
 */
/**
 * La INTENCION que ve un revisor: objetivo, aceptacion y alcance. Nada mas.
 *
 * Se le mandaba el `WorkPackage` COMPLETO -- 6.417 bytes en
 * H-20260818-040baf77 -- con el `changeSurface` dentro, que es un analisis de
 * presupuesto y no le dice nada a quien revisa codigo. Sumado al diff daban 13 KB
 * de entrada, y el revisor agoto sus 32.768 tokens de SALIDA: la vuelta murio en
 * la etapa 9 con OUTPUT_TRUNCATED, igual que H-20260816-bebf4372 -- que lo hizo
 * con 7,5 KB, es decir, con la MITAD.
 *
 * La regla ya estaba escrita dos lineas mas abajo, en `paraRevisar`: «lo que un
 * revisor necesita es QUE CAMBIO». No se aplico a la entrada nueva. Un recorte
 * que existe para una entrada y no para la de al lado no es un recorte: es una
 * excepcion que caduca en cuanto alguien anade la siguiente.
 */
export const paraIntencion = (art) => {
  const p = art?.payload;
  if (!p) return art;
  return { ...art, payload: { goal: p.goal, acceptance: p.acceptance, files: p.files } };
};

export const paraRevisar = (art) => {
  if (!art?.payload) return art;
  const { contents, toolCalls, mutations, careo } = art.payload;
  return {
    ...art,
    // LISTA BLANCA, no lista negra.
    //
    // Esto enumeraba lo que QUITABA (`const {contents, toolCalls, mutations,
    // ...resto}`), asi que todo campo nuevo del ChangeSet llegaba solo al
    // revisor. Cuando la Fase 11 anadio `changeSurface` -- un analisis de
    // presupuesto con sus checks, rutas, modulos y limites-- se colo entero sin
    // que nadie lo decidiera, y sumado a la intencion daban 13 KB de entrada: el
    // revisor agoto sus 32.768 tokens de salida y la vuelta murio en la etapa 9
    // (H-20260818-040baf77). La anterior que murio igual lo hizo con 7,5 KB.
    //
    // Es `frontera-de-datos-como-funcion-pura` literal: una frontera que declara
    // lo que EXCLUYE falla en abierto -- el siguiente campo entra gratis-- y una
    // que declara lo que INCLUYE falla en cerrado, que es el lado correcto.
    payload: {
      files: art.payload.files ?? Object.keys(contents ?? {}),
      diff: art.payload.diff,
      summary: art.payload.summary ?? null,
      ...(art.payload.status ? { status: art.payload.status } : {}),
      ...(toolCalls ? { toolCallCount: toolCalls.length } : {}),
      // F-3 · CUANTAS DE ESAS LECTURAS SE TRUNCARON.
      //
      // El recorte avisaba al modelo y a nadie mas: un `search` recortado y uno
      // completo daban el mismo ToolResult a ojos de quien juzga. Un revisor que
      // no sabe que el builder decidio sobre 111 de 244 coincidencias esta
      // juzgando una decision distinta de la que se tomo. Viaja el NUMERO, no la
      // bitacora: lo que hace falta es la advertencia, no el volumen.
      ...(toolCalls?.some((c) => c.truncated)
        ? { truncatedReads: toolCalls.filter((c) => c.truncated).length }
        : {}),
      // Las mutaciones si viajan, pero SIN el registro entero: al revisor le
      // sirve saber contra que version se aplico cada cambio -- eso es
      // revisable -- y no le sirven los cuarenta campos de la bitacora.
      ...(mutations ? { mutations: mutations.map((m) => ({ op: m.op, path: m.path, before: m.before, after: m.after, changed: m.changed })) } : {}),
      // EL CAREO VIAJA CON LA BITACORA. Es la mitad que hacia falta y la que se
      // quedaba fuera: el revisor recibia `files`, `diff` y `mutations` sin una
      // sola palabra sobre como se relacionan, leia la bitacora, veia una ruta
      // que no estaba en `files` y levantaba un P1 correcto DESDE SU VISTA. La
      // lista blanca es lo que decide lo que puede ver, asi que un campo que
      // arbitra y no se proyecta no arbitra nada.
      ...(careo ? { careo } : {}),
    },
  };
};

/**
 * Validation — y el CERO no se cree a la primera.
 *
 * «Sin hallazgos» es un resultado valido y preferible a uno fabricado. Pero
 * tambien es lo que devuelve una pasada perezosa, una truncada, o una que se
 * quedo sin espacio de salida. Distinguir «no hay nada» de «no vi nada» no se
 * puede hacer leyendo la respuesta: hay que preguntar otra vez.
 *
 * Cuesta una invocacion extra SOLO cuando la primera dice cero, que es
 * exactamente el caso sospechoso. Cuando hay hallazgos no cuesta nada.
 *
 * Y arrastra lo que quedo pendiente de la ronda anterior: un hallazgo que
 * bloqueo y no vuelve a salir no esta resuelto, esta callado.
 */
export async function validation(ctx, pedirFn = pedirValidacion) {
  const r = await pedirFn(ctx, '');
  const primera = r.payload.findings ?? [];

  let corroborado = null;
  let findings = primera;

  if (!primera.length) {
    // Segunda opinion INDEPENDIENTE. No ve la primera: si le dijeramos «la otra
    // no encontro nada» estariamos pidiendo que confirme, no que revise.
    const s = await pedirFn(ctx, ' [segunda opinion independiente: la primera pasada no encontro nada, '
      + 'pero eso no te lo digo para que lo confirmes. Revisa el cambio de cero]');
    findings = s.payload.findings ?? [];
    corroborado = findings.length === 0;
  }

  // El arrastre va DESPUES de la corroboracion: lo pendiente no cuenta como
  // "hallazgo encontrado por esta ronda", y confundirlo dejaria el cero sin
  // comprobar cada vez que hubiera algo heredado.
  const conArrastre = arrastrar(findings, ctx.pendientes ?? []);

  return {
    payload: {
      findings: conArrastre,
      passes: corroborado === null ? 1 : 2,
      zeroCorroborated: corroborado,
      carried: conArrastre.filter((f) => f.carried).length,
    },
    producedBy: r.producedBy,
    ...(corroborado === false ? { status: 'WARN', reason: 'la primera pasada no vio lo que vio la segunda' } : {}),
  };
}

/**
 * Lo que ve el revisor. NO es solo el diff.
 *
 * Revisaba contra `ChangeSet` y nada mas, asi que solo podia responder «¿esta
 * bien este codigo?». No podia responder la pregunta que decide si la vuelta
 * avanza: «¿responde este cambio a lo que se pidio, y a lo que bloqueo la ronda
 * anterior?». Sin la INTENCION no hay forma de marcar un cambio correcto que no
 * hace lo que la tarea pedia, y sin los hallazgos previos no hay forma de
 * distinguir un defecto nuevo de uno que lleva tres rondas.
 *
 * Va por `inputs` y no dentro del texto: el mismo canal que el ChangeSet, con la
 * misma forma, y sin que el revisor tenga que fiarse de un resumen en prosa.
 */
/**
 * ¿Es esta una vuelta de REWORK? Lo dice el ciclo de vida, que ya distingue la
 * ronda: si hay hallazgos previos, alguien volvio a por algo.
 */
export const esRework = (ctx) => (ctx?.lifecycle ?? []).length > 0;

/**
 * Los hallazgos que SIGUEN ABIERTOS, que es lo unico que un rework tiene que
 * cerrar.
 *
 * `FIXED` ya no esta; `REFUTED` nunca estuvo. Mandarlos otra vez es pedirle al
 * revisor que vuelva a pensar sobre lo que ya se cerro -- y en un modelo que
 * razona, pensar es lo que gasta el techo de salida.
 */
export const abiertosDe = (lifecycle) => (lifecycle ?? [])
  .filter((f) => f.status !== 'FIXED' && f.verdict !== 'REFUTED');

export function contextoDeRevision(ctx) {
  const bloqueados = ctx.artifacts?.Security?.payload?.blocked ?? [];
  const previos = ctx.lifecycle ?? [];
  if (!bloqueados.length && !previos.length) return {};

  // EN UN REWORK VIAJA MENOS, Y OTRA COSA.
  //
  // C-3 acoto el FORMATO de la respuesta -- «MAXIMO 3 hallazgos»-- y ahi se
  // quedo. La PREGUNTA seguia siendo «aplica los 12 lentes a todo el cambio», asi
  // que el trabajo mental era el mismo y solo se comprimia lo que se decia. Si
  // `completion_tokens` incluye el razonamiento, un contrato mas corto no puede
  // acotar eso NUNCA: acota la respuesta, no el pensamiento
  // (memory/failures/el-contrato-corto-acota-la-respuesta-no-el-pensamiento.md).
  //
  // MEDIDO en H-20260818-72a39e18: la etapa 9 del rework agoto los 32.768 dos
  // veces, con la reduccion aplicada, la misma entrada (+2 % de diff) y el mismo
  // modelo que habia pasado la ronda anterior.
  //
  // Asi que se recorta en el ORIGEN: solo lo que sigue abierto, sin el marcador
  // de la ronda. Vale INDEPENDIENTEMENTE de si la hipotesis del razonamiento se
  // confirma, que es lo que la hace la correccion correcta hoy.
  const abiertos = abiertosDe(previos);
  return {
    Contexto: {
      payload: {
        rondaAnterior: (esRework(ctx) ? abiertos : previos).map((f) => ({
          status: f.status, severity: f.severity, file: f.file, symbol: f.symbol,
          claim: String(f.claim ?? '').slice(0, 200),
        })),
        seguridadBloqueo: bloqueados.map((f) => ({ severity: f.severity, rule: f.rule, path: f.path })),
      },
    },
  };
}

/**
 * LA PREGUNTA, y cambia de FORMA entre ronda 0 y rework.
 *
 * Ronda 0: revision entera, los 12 lentes, es la primera vez que alguien mira
 * este cambio.
 *
 * Rework: DOS preguntas y nada mas. Se corrigio lo confirmado, y el fix
 * introdujo algo. Un rework no tiene que redescubrir el cambio: ya se reviso
 * entero en la ronda anterior, y volver a pedir los 12 lentes es pagar ese
 * trabajo otra vez para tirarlo.
 *
 * PURA y exportada: comprobarla a traves de una vuelta costaria 40 minutos.
 */
export function preguntaDeValidacion(ctx) {
  if (!esRework(ctx)) {
    return 'Devuelve {"findings":[…]} con los 12 lentes. Cada hallazgo con file, symbol, claim y '
      + 'evidence citable. MAXIMO 10 hallazgos, los mas graves primero, y `evidence` de una '
      + 'linea: no repitas el codigo citado. CERO hallazgos es un resultado valido y preferible '
      + 'a uno fabricado.';
  }
  const abiertos = abiertosDe(ctx.lifecycle);
  return 'Esto es un REWORK: el cambio YA se reviso entero en la ronda anterior. NO repitas la '
    + 'revision completa ni mires lo que no cambio. Responde SOLO a dos preguntas:\n'
    + `  1. ¿se corrigio cada uno de los ${abiertos.length} hallazgo(s) que seguian abiertos?\n`
    + '  2. ¿el fix introdujo alguno nuevo, EN LAS LINEAS QUE ACABAN DE CAMBIAR?\n'
    + 'Devuelve {"findings":[…]} con lo que siga abierto o sea nuevo. MAXIMO 5 hallazgos. '
    // `claim` SE NOMBRA, y se nombra por lo que paso: este enunciado pedia
    // `evidence` y no pedia `claim`, asi que el revisor de H-20260819-68ac6919
    // devolvio dos hallazgos con `claim` vacio y `evidence` lleno. Un hallazgo
    // sin claim no solo es ilegible: `fingerprint` se construye con el, y sin el
    // dos hallazgos distintos colapsan en uno. Ahora ademas lo hace cumplir el
    // contrato (`FindingSet.elements`), que es donde tiene que estar la regla:
    // un enunciado que pide bien es una cortesia, no una garantia.
    + 'Cada hallazgo lleva `claim` -- UNA frase que dice que esta mal-- y `evidence` de una '
    + 'linea que lo respalde. Un hallazgo sin `claim` se rechaza. '
    + 'CERO hallazgos es el resultado esperado si el fix es correcto, '
    + 'y es preferible a uno fabricado. No repitas el codigo citado ni razones en voz alta: '
    + 'responde el JSON.';
}

/**
 * LA MISMA PALABRA NOMBRABA DOS HECHOS OPUESTOS, y le llegaban los dos juntos.
 *
 * El revisor recibe `Intencion` (el WorkPackage) y `ChangeSet` (la Execution).
 * Los dos payloads traian una clave `files`:
 *
 *   Plan.payload.files       lo que se PUEDE tocar   (el allowlist, task.files)
 *   Execution.payload.files  lo que quedo CAMBIADO   (git status del workspace)
 *
 * MEDIDO en H-20260820-c9a55e79, item `cm-4-security`. El revisor levanto un P2:
 *
 *   «El fichero de produccion queda modificado al final (hash 6efddf6e) pese a
 *    que el summary afirma diff vacio Y EL ALLOWLIST LO EXCLUYE.»
 *
 * La segunda mitad es FALSA: `task.files` de h-002 incluye ese fichero -- es la
 * SEMILLA de la vuelta. El revisor leyo la lista de cambiados creyendo que era el
 * allowlist. El builder leyo el diff, no vio el fichero y contesto «el hallazgo es
 * FALSO». Ninguno mintio y ninguno pudo ganar: quemo cuatro rondas y agoto el
 * techo de la campana.
 *
 * No se arregla pidiendole al modelo que se fije mas. Se arregla no dandole dos
 * cosas distintas con el mismo nombre.
 */
export function entradasDeRevision(plan, changeSet) {
  const conClave = (art, vieja, nueva) => {
    const p = art?.payload;
    if (!p || p[vieja] === undefined) return art;
    const { [vieja]: valor, ...resto } = p;
    return { ...art, payload: { ...resto, [nueva]: valor } };
  };
  return {
    Intencion: conClave(plan, 'files', 'allowlist'),
    ChangeSet: conClave(changeSet, 'files', 'changedFiles'),
  };
}

const pedirValidacion = (ctx, extraSufijo = '') => pedir(ctx, 'reviewer', {
  stage: 'Validation', contract: 'FindingSet',
  inputs: {
    // La INTENCION original, para poder juzgar el cambio contra lo que se pidio.
    // `entradasDeRevision` renombra las DOS claves `files` que llegaban juntas:
    // `allowlist` (lo que se puede tocar) y `changedFiles` (lo que quedo cambiado).
    ...entradasDeRevision(ctx.artifacts.Plan, ctx.artifacts.Execution),
    ...contextoDeRevision(ctx),
  },
  // El tope de 10 no es una preferencia de estilo: sin el, el revisor agoto los
  // 32768 tokens de salida con 7,5 KB de entrada y tumbo la vuelta
  // H-20260816-bebf4372 en la etapa 8. Un hallazgo que no entra entre los diez
  // mas graves no iba a bloquear la convergencia de todos modos.
  // La pregunta cambia de FORMA en un rework, no solo de tamano. Ver
  // `preguntaDeValidacion`: el tope de 10 vive ahi con el resto del enunciado.
  extra: preguntaDeValidacion(ctx) + avisoDeCicloDeVida(ctx.lifecycle) + extraSufijo,
  // Lo que se le quita si se corta ya NO se declara aqui: lo declara el contrato
  // FindingSet en policy/tools.json. Escrito en esta etapa valia para esta etapa,
  // y las otras ocho llamadas a `pedir` se quedaban con el ruego generico.
});

// ── 9. Adversarial ───────────────────────────────────────────────────────────
/**
 * N pasadas INDEPENDIENTES, y el veredicto por mayoria.
 *
 * Una sola pasada era una muestra de un proceso ruidoso: el mismo hallazgo P5
 * sobre el MISMO codigo salio CONFIRMED, CONFIRMED y REFUTED en tres rondas de
 * H-20260816-b0ae48ef, y el anillo paso en la tercera. Pasar porque toco la
 * pasada blanda no es converger.
 *
 * En PARALELO porque deben ser independientes: ninguna ve el veredicto de otra.
 * Y una pasada que falla es una ABSTENCION, no un fallo de etapa -- si cualquiera
 * de las tres pudiera tumbar la vuelta, habriamos triplicado la superficie de
 * fallo y el anillo seria menos fiable que con una sola.
 */
/**
 * Lo que ve una pasada de refutacion. PURO, y separado del handler a proposito.
 *
 * EL DEFECTO: la pasada recibia SOLO el FindingSet. Se le pedia «comprueba la
 * premisa contra el codigo» sin darle el codigo, asi que lo unico que podia hacer
 * era juzgar el TEXTO del hallazgo -- y un texto no cambia porque el builder
 * arregle el fichero. De ahi que un hallazgo ya corregido saliera CONFIRMED tres
 * veces seguidas: no es que la pasada se equivocara, es que no tenia con que
 * acertar.
 *
 * Ahora ve el MISMO ChangeSet que vio Validation, que es el de la ronda actual:
 * en un REWORK el motor vuelve a la etapa 7, asi que `artifacts.Execution` ya trae
 * las correcciones del builder. Comprobar la premisa pasa a ser posible.
 */
/**
 * TRES PASADAS NO SON TRES OPINIONES si salen del mismo modelo.
 *
 * Cada voto llevaba `pass: 1|2|3` y NADA sobre quien voto. Aguas abajo,
 * `confirmed: 3` se lee como consenso de tres -- y en H-20260824-fa058d63 eran
 * tres muestras del MISMO `deepseek:deepseek-v4-pro`, que ademas es el modelo que
 * habia escrito los hallazgos como `reviewer`.
 *
 * Las tres razones venian redactadas distinto, asi que el remuestreo es real y no
 * una copia de cache. Pero tres muestras de un modelo correlacionan casi por
 * completo: en el hallazgo F1 las tres se equivocaron igual, y era un P1 FALSO.
 *
 * `independence.status` ya declaraba DEGRADED arriba. El numero que la
 * convergencia cuenta no lo heredaba: seguia diciendo 3.
 *
 * Extension de la regla de los saltados y la de la abstencion:
 *   confirmar por no poder comprobar sale con la misma etiqueta que comprobar,
 *   y confirmar tres veces con el mismo modelo sale con la misma etiqueta que
 *   confirmar con tres.
 *
 * Hallazgo de third auditando h-007.
 */
export function sellarVotantes(votado, pasadas) {
  const modeloDe = (i) => (pasadas ?? [])[i]?.model ?? null;
  const distintos = new Set((pasadas ?? []).filter((p) => p?.ok && p.model).map((p) => p.model));
  return {
    ...votado,
    findings: (votado?.findings ?? []).map((f) => ({
      ...f,
      votes: (f.votes ?? []).map((v) => ({ ...v, model: modeloDe((v.pass ?? 1) - 1) })),
    })),
    // `passes` es cuantas VECES se pregunto; `voters` cuantos DISTINTOS
    // contestaron. Que sean el mismo numero es la excepcion, no la norma.
    voters: distintos.size,
  };
}

export function entradaAdversarial(ctx) {
  const base = ctx.artifacts?.Validation?.payload?.findings ?? [];

  // LA IDENTIDAD VIAJA. El harness calcula el `fingerprint` de cada hallazgo y lo
  // manda como `id`; el modelo lo COPIA en su voto. Antes se le pedia que
  // devolviera el hallazgo entero para poder recalcularla, y eso fallaba de las
  // dos formas posibles: si reformulaba, el voto no casaba (6 votos tirados en
  // H-20260818-50778834); si abreviaba, el contrato lo rechazaba entero (la unica
  // pasada que contesto en H-20260821-575882c8).
  const proy = proyectar('FindingSet', ctx.artifacts?.Validation);
  // `proyectar` conserva el envoltorio `{payload}` cuando el artefacto lo trae, y
  // lo quita cuando no. Se respetan las dos formas: escribir la lista en el sitio
  // equivocado deja al modelo sin `id` y todos los votos salen huerfanos.
  const cuerpo = proy?.payload ?? proy ?? {};
  const ids = idsDe(cuerpo.findings);
  const conId = { ...cuerpo, findings: (cuerpo.findings ?? []).map((f, i) => ({ id: ids[i], ...f })) };
  const inputs = {
    FindingSet: proy?.payload ? { ...proy, payload: conId } : conId,
    ChangeSet: entradasDeRevision(null, proyectar('ChangeSet', ctx.artifacts?.Execution)).ChangeSet,
    // EL ALLOWLIST, que no llegaba. Un refutador solo vale lo que puede comprobar.
    //
    // MEDIDO en H-20260820-c9a55e79: el revisor levanto un P2 que afirmaba «Y EL
    // ALLOWLIST LO EXCLUYE» sobre un fichero que el allowlist SI incluye --era la
    // semilla de la vuelta-- y esta etapa lo CONFIRMO. No podia hacer otra cosa:
    // se le pidio refutar una afirmacion sobre una lista que no tenia delante.
    //
    // Confirmar por no poder comprobar es la peor forma de confirmar, porque sale
    // con la misma etiqueta que una comprobacion de verdad. ADR-003 exige que el
    // refutador sea de otra familia; esto exige que ademas VEA lo que juzga.
    Alcance: { payload: { allowlist: ctx.artifacts?.Plan?.payload?.files ?? [] } },
  };

  return {
    inputs,
    extra: 'REFUTA. Comprueba la PREMISA de cada hallazgo contra el ChangeSet que acompana a este '
      + 'FindingSet. En la ronda 4 de esta rama, 15 de 23 cayeron porque el mecanismo citado era '
      + 'falso o la cita estaba fabricada.\n\n'
      + 'OJO CON LAS DOS LISTAS, que no son la misma y un hallazgo real las confunde: '
      + '`Alcance.allowlist` es lo que se PUEDE tocar; `ChangeSet.changedFiles` es lo que quedo '
      + 'CAMBIADO. Un fichero permitido y no cambiado es lo NORMAL. Si un hallazgo afirma algo '
      + 'sobre el allowlist, comprueba `Alcance.allowlist` -- y si no puedes comprobarlo, REFUTA: '
      + 'confirmar por no poder comprobar sale con la misma etiqueta que comprobar.\n\n'
      + 'DEVUELVE SOLO VOTOS, no hallazgos:\n'
      + '`{"votes":[{"id":"1","vote":"CONFIRMED"|"REFUTED","reason":"media linea"}]}`\n'
      + `El \`id\` es el NUMERO que lleva cada hallazgo: ${base.map((_, i) => i + 1).join(', ')}. `
      + `UN voto por cada uno de los ${base.length}, ni uno mas, ni uno menos. `
      + 'No inventes ids ni uses otro formato: un voto con un `id` que no esta en esa lista se '
      + 'descarta y cuenta como abstencion. '
      + 'NO repitas `file`, `symbol`, `claim`, `severity` ni `evidence`: ya los tengo. '
      + 'No anadas hallazgos nuevos, no omitas ninguno y no reproduzcas el codigo. '
      + 'Un hallazgo que omitas cuenta como abstencion, no como refutacion.'
      + avisoDeArrastre(base)
      + avisoDeCicloDeVida(ctx?.lifecycle),
  };
}

export async function adversarial(ctx) {
  const base = ctx.artifacts.Validation?.payload?.findings ?? [];

  // LA TERCERA FUENTE. Compute la resolvio evitando la familia del escritor Y la
  // del revisor; aqui solo se usa. Si no habia ninguna, `assignments.adversarial`
  // ES la del revisor y Compute ya lo declaro DEGRADED con su motivo -- degradar
  // esta permitido, degradar en silencio no.
  const asign = ctx.assignments?.adversarial ?? await resolverModelo(ctx, 'reviewer');
  const rol = ctx.assignments?.adversarial ? 'adversarial' : 'reviewer';
  const indep = ctx.independence ?? null;

  // Sin hallazgos no hay nada que refutar, y tres llamadas para votar sobre el
  // conjunto vacio son tres llamadas tiradas.
  if (!base.length) {
    contar(ctx, rol);
    return {
      payload: { findings: [], passes: 0, passesOk: 0, disagreements: 0, undecided: 0, independence: indep },
      producedBy: { capability: rol, ...asign, passes: 0, why: 'Validation no produjo hallazgos' },
    };
  }

  const { inputs, extra } = entradaAdversarial(ctx);

  const unaPasada = async (i) => {
    contar(ctx, rol);
    const r = await invokeCapability(cap('reviewer'), asign, {
      stage: 'Adversarial', contract: 'VoteSet',
      inputs,
      // La unica diferencia entre pasadas. No es para que respondan distinto:
      // es para que la cache del proveedor no devuelva tres veces la MISMA
      // respuesta y el voto sea un voto repetido en vez de tres votos.
      extra: `${extra}\n\n[pasada ${i + 1} de ${PASADAS}, independiente: no conoces las otras]`,
    });
    const modelo = `${asign?.provider ?? '?'}:${asign?.model ?? '?'}`;
    return r.ok ? { ok: true, votes: r.payload.votes ?? [], model: modelo } : { ok: false, error: r.error, model: modelo };
  };

  // EN SERIE SI EL MODELO CORRE AQUI. Ver `adversarial.enSerie`: medido, tres
  // inferencias concurrentes en la misma CPU dan una pared 3,5x PEOR y estiran
  // cada peticion entre 7 y 21 veces, que es lo que la empuja contra los 300 s
  // de undici. La independencia es sobre lo que cada pasada VE, no sobre cuando
  // corre.
  const { loadCatalog } = await import('./capabilities.mjs');
  const serie = enSerie(loadCatalog(), asign);
  let pasadas;
  if (serie) {
    pasadas = [];
    for (let i = 0; i < PASADAS; i++) pasadas.push(await unaPasada(i));
  } else {
    pasadas = await Promise.all(Array.from({ length: PASADAS }, (_, i) => unaPasada(i)));
  }

  const votado = unificarVotos(base, pasadas);
  if (!votado.passesOk) {
    throw new Error(`las ${PASADAS} pasadas de refutacion fallaron: ${pasadas.map((p) => p.error).join(' · ')}`);
  }

  return {
    payload: { ...sellarVotantes(votado, pasadas), independence: indep },
    producedBy: {
      capability: rol, ...asign,
      passes: PASADAS, passesOk: votado.passesOk, disagreements: votado.disagreements,
      independence: indep?.status ?? null,
    },
  };
}

// ── 11. Security ─────────────────────────────────────────────────────────────
/**
 * Security — los scanners CORREN, y la politica decide.
 *
 * Antes esta etapa era una sola llamada a un modelo que declaraba `MISSING` de
 * memoria. Ahora ejecuta semgrep, `npm audit`, `npm sbom` y el barrido de
 * secretos DENTRO del workspace, sobre los ficheros que la vuelta modifico, y
 * traduce lo que devuelven con `policy/security.json`.
 *
 * La severidad NO la pone el scanner ni el modelo: la pone la politica. Y
 * `scanner output -> PASS` no existe -- un control que no se pudo ejecutar sale
 * `MISSING`, que es distinto de `sin hallazgos`.
 *
 * Al modelo se le pide lo unico que un scanner no sabe hacer: leer el cambio y
 * decir si hay algo que las reglas no cubren. Su respuesta se ANEXA; no altera
 * ningun veredicto (ADR-004 aplicado a Security).
 */
export async function security(ctx) {
  const ws = ctx.workspace ?? ctx.artifacts?.Sandbox?.payload;
  const cambio = ctx.artifacts?.Execution?.payload ?? {};
  const policy = loadSecurityPolicy();
  const hoy = new Date().toISOString().slice(0, 10);

  const { controles, findings } = await escanear(ws, {
    files: cambio.files ?? [], diff: cambio.diff ?? '', policy,
  });
  // EL BARRIDO DE LA SEMILLA VA AQUI, DELANTE DEL VEREDICTO. Estaba treinta
  // lineas mas abajo, DESPUES de `aplicarPolitica`: el hecho se media y no
  // decidia nada. Ver `veredictoDeSemillas` en semillas.mjs para el defecto
  // entero (h-007) -- el resumen es que `secretos()` barre el DIFF de la vuelta,
  // asi que la credencial sembrada solo entraba en su poblacion si el builder
  // tocaba ese fichero, y el ALLOW no significaba «limpio» sino «nadie miro ahi».
  // EL DESTINO DE LO QUE SE SEMBRO, publicado donde se busca.
  //
  // MEDIDO sobre las nueve vueltas del 21-22 ago: esta etapa daba los MISMOS 12
  // hallazgos con semilla y sin ella, porque para cuando corre el builder ya la
  // ha corregido. O sea que el artefacto que alguien abre para preguntar «¿mordio
  // la puerta?» no decia nada de la semilla, y la respuesta habia que
  // reconstruirla leyendo las llamadas de la etapa 7 una a una.
  //
  // En `84b9ad17` la respuesta era que SI: run_gate en rojo, el builder leyo la
  // evidencia, parcheo el fichero, run_gate en verde. Eso es VAL-011 demostrado
  // en vivo, y no se estaba contando. Una capacidad que hay que reconstruir a
  // mano de un log no esta demostrada: esta escondida.
  const seeded = ctx.artifacts?.Sandbox?.payload?.seeded ?? [];
  // EL BARRIDO, que es lo unico MEDIDO de los cuatro campos. Los otros tres se
  // infieren de la secuencia de llamadas --hubo un rojo, alguien toco, hubo un
  // verde-- y eso es un proxy. Y al cerrar la vuelta el workspace SE BORRA, asi
  // que `corregida: true` deja de poder convertirse en medicion PARA SIEMPRE.
  //
  // El valor no se guarda en ningun sitio: se RE-DERIVA de (tipo, executionId),
  // que es la misma sal con la que se sembro. Medir sin guardar.
  //
  // El patron va por STDIN y no por argv: un secreto en la linea de comandos es
  // visible en `ps`, y este arreglo existe justamente para eso.
  const { credencialSintetica } = await import('./credenciales-sinteticas.mjs');
  const barrer = (s) => {
    if (!s?.generado) return null;   // semilla literal: no hay valor re-derivable
    const v = credencialSintetica(s.generado, ctx.executionId);
    if (!v) return null;
    try {
      execFileSync('grep', ['-rlF', '-f', '-', '--exclude-dir=node_modules', '--exclude-dir=.git', '--', ws.path],
        { input: v, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
      return true;                   // exit 0 = lo encontro
    } catch (e) {
      // grep sale 1 cuando NO hay coincidencias y >1 cuando falla de verdad.
      // Confundirlos convertiria «no pude mirar» en «no esta», que es la clase
      // de silencio que este campo existe para no tener.
      return e?.status === 1 ? false : null;
    }
  };
  const semillas = destinoDeSemillas(seeded, cambio.toolCalls ?? [], {
    sigueEnElArbol: barrer,
    // Lo que la ronda ANTERIOR establecio. Sin esto, el artefacto final de una
    // vuelta con rework dice «nadie la cazo» porque en la ronda 2 el builder la
    // quita antes del primer gate y ya no hay rojo que ver.
    previas: ctx.semillasPorRonda?.at(-1) ?? null,
  });
  ctx.semillasPorRonda = [...(ctx.semillasPorRonda ?? []), semillas];
  const { hallazgos: deSemilla, noMedidas: semillasNoMedidas } = veredictoDeSemillas(semillas);

  const veredicto = aplicarPolitica([...findings, ...deSemilla], policy, { hoy });
  const caducadas = excepcionesCaducadas(policy, hoy);

  // El modelo LEE; no decide. Si falla, la etapa NO cae: los controles ya
  // corrieron y su resultado no depende de que alguien lo comente.
  let lectura = null;
  try {
    const r = await pedir(ctx, 'security', {
      stage: 'Security', contract: 'SecurityReport',
      inputs: {
        ChangeSet: ctx.artifacts.Execution,
        Controles: { payload: { controles: resumen(controles), gate: veredicto.gate, counts: veredicto.counts } },
      },
      extra: 'Los scanners YA corrieron y su veredicto no se discute. Di UNA cosa que las '
           + 'reglas de harness/security/rules.yaml no cubran y que este cambio introduzca. '
           + 'Si no ves ninguna, dilo: inventar un riesgo es peor que no verlo. '
           + 'Devuelve sca/sbom/sast/owasp copiando el estado que se te da.',
    });
    lectura = r.payload;
  } catch (e) {
    lectura = { error: String(e.message).slice(0, 200) };
  }

  const estados = resumen(controles);

  return {
    payload: {
      ...(semillas.length ? { seeds: semillas, seedsResumen: resumenDeSemillas(semillas) } : {}),
      // El contrato exige estos cuatro; salen del ESTADO de los controles, no de
      // lo que declare nadie.
      sca: estados['sca:fe'] ?? 'MISSING',
      sbom: estados.sbom ?? 'MISSING',
      sast: estados.sast ?? 'MISSING',
      owasp: 'PARTIAL',
      owaspMap: policy.owasp,
      controls: controles.map(({ findings: _f, ...c }) => c),
      gate: veredicto.gate,
      counts: veredicto.counts,
      findings: veredicto.findings,
      blocked: veredicto.blocked,
      expiredExceptions: caducadas.map((e) => e.id),
      modelReading: lectura,
    },
    __gate: veredicto.gate,
    // Un control caducado no es un detalle de contabilidad: dejo de proteger.
    // Y una semilla que NO SE PUDO BARRER tampoco: `sigueEnElArbol === null` es
    // «no pude mirar», que no es «no esta». Un control que no se pudo ejecutar
    // sale MISSING, nunca PASS -- es la regla de esta misma etapa, aplicada al
    // unico campo que hasta hoy no la cumplia.
    ...(caducadas.length || semillasNoMedidas.length
      ? { status: 'WARN', reason: [
            caducadas.length ? `excepciones caducadas: ${caducadas.map((e) => e.id).join(', ')}` : null,
            semillasNoMedidas.length ? `semillas SIN BARRER (no se pudo mirar, no es «no esta»): ${semillasNoMedidas.join(', ')}` : null,
          ].filter(Boolean).join(' · ') }
      : {}),
  };
}

/**
 * El gate de seguridad, aparte del handler para poder probarlo sin escanear.
 *
 * LANZA cuando la politica bloquea. Es lo que convierte un informe en una
 * puerta: un `SecurityReport` con hallazgos bloqueantes que deja pasar la vuelta
 * es documentacion, no seguridad. `onFail: REWORK` en el manifiesto hace que el
 * builder vuelva a Execution con el hallazgo delante, lo corrija por el Mutation
 * Protocol, y el reescaneo de la ronda siguiente decida.
 */
export function assertSecurityGate(payload) {
  if (payload?.gate !== 'BLOCK') return payload;
  const d = (payload.blocked ?? []).map((f) => `${f.severity} ${f.rule} en ${f.path}:${f.location}`);
  throw new Error(`seguridad BLOQUEA: ${payload.counts.block} hallazgo(s) — ${d.join(' · ')}`);
}

// ── 16. Learning ─────────────────────────────────────────────────────────────
export const learning = (ctx) => pedir(ctx, 'trigger', {
  stage: 'Learning', contract: 'LearningRecord',
  inputs: { EvidencePackage: ctx.artifacts.Evidence2 ?? ctx.artifacts.Evidence },
  extra: '¿Que aprendio esta vuelta que siga siendo cierto la semana que viene? '
       + 'Si nada, `worthKeeping: false` con motivo — es un resultado valido. '
       + 'Si algo, nombra las rutas en `memoryEntries` con el formato de memory/README.md.',
});

/**
 * Release — redacta el resumen del EvidencePackage.
 *
 * Su etapa (Evidence2) es determinista: el veredicto sale del codigo de salida
 * del gate y NO se le consulta al modelo (ADR-004). Lo que si es trabajo de
 * modelo es contar que paso en la vuelta de forma legible.
 *
 * Existe porque `release` era el dueno declarado de la etapa 15 y no se invocaba
 * nunca: Compute le asignaba un modelo que jamas se usaba, y FT-4 lo marcaba
 * -con razon- como "asignado y NUNCA invocado".
 */
export async function releaseSummary(ctx, paquete) {
  return pedir(ctx, 'release', {
    stage: 'Evidence2', contract: 'EvidencePackage',
    inputs: { Verdict: ctx.artifacts.Convergence, SecurityReport: ctx.artifacts.Security },
    extra: [
      'El paquete de evidencia YA esta calculado y su `verdict` no se discute:\n\n',
      '```json\n', JSON.stringify(paquete, null, 2).slice(0, 6000), '\n```\n\n',
      'Devuelve el MISMO objeto anadiendo una clave `summary`: dos o tres frases que',
      ' cuenten que se cambio, que lo valido y que quedo abierto. Sin adjetivos y sin',
      ' repetir cifras que ya estan en el objeto.',
    ].join(''),
  });
}
