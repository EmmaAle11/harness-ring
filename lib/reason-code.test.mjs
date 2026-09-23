/**
 * Los fixtures son `reason` REALES del histórico (.harness/runs/<id>/trace.json),
 * copiados literalmente. Un clasificador probado contra frases inventadas no
 * demuestra nada sobre las vueltas que tenemos.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codigoDe, etapaDe, veredicto, determinismo, clasificarConBaseline, CODIGOS } from './reason-code.mjs';

// ── literales del histórico ────────────────────────────────────────────────
const TOPE = "ROLLBACK en 'Execution': el builder termino en FAILED tras 90 iteraciones y 20 llamadas: tope de 90 iteraciones agotado";
const BLOQ = "ROLLBACK en 'Execution': el builder termino en BLOCKED tras 2 iteraciones y 1 llamadas: La lista de simbolos de la spec no se sostiene";
const SUPF = "ROLLBACK en 'Execution': superficie de cambio fuera de presupuesto (MEASURED): lines 310 > 135.";
const CITA = "STOP en 'Knowledge': researcher no produjo un ArchitectureBaseline valido: incumple ArchitectureBaseline: cita rutas de memory/ que NO EXISTEN: memory/failures/x.md. Una cita inventada no demuestra lectura: la desmiente";

test('las tres causas de Execution NO comparten codigo', () => {
  const c = [TOPE, BLOQ, SUPF].map(codigoDe);
  assert.deepEqual(c, ['TOPE_ITERACIONES', 'BUILDER_SE_AUTOBLOQUEA', 'PRESUPUESTO_SUPERFICIE']);
  assert.equal(new Set(c).size, 3, 'trece vueltas del histórico caian en el mismo saco');
});

test('ORDEN: el tope gana a BLOCKED aunque la frase contenga ambos', () => {
  // «termino en FAILED … tope de 90 iteraciones»: si BUILDER_SE_AUTOBLOQUEA
  // ganara, cuatro fallos del harness se contarian como culpa de la spec.
  assert.equal(codigoDe(TOPE), 'TOPE_ITERACIONES');
  assert.equal(CODIGOS[codigoDe(TOPE)].culpa, 'harness');
});

test('la cita inventada es del modelo, no un baseline generico', () => {
  // el texto contiene «ArchitectureBaseline», pero lo especifico es la cita.
  assert.equal(codigoDe(CITA), 'CITA_INVENTADA');
  assert.equal(CODIGOS.CITA_INVENTADA.culpa, 'modelo');
});

test('el auto-bloqueo del builder es culpa de la SPEC: el anillo funciono', () => {
  assert.equal(CODIGOS[codigoDe(BLOQ)].culpa, 'spec');
});

test('etapaDe lee la etapa del propio reason', () => {
  assert.equal(etapaDe(TOPE), 'Execution');
  assert.equal(etapaDe(CITA), 'Knowledge');
  assert.equal(etapaDe('sin formato conocido'), null);
});

test('un reason vacio es SIN_CLASIFICAR, nunca un codigo inventado', () => {
  for (const v of [null, undefined, '', '   ']) assert.equal(codigoDe(v), 'SIN_CLASIFICAR');
});

test('PASSED no se clasifica como fallo', () => {
  const v = veredicto({ executionId: 'H-1', verdict: 'PASSED', reason: null, stages: [] });
  assert.equal(v.reason_code, 'OK');
  assert.equal(v.culpa, null);
});

test('veredicto cuenta las etapas OK, no las declaradas', () => {
  const v = veredicto({
    executionId: 'H-2', verdict: 'FAILED', reason: TOPE,
    stages: [{ status: 'OK' }, { status: 'OK' }, { status: 'FAIL' }, { status: 'PENDING' }],
  });
  assert.equal(v.etapasRecorridas, 2);
  assert.equal(v.reason_code, 'TOPE_ITERACIONES');
  assert.equal(v.etapa, 'Execution');
});

test('DETERMINISMO: el caso real que la metrica vieja llamo reproducible', () => {
  // Las tres vueltas de h-008: mismo vector de etapas, s²=0 con la metrica vieja.
  const d = determinismo([
    { verdict: 'FAILED', reason: TOPE, stages: [] },
    { verdict: 'FAILED', reason: BLOQ, stages: [] },
    { verdict: 'FAILED', reason: SUPF, stages: [] },
  ]);
  assert.equal(d.reproducible, false, 's²=0 decia que si; tres causas dicen que no');
  assert.equal(d.clases, 3);
  assert.equal(d.acuerdo, 1 / 3);
});

test('DETERMINISMO: tres vueltas por la MISMA causa si son reproducibles', () => {
  const d = determinismo(Array.from({ length: 3 }, () => ({ verdict: 'FAILED', reason: TOPE, stages: [] })));
  assert.equal(d.reproducible, true);
  assert.equal(d.acuerdo, 1);
});

test('con n=1 no hay acuerdo que medir: null, no 1', () => {
  const d = determinismo([{ verdict: 'FAILED', reason: TOPE, stages: [] }]);
  assert.equal(d.acuerdo, null);
  assert.equal(d.reproducible, false);
});

test('el modelo que pide aclaracion incumple el CONTRATO, no se autobloquea', () => {
  // Caso real de agosto (H-20260827-f5ef6a76): el researcher devolvio una
  // pregunta donde el contrato exige un FactSet. Sin esta regla caia en
  // SIN_CLASIFICAR y su causa quedaba invisible.
  const r = "STOP en 'Evidence': researcher no produjo un FactSet valido: no devolvio JSON reconocible; devolvio: \"Necesito claridad: ¿cual es el cambio especifico que debo analizar?\"";
  assert.equal(codigoDe(r), 'CONTRATO_NO_JSON');
  assert.equal(CODIGOS.CONTRATO_NO_JSON.culpa, 'modelo');
  assert.equal(etapaDe(r), 'Evidence');
});

test('ROJO_PREEXISTENTE: el tope agotado que NO era culpa del tope', () => {
  // Caso real h-008 v2 (H-20260917-75135851): 18 fallos durante la vuelta, los
  // MISMOS 18 en el arbol limpio. Delta 0 -> no rompio nada, peleaba con deuda ajena.
  const t = { verdict: 'FAILED', reason: TOPE, stages: [] };
  assert.equal(clasificarConBaseline(t, { fallosDespues: 18, fallosAntes: 18 }), 'ROJO_PREEXISTENTE');
  assert.equal(CODIGOS.ROJO_PREEXISTENTE.culpa, 'entorno');
});

test('si el builder SI rompio algo, el tope sigue siendo del tope', () => {
  const t = { verdict: 'FAILED', reason: TOPE, stages: [] };
  assert.equal(clasificarConBaseline(t, { fallosDespues: 25, fallosAntes: 18 }), 'TOPE_ITERACIONES');
});

test('sin medicion NO se reclasifica: un dato a medias no es un dato', () => {
  const t = { verdict: 'FAILED', reason: TOPE, stages: [] };
  assert.equal(clasificarConBaseline(t, {}), 'TOPE_ITERACIONES');
  assert.equal(clasificarConBaseline(t, { fallosDespues: 18 }), 'TOPE_ITERACIONES');
  assert.equal(clasificarConBaseline(t), 'TOPE_ITERACIONES');
});

test('la medicion solo aplica al tope: no reescribe otras causas', () => {
  const t = { verdict: 'FAILED', reason: BLOQ, stages: [] };
  assert.equal(clasificarConBaseline(t, { fallosDespues: 18, fallosAntes: 18 }), 'BUILDER_SE_AUTOBLOQUEA');
});

test('FRONTERA_VIOLADA: el fichero que el builder no escribio', () => {
  // H-20260917-fef6f11b: la vuelta murio por `public/version.json`, que NO lo
  // toco el builder -- lo regenera vite al correr run_test/run_typecheck.
  const r = "ROLLBACK en 'Execution': frontera violada por 'builder': 'public/version.json' esta fuera de [src, backend/src, scripts, migration, docker/init-db]";
  assert.equal(codigoDe(r), 'FRONTERA_VIOLADA');
  assert.equal(CODIGOS.FRONTERA_VIOLADA.culpa, 'harness', 'la frontera es del harness, no del modelo');
  assert.equal(etapaDe(r), 'Execution');
});

test('toda clave de CODIGOS declara culpa y descripcion', () => {
  for (const [k, v] of Object.entries(CODIGOS)) {
    assert.ok('culpa' in v, `${k} sin culpa`);
    assert.ok(v.desc?.length > 10, `${k} sin descripcion util`);
  }
});

// ── La vuelta que CONVERGIO y murio en la puerta ─────────────────────────────
//
// H-20260921-26bf176e llego a 15/16 --record de la rama-- con Convergence en
// `pass: true, blockers: 0, CONVERGED`: cero hallazgos P0-P5. Murio en la etapa
// 15 porque `gate --full` salio rojo dentro del workspace, y el rojo era de un
// test cuyo ancla a un commit habia muerto al reescribir la historia: nada que
// ver con el cambio de la vuelta.
//
// `veredicto()` devolvia SIN_CLASIFICAR, que significa «no se a que familia
// pertenece esto». Y si se sabe: el trabajo del modelo estaba TERMINADO y la
// puerta lo rechazo por el estado del arbol. Llamarlo «sin clasificar» pierde la
// unica distincion que importa -- que el modelo no tiene nada que corregir.
test('PUERTA_EN_ROJO: la vuelta convergio y la mato el gate, no el modelo', () => {
  const r = veredicto({ reason: 'gate --full en rojo dentro del workspace' });
  // El campo es `reason_code`, no `codigo`: lo escribi mal y el test acuso al
  // codigo de un defecto propio -- `undefined !== 'PUERTA_EN_ROJO'`.
  assert.equal(r.reason_code, 'PUERTA_EN_ROJO');
  assert.equal(r.culpa, 'entorno', 'la culpa no es del modelo: ya habia convergido');
  assert.equal(r.etapa, 'Evidence2');
});

test('PUERTA_EN_ROJO no se traga un fallo de convergencia', () => {
  // El orden de REGLAS importa: si `gate` ganara a `convergenc`, una vuelta que
  // NO converge y ademas tiene la puerta roja se contaria como culpa del entorno.
  const r = veredicto({ reason: 'convergencia no alcanzada tras 4 rondas' });
  assert.equal(r.reason_code, 'CONVERGENCIA_NO_ALCANZADA');
  assert.equal(r.culpa, 'modelo');
});
