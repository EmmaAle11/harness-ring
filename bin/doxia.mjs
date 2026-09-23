#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// DoxIA Harness — CLI.
//
// Orquesta; NO calcula. Toda la logica que merece un test vive en harness/lib/
// con su test al lado. Es la misma regla que el repo aplica al backend: un fix
// va en el fichero puro, no en el orquestador.
//
//   doxia doctor    que proveedores responden DE VERDAD
//   doxia sync      regenera .kiro/agents, .claude/agents y los hooks
//   doxia plan      resuelve una referencia pineada de la boveda
//   doxia gate      invoca scripts/gate.sh (NO reimplementa nada)
//   doxia state     el tablero; `state save` lo vuelca (sobrevive a /compact)
//   doxia run       ejecuta el ciclo
// ─────────────────────────────────────────────────────────────────────────────
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { redactarSecretos } from '../lib/secretos.mjs';
import { ROOT, RUNTIME, loadCapabilities, loadRouter, loadCatalog } from '../lib/capabilities.mjs';
import { resolveModel } from '../lib/router.mjs';
import { converge, bloqueantes } from '../lib/converge.mjs';
import { saveState, loadState, renderState } from '../lib/state.mjs';
import { resolvePlan, tareasDePlan, rutasContraElArbol } from '../lib/plan.mjs';
import { probeAll, aliveSet, modelSet, invoke } from '../adapters/models/index.mjs';
import { syncKiro } from '../adapters/kiro.mjs';
import { syncClaudeCode } from '../adapters/claude-code.mjs';
import { runRing, newExecutionId } from '../lib/ring.mjs';
import { revisar as revisarSpec } from '../lib/spec.mjs';
import { drenar as drenarTelemetria } from '../lib/telemetry.mjs';
import { claim, release } from '../lib/claim.mjs';
import * as sandbox from '../lib/sandbox.mjs';
import { buildTrace, checkTrace, loadRun, reconstruct } from '../lib/trace.mjs';
import { stageArtifactName, specManifestPath } from '../lib/artifact.mjs';
import { runFitness } from '../lib/fitness.mjs';
import { ringHandlers, saveLearning, saveLearningCandidates } from '../lib/stages.mjs';
import { ENV_LIMPIO } from '../lib/sandbox.mjs';
// C-6. Se importan con alias porque `run`, `state` y `trace` ya ocupan esos nombres
// en este fichero: el CLI es la unica capa donde conviven todos los verbos.
import {
  crear as crearCampana, leer as leerCampana, guardar as guardarCampana,
  aplicar as aplicarCampana, estado as estadoCampana,
  siguiente as siguienteItem, dentroDelGasto,
} from '../lib/campaign.mjs';

const [cmd, ...args] = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };

// ── doctor ───────────────────────────────────────────────────────────────────
// La disponibilidad la dice la MAQUINA, no el JSON. Un proveedor declarado y
// no cableado sale `sin adaptador`, no "configurado".
async function doctor() {
  const router = loadRouter();
  const probes = await probeAll();
  const vivos = aliveSet(probes);
  const instalados = modelSet(probes);   // el modelo pedido, ademas del proveedor
  const catalog = loadCatalog();

  console.log('\n  Proveedores');
  console.log('  ─────────────────────────────────────────────────────────────');
  for (const [id, decl] of Object.entries(router.providers)) {
    const p = probes[id];
    const estado = !p ? 'sin adaptador' : p.alive ? 'VIVO' : 'caido';
    const nota = p ? p.detail : decl.note || `declarado (${decl.kind})`;
    console.log(`  ${estado === 'VIVO' ? 'ok  ' : '--  '} ${id.padEnd(10)} ${estado.padEnd(14)} ${nota}`);
  }

  console.log('\n  Clases de tarea');
  console.log('  ─────────────────────────────────────────────────────────────');
  for (const a of loadCapabilities()) {
    const r = resolveModel(a, { router, catalog, available: vivos, models: instalados });
    console.log(
      r.error ? `  FAIL ${a.id.padEnd(11)} ${r.error}` : `  ok   ${a.id.padEnd(11)} ${a.model_class.padEnd(7)} -> ${r.id}`,
    );
  }

  // La comprobacion que decide si el harness puede funcionar (ADR-003).
  const router2 = loadRouter();
  const builder = loadCapabilities().find((a) => a.id === 'builder');
  const reviewer = loadCapabilities().find((a) => a.id === 'reviewer');
  const b = resolveModel(builder, { router: router2, catalog, available: vivos, models: instalados });
  const rv = b.error ? { error: b.error } : resolveModel(reviewer, { router: router2, catalog, available: vivos, models: instalados, avoid: [b.id] });

  console.log('\n  Diversidad escritor/revisor (ADR-003)');
  console.log('  ─────────────────────────────────────────────────────────────');
  if (b.error || rv.error) {
    console.log(`  FAIL ${b.error || rv.error}`);
    console.log('       El harness NO puede revisar de forma independiente.');
    return 1;
  }
  console.log(`  ok   builder -> ${b.id}   ·   reviewer -> ${rv.id}`);
  console.log('');
  return 0;
}

// ── sync ─────────────────────────────────────────────────────────────────────
function sync() {
  const out = [...syncKiro(), ...syncClaudeCode(), ...syncHooks()];
  console.log(`\n  ${out.length} artefactos regenerados desde harness/capabilities/:`);
  for (const f of out) console.log(`    ${f}`);
  console.log('\n  Son ARTEFACTOS: no los edites, edita el .md fuente.\n');
  return 0;
}

// Los hooks NO se versionan (.gitignore ignora **/.claude/settings.json), asi
// que se INYECTAN en el settings local. El harness sigue siendo la autoridad.
function syncHooks() {
  const path = join(ROOT, '.claude', 'settings.local.json');
  const cfg = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  const doxia = `node "${join(ROOT, 'harness', 'bin', 'doxia.mjs')}"`;

  cfg.hooks ??= {};
  // PreCompact: el unico punto donde se puede salvar el estado ANTES de perder
  // el contexto. Es lo que automatiza el "prompt de arranque" manual.
  cfg.hooks.PreCompact = [{ hooks: [{ type: 'command', command: `${doxia} state save` }] }];
  // SessionStart: su stdout entra al contexto del modelo.
  cfg.hooks.SessionStart = [{ hooks: [{ type: 'command', command: `${doxia} state` }] }];

  mkdirSync(join(ROOT, '.claude'), { recursive: true });
  // sin-redactar: es CONFIGURACION (.claude/settings.local.json, los hooks). No es un
  // artefacto de vuelta y redactarlo dejaria los hooks sin poder ejecutarse.
  writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n');
  return ['.claude/settings.local.json (hooks PreCompact + SessionStart)'];
}

// ── gate ─────────────────────────────────────────────────────────────────────
// Invoca la autoridad. NO reimplementa ninguna comprobacion (ADR-002).
function gate() {
  const mode = has('--full') ? '--full' : '--fast';
  try {
    execFileSync('bash', [join(ROOT, 'scripts', 'gate.sh'), mode], { cwd: ROOT, stdio: 'inherit' });
    return 0;
  } catch (e) {
    return e.status ?? 1;
  }
}

// ── plan ─────────────────────────────────────────────────────────────────────
function plan() {
  const r = resolvePlan(args[0]);
  if (r.error) { console.error(`  ${r.error}`); return 1; }
  console.log(`\n  ref    : ${r.ref}`);
  console.log(`  commit : ${r.commit}`);
  console.log(`  sha256 : ${r.sha256.slice(0, 16)}…`);
  console.log(`  bytes  : ${r.text.length}`);
  if (has('--print')) console.log(`\n${r.text}`);

  // --spec: DE PLAN A TAREA, y todo lo que no se supo leer.
  //
  // El anillo consume `.kiro/specs/<id>/<id>.json`; `third` produce markdown. Sin
  // esto, correr uno de sus planes exige que un humano lo transcriba, y lo que se
  // pierde en la transcripcion no lo ve nadie.
  //
  // NO escribe la spec: la PROPONE y la juzga. Escribirla sola convertiria una
  // lectura en una autoridad, y quien redacta la tarea sigue siendo una persona.
  if (has('--spec')) {
    const { tareas, problemas } = tareasDePlan(r.text);
    console.log(`\n  ${tareas.length} tarea(s)\n`);
    for (const t of tareas) {
      const p = revisarSpec({ goal: t.goal, files: t.files, forbiddenPaths: t.forbiddenPaths, acceptance: t.acceptance });
      const modulos = new Set(t.files.map((f) => f.split('/').slice(0, 3).join('/')));
      console.log(`  T${t.n}  ${t.goal.slice(0, 56)}`);
      console.log(`      files ${t.files.length} · acceptance ${t.acceptance.length}`
        + ` · noTocar ${t.forbiddenPaths.length} · modulos ${modulos.size}`
        + ` · presupuesto ${t.files.length * 45} lineas`);
      for (const q of p) console.log(`      SPEC_BLOCKED: ${q.slice(0, 100)}`);
    }
    // LOS PROBLEMAS AL FINAL Y CONTADOS. Un verbo que el vocabulario no conoce no
    // se salta: sale aqui. Un extractor que ignora lo que no entiende no informa
    // de lo que ignoro, y su silencio se lee como ausencia.
    console.log(`\n  ${problemas.length} problema(s) de lectura del plan`);
    for (const q of problemas) console.log(`      · ${q}`);

    // PASO 2: las rutas contra el arbol. El predicado se construye aqui --una
    // sola lectura de `git ls-tree`-- y se INYECTA: `rutasContraElArbol` es pura.
    // La ref sale de --contra, y si no se puede leer NO se calla: sale CIEGO.
    const contra = val('--contra') ?? 'HEAD';
    let arbol = null;
    try {
      arbol = new Set(execFileSync('git', ['ls-tree', '-r', '--name-only', contra],
        { cwd: ROOT, env: ENV_LIMPIO(), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\n'));
    } catch (e) {
      console.log(`\n  CIEGO contra '${contra}': ${String(e.message).slice(0, 90)}`);
      console.log('      Esto NO es «las rutas estan bien»: es que no se pudo mirar el arbol.');
    }
    if (arbol) {
      const rutas = rutasContraElArbol(tareas, (r) => arbol.has(r));
      console.log(`\n  ${rutas.length} ruta(s) que no casan contra ${contra}`);
      for (const q of rutas) console.log(`      · ${q}`);
    }
  }
  console.log('');
  return 0;
}

// ── fitness ──────────────────────────────────────────────────────────────────
// Los cinco FT sobre una corrida. `--next <id>` da la SEGUNDA corrida que FT-5
// exige: sin ella se demuestra que el recorrido funciona, no que sea un anillo.
function fitness() {
  const id = args.find((a) => !a.startsWith('--'));
  if (!id) { console.error('  uso: doxia fitness <executionId> [--next <id>] [--spec <spec>]'); return 1; }

  // EL MANIFIESTO SALE DE LA CORRIDA, no de un valor por defecto. `--spec` sigue
  // existiendo para las vueltas viejas, que no lo registraron; lo que se quita es
  // ADIVINAR. Si no se sabe contra que spec juzgar, se dice: los cinco fitness
  // tests comparan el ChangeSet contra `task.files` y `forbiddenPaths`, asi que
  // con el manifiesto de otra tarea el veredicto es ruido con forma de resultado.
  const specDeLaCorrida = (() => {
    try {
      const t = JSON.parse(readFileSync(join(RUNTIME, 'runs', id, 'trace.json'), 'utf8'));
      return t.specId ?? null;
    } catch { return null; }
  })();
  const specId = val('--spec') ?? specDeLaCorrida;
  if (!specId) {
    console.error(`\n  ${id} no registro contra que spec corrio, y no se va a adivinar.`);
    console.error('  Las vueltas anteriores al 2026-08-19 no lo escribian. Dilo tu:\n');
    console.error(`    doxia fitness ${id} --spec <spec>\n`);
    return 1;
  }
  const manifest = JSON.parse(readFileSync(specManifestPath(ROOT, specId), 'utf8'));
  const r = runFitness(id, manifest, { nextId: val('--next') });

  if (r.error) { console.error(`  ${r.error}`); return 1; }

  console.log(`\n  Fitness · ${id}`);
  console.log('  ─────────────────────────────────────────────────────────────');
  for (const t of r.results) {
    console.log(`  ${t.pass ? 'ok  ' : 'FAIL'} ${t.id}  ${t.name}`);
    for (const d of t.detail) console.log(`         ${d}`);
  }
  console.log('  ─────────────────────────────────────────────────────────────');
  console.log(`  ${r.pass ? 'EL ANILLO CERRO' : 'NO CERRO'} — ${r.results.filter((x) => x.pass).length}/5\n`);

  writeFileSync(join(RUNTIME, 'runs', id, 'fitness.json'),
    redactarSecretos(JSON.stringify(r, null, 2)) + '\n');
  return r.pass ? 0 : 1;
}

// ── trace ────────────────────────────────────────────────────────────────────
// Reconstruye una corrida leyendo SOLO .harness/runs/<id>/. Es la prueba de la
// Fase 9: si hiciera falta un dato que no esta ahi, la corrida no es auditable.
function trace() {
  const id = args.find((a) => !a.startsWith('--'));
  if (!id) { console.error('  uso: doxia trace <executionId> [--json]'); return 1; }

  const r = reconstruct(id);
  if (has('--json')) { console.log(JSON.stringify(r.trace ?? {}, null, 2)); return r.ok ? 0 : 1; }

  console.log('');
  for (const l of r.lines) console.log(`  ${l}`);
  if (r.problems.length) {
    console.log('\n  RECONSTRUCCION INCOMPLETA');
    for (const p of r.problems) console.log(`    ${p}`);
  } else {
    console.log('\n  reconstruida entera desde .harness/runs/ — sin memoria humana');
  }
  console.log('');
  return r.ok ? 0 : 1;
}

// ── state ────────────────────────────────────────────────────────────────────
function state() {
  if (args[0] === 'save') {
    const b = saveState({ nota: val('--nota'), bloque: val('--bloque'), ronda: val('--ronda') });
    console.error(`  tablero guardado: ${b.branch} @ ${b.head}`);
    return 0;
  }
  console.log(renderState(loadState()));
  return 0;
}

// ── run ──────────────────────────────────────────────────────────────────────
// El ciclo. Hoy solo la rama --self-review: el harness revisandose a si mismo.
// Un orquestador que nunca orquesto no existe, y su propio diff es el objeto de
// prueba mas seguro que hay -- acotado y sin poder danar el arbol.
/**
 * UNA vuelta del anillo, de punta a punta, y su VEREDICTO.
 *
 * Estaba embebida en `cmdRun`, que solo devuelve 0 o 1. Una campana --C-6, el
 * trabajo que no cabe en una vuelta-- necesita mas: `campaign.aplicar` decide si
 * un item cierra, reabre o se bloquea a partir de si convergio, cuantos hallazgos
 * quedaron sin revisar y cuantos bloquean. Nada de eso cabe en un entero.
 *
 * La biblioteca de campana estaba entera y probada desde C-6 y NO tenia conductor:
 * `grep campaign harness/bin/doxia.mjs` no devolvia una linea. Una capacidad que
 * solo existe en su test es una declaracion -- lo mismo que le pasaba a la clase
 * `move` esta manana.
 *
 * Extraccion SIN cambio de comportamiento: el cuerpo es el que ya corria.
 */
export async function correrAnillo({ manifest, specId }) {
    const executionId = newExecutionId();

    // AISLAMIENTO TEMPORAL. El sandbox da un worktree por vuelta, pero
    // `last-learning.json` y `.harness/learning/` son de todas: dos vueltas
    // solapadas hacen que FT-5 compruebe la cadena contra una corrida que no es su
    // predecesora. Ya paso (memory/failures/dos-anillos-a-la-vez.md).
    //
    // Se reclama ANTES de escribir nada y se suelta en `finally`, incluso si la
    // vuelta revienta: un cerrojo que solo se suelta en el camino feliz deja el
    // anillo bloqueado justo cuando algo fallo.
    try {
      claim(executionId);
    } catch (e) {
      console.error(`\n  ${e.message}\n`);
      return { executionId, verdict: 'BLOCKED', reason: e.message, pass: false, convergenceStatus: 'UNKNOWN', blockers: null, unreviewed: 0, trace: null };
    }
    try {
    console.error(`\n  anillo ${manifest.id} · ${executionId} · ${manifest.stages.length} etapas\n`);

    // SE LIMPIA AL ARRANCAR, no al terminar. Los workspaces no los retiraba
    // nadie --ni al fallar ni al cerrar en verde-- y el registro de worktrees es
    // GLOBAL al `.git`: cada vuelta dejaba basura en el `git worktree list` de
    // los otros agentes que comparten el repositorio.
    //
    // Al ARRANCAR y no al terminar porque una vuelta que muere de un `kill` no
    // ejecuta su `finally`; la siguiente si arranca. Limpiar al empezar es lo
    // unico que sobrevive a la forma en que estas cosas se mueren de verdad.
    //
    // Conserva la ULTIMA FALLIDA: es la unica que alguien va a querer abrir.
    try {
      const { retirados, conservado } = sandbox.limpiarWorkspaces({ actual: executionId });
      if (retirados.length) {
        console.error(`  workspaces retirados: ${retirados.length}`
          + `${conservado ? ` · conservado ${conservado} (ultima fallida)` : ''}\n`);
      }
    } catch (e) {
      // Que la limpieza falle NO puede tumbar la vuelta: es higiene, no la tarea.
      console.error(`  aviso: no se pudieron retirar workspaces viejos (${e.message})\n`);
    }

    // Estado compartido entre etapas: Compute lo llena, las demas lo leen.
    const shared = {
      // LA BASE SE FIJA AL ARRANCAR, no cuando llega la etapa 6.
      //
      // Era la CADENA 'HEAD', y `sandbox.create` la resolvia al crear el
      // worktree -- quince minutos despues, porque Knowledge, Evidence, Decision,
      // Plan y Compute van antes. MEDIDO hoy: lance H-20260821-6ebd7317 sobre
      // `896eb9f2` y su workspace salio en `678ff8ae`, tres commits mios mas
      // tarde. La vuelta cambio de base sin que nadie lo pidiera.
      //
      // No es teorico: si uno de esos commits rompe algo, la vuelta falla por una
      // causa que no tiene nada que ver con su tarea, y el diagnostico empieza
      // mirando la tarea. Una vuelta se corre CONTRA UN COMMIT, y ese commit es
      // el que habia cuando se lanzo.
      manifest, commit: sandbox.baseCommit(), startedAt: new Date().toISOString(),
      previousLearning: readJSONSafe(join(RUNTIME, 'runs', 'last-learning.json')),
      assignments: null, workspace: null, invocations: {},
    };
    // `shared` es el PORTADOR mutable: Compute escribe `assignments`, Sandbox
    // escribe `workspace`, y las etapas siguientes los leen. Se mezcla ctx DENTRO
    // de shared, no al reves -- al reves, cada etapa reescribia `workspace` con
    // el null inicial y Execution no encontraba el sandbox que Sandbox creo.
    const handlers = ringHandlers();
    const wrapped = Object.fromEntries(Object.entries(handlers).map(([k, h]) => [
      k, (ctx) => h(Object.assign(shared, ctx)),
    ]));

    const r = await runRing(manifest, wrapped, {
      executionId,
      onStage: (s) => console.error(`    ${String(s.n).padStart(2)} ${s.stage.padEnd(16)} ${s.status.padEnd(7)} ${s.reason ?? ''}`),
      log: (m) => console.error(m),
    });

    const dir = join(RUNTIME, 'runs', executionId);

    // PRIMERO los conteos finales, DESPUES la traza.
    //
    // `buildTrace` lee `r.artifacts`, y el artefacto de AdapterLayer es el
    // snapshot de la etapa 13: no puede haber contado las invocaciones de
    // Evidence2 (15) ni Learning (16), que van detras. Construir la traza antes de
    // consolidar la hacia decir `release=0 trigger=0` sobre una vuelta donde las
    // dos se invocaron -- el mismo defecto que ya costo una vuelta entera cuando
    // la reordenacion dejo atras a sus consumidores, ahora con un consumidor
    // nuevo. Lo encontro `doxia trace` en su primer uso real.
    const bindingsFinales = Object.entries(shared.assignments ?? {}).map(([capability, a]) => ({
      capability, provider: a.provider, model: a.model,
      invocations: shared.invocations?.[capability] ?? 0,
    }));
    if (r.artifacts?.AdapterLayer) {
      r.artifacts.AdapterLayer.payload = { bindings: bindingsFinales };
      consolidar(dir, stageArtifactName(manifest, 'AdapterLayer'), { bindings: bindingsFinales });
    }

    // Observability: la traza es el CAMINO. `invocations: 1` lo pone quien
    // invoca -- el motor no puede saber cuantas veces lo llamaron, y FT-2 lo mide.
    //
    // `parentExecutionId` sale del LearningRecord que esta vuelta consumio, que es
    // la definicion operativa de «la vuelta anterior»: la que dejo lo que esta
    // leyo. Deducirlo por fecha seria adivinar, y las vueltas fallidas no dejan
    // LearningRecord -- asi que la cadena enlaza las que cerraron, que son las
    // unicas que ensenaron algo.
    // La telemetria se DRENA aqui, una sola vez y despues del anillo: el sumidero
    // es de modulo -- `invoke()` no conoce la vuelta -- y quien si la conoce es
    // quien la cierra. Drenar antes dejaria fuera las etapas 15 y 16.
    const trace = buildTrace(r, {
      invocations: 1,
      parentExecutionId: shared.previousLearning?.executionId ?? null,
      telemetry: drenarTelemetria(),
    });
    // LA VUELTA REGISTRA QUE SPEC CORRIO. No lo hacia, y `doxia fitness` tenia que
    // adivinarlo: tomaba `h-001-ring-execution` por defecto. MEDIDO en
    // H-20260819-0015833a --la vuelta de H-004--, FT-3 salio en rojo diciendo que
    // los cuatro ficheros estaban en `forbiddenPaths`; lo estaban en los de H-001,
    // que prohibe `backend/src/**`, no en los de H-004, que lo permite.
    //
    // La direccion peligrosa es la contraria: un manifiesto ajeno tambien puede
    // dar PASS a una vuelta que SI escribio donde tenia prohibido. Un veredicto
    // calculado contra la spec equivocada es peor que no tener veredicto, porque
    // se lee igual que uno bueno.
    // POR `redactarSecretos`, como todo artefacto. `trace.json` NO pasa por
    // `writeArtifact` --se escribe aqui, directo-- asi que la redaccion de 20a92da
    // no lo tocaba: MEDIDO en H-20260824-d897a07f, 4 apariciones de la semilla en
    // claro cuando `07-execution.json` tenia 0 y 5 marcas.
    //
    // Redacte UN camino de escritura y habia otro. Es el guarda que cubre una forma
    // de seis, cometido en el arreglo que existe para eso.
    writeFileSync(join(dir, 'trace.json'),
      redactarSecretos(JSON.stringify({ ...trace, specId }, null, 2)) + '\n');

    // Observability y AdapterLayer RESUMEN la vuelta entera pero corren dentro de
    // ella: no pueden ver lo que viene despues. Sus artefactos se consolidan aqui,
    // cuando ya se conoce el recorrido completo. Sin esto, FT-1 reportaba 10 de 16
    // y FT-4 daba por no invocadas a las capacidades de las ultimas etapas.
    //
    // El NOMBRE se deriva del manifiesto, nunca se escribe a mano: cuando la
    // reordenacion en dos mitades las movio a la 14 y la 13, estos dos literales
    // se quedaron en 11 y 14, `consolidar` callo ante el fichero ausente y el fix
    // dejo de existir sin que nada se pusiera rojo.
    // Solo se consolida lo que LLEGO A CORRER. En una vuelta que se detiene antes
    // —Knowledge en rojo, por ejemplo— esos artefactos no existen y es correcto que
    // no existan: exigirlos hacia que el orquestador reventara DESPUES de que el
    // anillo ya hubiera reportado su fallo, tapando el error real con un stack
    // trace sobre un fichero ausente.
    if (r.artifacts?.Observability) {
      consolidar(dir, stageArtifactName(manifest, 'Observability'), trace);
    }

    const problemas = checkTrace(trace, manifest);
    console.error(`\n  ${r.verdict}${r.reason ? ' — ' + r.reason : ''}`);
    console.error(`  ${r.stages.length}/${manifest.stages.length} etapas · ${trace.totalMs}ms · .harness/runs/${executionId}/`);
    for (const x of problemas) console.error(`  traza: ${x}`);
    console.error('');
    // FT-5: lo aprendido se persiste para que la vuelta N+1 lo consuma.
    const lr = r.artifacts?.Learning?.payload;
    if (lr) console.error(`  learning: ${saveLearning(executionId, lr).replace(ROOT + '/', '')}`);

    // Los TRES niveles. `historicas` son las vueltas anteriores: sin ellas la
    // confianza no sube de 0.5 y nada se auto-promueve nunca, porque la
    // repetibilidad es una propiedad de la serie y no de una corrida.
    try {
      const historicas = corridasAnteriores(executionId);
      const { path: pc, candidates } = saveLearningCandidates(
        executionId, { executionId, trace, artifacts: r.artifacts },
        { historicas, model: shared.assignments?.trigger?.id ?? null, date: new Date().toISOString().slice(0, 10) },
      );
      const n = (v) => candidates.filter((c) => c.decision.verdict === v).length;
      console.error(`  candidatos: ${n('PROMOTE')} PROMOTE · ${n('REVIEW')} REVIEW · ${n('REJECT')} REJECT`
        + ` -> ${pc.replace(ROOT + '/', '')}`);
    } catch (e) {
      console.error(`  candidatos: no se pudieron resolver — ${e.message}`);
    }

    saveState({ nota: `anillo ${executionId}: ${r.verdict} (${r.stages.length}/${manifest.stages.length})` });

    // EL VEREDICTO, no un codigo de salida. `cmdRun` solo necesitaba 0 o 1; una
    // campana necesita saber POR QUE no cerro -- si convergio, cuantos hallazgos
    // quedaron sin revisar y cuantos bloquean-- porque de eso depende si el item
    // vuelve a PENDING, se marca BLOCKED o cierra. `campaign.aplicar` lo exige y
    // no se puede deducir de un entero.
    return {
      executionId,
      verdict: r.verdict,
      reason: r.reason ?? null,
      pass: r.verdict === 'PASSED',
      convergenceStatus: trace.convergence?.status ?? trace.metrics?.convergenceStatus ?? 'UNKNOWN',
      blockers: trace.convergence?.blockers ?? null,
      // Las ABSTENCIONES viven en el artefacto de Adversarial, no en la traza: un
      // item no cierra por abstencion (`cerrar-por-abstencion-no-es-converger`).
      unreviewed: r.artifacts?.Adversarial?.payload?.undecided ?? 0,
      trace,
    };
    } finally {
      release(executionId);
    }
}

async function run() {
  const router = loadRouter();
  const probesSR = await probeAll();
  const vivos = aliveSet(probesSR);
  const instaladosSR = modelSet(probesSR);
  const catalogSR = loadCatalog();
  const agents = loadCapabilities();

  // ── El anillo ──────────────────────────────────────────────────────────────
  // `--ring <spec>` recorre el manifiesto de 16 etapas. Los handlers de cada
  // etapa son WP-D y WP-E; hoy el motor esta y las etapas todavia no.
  if (has('--ring')) {
    const specId = val('--ring') ?? 'h-001-ring-execution';
    const path = specManifestPath(ROOT, specId);
    if (!existsSync(path)) { console.error(`  sin manifiesto: ${path}`); return 1; }

    const manifest = JSON.parse(readFileSync(path, 'utf8'));

    // LA SPEC, ANTES DE GASTAR NADA. Dos de las cinco corridas fallidas de las
    // fases 7-9 murieron por una aceptacion imposible, no por el harness, y las
    // dos agotaron sus REWORK primero: 45 minutos y cuatro invocaciones de
    // modelo para descubrir algo que el manifiesto ya decia. Se comprueba aqui,
    // donde el error cuesta un segundo y ni siquiera se ha reclamado el anillo.
    const problemasSpec = revisarSpec(manifest.task);
    if (problemasSpec.length) {
      console.error(`\n  SPECIFICATION_BLOCKED — ${manifest.id} no se puede ejecutar tal como esta:\n`);
      for (const x of problemasSpec) console.error(`    · ${x}`);
      console.error('\n  No es un fallo del anillo: es la tarea. Corrige el manifiesto.\n');
      return 1;
    }

    const r = await correrAnillo({ manifest, specId });
    return r.pass ? 0 : 1;
  }

  if (!has('--self-review')) {
    console.error('  doxia run --self-review    revision del propio harness');
    console.error('  doxia run --ring <spec>    recorre el anillo de 16 etapas');
    return 2;
  }

  const reviewer = agents.find((a) => a.id === 'reviewer');
  const builder = agents.find((a) => a.id === 'builder');

  // ADR-003 aplicado: el revisor no puede compartir proveedor con el escritor.
  // Aqui "el escritor" fue Claude (esta sesion), asi que se veta explicitamente.
  const m = resolveModel(reviewer, { router, catalog: catalogSR, available: vivos, models: instaladosSR, avoid: ['claude:opus'] });
  if (m.error) { console.error(`  PARADA DURA — ${m.error}`); return 1; }

  // Se revisa CODIGO, no la documentacion que lo acompana. Y fichero a fichero:
  // un modelo local tiene contexto acotado, y meterle 85 KB de golpe devuelve un
  // 400 -- o, peor, un resumen superficial que pasa en verde. Un objeto truncado
  // en silencio es otra vez el-fix-que-no-existe.
  const ficheros = codigoDe('harness/');
  if (!ficheros.length) {
    console.error('  nada que revisar en harness/: se aborta en vez de pasar en verde.');
    return 1;
  }

  console.error(`  reviewer -> ${m.id}   (escritor vetado: claude)`);
  console.error(`  objeto   -> ${ficheros.length} ficheros de codigo\n`);

  const crudos = [];
  for (const { path, text } of ficheros) {
    process.stderr.write(`    ${path.padEnd(42)} `);
    const prompt = [
      reviewer.prompt,
      '\n\n## Objeto de revision\n\nFichero `', path, '` del harness de DoxIA.\n\n```\n',
      text.slice(0, 24000),
      '\n```\n\nDevuelve SOLO un array JSON, sin texto alrededor. Cada elemento:\n',
      '{"file":"', path, '","symbol":"funcion","claim":"la afirmacion","severity":"P0|P1|P2|P3|P4|P5",',
      '"confidence":"CONFIRMED|PARTIAL|UNKNOWN","lens":"funcional|acid|cia|zerotrust|arquitectonico",',
      '"evidence":["cita del codigo"]}\n',
      'Sin hallazgos -> []. Ninguno sin evidencia citable del fichero.',
    ].join('');

    try {
      const raw = await invoke(m, prompt, { timeoutMs: 600000 });
      const f = parseFindings(raw).map((x) => ({ ...x, file: x.file || path, agent: 'reviewer', model: m.id }));
      crudos.push(...f);
      console.error(`${f.length} hallazgo(s)`);
    } catch (e) {
      console.error(`ERROR ${e.message.slice(0, 60)}`);
    }
  }
  const unificados = converge(crudos);
  const bloq = bloqueantes(unificados);

  const outDir = join(RUNTIME, 'runs');
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, `self-review-${Date.now()}.json`);
  writeFileSync(out, redactarSecretos(JSON.stringify({
    stage: 'Review + Convergence', reviewer: m.id, crudos: crudos.length,
    unificados: unificados.length, bloqueantes: bloq.length, findings: unificados,
  }, null, 2)) + '\n');

  console.error(`\n  crudos ${crudos.length} -> unificados ${unificados.length} -> bloqueantes ${bloq.length}`);
  for (const f of unificados.slice(0, 10)) {
    console.error(`    ${(f.severity ?? '--').padEnd(3)} ${f.file}:${f.symbol} — ${String(f.claim).slice(0, 80)}`);
  }
  console.error(`  evidencia: ${out.replace(ROOT + '/', '')}\n`);
  saveState({ nota: `self-review ${m.id}: ${bloq.length} bloqueantes` });
  return 0;
}

// Ficheros de CODIGO de una ruta: modificados y nuevos. `git diff` no ve lo
// untracked, asi que un directorio entero nuevo daria un objeto vacio y la
// revision pasaria en verde sin mirar nada. Se incluyen ambos, y se excluyen
// los tests (revisar el test junto al codigo invita a que el revisor de por
// buena la logica porque su propio test la confirma).
function codigoDe(ruta) {
  const listar = (args) =>
    execFileSync('git', args, { cwd: ROOT, env: ENV_LIMPIO(), encoding: 'utf8' }).split('\n').filter(Boolean);

  const nuevos = listar(['ls-files', '--others', '--exclude-standard', '--', ruta]);
  const modificados = listar(['diff', '--name-only', 'HEAD', '--', ruta]);

  return [...new Set([...nuevos, ...modificados])]
    .filter((f) => /\.(mjs|js|ts|sh)$/.test(f) && !/\.test\.|\.spec\./.test(f))
    .sort()
    .map((path) => {
      try {
        return { path, text: readFileSync(join(ROOT, path), 'utf8') };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/** Las vueltas ya registradas, para que la repetibilidad se pueda medir. */
function corridasAnteriores(actual) {
  const dir = join(RUNTIME, 'runs');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== actual)
    .map((d) => loadRun(d.name))
    .filter(Boolean);
}

const readJSONSafe = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };

/** Reescribe el payload de un artefacto ya emitido, conservando su sobre. */
// Un artefacto ausente aqui NO es un caso a tolerar: significa que la etapa no
// escribio, o que el nombre dejo de coincidir con el manifiesto. Callar fue lo
// que mantuvo el defecto vivo una vuelta entera, asi que lanza.
function consolidar(dir, fichero, payload) {
  const p = join(dir, fichero);
  const env = readJSONSafe(p);
  if (!env) throw new Error(`no se puede consolidar '${fichero}': ausente o ilegible en ${dir}`);
  // POR `redactarSecretos`, igual que `writeArtifact` y `trace.json`. ESTE es el
  // tercer camino de escritura, y el que explicaba lo que dejé sin diagnosticar:
  // `14-observability.json` se escribe DOS veces --la primera por `writeArtifact`,
  // redactada; la segunda AQUI, reescribiéndola sin redactar-- asi que salia en
  // claro pese a pasar por el camino bueno la primera vez.
  //
  // MEDIDO en H-20260824-d897a07f: 4 apariciones de la semilla en `14-observability`
  // con `07-execution` en 0 y 5 marcas, ambos supuestamente por el mismo escritor.
  writeFileSync(p, redactarSecretos(JSON.stringify({ ...env, payload, consolidadoAlCerrar: true }, null, 2)) + '\n');
}

// Un modelo local no siempre devuelve JSON limpio. Se extrae el primer array
// y se ignora el resto: mas robusto que exigir obediencia perfecta al formato.
function parseFindings(raw) {
  const m = /\[[\s\S]*\]/.exec(String(raw));
  if (!m) return [];
  try {
    const v = JSON.parse(m[0]);
    return Array.isArray(v) ? v.filter((f) => f && f.file) : [];
  } catch {
    return [];
  }
}

// ── campaign ─────────────────────────────────────────────────────────────────
// C-6 · EL TRABAJO QUE NO CABE EN UNA VUELTA.
//
// `harness/lib/campaign.mjs` estaba ENTERA y probada desde C-6 -- crear, siguiente,
// aplicar, estado, dentroDelGasto-- y no tenia conductor: `grep campaign` sobre este
// fichero no devolvia una linea. Una capacidad que solo existe en su test es una
// declaracion, que es exactamente lo que le pasaba a la clase `move` esta manana.
//
// LA FRONTERA NO SE MUEVE. La campana la PLANIFICA UN HUMANO y la EJECUTA EL ANILLO:
// `campaign new` LEE una lista de items de un fichero y no la deriva de nada. Aqui no
// hay -- ni puede haber-- una llamada a un modelo: un anillo que se inventa su propio
// alcance convierte «0 P0-P5» en una afirmacion sobre el conjunto que el mismo eligio.
async function campaign() {
  const sub = args[0];

  if (sub === 'new') {
    const f = args[1];
    if (!f || !existsSync(f)) { console.error('  uso: doxia campaign new <plan.json>'); return 1; }
    const plan = JSON.parse(readFileSync(f, 'utf8'));
    let c;
    try {
      c = crearCampana(plan);
    } catch (e) {
      console.error(`\n  ${e.message}\n`);
      return 1;
    }
    console.error(`\n  campana ${c.id} · ${c.items.length} items · techo ${c.budget.maxRounds} vueltas`);
    console.error(`  planificada por: ${c.plannedBy}`);
    console.error(`  ${guardarCampana(c).replace(ROOT + '/', '')}\n`);
    return 0;
  }

  const id = args[1] ?? args[0];
  const c0 = id ? leerCampana(id) : null;
  if (!c0) { console.error(`  sin campana: ${id ?? '(sin id)'}`); return 1; }

  if (sub === 'status' || !sub) {
    tablero(c0);
    return estadoCampana(c0).status === 'OPEN' ? 0 : 0;
  }

  if (sub !== 'run') {
    console.error('  uso: doxia campaign new <plan.json> | status <id> | run <id>');
    return 2;
  }

  // EL BUCLE. Cada iteracion es UNA vuelta del anillo sobre UN item, y el estado se
  // persiste DESPUES de cada una: si esto muere -- reloj, caida, ctrl-C-- la campana
  // se reanuda donde quedo. Esa es toda la propiedad que C-6 existe para dar.
  let c = c0;
  for (;;) {
    const gasto = dentroDelGasto(c);
    if (!gasto.ok) { console.error(`\n  HALTED — ${gasto.why}\n`); break; }

    const it = siguienteItem(c);
    if (!it) break;

    const spec = it.specId ?? c.specId;
    if (!spec) {
      console.error(`\n  item '${it.id}' sin \`specId\`: una campana ejecuta manifiestos, no prosa\n`);
      return 1;
    }
    const path = specManifestPath(ROOT, spec);
    if (!existsSync(path)) { console.error(`\n  sin manifiesto: ${path}\n`); return 1; }

    // LA SPEC, ANTES DE GASTAR LA VUELTA. La rama `--ring` ya lo hacia y la campana
    // no: un manifiesto imposible habria consumido una vuelta del techo -- y en una
    // campana eso no es un minuto perdido, es una ronda menos para el resto de la
    // lista. Un item cuya spec no se puede ejecutar se marca BLOCKED, que es lo que
    // significa: necesita a una persona, no otra vuelta.
    const manifiesto = JSON.parse(readFileSync(path, 'utf8'));
    const problemas = revisarSpec(manifiesto.task);
    if (problemas.length) {
      console.error(`\n  SPECIFICATION_BLOCKED — ${spec}:`);
      for (const x of problemas) console.error(`    · ${x}`);
      c = aplicarCampana(c, {
        itemId: it.id,
        verdict: { pass: false, convergenceStatus: 'SPECIFICATION_BLOCKED', blockers: problemas.length },
        tokens: 0, at: new Date().toISOString(),
      });
      guardarCampana(c);
      tablero(c);
      continue;
    }

    console.error(`\n  ── campana ${c.id} · item ${it.id} (${it.status}, ronda ${(it.rounds ?? 0) + 1}) ──`);
    console.error(`  ${it.goal}`);

    const r = await correrAnillo({ manifest: manifiesto, specId: spec });

    c = aplicarCampana(c, {
      itemId: it.id,
      verdict: r,
      tokens: r.trace?.metrics?.tokens ?? 0,
      at: new Date().toISOString(),
    });
    guardarCampana(c);
    tablero(c);
  }

  const fin = estadoCampana(c);
  console.error(`\n  campana ${c.id}: ${fin.status}${fin.why ? ' — ' + fin.why : ''}\n`);
  // CLOSED es el unico verde. HALTED y BLOCKED necesitan a una persona, y devolver 0
  // por ellos seria contar «se acabo el presupuesto» como «se acabo el trabajo».
  return fin.status === 'CLOSED' ? 0 : 1;
}

function tablero(c) {
  const e = estadoCampana(c);
  console.error(`\n  ${c.id} · ${e.status} · ${e.done}/${e.total} hechos · ${e.blocked} bloqueados · ${e.open} abiertos · ${e.rounds} vuelta(s)`);
  for (const it of c.items) {
    const ultimo = (it.history ?? []).at(-1);
    console.error(`    ${it.status.padEnd(11)} ${it.id.padEnd(22)} ${it.goal.slice(0, 46)}`
      + (ultimo?.why ? `\n      └ ${ultimo.why.slice(0, 100)}` : '')
      // Guardar el puntero y no ensenarlo deja el arreglo a medias: quien lee el
      // tablero sigue sin saber que run mirar. El comando va escrito entero.
      + (ultimo?.executionId ? `\n      └ traza: doxia trace ${ultimo.executionId}` : ''));
  }
}

// ── despacho ─────────────────────────────────────────────────────────────────
const CMDS = { doctor, sync, gate, plan, state, run, fitness, trace, campaign };
if (!CMDS[cmd]) {
  console.log(`
  DoxIA Harness

    doxia doctor                       que proveedores responden de verdad
    doxia sync                         regenera agentes de cada IDE + hooks
    doxia plan <repo:ruta@commit>      resuelve un plan pineado  [--print] [--spec] [--contra <ref>]
    doxia gate [--fast|--full]         invoca scripts/gate.sh
    doxia state [save]                 el tablero (sobrevive a /compact)
    doxia run --self-review            el harness se revisa a si mismo
    doxia run --ring <spec>            recorre el anillo de 16 etapas
    doxia fitness <id> [--next <id>]   los 5 fitness tests sobre una corrida
    doxia trace <id> [--json]          reconstruye una corrida desde su evidencia
    doxia campaign new <plan.json>     la lista de trabajo que no cabe en una vuelta
    doxia campaign status|run <id>     el tablero · ejecuta hasta cerrar o agotar techo

  Especificacion: harness/README.md
`);
  process.exit(cmd ? 1 : 0);
}
process.exit(await CMDS[cmd]());
