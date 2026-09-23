// node --test harness/lib/
//
// Los dos escenarios que la politica existe para distinguir, y que hoy no se
// distinguen porque hay un solo voto:
//
//   1 refutacion de 3  ->  el hallazgo SOBREVIVE
//   2 refutaciones de 3 ->  el hallazgo MUERE
//
// Medido en H-20260816-b0ae48ef: el mismo P5, sobre el MISMO codigo, salio
// CONFIRMED, CONFIRMED y REFUTED en tres rondas. Con una sola pasada, cual de las
// tres te toca decide si el anillo pasa.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tally, unificarVotos, arrastrar, avisoDeArrastre, PASADAS, enSerie } from './adversarial.mjs';
import { idsDe } from './findings.mjs';
import { entradaAdversarial, sellarVotantes } from './stages-model.mjs';

const voto = (pass, verdict) => ({ pass, verdict, reason: 'x' });
const H = (over = {}) => ({ file: 'src/a.ts', symbol: 'f', claim: 'algo', severity: 'P4', evidence: ['x'], ...over });

test('N es IMPAR: con N par un empate no es un veredicto', () => {
  assert.equal(PASADAS % 2, 1);
});

// ── Los dos escenarios confirmados ──────────────────────────────────────────
test('1 refutacion de 3: el hallazgo SOBREVIVE', () => {
  const r = tally([voto(1, 'CONFIRMED'), voto(2, 'REFUTED'), voto(3, 'CONFIRMED')]);
  assert.equal(r.verdict, 'CONFIRMED');
  assert.deepEqual(r.counts, { confirmed: 2, refuted: 1, abstained: 0, lost: 0 });
  // Una sola voz que refuta NO puede retirar un hallazgo: es exactamente la
  // varianza que esto viene a corregir.
});

test('2 refutaciones de 3: el hallazgo MUERE', () => {
  const r = tally([voto(1, 'REFUTED'), voto(2, 'CONFIRMED'), voto(3, 'REFUTED')]);
  assert.equal(r.verdict, 'REFUTED');
  assert.deepEqual(r.counts, { confirmed: 1, refuted: 2, abstained: 0, lost: 0 });
});

test('3 de 3 en cualquier sentido no es un caso especial', () => {
  assert.equal(tally([voto(1, 'REFUTED'), voto(2, 'REFUTED'), voto(3, 'REFUTED')]).verdict, 'REFUTED');
  assert.equal(tally([voto(1, 'CONFIRMED'), voto(2, 'CONFIRMED'), voto(3, 'CONFIRMED')]).verdict, 'CONFIRMED');
});

test('el empate a 1-1 NO mata el hallazgo: matar exige MAYORIA de refutaciones', () => {
  const r = tally([voto(1, 'CONFIRMED'), voto(2, 'REFUTED'), voto(3, null)]);
  assert.equal(r.verdict, 'CONFIRMED', 'sin mayoria para refutar, el hallazgo se queda');
  assert.equal(r.counts.abstained, 1);
});

// ── Abstencion ──────────────────────────────────────────────────────────────
test('menos de dos votos es UNDECIDED, no un veredicto inventado', () => {
  const r = tally([voto(1, 'CONFIRMED'), voto(2, null), voto(3, null)]);
  assert.equal(r.verdict, 'UNDECIDED');
  assert.match(r.why, /nadie pudo decidirlo/);
  assert.equal(r.counts.abstained, 2);
});

test('cero votos NO es UNDECIDED: es UNREVIEWED, y la diferencia decide la vuelta', () => {
  // Este test afirmaba UNDECIDED, y esa confusion es la que dejo cerrar
  // H-20260818-50778834 en CONVERGED con sus dos hallazgos sin juzgar:
  // UNDECIDED no bloquea, y aqui no habia habido votacion ninguna.
  const r = tally([voto(1, null), voto(2, null), voto(3, null)]);
  assert.equal(r.verdict, 'UNREVIEWED');
  assert.equal(r.counts.confirmed + r.counts.refuted, 0);
  assert.equal(r.counts.abstained, 3);
});

// ── Union de pasadas ────────────────────────────────────────────────────────
//
// EL CAMBIO QUE ESTOS TESTS FIJAN. La pasada devolvia los hallazgos ENTEROS con
// su veredicto, y el voto se casaba recalculando la identidad sobre lo que el
// modelo escribia. Fallaba de las dos formas posibles:
//
//   reformula  -> la clave no coincide y el voto se tira (6 de 6 en
//                 H-20260818-50778834, la primera vuelta con otra familia)
//   abrevia    -> faltan `file`, `symbol`, `claim`... y el contrato rechaza la
//                 pasada ENTERA (H-20260821-575882c8)
//
// Ahora el harness calcula el id, lo envia, y el modelo lo COPIA. Vota, que es su
// trabajo; no reescribe el de otro.
const V = (id, vote, reason = 'x') => ({ id, vote, reason });

test('el voto casa por el id ENVIADO, aunque el refutador reformule el claim', () => {
  // Este es el test que justifica el contrato `Vote`. Al refutador se le PIDE que
  // razone por su cuenta: que reformule es la senal de que esta funcionando, y
  // antes era exactamente lo que le tiraba el voto.
  const base = [H({ claim: 'el reloj se construye dentro de la funcion pura' })];
  const [id] = idsDe(base);
  const r = unificarVotos(base, [
    { ok: true, votes: [V(id, 'CONFIRMED')] },
    { ok: true, votes: [V(id, 'REFUTED')] },
    { ok: true, votes: [V(id, 'CONFIRMED')] },
  ]);
  assert.equal(r.findings.length, 1, 'un hallazgo, no tres');
  assert.equal(r.findings[0].verdict, 'CONFIRMED');
  assert.equal(r.findings[0].votes.length, 3);
  assert.equal(r.orphanVotes, 0);
});

test('una pasada que FALLA es una abstencion, no un fallo de etapa', () => {
  // Si cualquiera de las tres pudiera tumbar la vuelta, habriamos triplicado la
  // superficie de fallo y el anillo seria MENOS fiable que con una sola pasada.
  const base = [H()]; const [id] = idsDe(base);
  const r = unificarVotos(base, [
    { ok: true, votes: [V(id, 'REFUTED')] },
    { ok: false, error: 'OUTPUT_TRUNCATED' },
    { ok: true, votes: [V(id, 'REFUTED')] },
  ]);
  assert.equal(r.passesOk, 2);
  assert.equal(r.findings[0].verdict, 'REFUTED', 'dos votos bastan para decidir');
  assert.equal(r.findings[0].counts.abstained, 1);
});

test('un voto con un id que nadie envio no vota, y NO desaparece en silencio', () => {
  // El fallo que costo H-20260818-50778834: 6 votos emitidos, 6 tirados, todo
  // UNDECIDED, y nada en el artefacto decia que se habian tirado. `UNDECIDED` se
  // lee como «no hubo mayoria» cuando lo que hubo fue un emparejamiento roto.
  const base = [H()]; const [id] = idsDe(base);
  const r = unificarVotos(base, [
    { ok: true, votes: [V(id, 'CONFIRMED'), V('me-lo-invento', 'CONFIRMED')] },
    { ok: true, votes: [V(id, 'CONFIRMED')] },
    { ok: true, votes: [V(id, 'CONFIRMED')] },
  ]);
  assert.equal(r.findings.length, 1, 'el conjunto a votar lo fija Validation, no las pasadas');
  assert.equal(r.orphanVotes, 1, 'sin este numero, un emparejamiento roto es indistinguible del silencio');
});

test('dos hallazgos con la MISMA huella reciben ids distintos y no se roban el voto', () => {
  // `fingerprint` puede repetirse; el id no. Un voto atribuido al hallazgo
  // equivocado es peor que un voto perdido.
  const base = [H({ claim: 'mal' }), H({ claim: 'mal' })];
  const ids = idsDe(base);
  assert.equal(new Set(ids).size, 2);
  const r = unificarVotos(base, [
    { ok: true, votes: [V(ids[0], 'REFUTED'), V(ids[1], 'CONFIRMED')] },
    { ok: true, votes: [V(ids[0], 'REFUTED'), V(ids[1], 'CONFIRMED')] },
    { ok: true, votes: [V(ids[0], 'REFUTED'), V(ids[1], 'CONFIRMED')] },
  ]);
  assert.equal(r.findings[0].verdict, 'REFUTED');
  assert.equal(r.findings[1].verdict, 'CONFIRMED');
  assert.equal(r.orphanVotes, 0);
});

test('omitir un hallazgo cuenta como abstencion, NO como refutacion', () => {
  // Si el silencio matara hallazgos, la forma mas facil de pasar el anillo seria
  // que el refutador devolviera menos cosas.
  const base = [H()]; const [id] = idsDe(base);
  const r = unificarVotos(base, [
    { ok: true, votes: [] },
    { ok: true, votes: [] },
    { ok: true, votes: [V(id, 'CONFIRMED')] },
  ]);
  assert.equal(r.findings[0].verdict, 'UNDECIDED');
  assert.notEqual(r.findings[0].verdict, 'REFUTED');
});

// ── La varianza, medida ─────────────────────────────────────────────────────
test('el desacuerdo se CUENTA: la varianza deja de ser anecdota', () => {
  const base = [H(), H({ claim: 'otro defecto distinto del primero' })];
  const ids = idsDe(base);
  const r = unificarVotos(base, [
    { ok: true, votes: [V(ids[0], 'CONFIRMED'), V(ids[1], 'CONFIRMED')] },
    { ok: true, votes: [V(ids[0], 'REFUTED'), V(ids[1], 'CONFIRMED')] },
    { ok: true, votes: [V(ids[0], 'CONFIRMED'), V(ids[1], 'CONFIRMED')] },
  ]);
  assert.equal(r.disagreements, 1, 'el primero tuvo votos divididos; el segundo no');
  assert.equal(r.undecided, 0);
  assert.equal(r.passes, 3);
});

test('cada hallazgo conserva sus votos con el numero de pasada', () => {
  const base = [H()]; const [id] = idsDe(base);
  const r = unificarVotos(base, [
    { ok: true, votes: [V(id, 'CONFIRMED', 'la premisa se sostiene')] },
    { ok: true, votes: [V(id, 'REFUTED', 'el simbolo no existe')] },
    { ok: true, votes: [V(id, 'CONFIRMED')] },
  ]);
  assert.deepEqual(r.findings[0].votes.map((v) => v.pass), [1, 2, 3]);
  assert.equal(r.findings[0].votes[1].reason, 'el simbolo no existe',
    'la razon de quien discrepa es lo que hace auditable el desacuerdo');
});

// ── Arrastre: la ausencia no es resolucion ─────────────────────────────────
// H-20260816-e2ec5f67: un P5 confirmado por 2 de 3 bloqueo la ronda 1, y en la
// ronda 2 Validation NO volvio a reportarlo. Nadie lo refuto, nadie lo arreglo:
// se cayo de la lista y la vuelta acabo en PASSED.
test('un hallazgo que bloqueo y no vuelve a salir SE ARRASTRA', () => {
  const pendiente = H({ severity: 'P3', findingId: 'H-X:f:1', verdict: 'CONFIRMED' });
  const r = arrastrar([], [pendiente]);
  assert.equal(r.length, 1);
  assert.equal(r[0].carried, true);
  assert.equal(r[0].carriedFrom, 'H-X:f:1');
  assert.match(r[0].carriedReason, /no volvio a reportarlo/);
});

test('el arrastrado PIERDE su veredicto: se vota otra vez, no se hereda', () => {
  const r = arrastrar([], [H({ verdict: 'CONFIRMED', votes: [1, 2, 3], counts: { confirmed: 2 }, why: 'viejo' })]);
  assert.equal(r[0].verdict, undefined, 'si heredara el veredicto ya no habria que refutarlo');
  assert.equal(r[0].votes, undefined);
  assert.equal(r[0].counts, undefined);
});

test('si la ronda nueva SI lo reporta, no se duplica', () => {
  const r = arrastrar([H({ severity: 'P4' })], [H({ severity: 'P3', findingId: 'H-X:f:1' })]);
  assert.equal(r.length, 1, 'misma identidad (file, symbol, claim)');
  assert.equal(r[0].carried, undefined, 'gana el reportado de nuevo, con su severidad fresca');
});

test('arrastrar sin pendientes no cambia nada', () => {
  const nuevos = [H()];
  assert.deepEqual(arrastrar(nuevos, []), nuevos);
  assert.deepEqual(arrastrar(nuevos), nuevos);
});

// ── El arrastrado tiene que poder MORIR ────────────────────────────────────
// H-20260817-95193afa: el builder elimino el `dangerouslySetInnerHTML` sembrado
// (`grep -c` -> 0) y las tres pasadas siguieron confirmando el hallazgo. Los
// cinco bloqueantes finales eran arrastrados y ninguno nuevo. Sin estas dos
// piezas -- la etiqueta y el codigo -- el arrastre fosiliza lo que conserva.
test('sin arrastrados, la pasada no recibe ningun aviso', () => {
  assert.equal(avisoDeArrastre([H(), H({ claim: 'otro' })]), '');
  assert.equal(avisoDeArrastre([]), '');
  assert.equal(avisoDeArrastre(), '');
});

test('con arrastrados, el aviso dice CUANTOS y que REFUTED es la respuesta correcta', () => {
  const aviso = avisoDeArrastre([H(), H({ claim: 'viejo', carried: true }), H({ claim: 'otro', carried: true })]);
  assert.match(aviso, /\b2\b/, 'cuenta solo los heredados, no los frescos');
  assert.match(aviso, /carried/);
  assert.match(aviso, /REFUTED/, 'sin decir cual es el veredicto correcto, se re-confirma por inercia');
  assert.match(aviso, /ChangeSet/, 'contra el codigo de AHORA, no contra el texto del hallazgo');
});

test('la pasada de refutacion recibe el ChangeSet: sin codigo no hay premisa que comprobar', () => {
  // El defecto de fondo. Se le pedia «comprueba la premisa contra el codigo» y se
  // le mandaba SOLO el FindingSet: lo unico que podia juzgar era el texto, y un
  // texto no cambia porque el builder arregle el fichero.
  const ctx = {
    artifacts: {
      Validation: { payload: { findings: [H({ carried: true })] } },
      Execution: { payload: { files: ['src/a.ts'], diff: '--- a/src/a.ts\n+++ b/src/a.ts\n+const x = 1;' } },
    },
  };
  const { inputs, extra } = entradaAdversarial(ctx);

  assert.ok(inputs.ChangeSet, 'sin ChangeSet la pasada juzga el texto del hallazgo, no el codigo');
  assert.equal(inputs.ChangeSet.payload.diff, ctx.artifacts.Execution.payload.diff);
  assert.ok(inputs.FindingSet, 'y sigue viendo que se vota');
  assert.match(extra, /REFUTA/);
  assert.match(extra, /carried/, 'el aviso de arrastre va cableado, no es opcional');
});

test('sin arrastrados el extra no menciona el arrastre: el aviso es condicional', () => {
  const { extra } = entradaAdversarial({
    artifacts: {
      Validation: { payload: { findings: [H()] } },
      Execution: { payload: { files: ['src/a.ts'], diff: 'x' } },
    },
  });
  assert.doesNotMatch(extra, /carried/);
});

test('un arrastrado que NADIE refuta sigue vivo y vuelve a bloquear', () => {
  // El titulo de este test decia «vuelve a bloquear» y la asercion decia
  // UNDECIDED, que es JUSTO el veredicto que Convergence no bloquea. Llevaba
  // puesto el nombre de su intencion y la asercion de lo contrario, asi que el
  // arrastre podia morir en silencio con el test en verde.
  const arrastrado = arrastrar([], [H({ severity: 'P3', verdict: 'CONFIRMED' })]);
  const [idA] = idsDe(arrastrado);
  const sinVotos = unificarVotos(arrastrado, [{ ok: true, votes: [] }, { ok: true, votes: [] }, { ok: true, votes: [] }]);
  assert.equal(sinVotos.findings[0].verdict, 'UNREVIEWED', 'sin votos NO se refuto, y lo no refutado bloquea');

  // ...y si DOS lo refutan de verdad, entonces si muere: el builder lo arreglo y
  // la premisa dejo de sostenerse. Esa es la unica forma legitima de matarlo.
  const refutado = unificarVotos(arrastrado, [
    { ok: true, votes: [V(idA, 'REFUTED')] },
    { ok: true, votes: [V(idA, 'REFUTED')] },
    { ok: true, votes: [V(idA, 'CONFIRMED')] },
  ]);
  assert.equal(refutado.findings[0].verdict, 'REFUTED');
});

// ── Cerrar por ABSTENCION no es converger (Fase 11) ─────────────────────────
//
// MEDIDO en H-20260818-50778834, la primera vuelta con un refutador de OTRA
// familia: las tres pasadas corrieron bien (`passesOk: 3`) y se abstuvieron en
// los dos hallazgos. Los dos salieron UNDECIDED, Convergence no bloquea
// UNDECIDED, y el anillo declaro CONVERGED con cero bloqueantes.
test('nadie se pronuncio NO es lo mismo que no hubo mayoria', () => {
  const nadie = tally([{ pass: 1, verdict: null }, { pass: 2, verdict: null }, { pass: 3, verdict: null }]);
  assert.equal(nadie.verdict, 'UNREVIEWED', 'tres abstenciones = la refutacion no ocurrio');
  assert.match(nadie.why, /se abstuvieron/);
  assert.equal(nadie.counts.abstained, 3);

  const sinMayoria = tally([{ pass: 1, verdict: 'REFUTED' }, { pass: 2, verdict: null }, { pass: 3, verdict: null }]);
  assert.equal(sinMayoria.verdict, 'UNDECIDED', 'un voto emitido SI es una votacion sin mayoria');
});

test('la etapa 11 BLOQUEA lo no revisado y sigue sin bloquear lo indeciso', async () => {
  const { convergence } = await import('./stages-deterministic.mjs');
  const f = (claim, verdict) => ({ file: 'src/a.ts', symbol: 'f', claim, severity: 'P4', verdict });

  const sinRevisar = await convergence({ artifacts: { Adversarial: { payload: { findings: [f('uno', 'UNREVIEWED')] } } } });
  assert.equal(sinRevisar.status, 'FAIL', 'no revisado no es aprobado');
  assert.equal(sinRevisar.payload.blockers, 1);
  assert.equal(sinRevisar.payload.unreviewed, 1);

  const indeciso = await convergence({ artifacts: { Adversarial: { payload: { findings: [f('dos', 'UNDECIDED')] } } } });
  assert.equal(indeciso.payload.pass, true, 'bloquear con lo que nadie pudo decidir es bloquear con ruido');
  assert.equal(indeciso.payload.blockers, 0);
});

// EL VOTO SE PERDIA EN EL Map.get. `unificarVotos` casaba por `findingKey`, que
// lleva el CLAIM COMPLETO: funciona cuando refuta el MISMO modelo que reporto y
// se rompe justo cuando NO lo es. La independencia de criterio que costo toda la
// fase se perdia al indexar.
// ── Lo que estos dos tests protegian, y por que cambian de mecanismo ────────
//
// Protegian una PROPIEDAD real: un refutador de otra familia reformula --se le
// PIDE que razone por su cuenta-- y su voto tiene que contar igual. La forma de
// conseguirla era casar por `fingerprint` cuando `findingKey` fallaba: dos
// indices sobre el texto que devolvia el modelo.
//
// La propiedad sigue; el mecanismo no. Casar sobre el texto del modelo obligaba
// a que lo devolviera entero, y eso es lo que rechazo el contrato en
// H-20260821-575882c8. Ahora la identidad la calcula el harness y viaja: el
// modelo la copia. La propiedad la fija arriba `el voto casa por el id ENVIADO,
// aunque el refutador reformule el claim`, que es la MISMA afirmacion con una
// implementacion que no depende de que dos textos se parezcan.
//
// No se borran en silencio: se declara que su mecanismo dejo de existir.

test('la reformulacion ya no puede perder un voto: el id no se deriva del texto', () => {
  const base = [{ file: 'src/a.ts', symbol: 'fmt', claim: 'el indice sale negativo y devuelve undefined', severity: 'P4' }];
  const [id] = idsDe(base);
  // El refutador reformula por completo. Da igual: vota con el id que recibio.
  const pasada = { ok: true, votes: [V(id, 'REFUTED', 'ya corregido')] };
  const r = unificarVotos(base, [pasada, pasada, pasada]);
  assert.equal(r.findings[0].verdict, 'REFUTED');
  assert.equal(r.findings[0].counts.refuted, 3, 'tres votos emitidos, cero tirados');
  assert.equal(r.unreviewed, 0);
  assert.equal(r.orphanVotes, 0);
});

test('dos hallazgos del mismo simbolo con claims casi iguales no se roban el voto', () => {
  const a = { file: 'src/a.ts', symbol: 'fmt', claim: 'el indice sale negativo devuelve undefined', severity: 'P4' };
  const b = { file: 'src/a.ts', symbol: 'fmt', claim: 'el indice sale negativo devuelve undefined ademas', severity: 'P5' };
  const ids = idsDe([a, b]);
  assert.equal(new Set(ids).size, 2, 'ids distintos aunque los claims se parezcan');
  const pasada = { ok: true, votes: [V(ids[0], 'REFUTED', 'a'), V(ids[1], 'CONFIRMED', 'b')] };
  const r = unificarVotos([a, b], [pasada, pasada]);
  assert.equal(r.findings[0].verdict, 'REFUTED', 'cada hallazgo recibe SU voto');
  assert.equal(r.findings[1].verdict, 'CONFIRMED');
});

// ── El contrato del voto se HACE CUMPLIR, no solo se declara ────────────────
//
// Declarar `Vote` en contracts.json no sirve de nada si el validador no lo
// aplica a cada elemento: una lista de objetos vacios cumpliria `VoteSet` y los
// tres votos saldrian huerfanos sin que nada fallara. Ya paso con `FindingSet`
// en H-20260819-68ac6919, y por eso existe `elements`.
test('un voto sin `id` o sin `vote` NO cumple el contrato', async () => {
  const { validate } = await import('./artifact.mjs');
  assert.deepEqual(validate('VoteSet', { votes: [{ id: 'a.ts|g|x', vote: 'REFUTED', reason: 'ok' }] }), []);
  assert.match(validate('VoteSet', { votes: [{ vote: 'REFUTED' }] })[0], /falta 'id'/,
    'sin id el voto no se puede atribuir, y atribuirlo mal es peor que perderlo');
  assert.match(validate('VoteSet', { votes: [{ id: 'a' }] })[0], /falta 'vote'/);
  assert.equal(validate('VoteSet', { votes: [{}] }).length, 2, 'una lista de objetos vacios NO cumple');
});

test('`Vote` y `Verdict` son contratos DISTINTOS, y el nuevo no piso al viejo', async () => {
  // `Verdict` ya existia y es la salida de Convergence -- el umbral del DoD--.
  // El nombre obvio estaba cogido; llamar `Verdict` al voto de una pasada habria
  // sido dos contratos con el mismo nombre, que es la forma mas cara de la
  // segunda autoridad. Lo detecto una asercion al escribirlo, no una relectura.
  const { CONTRACTS } = await import('./artifact.mjs');
  const c = CONTRACTS.contracts ?? CONTRACTS;
  assert.deepEqual(c.Verdict.required, ['pass', 'blockers', 'refutationRate'], 'Verdict sigue siendo el del DoD');
  assert.deepEqual(c.Vote.required, ['id', 'vote']);
});

// ── El paralelismo que era gratis y no lo era ───────────────────────────────
test('las pasadas van EN SERIE si el modelo corre en esta maquina', async () => {
  // MEDIDO el 21-ago, prompt de 14.621 chars con qwen2.5-coder:14b:
  //   paralelo  117,7 / 72,6 / 99,7 s  -> pared 117,7 s
  //   serie       5,6 / 17,5 / 10,7 s  -> pared  33,9 s
  // La pared es 3,5x peor Y cada peticion dura hasta 21 veces mas, que es lo que
  // la estrella contra los 300 s de undici. El comentario del modulo decia que
  // correr en paralelo era gratis porque las pasadas son independientes; la
  // independencia es cierta, lo de gratis no.
  const { loadCatalog } = await import('./capabilities.mjs');
  const cat = loadCatalog();
  assert.equal(enSerie(cat, { provider: 'ollama', model: 'qwen2.5-coder:14b' }), true,
    'un modelo local compite consigo mismo: en serie');
  assert.equal(enSerie(cat, { provider: 'deepseek', model: 'deepseek-v4-pro' }), false,
    'uno remoto no consume esta CPU: en paralelo, que ahi si es gratis');
});

test('la decision NO se toma por el nombre del proveedor', async () => {
  // Fijar `provider === 'ollama'` seria fijar el literal de hoy: manana entra
  // otro runtime local y el defecto vuelve sin que nada falle. Lo que importa es
  // que el modelo corra AQUI, y eso el catalogo ya lo declara.
  const inventado = { models: [{ provider: 'runtime-nuevo', model_id: 'x', offline: true }] };
  assert.equal(enSerie(inventado, { provider: 'runtime-nuevo', model: 'x' }), true);
  const remoto = { models: [{ provider: 'ollama', model_id: 'y', offline: false }] };
  assert.equal(enSerie(remoto, { provider: 'ollama', model: 'y' }), false,
    'ni siquiera ollama va en serie si el catalogo dice que no es local');
});

test('el refutador VE el allowlist, o confirma lo que no puede comprobar', () => {
  // MEDIDO en H-20260820-c9a55e79, item cm-4-security. El revisor levanto un P2:
  //   «...pese a que el summary afirma diff vacio Y EL ALLOWLIST LO EXCLUYE»
  // sobre un fichero que el allowlist SI incluye: era la SEMILLA de la vuelta.
  // Esta etapa lo CONFIRMO, y no podia hacer otra cosa -- se le pidio refutar una
  // afirmacion sobre una lista que no tenia delante.
  //
  // Confirmar por no poder comprobar sale con la MISMA etiqueta que comprobar.
  const ctx = {
    artifacts: {
      Plan: { stage: 'Plan', payload: { goal: 'g', files: ['src/a.tsx', 'src/a.spec.tsx'] } },
      Execution: { stage: 'Execution', payload: { files: ['src/a.spec.tsx'], diff: 'd' } },
      Validation: { stage: 'Validation', payload: { findings: [{ file: 'src/a.tsx', claim: 'el allowlist lo excluye' }] } },
    },
  };
  const { inputs, extra } = entradaAdversarial(ctx);
  assert.deepEqual(inputs.Alcance.payload.allowlist, ['src/a.tsx', 'src/a.spec.tsx'],
    'sin el allowlist, una premisa sobre el allowlist no se puede refutar');

  // Y las dos listas dejan de llamarse igual tambien aqui.
  assert.deepEqual(inputs.ChangeSet.payload?.changedFiles ?? inputs.ChangeSet.changedFiles, ['src/a.spec.tsx']);

  // El enunciado tiene que DECIR que son distintas: darle el dato y no avisarle
  // deja el mismo error a un paso.
  assert.match(extra, /allowlist/);
  assert.match(extra, /changedFiles/);
  assert.match(extra, /REFUTA/);
});

test('tres pasadas no son tres opiniones si salen del mismo modelo', () => {
  // MEDIDO en H-20260824-fa058d63. El voto llevaba `pass: 1|2|3` y NADA sobre
  // quien voto, asi que `confirmed: 3` se leia aguas abajo como consenso de tres.
  // Eran tres muestras del MISMO deepseek:deepseek-v4-pro -- que ademas es el
  // modelo que habia escrito los hallazgos como `reviewer`. En F1 las tres se
  // equivocaron igual, y era un P1 FALSO. Hallazgo de third.
  const votado = { findings: [{ claim: 'c', votes: [{ pass: 1, verdict: 'CONFIRMED' }, { pass: 2, verdict: 'CONFIRMED' }] }] };

  const mismo = sellarVotantes(votado, [
    { ok: true, model: 'deepseek:deepseek-v4-pro' },
    { ok: true, model: 'deepseek:deepseek-v4-pro' },
  ]);
  assert.equal(mismo.voters, 1, 'dos pasadas del mismo modelo son UN votante');
  assert.deepEqual(mismo.findings[0].votes.map((v) => v.model),
    ['deepseek:deepseek-v4-pro', 'deepseek:deepseek-v4-pro'],
    'cada voto tiene que decir quien lo emitio');

  const distintos = sellarVotantes(votado, [
    { ok: true, model: 'deepseek:deepseek-v4-pro' },
    { ok: true, model: 'ollama:qwen3-coder' },
  ]);
  assert.equal(distintos.voters, 2);
  assert.equal(distintos.findings[0].votes[1].model, 'ollama:qwen3-coder');

  // Una pasada que FALLO no es un votante: no contesto.
  const conFallo = sellarVotantes(votado, [
    { ok: true, model: 'deepseek:deepseek-v4-pro' },
    { ok: false, model: 'deepseek:deepseek-v4-pro', error: 'timeout' },
  ]);
  assert.equal(conFallo.voters, 1);

  // Y no se inventa un modelo donde no lo hay.
  assert.equal(sellarVotantes(votado, []).findings[0].votes[0].model, null);
  assert.equal(sellarVotantes(votado, []).voters, 0);

  // EL CABLEADO, no solo la funcion. Quitar `sellarVotantes` del payload dejaba
  // los cuatro casos de arriba en verde y el artefacto sin sellar: un test que
  // prueba la pieza y no su montaje deja el defecto entero en pie. Lo comprobe
  // por reversion y NO se puso rojo -- que es la clase que este dia entero ha
  // ido cerrando.
  const src = readFileSync(new URL('./stages-model.mjs', import.meta.url), 'utf8');
  assert.match(src, /payload:\s*\{\s*\.\.\.sellarVotantes\(votado, pasadas\)/,
    'el payload de Adversarial no pasa por sellarVotantes: los votos salen sin `model`');

  // Y QUE ALGUIEN LO LEA. `voters` se escribia y no lo consumia nadie, mientras
  // `passes` si lo lee Convergence: publicar solo el segundo es exactamente lo
  // que hacia que `confirmed: 3` se leyera como consenso de tres. Segunda vez hoy
  // que escribo un dato que nadie mira -- la primera fue `veredictosInestables`.
  const det = readFileSync(new URL('./stages-deterministic.mjs', import.meta.url), 'utf8');
  assert.match(det, /voters: ctx\.artifacts\?\.Adversarial\?\.payload\?\.voters/,
    'Convergence publica `passes` y no `voters`: el numero vuelve a leerse como consenso');
});

// ── EL VOTO QUE SE EMITIO Y TIRAMOS (H-20260824-d897a07f) ───────────────────
//
// La vuelta convergio porque se perdieron los votos, no porque se arreglara
// nada: 4 hallazgos x 3 pasadas = 12 votos esperados, `passesOk: 3` --las tres
// CONTESTARON-- y `orphanVotes: 8`. Cada hallazgo se quedo con un voto, todos
// UNDECIDED, Convergence no bloquea UNDECIDED, `pass: true`. Tres hallazgos eran
// falsos y salieron bien POR ACCIDENTE; el cuarto era verdadero y murio por el
// mismo camino.
test('los votos huerfanos se GUARDAN, no solo se cuentan', () => {
  const base = [H()]; const [id] = idsDe(base);
  const r = unificarVotos(base, [
    { ok: true, votes: [V('id-inventado', 'REFUTED')] },
    { ok: true, votes: [V(id, 'CONFIRMED')] },
    { ok: true, votes: [V(id, 'CONFIRMED')] },
  ]);
  assert.equal(r.orphanVotes, 1);
  // Sin ESTO, `orphanVotes: 8` es un numero del que no se puede hacer nada: no
  // dice si el modelo se invento el id o si contesto sobre otro conjunto.
  assert.equal(r.orphans.length, 1);
  assert.equal(r.orphans[0].pass, 1);
  assert.equal(r.orphans[0].id, 'id-inventado');
  assert.equal(r.orphans[0].vote, 'REFUTED', 'el voto tirado decia algo, y ahora consta que');
});

test('una pasada que voto y no casamos NO cuenta como abstencion', () => {
  const base = [H()]; const [id] = idsDe(base);
  const r = unificarVotos(base, [
    { ok: true, votes: [V('otro-id', 'REFUTED')] },   // hablo, y no la entendimos
    { ok: true, votes: [V(id, 'CONFIRMED')] },
    { ok: true, votes: [] },                           // esta si se abstuvo
  ]);
  const f = r.findings[0];
  assert.equal(f.verdict, 'UNDECIDED', 'un voto de dos necesarios sigue sin ser mayoria');
  assert.equal(f.counts.lost, 1, 'la pasada 1 voto: su silencio no es una abstencion');
  assert.equal(f.counts.abstained, 1, 'y la 3 si se abstuvo: son dos hechos distintos');
  assert.equal(f.lostVotes, 1);
  assert.match(f.why, /el harness tiro el voto/);
  assert.equal(r.lostVoteFindings, 1, 'la decision propia del harness, en el artefacto');
});

test('sin huerfanos, un indeciso sigue siendo un indeciso de verdad', () => {
  // El control del control: si esto no fuera cero, la marca acusaria a toda
  // votacion renida y el guarda se desactivaria por ruido.
  const base = [H()]; const [id] = idsDe(base);
  const r = unificarVotos(base, [
    { ok: true, votes: [V(id, 'CONFIRMED')] },
    { ok: true, votes: [] },
    { ok: true, votes: [] },
  ]);
  assert.equal(r.findings[0].verdict, 'UNDECIDED');
  assert.equal(r.findings[0].counts.lost, 0);
  assert.equal(r.lostVoteFindings, 0);
});

test('la etapa 11 BLOQUEA el indeciso cuyo voto tiramos, y sigue eximiendo al otro', async () => {
  const { convergence } = await import('./stages-deterministic.mjs');
  const f = (claim, extra) => ({ file: 'src/a.ts', symbol: 'f', claim, severity: 'P3', verdict: 'UNDECIDED', ...extra });

  const ruido = await convergence({ artifacts: { Adversarial: { payload: { findings: [f('sin mayoria')] } } } });
  assert.equal(ruido.payload.pass, true, 'la decision de H-20260818-50778834 sigue en pie');
  assert.equal(ruido.payload.blockers, 0);

  const perdido = await convergence({
    artifacts: { Adversarial: { payload: { findings: [f('voto tirado', { lostVotes: 2 })], orphanVotes: 8 } } },
  });
  assert.equal(perdido.payload.pass, false, 'la refutacion OCURRIO: no se cierra sobre ella');
  assert.equal(perdido.payload.blockers, 1);
  assert.equal(perdido.payload.undecidedByLostVotes, 1);
  assert.equal(perdido.payload.orphanVotes, 8, 'el numero viaja al artefacto que se lee');
});

test('al fundir duplicados el voto perdido NO se cae con el segundo', async () => {
  // `converge` conservaba los campos del PRIMERO. Si la marca la traia el
  // segundo, el hallazgo fundido salia limpio y se eximia.
  const { convergence } = await import('./stages-deterministic.mjs');
  const f = (extra) => ({ file: 'src/a.ts', symbol: 'f', claim: 'el mismo', severity: 'P3', verdict: 'UNDECIDED', ...extra });
  const r = await convergence({
    artifacts: { Adversarial: { payload: { findings: [f({}), f({ lostVotes: 1 })] } } },
  });
  assert.equal(r.payload.unified, 1, 'son el mismo hallazgo');
  assert.equal(r.payload.blockers, 1, 'y uno de los dos traia la marca');
});
