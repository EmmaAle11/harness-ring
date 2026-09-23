// node --test harness/lib/
//
// El EvidencePackage tiene que decir DONDE esta su evidencia.
//
// Hay dos `.harness/evidence/` -- el del workspace y el del arbol principal -- y
// el gate escribe en el de SU raiz, que es el workspace. El paquete no lo decia,
// asi que la etapa 16 de H-20260816-b0ae48ef busco en el arbol principal, no
// encontro nada y concluyo que la vuelta no habia persistido evidencia. Con
// `verdict: PASS` delante y el fichero existiendo. Faltaba el puntero.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { rutaDeEvidencia, conVeredictoDeSeguridad } from './stages.mjs';
import { assertSecurityGate } from './stages-model.mjs';
import { RUNTIME, ROOT } from './capabilities.mjs';

const WS = join(RUNTIME, 'workspaces', 'test-stages');
const DIR = join(WS, '.harness', 'evidence');

before(() => {
  rmSync(WS, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
});
after(() => rmSync(WS, { recursive: true, force: true }));

test('sin fichero, devuelve null: no se inventa una ruta', () => {
  assert.equal(rutaDeEvidencia(WS, 'abc1234'), null);
  assert.equal(rutaDeEvidencia(null, 'abc1234'), null, 'sin workspace tampoco apunta al arbol principal');
});

test('apunta al fichero del WORKSPACE, no al del arbol principal', () => {
  writeFileSync(join(DIR, 'abc1234-1.json'), '{}');
  const p = rutaDeEvidencia(WS, 'abc1234');
  assert.ok(p.startsWith(WS), `la ruta sale del workspace: ${p}`);
  assert.match(p, /abc1234-1\.json$/);
});

test('con varias corridas del gate, la de ESTA vuelta es la de n mas alto', () => {
  // gate.sh numera <sha>-<n>.json subiendo n. Un orden lexicografico daria
  // '-10' antes que '-9' y el paquete apuntaria a una corrida vieja.
  for (const n of [2, 9, 10]) writeFileSync(join(DIR, `abc1234-${n}.json`), '{}');
  assert.match(rutaDeEvidencia(WS, 'abc1234'), /abc1234-10\.json$/);
});

test('no confunde el sha de otra corrida', () => {
  writeFileSync(join(DIR, 'def5678-1.json'), '{}');
  assert.match(rutaDeEvidencia(WS, 'def5678'), /def5678-1\.json$/);
  assert.match(rutaDeEvidencia(WS, 'abc1234'), /abc1234-10\.json$/);
});

// ── Los checks del gate viajan en el paquete, no solo su ruta ───────────────
// El gate escribe en el `.harness/evidence/` del WORKSPACE, que no forma parte de
// `.harness/runs/<id>/`. Con solo la ruta, reconstruir la corrida desde su
// directorio dejaba `tests` vacio -- cierto, y un hueco.
test('leerGateChecks trae los checks reales; sin fichero devuelve [] y no inventa', async () => {
  const { leerGateChecks } = await import('./stages.mjs');
  assert.deepEqual(leerGateChecks(null), []);
  assert.deepEqual(leerGateChecks(join(DIR, 'no-existe.json')), []);

  writeFileSync(join(DIR, 'gate-1.json'), JSON.stringify({
    checks: [
      { check: 'unit_tests:fe', status: 'PASS', nota: '64 ficheros / 683 tests' },
      { check: 'sast', status: 'MISSING', nota: 'sin SAST' },
    ],
  }));
  const c = leerGateChecks(join(DIR, 'gate-1.json'));
  assert.equal(c.length, 2);
  assert.equal(c[0].nota, '64 ficheros / 683 tests', 'la nota es donde vive el piso de tests');
  assert.equal(c[1].status, 'MISSING', 'lo no ejecutado se conserva como MISSING, no se filtra');
});

test('un fichero de gate ilegible devuelve [] en vez de reventar la etapa 15', async () => {
  const { leerGateChecks } = await import('./stages.mjs');
  writeFileSync(join(DIR, 'roto.json'), '{ esto no es json');
  assert.deepEqual(leerGateChecks(join(DIR, 'roto.json')), []);
});

// ── Un BLOCK de seguridad conserva su informe ──────────────────────────────
//
// `runRing` captura lo que LANZA una etapa y escribe `payload: null`. La etapa
// Security lanzaba, asi que el SecurityReport entero -- controles, hallazgos,
// counts, alcance del SBOM-- se perdia EXACTAMENTE en la vuelta donde la puerta
// muerde. Medido en H-20260817-2962fd70: `08-security.json` con `payload: null`
// sobre un BLOCK real, y un comentario encima diciendo que se conservaba.
//
// Devolver `FAIL` en vez de lanzar da el mismo `onFail` y conserva el payload.
test('un BLOCK devuelve FAIL y CONSERVA su informe', () => {
  const informe = {
    sca: 'RAN', sbom: 'RAN', sast: 'RAN', owasp: 'PARTIAL',
    gate: 'BLOCK', counts: { total: 1, block: 1, warn: 0 },
    controls: [{ control: 'sast', status: 'RAN' }],
    blocked: [{ severity: 'P1', rule: 'xss-innerhtml-sin-sanitizar', path: 'src/a.tsx', location: '87:20' }],
    findings: [],
  };
  const r = conVeredictoDeSeguridad({ payload: informe });

  assert.equal(r.status, 'FAIL', 'un BLOCK detiene la vuelta');
  assert.equal(r.payload, informe, 'y su informe SOBREVIVE entero: es la evidencia de por que se detuvo');
  assert.equal(r.payload.blocked.length, 1);
  assert.match(r.reason, /BLOQUEA/);
  assert.match(r.reason, /xss-innerhtml-sin-sanitizar/, 'el motivo nombra la regla, no solo "fallo"');
});

test('lo que NO bloquea pasa intacto, sin status ni reason inventados', () => {
  const ok = { payload: { gate: 'WARN', counts: { block: 0 }, blocked: [] } };
  assert.equal(conVeredictoDeSeguridad(ok), ok);
  assert.equal(conVeredictoDeSeguridad(ok).status, undefined);
});

test('assertSecurityGate deja pasar lo que no bloquea, y lanza lo que si', () => {
  const ok = { gate: 'WARN', counts: { block: 0 }, blocked: [] };
  assert.equal(assertSecurityGate(ok), ok, 'WARN no detiene la vuelta');
  assert.throws(
    () => assertSecurityGate({ gate: 'BLOCK', counts: { block: 1 }, blocked: [{ severity: 'P1', rule: 'r', path: 'p', location: '1' }] }),
    /BLOQUEA/,
  );
});

// ── El presupuesto de ITERACIONES tenia el mismo agujero que el de superficie ──
//
// `conVeredictoDeSuperficie` ya documenta este defecto para la puerta de al lado:
// un veredicto que borra su evidencia no se puede auditar NI recalibrar. Se
// corrigio en Security, en Convergence y en la superficie; agotar iteraciones
// seguia LANZANDO, y `runRing` escribe `payload: null` cuando una etapa lanza.
//
// MEDIDO en H-20260820-477b813c: 40 llamadas, 15 de ellas `apply_patch` con solo
// 5 en verde. El mensaje de git que explica los otros diez estaba en `toolCalls`
// y no llego a disco, asi que la causa habia que inferirla de `exit=1`.
//
// Revertir a `throw` deja este test en rojo por asercion.
test('al agotarse el presupuesto de iteraciones, las llamadas SOBREVIVEN', async () => {
  const { sinPresupuesto } = await import('./stages-model.mjs');
  const toolCalls = [
    { n: 1, tool: 'apply_patch', exitCode: 1, output: 'error: patch failed: src/App.tsx:12' },
    { n: 2, tool: 'move_file', exitCode: 0, output: 'a -> b' },
  ];

  const r = sinPresupuesto(
    { status: 'FAILED', stop: 'tope de 40 iteraciones agotado', iterations: 40, toolCalls, mutations: [1], usage: null, final: null },
    { asign: { provider: 'claude', model: 'opus' }, files: ['src/App.tsx'], diff: 'diff --git a/x b/x' },
  );

  assert.equal(r.status, 'FAIL', 'el anillo tiene que fallar igual: el ROLLBACK es la respuesta correcta');
  assert.match(r.reason, /40 iteraciones/);

  // Lo que antes se perdia entero.
  assert.equal(r.payload.toolCalls.length, 2);
  assert.match(r.payload.toolCalls[0].output, /patch failed/, 'el motivo de git tiene que poder leerse');
  assert.equal(r.payload.diff, 'diff --git a/x b/x');
  assert.deepEqual(r.payload.files, ['src/App.tsx']);
  assert.equal(r.payload.iterations, 40);
  assert.equal(r.producedBy.capability, 'builder');
  assert.equal(r.producedBy.provider, 'claude');

  // La superficie NUNCA se midio: se analiza sobre un cambio terminado. Declararla
  // `null` no es lo mismo que declararla vacia, y confundirlas seria afirmar que
  // este cambio cabia en el presupuesto.
  assert.equal(r.payload.changeSurface, null);
});

test('el handler de Execution USA sinPresupuesto: una funcion que nadie llama no existe', () => {
  const src = readFileSync(new URL('./stages-model.mjs', import.meta.url), 'utf8');
  // La llamada se comprueba por partes y no como una linea literal: ahora los
  // ficheros van filtrados (P0 de frontera, los artefactos de vite no son del
  // builder) y la llamada ocupa varias lineas.
  assert.match(src, /return sinPresupuesto\(r, \{/);
  assert.match(src, /files: sinArtefactosDeBuild\(sandbox\.changedFiles\(ws\)\)/);
  // Y el defecto exacto no vuelve por la misma puerta.
  assert.doesNotMatch(src, /throw new Error\(`el builder termino en/);
});

// ── «ya esta hecho» no es «nunca se hizo» ────────────────────────────────────
//
// MEDIDO en H-20260820-481ff307. La vuelta llego a Convergence (11/16), que pidio
// un rework por un P2: «el gate --full no se ha ejecutado» -- una EJECUCION que
// falta, no una mutacion--. El builder volvio, corrio `run_gate` con resultado
// PASS y declaro NO_CHANGE_REQUIRED porque no quedaba una sola mutacion pendiente.
// La etapa lo tumbo citando los 17 ficheros de la aceptacion, con esos 17 ficheros
// ya cambiados delante.
//
// El hecho «se modifico algo» lo tiene git; esa rama lo deducia del manifiesto.
test('en un REWORK sin nada que mutar, el trabajo YA aplicado cierra la etapa', async () => {
  const { conVeredictoSinCambio } = await import('./stages-model.mjs');
  const task = { files: Array.from({ length: 17 }, (_, i) => `f${i}.ts`) };
  const r = { status: 'NO_CHANGE_REQUIRED', stop: 'ya cumple la aceptacion entera', final: null };

  const hecho = conVeredictoSinCambio(r, { task, yaAplicado: ['src/App.tsx', 'src/app/aafa/archivero/grouping.ts'] });
  assert.equal(hecho.status, 'DONE', 'con el cambio en el workspace, la etapa sigue');
  assert.match(hecho.final.summary, /ya cumple/, 'el motivo del builder no se pierde');
});

test('y el `done` HUECO se sigue rechazando: nada en el workspace, nada que ensenar', async () => {
  const { conVeredictoSinCambio } = await import('./stages-model.mjs');
  const task = { files: ['a.ts', 'b.ts'] };
  const r = { status: 'NO_CHANGE_REQUIRED', stop: 'esto ya estaba bien', final: null };

  assert.throws(
    () => conVeredictoSinCambio(r, { task, yaAplicado: [] }),
    /EXIGE modificacion[\s\S]*no\s+registra NINGUN cambio/,
    'sin cambios en git, afirmar que ya estaba bien es un done vacio con otro nombre',
  );

  // Una tarea que solo pide COMPROBAR si lo admite, y eso no cambia.
  const soloComprueba = conVeredictoSinCambio(r, { task: { ...task, requiresChange: false }, yaAplicado: [] });
  assert.equal(soloComprueba.status, 'NO_CHANGE_REQUIRED');
});

test('lo que no es NO_CHANGE_REQUIRED pasa intacto', async () => {
  const { conVeredictoSinCambio } = await import('./stages-model.mjs');
  const r = { status: 'DONE', final: { summary: 'hecho' } };
  assert.equal(conVeredictoSinCambio(r, { task: { files: [] }, yaAplicado: [] }), r);
});

// ── La puerta de la etapa 1, ejecutable ──────────────────────────────────────
//
// El manifiesto la describe desde el primer dia -- «el artefacto cita al menos una
// entrada de memory/ por su ruta; sin cita, no leyo nada»-- y el prompt marca la
// del executionId anterior como OBLIGATORIA. Ninguna se comprobaba: el contrato
// solo exige `scope`, `facts` y `unknowns`, asi que las dos eran prosa.
//
// MEDIDO en H-20260820-cd46f093: la vuelta cerro 16/16 y FT-5 fallo porque su
// Knowledge no citaba a H-20260820-55a25dae. El cableado estaba bien -- el
// LearningRecord llegaba al prompt y `parentExecutionId` lo registraba-- pero la
// cita dependia de que el modelo se acordara.
test('un Knowledge que no cita memory/ POR SU RUTA no vale', async () => {
  const { exigenciasDeKnowledge } = await import('./stages-model.mjs');
  const exige = exigenciasDeKnowledge(null);

  assert.match(exige({ scope: 'aafa', facts: [{ nodo: 'x' }] })[0], /memory\//);
  // Nombrar la carpeta no es citar una entrada: la ruta es lo que prueba la lectura.
  assert.equal(exige({ facts: [{ e: 'lei memory/ entera' }] }).length, 1, 'sin fichero .md no hay cita');
  assert.equal(exige({ facts: [{ e: 'memory/failures/el-fix-que-no-existe.md' }] }).length, 0);
});

test('y la flecha Learning->Knowledge se EXIGE, que es lo que lo hace un anillo', async () => {
  const { exigenciasDeKnowledge } = await import('./stages-model.mjs');
  const exige = exigenciasDeKnowledge({ executionId: 'H-20260820-55a25dae' });
  const conMemoria = { facts: [{ e: 'memory/architecture/current-state.md' }] };

  const faltan = exige(conMemoria);
  assert.equal(faltan.length, 1);
  assert.match(faltan[0], /H-20260820-55a25dae/);
  assert.match(faltan[0], /anillo/, 'el motivo dice POR QUE se exige, no solo que falta');

  // Citarla cierra la puerta.
  assert.equal(exige({ facts: [...conMemoria.facts, { v: 'H-20260820-55a25dae' }] }).length, 0);

  // Y sin vuelta anterior no se exige lo que no existe: la primera del anillo vale.
  assert.equal(exigenciasDeKnowledge(null)(conMemoria).length, 0);
});

test('lo que falta VUELVE al modelo y se reintenta, no tumba la etapa', async () => {
  // Va por el mismo camino que `validate`, a proposito: un olvido de cita lo
  // arregla una segunda pasada; matar una vuelta de 20 minutos por eso, no.
  const src = readFileSync(new URL('./invoke.mjs', import.meta.url), 'utf8');
  assert.match(src, /\[\.\.\.validate\(contract, payload\), \.\.\.\(exige\?\.\(payload\) \?\? \[\]\)\]/);
});

// ── La evidencia a medias no lleva el nombre de la evidencia ────────────────
//
// `gate.sh` construye su JSON APENDANDO, para que una corrida que muera conserve
// lo que llevaba. Mientras escribe, el fichero es JSON invalido -- y con el nombre
// definitivo puesto desde el principio, cualquiera que lo abriera se llevaba el
// error. `harness-status.sh:19` hace `ls -t .harness/evidence/*.json | head -1`,
// o sea siempre el mas nuevo: el comando que CLAUDE.md manda para reanudar sesion
// se rompia exactamente mientras habia una corrida. Y un gate MUERTO dejaba ese
// `.json` invalido para siempre, que es la regla #0 invertida.
//
// Se escribe en `<sha>-<n>.json.partial` y se renombra al cerrar.

test('ningun fichero de evidencia con nombre definitivo es ilegible', () => {
  // ESTE TEST SE MIDE A SI MISMO, y por eso vale. `node --test` corre DENTRO de
  // `gate.sh --fast` (comprobacion 9 de la puerta), asi que cuando la puerta lo
  // ejecuta hay una corrida a medio escribir en ese directorio: la suya. Sin el
  // `.partial`, ese fichero se llama `<sha>-<n>.json`, no parsea, y esta linea se
  // pone roja en CADA corrida de la puerta. Con el, no hay un solo `.json` a
  // medias que abrir.
  //
  // Corriendo `node --test` a mano, sin puerta, no hay corrida viva y el test pasa
  // sin afirmar gran cosa. Es honesto decirlo: quien lo revierta lo descubre por
  // la puerta, que es quien manda en el `definition_of_done`.
  const dir = join(ROOT, '.harness', 'evidence');
  if (!existsSync(dir)) return;                 // sin corridas todavia: nada que afirmar

  // Solo los definitivos. `<sha>-<n>.sbom.json` es CycloneDX -- otra familia, sin
  // veredicto-- y `.partial` no casa con `.json`, que es justo el efecto buscado.
  for (const f of readdirSync(dir).filter((x) => /^[0-9a-z]+-\d+\.json$/.test(x))) {
    let d;
    assert.doesNotThrow(
      () => { d = JSON.parse(readFileSync(join(dir, f), 'utf8')); },
      `'${f}' no es JSON valido. Un fichero de evidencia con nombre definitivo esta `
      + `CERRADO por definicion: si esta a medias tiene que llamarse '.json.partial'`,
    );
    assert.ok(d.verdict, `'${f}' no declara veredicto: existe y no dice como acabo`);
  }
});

test('un fichero a medias no se sirve como evidencia de nada', () => {
  writeFileSync(join(DIR, 'def5678-1.json'), JSON.stringify({ verdict: 'PASS', checks: [] }));
  // La `n` MAS ALTA es la del parcial, y aun asi no gana: no esta cerrado. Sin la
  // regla, la etapa 16 embeberia los checks de una corrida a medio escribir.
  writeFileSync(join(DIR, 'def5678-2.json.partial'), '{\n  "sha": "def5678",\n  "checks": [\n    {"check":"lint"');

  assert.equal(rutaDeEvidencia(WS, 'def5678'), join(DIR, 'def5678-1.json'),
    'el parcial tiene la n mas alta y aun asi no es la evidencia de la corrida');
});

// ── deps:hygiene · el arbol de disco contra su manifiesto ───────────────────
//
// `npm audit` mira el MANIFIESTO; `npm ls` mira el DISCO. El gate solo hacia la
// primera pregunta, asi que un `node_modules` con paquetes `invalid` --instalado
// fuera del rango declarado-- o `extraneous` --en disco y en ningun manifiesto--
// firmaba en verde. Es la misma forma que el SAST diciendo «0 hallazgos» sin
// decir sobre cuantos ficheros: un PASS cuyo denominador es otra cosa.
//
// El test lee el FUENTE de la puerta a proposito. Es el unico sitio donde vive
// la regla --`gate.sh` es la autoridad unica del definition_of_done-- y un check
// que desaparece de ahi no rompe ningun otro test: se iria en silencio, que es
// como se pierden las puertas.

test('la puerta comprueba el arbol contra su manifiesto, y lo hace en --fast', () => {
  const src = readFileSync(new URL('../../scripts/gate.sh', import.meta.url), 'utf8');
  assert.match(src, /record deps:hygiene/, 'el check desaparecio de la puerta');
  assert.match(src, /npm ls --depth=0/, 'ya no mira el disco');
  assert.match(src, /invalid\|extraneous/, 'dejo de buscar las dos formas de arbol sucio');

  // En --fast: MEDIDO en 0,798 s para los dos proyectos. Si cayera dentro del
  // `if MODE = full`, el pre-commit --que es quien tiene delante el arbol local
  // sucio-- dejaria de verlo, y en CI (donde se acaba de hacer `npm ci`) nunca
  // hay nada que encontrar. El check correcto en el modo equivocado no comprueba
  // nada.
  const full = src.indexOf('if [ "$MODE" = "full" ]');
  assert.ok(full > 0, 'no se encontro el guardia de modo');
  assert.ok(src.indexOf('record deps:hygiene') < full,
    'deps:hygiene cayo dentro de --full: en CI el arbol siempre esta limpio y no comprobaria nada');
});

test('deps:hygiene NO se pronuncia sobre un node_modules prestado', () => {
  // El sandbox del anillo ENLAZA `node_modules` del arbol principal, y npm marca
  // como `extraneous` todo lo que hay dentro de un symlink: 422 falsos en el FE
  // la primera vez que una vuelta llego a la etapa 15. Un WARN que sale en TODAS
  // las vueltas no informa de nada -- es el mismo ruido que 3.617 warnings de
  // lint-- y ademas la pregunta no tiene sentido: el arbol no es suyo.
  //
  // Se DECLARA SKIP con su motivo. Lo que no se puede comprobar no se aprueba.
  const src = readFileSync(new URL('../../scripts/gate.sh', import.meta.url), 'utf8');
  assert.match(src, /if \[ -L "\$ROOT\/\$proj\/node_modules" \]/,
    'dejo de detectar el enlace: el WARN falso vuelve a cada vuelta');
  assert.match(src, /record deps:hygiene SKIP[\s\S]{0,140}prestado/,
    'un arbol prestado se declara SKIP, no PASS: aprobar lo que no se miro es peor que no mirarlo');
});

// DOS GUARDIAS SE CONTRADECIAN, y la fusion del 2026-09-07 los puso frente a frente: `controles`
// (del tronco) exige que toda etapa PUEDA fallar; esta asercion prohibia que `deps:hygiene` fallara
// nunca. Las dos tenian razon sobre COSAS DISTINTAS y la palabra «sucio» las confundia:
//
//   extraneous / invalid  -> deuda local (un `npm i` a medias, otro lockfile). WARN, y con motivo:
//                            bloquear por eso deja la puerta roja de nacimiento y nadie la usa.
//   dependencia AUSENTE   -> el manifiesto la pide y el arbol no la tiene. Eso no es deuda: es un
//                            arbol que no puede correr. Paso hoy con `@firecrawl/pdf-inspector` y
//                            lo cazo `architecture`, no esta etapa.
//
// Asi que la asercion no se relaja, se AFINA: sigue exigiendo el WARN para lo primero y ahora
// exige tambien el FAIL para lo segundo. Una regla que no distingue los dos casos protege al
// equivocado.
test('deps:hygiene DECLARA la deuda local y BLOQUEA la dependencia ausente', () => {
  const src = readFileSync(new URL('../../scripts/gate.sh', import.meta.url), 'utf8');
  assert.match(src, /record deps:hygiene WARN/,
    'un arbol sucio es deuda local, no un defecto del cambio en curso: '
    + 'bloquear por eso deja la puerta roja de nacimiento y nadie la usa');
  assert.match(src, /record deps:hygiene FAIL/,
    'una dependencia declarada y ausente no es deuda local: es un arbol que no puede correr');
  assert.match(src, /D_AUSENTE/,
    'el FAIL tiene que colgar de la AUSENCIA, no del recuento de extraneous');
});

// ── El techo de warnings, que era una nota y no una regla ───────────────────
//
// La comprobacion de lint llevaba desde que se escribio la nota «deuda: solo
// debe bajar», y NADIE la hacia cumplir. Costo dos imports muertos en
// `ExpedienteScreen.tsx` que el lint SI senalaba: eran 2 lineas entre 3.649. Un
// canal con relacion senal/ruido de 1 entre 3.649 esta encendido y no dice nada,
// que es peor que estar apagado, porque parece que dice.
test('los warnings de lint tienen TECHO, y romperlo es FAIL', () => {
  const src = readFileSync(new URL('../../scripts/gate.sh', import.meta.url), 'utf8');
  const m = /^LINT_WARN_MAX=(\d+)$/m.exec(src);
  assert.ok(m, 'el techo desaparecio de la puerta: la deuda vuelve a poder crecer');
  assert.ok(Number(m[1]) > 0 && Number(m[1]) < 100000, `techo absurdo: ${m[1]}`);
  assert.match(src, /record lint FAIL[\s\S]{0,120}TECHO ROTO/,
    'pasarse del techo tiene que ser FAIL: un WARN sobre 3.617 warnings es otro warning');
});

test('el techo AVISA cuando sobra, o deja de apretar', () => {
  // Un techo que se queda muy por encima de la realidad vuelve a ser una nota.
  // Si la deuda baja de verdad, la puerta lo dice para que el techo la siga.
  const src = readFileSync(new URL('../../scripts/gate.sh', import.meta.url), 'utf8');
  assert.match(src, /BAJA EL TECHO a/);
});

test('lo que el piso dice sobre los tests condicionales es CIERTO', () => {
  // Un piso sobre «tests que PASAN» es un piso sobre EL ENTORNO EN QUE SE MIDIO:
  // `node --test` no cuenta los saltados en `pass`, asi que cada test condicional
  // hace que la cifra dependa de donde se corra. Puse el piso con la cifra de mi
  // arbol y H-20260821-6ebd7317 murio en 15/16 con «un test desaparecio». No
  // desaparecio: se salto.
  //
  // ESTE TEST YA DISPARO UNA VEZ, y por eso existe: cuando el ultimo condicional
  // dejo de serlo --la comprobacion de `.env.production` paso a MEDIR la ausencia
  // en vez de saltarsela-- aviso de que el piso podia subir al total. Un piso que
  // deja holgura de mas es un piso que ya no apreta.
  //
  // No fija el NUMERO --seria el literal de hoy-- sino que lo ESCRITO junto al
  // piso coincida con lo que hay.
  const src = readFileSync(new URL('../../scripts/gate.sh', import.meta.url), 'utf8');
  assert.ok(/^HARNESS_TESTS_MIN=\d+$/m.test(src), 'el piso del harness desaparecio');

  const dir = new URL('./', import.meta.url);
  const condicionales = readdirSync(dir)
    .filter((f) => f.endsWith('.test.mjs'))
    .reduce((n, f) => n + (readFileSync(new URL(f, dir), 'utf8').match(/\bt\.skip\(/g) ?? []).length, 0);

  // La cifra DECLARADA junto al piso contra la cifra REAL. No se busca una
  // palabra en la prosa --el comentario cuenta la historia y la menciona-- sino
  // el numero, que es lo unico que se puede comparar.
  const declarado = /^# TESTS_CONDICIONALES=(\d+)\b/m.exec(src);
  assert.ok(declarado, 'el piso dejo de declarar cuantos tests condicionales hay');
  assert.equal(Number(declarado[1]), condicionales,
    `el piso declara ${declarado[1]} test(s) condicional(es) y hay ${condicionales}. `
    + 'Con condicionales, el piso va en la cifra del entorno MAS POBRE; sin ellos, en el total.');
});


// ── El consumidor que podia no existir sin decirlo ───────────────────────────
//
// La puerta tiene TRES consumidores: el hook de Kiro, el pre-commit de husky y
// CI. El segundo puede faltar en silencio: `core.hooksPath` apunta a `.husky/_`,
// que lo genera `npm install` y no se versiona, así que en un worktree recién
// creado git no encuentra el hook y NO avisa.
//
// MEDIDO el 2026-08-23 en el worktree `doxia-harness`: nueve commits del día sin
// una sola evidencia de pre-commit. El único verde era el que corría a mano — y
// el día que vi un FAIL y commiteé igual, nada me paró.

test('el pre-commit CONSUME la puerta, y no una copia de sus reglas', () => {
  const hook = readFileSync(new URL('../../.husky/pre-commit', import.meta.url), 'utf8');
  assert.match(hook, /bash scripts\/gate\.sh --fast/,
    'el pre-commit dejó de llamar a la puerta: o no comprueba nada, o comprueba una copia que diverge en silencio');
});

test('la puerta DICE si el hook no está cableado, en vez de callarlo', () => {
  const gate = readFileSync(new URL('../../scripts/gate.sh', import.meta.url), 'utf8');
  assert.match(gate, /record hook:pre-commit PASS/, 'la puerta ya no comprueba su propio consumidor');
  assert.match(gate, /record hook:pre-commit MISSING/,
    'sin la rama MISSING, un hook ausente es indistinguible de uno que pasa: el modo de fallo entero');
});

test('nada del harness llama a git sin ENV_LIMPIO', () => {
  // El fixture de `index-repo.test.mjs` lo hacía, y dentro de un hook de git
  // —donde GIT_DIR y GIT_INDEX_FILE están exportados— commiteó en la rama de
  // quien estaba commiteando: `be2951bb "base"`, 1181 ficheros borrados, empujado
  // a origin antes de que nadie lo viera.
  //
  // Dos de las tres fixtures lo llevaban. Acordarse no es un mecanismo.
  // TODO el harness, no solo los tests. La primera version de este guarda miraba
  // `*.test.mjs` y dejo pasar `index-repo.mjs`, que corre `git ls-files` desde el
  // modulo: dentro de un hook leia el indice del repo PRINCIPAL, asi que el test
  // del fixture medio 1179 ficheros donde esperaba 1.
  // SEIS FORMAS Y TODO harness/, no una forma y dos directorios.
  //
  // La primera version miraba `execFileSync('git'` sobre lib+bin. El test se llama
  // «nada del harness» y su asercion cubria UNA de seis formas y DOS de los cinco
  // directorios con codigo: los 9 .mjs de harness/adapters/ nunca se barrieron.
  // Nombre universal, asercion particular -- la misma clase que el defecto del
  // 2026-08-23 en que un test decia cubrir la puerta y medía la direccion contraria.
  //
  // Y lo que obliga a las muestras: el arbol esta HOY limpio en las seis formas,
  // asi que estrechar la regex NO pone esto en rojo. Un guarda que no se puede
  // revertir en rojo no esta demostrado. (la objecion es de third)
  const LLAMA_A_GIT = /(execFileSync|execFile|execSync|spawnSync|spawn)\(\s*['"`]git\b/;
  // Un comentario que CITA la llamada es legitimo; usarla no. Sin esto, la primera
  // version se cazo a si misma: `not ok` senalando la linea de prosa que explica el
  // defecto. Misma regla que scripts-portables.spec.ts.
  const esComentario = (l) => /^\s*(\/\/|\*|\/\*)/.test(l);
  const sinGuarda = (src) => {
    const lineas = src.split('\n');
    return lineas.flatMap((l, i) => {
      if (esComentario(l) || !LLAMA_A_GIT.test(l)) return [];
      // LA VENTANA SALTA LOS COMENTARIOS, y no es un detalle de estilo. La version
      // del tronco de `index-repo.mjs` mete NUEVE lineas de comentario entre
      // `execFileSync('git'` y su `env:`. Con una ventana fija de 4 lineas crudas
      // este guarda la daba por desprotegida: falso positivo sobre codigo correcto.
      //
      // Un guarda que no alcanza lo que dice vigilar no se corrige: se desactiva.
      // MEDIDO al ensayar la fusion del tronco en feat/harness el 2026-08-24.
      const trozo = lineas.slice(i).filter((x) => !esComentario(x)).slice(0, 4).join('\n');
      return /ENV_LIMPIO\(\)/.test(trozo) ? [] : [i + 1];
    });
  };

  // La muestra se ARMA, no se escribe literal: escrita, el barrido de abajo la
  // leeria como una llamada de verdad y este test se cazaria a si mismo. Lo hizo:
  // primera version, `not ok` senalando sus PROPIAS lineas 450 y 451.
  const muestra = (fn, q, opts = 'cwd: r') => `${fn}(${q}git${q}, ['status'], { ${opts} });`;
  assert.deepEqual(sinGuarda(muestra('execFileSync', "'")), [1]);
  assert.deepEqual(sinGuarda(muestra('execSync', '"')), [1], 'execSync con comilla doble se escapaba entera');
  assert.deepEqual(sinGuarda(muestra('spawnSync', "'")), [1], 'el `git init` que reinicializo el repo era de esta familia');
  assert.deepEqual(sinGuarda(muestra('execFileSync', "'", 'env: ENV_LIMPIO()')), []);

  // LA FORMA REAL DEL TRONCO: la llamada, NUEVE lineas de comentario explicando por
  // que el entorno limpio no es decorativo, y despues el `env:`. Con la ventana fija
  // de 4 lineas crudas este guarda la daba por desprotegida. Es el caso que lo cazo,
  // y va aqui para que no vuelva: un falso positivo desactiva un guarda igual de
  // rapido que un falso negativo lo deja pasar.
  const conComentarios = [
    muestra('execFileSync', "'", '').replace(' });', ''),
    ...Array.from({ length: 9 }, (_, k) => `    // linea de comentario ${k + 1}`),
    '    cwd: root, env: ENV_LIMPIO(), encoding: \'utf8\',',
    '  });',
  ].join('\n');
  assert.deepEqual(sinGuarda(conComentarios), [],
    'nueve lineas de comentario entre la llamada y su env: no la dejan desprotegida');

  // SEPTIMA FORMA, que NINGUNA regex ve: el binario en una variable
  // -- `execFileSync(BIN, args)`. Medido hoy: 0 ocurrencias. Queda escrito porque
  // es lo que introduce un refactor sin querer, y ese dia este guarda callara.
  // (lo cazo third)

  const raiz = new URL('../', import.meta.url);
  const ficheros = readdirSync(raiz, { recursive: true })
    .filter((x) => String(x).endsWith('.mjs'))
    .map((x) => new URL(String(x), raiz));
  assert.ok(ficheros.length > 70, `solo ${ficheros.length} ficheros barridos: el guarda dejo de mirar`);
  for (const f of ficheros) {
    const malas = sinGuarda(readFileSync(f, 'utf8'));
    assert.deepEqual(malas, [],
      `${f.pathname.split('/').pop()}:${malas.join(',')} corre git sin ENV_LIMPIO(): dentro de un hook operaría sobre el repo principal`);
  }
});

test('la cita de memory/ tiene que EXISTIR, no sólo parecerlo', async () => {
  // La puerta comprobaba `/memory\/[\w./-]+\.md/` — la FORMA. Se satisface con
  // `memory/inventada/no-existe.md`, así que la comprobación que existe para
  // demostrar que el modelo leyó se pasaba escribiendo algo con pinta de ruta.
  //
  // Y una cita inventada en un artefacto de auditoría es PEOR que ninguna: la
  // etapa siguiente la lee como un hecho ya comprobado.
  //
  // Salió al centralizar `memory/`: un espejo con 85 entradas de 101 no es un
  // índice pequeño — es un índice desde el que se puede citar una ruta que en
  // otro árbol no existe.
  const { exigenciasDeKnowledge } = await import('./stages-model.mjs');
  const reales = ['memory/architecture/current-state.md', 'memory/patterns/una-autoridad-por-hecho.md'];

  const buena = exigenciasDeKnowledge(null, reales)({ facts: [{ evidence: 'memory/architecture/current-state.md' }] });
  assert.deepEqual(buena, [], `una cita real no debería fallar: ${buena}`);

  const inventada = exigenciasDeKnowledge(null, reales)({ facts: [{ evidence: 'memory/inventada/no-existe.md' }] });
  assert.equal(inventada.length, 1, 'una ruta inventada pasó la puerta');
  assert.match(inventada[0], /NO EXISTEN/);

  // TRES CASOS, no dos. Lo cazó third: con `rutas?.length` la lista VACÍA caía en
  // el mismo sitio que «no me pasaron lista», así que un árbol SIN memory/
  // aceptaba cualquier cita inventada — y salía igual de verde que uno donde la
  // cita es correcta. Un control que falla abierto no falla: no existe.
  //
  // `null`  = no había con qué comprobar  → la forma, declarado
  // `[]`    = comprobé y no hay nada      → eso ES el hallazgo
  const sinLista = exigenciasDeKnowledge(null)({ facts: [{ evidence: 'memory/lo-que-sea.md' }] });
  assert.deepEqual(sinLista, [], 'sin árbol delante se conserva la conducta vieja, declarada');

  const listaVacia = exigenciasDeKnowledge(null, [])({ facts: [{ evidence: 'memory/lo-que-sea.md' }] });
  assert.equal(listaVacia.length, 1, 'un árbol sin memory/ aceptó una cita que no se puede comprobar');
  assert.match(listaVacia[0], /no hay NINGUNA entrada/);
});
