// node --test harness/lib/
//
// Runner NATIVO de node (node:test), no vitest. Razon: vitest solo incluye
// `src/**` y el gate vigila el piso del FE (62 ficheros / 671 tests). Meter los
// tests del harness ahi mezclaria dos contabilidades y haria el piso inutil como
// senal. Cero dependencias nuevas.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { converge, findingKey, norm, bloqueantes } from './converge.mjs';

test('normaliza acentos, puntuacion y espacios', () => {
  assert.equal(norm('  El  FIX  no EXISTE. '), 'el fix no existe');
  assert.equal(norm('validación multi-tenant'), 'validacion multi tenant');
});

test('la clave ignora la linea: solo fichero, simbolo y claim', () => {
  const a = { file: 'src/a.ts', symbol: 'calcVigencia', claim: 'no valida null', line: 10 };
  const b = { file: './src/a.ts', symbol: 'calcVigencia', claim: 'No valida null!', line: 9999 };
  assert.equal(findingKey(a), findingKey(b));
});

test('fusiona duplicados y ACUMULA la evidencia de ambos', () => {
  const out = converge([
    { file: 'src/a.ts', symbol: 'f', claim: 'x', severity: 'P3', confidence: 'PARTIAL',
      evidence: ['e1'], lens: 'ACID', agent: 'reviewer' },
    { file: 'src/a.ts', symbol: 'f', claim: 'X.', severity: 'P1', confidence: 'CONFIRMED',
      evidence: ['e2'], lens: 'CIA', agent: 'security' },
  ]);

  assert.equal(out.length, 1, 'dos hallazgos del mismo (fichero,simbolo,claim) son uno');
  assert.equal(out[0].severity, 'P1', 'gana la severidad PEOR');
  assert.equal(out[0].confidence, 'CONFIRMED', 'gana la confianza MEJOR');
  assert.deepEqual(out[0].evidence, ['e1', 'e2'], 'la evidencia NO se descarta');
  assert.deepEqual(out[0].lenses, ['ACID', 'CIA']);
  assert.deepEqual(out[0].agents, ['reviewer', 'security']);
  assert.equal(out[0].seenBy, 2, 'corroboracion independiente: visible y contable');
});

test('no fusiona hallazgos distintos', () => {
  const out = converge([
    { file: 'src/a.ts', symbol: 'f', claim: 'x', severity: 'P3' },
    { file: 'src/a.ts', symbol: 'g', claim: 'x', severity: 'P3' },
    { file: 'src/b.ts', symbol: 'f', claim: 'x', severity: 'P3' },
  ]);
  assert.equal(out.length, 3);
});

test('un REFUTED no converge: se descarta', () => {
  const out = converge([
    { file: 'src/a.ts', symbol: 'f', claim: 'premisa falsa', severity: 'P1', verdict: 'REFUTED' },
    { file: 'src/a.ts', symbol: 'g', claim: 'real', severity: 'P4', verdict: 'CONFIRMED' },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].symbol, 'g');
});

test('ordena por severidad y luego por corroboracion', () => {
  const out = converge([
    { file: 'a', symbol: 's', claim: 'c1', severity: 'P4' },
    { file: 'b', symbol: 's', claim: 'c2', severity: 'P0' },
    { file: 'c', symbol: 's', claim: 'c3', severity: 'P2' },
  ]);
  assert.deepEqual(out.map((f) => f.severity), ['P0', 'P2', 'P4']);
});

test('bloqueantes = el umbral del DoD', () => {
  const out = converge([
    { file: 'a', symbol: 's', claim: 'c1', severity: 'P2' },
    { file: 'b', symbol: 's', claim: 'c2', severity: 'INFO' },
  ]);
  assert.equal(bloqueantes(out).length, 1, 'solo P0-P5 bloquean');
});

test('entrada vacia o nula no revienta', () => {
  assert.deepEqual(converge([]), []);
  assert.deepEqual(converge(null), []);
});

// ── UNDECIDED no bloquea; sin veredicto SI ─────────────────────────────────
// La distincion que hace segura la politica de mayoria: bloquear con un hallazgo
// que las tres pasadas no pudieron decidir es bloquear con ruido; dar por bueno
// uno que NUNCA paso por la refutacion es aprobar sin revisar.
// Se ejercita la ETAPA, no un filtro reescrito aqui. Escrito con el filtro
// duplicado en el test, revertir la regla en la etapa dejaba los dos casos en
// verde: el test medía su propia copia (el-test-que-pasa-por-el-orden-de-la-lista).
const ctxCon = (findings) => ({ artifacts: { Adversarial: { payload: { findings } } } });

test('la etapa 10 NO bloquea con UNDECIDED, y lo cuenta', async () => {
  const { convergence } = await import('./stages-deterministic.mjs');
  const r = await convergence(ctxCon([
    { file: 'src/a.ts', symbol: 'f', claim: 'uno', severity: 'P3', verdict: 'UNDECIDED' },
    { file: 'src/b.ts', symbol: 'g', claim: 'dos', severity: 'P4', verdict: 'REFUTED' },
  ]));
  assert.equal(r.payload.pass, true);
  assert.equal(r.payload.blockers, 0);
  assert.equal(r.payload.undecided, 1, 'no bloquea, pero queda registrado');
});

test('la etapa 10 SI bloquea con CONFIRMED', async () => {
  const { convergence } = await import('./stages-deterministic.mjs');
  const r = await convergence(ctxCon([{ file: 'src/a.ts', symbol: 'f', claim: 'uno', severity: 'P3', verdict: 'CONFIRMED' }]));
  assert.equal(r.status, 'FAIL');
  assert.match(r.reason, /P0-P5 confirmados/);
});

test('la etapa 10 SI bloquea con un hallazgo SIN veredicto: no revisado no es aprobado', async () => {
  const { convergence } = await import('./stages-deterministic.mjs');
  const r = await convergence(ctxCon([{ file: 'src/a.ts', symbol: 'f', claim: 'uno', severity: 'P2' }]));
  assert.equal(r.status, 'FAIL');
  assert.match(r.reason, /P0-P5 confirmados/);
});

// EL VERDICT SOBREVIVE AL BLOQUEO.
//
// La etapa LANZABA, y `runRing` escribe `payload: null` cuando una etapa lanza:
// los tres `11-convergence.json` de H-20260817-009c7621 pesan 265 bytes y no
// contienen ni un bloqueante. Se perdia el Verdict exactamente en la ronda que
// lo necesitaba. Mismo defecto que ya se habia corregido en Security, la etapa
// de al lado.
//
// Revertir a `throw` deja este test en rojo por asercion, no por excepcion.
test('al bloquear, el Verdict NO se pierde: FAIL con payload', async () => {
  const { convergence } = await import('./stages-deterministic.mjs');
  const r = await convergence(ctxCon([{ file: 'src/a.ts', symbol: 'f', claim: 'uno', severity: 'P3', verdict: 'CONFIRMED' }]));
  assert.equal(r.status, 'FAIL');
  assert.equal(r.payload.pass, false);
  assert.equal(r.payload.blockers, 1);
  assert.equal(r.payload.round, 1);
  assert.equal(r.payload.convergenceStatus, 'CONVERGING');
  assert.equal(r.payload.findings[0].status, 'NEW');
});

test('al bloquear, la etapa 10 GUARDA los bloqueantes para que la ronda siguiente los arrastre', async () => {
  const { convergence } = await import('./stages-deterministic.mjs');
  const ctx = ctxCon([{ file: 'src/a.ts', symbol: 'f', claim: 'uno', severity: 'P3', verdict: 'CONFIRMED' }]);
  await convergence(ctx);
  // Sin esto, no volver a reportar el hallazgo lo mataba: paso en
  // H-20260816-e2ec5f67 y la vuelta cerro en PASSED sin arreglar nada.
  assert.equal(ctx.pendientes.length, 1);
  assert.equal(ctx.pendientes[0].claim, 'uno');
});

// ── El ciclo, sobre la ETAPA y no sobre la funcion pura ─────────────────────
test('cuatro rondas alternando: la etapa detecta el ciclo y ENDURECE su onFail', async () => {
  const { convergence } = await import('./stages-deterministic.mjs');
  const { accionDeFallo } = await import('./ring.mjs');
  const A = { file: 'src/a.ts', symbol: 'a', claim: 'defecto alfa alfa', severity: 'P4', verdict: 'CONFIRMED' };
  const B = { file: 'src/b.ts', symbol: 'b', claim: 'defecto beta beta', severity: 'P4', verdict: 'CONFIRMED' };
  const C = { file: 'src/c.ts', symbol: 'c', claim: 'defecto gama gama', severity: 'P4', verdict: 'CONFIRMED' };

  const ctx = { artifacts: {} };
  let r;
  for (const ronda of [[A, B], [B, C], [A, C], [B, A]]) {
    ctx.artifacts = { Adversarial: { payload: { findings: ronda } } };
    r = await convergence(ctx);
  }

  assert.equal(r.payload.convergenceStatus, 'OSCILLATING');
  assert.equal(r.payload.round, 4);
  assert.ok(r.payload.reappeared.length >= 2, 'A y B se fueron y volvieron');
  assert.equal(r.onFail, 'STOP', 'un ciclo no se arregla reintentando');
  // Y el motor lo OBEDECE: el manifiesto dice REWORK y la etapa lo endurece.
  assert.equal(accionDeFallo({ onFail: 'REWORK — vuelve a la etapa 7' }, r), 'STOP');
});

test('una etapa NUNCA puede ablandar su onFail', async () => {
  const { accionDeFallo } = await import('./ring.mjs');
  assert.equal(accionDeFallo({ onFail: 'STOP DURO' }, { onFail: 'REWORK' }), 'STOP',
    'si una etapa pudiera pedir REWORK sobre un STOP, la puerta la abriria quien no la pasa');
  assert.equal(accionDeFallo({ onFail: 'ROLLBACK del worktree + STOP' }, { onFail: 'REWORK' }), 'ROLLBACK');
  assert.equal(accionDeFallo({ onFail: 'REWORK' }, {}), 'REWORK', 'sin override manda el manifiesto');
});

test('al converger, la etapa 10 VACIA los pendientes: nada se arrastra de mas', async () => {
  const { convergence } = await import('./stages-deterministic.mjs');
  const ctx = ctxCon([{ file: 'src/a.ts', symbol: 'f', claim: 'uno', severity: 'P3', verdict: 'REFUTED' }]);
  ctx.pendientes = [{ file: 'viejo.ts', symbol: 'x', claim: 'ya resuelto' }];
  await convergence(ctx);
  assert.deepEqual(ctx.pendientes, []);
});

// ── La regla absoluta: ninguna severidad es tolerable (ADR-007) ─────────────
//
// Se considero un umbral en P3 -- H-20260817-f00dd8f2 agoto sus REWORK con tres
// P4 vivos y habria cerrado en la ronda 1-- y se descarto. Un hallazgo archivado
// como deuda no vuelve a mirarse, y este repo tiene la medida: VULN-001 se
// REINTRODUJO despues de corregirse. Lo que se ajusto fue MAX_REWORK, que compra
// rondas para llegar al cero; no el cero.
//
// Sin este test la regla es una frase en un comentario, que es exactamente
// `el-fix-que-no-existe` aplicado a una politica.
test('TODA la escala bloquea: ninguna severidad se declara tolerable', () => {
  for (const sev of ['P0', 'P1', 'P2', 'P3', 'P4', 'P5']) {
    const f = { file: 'src/a.ts', symbol: 'x', claim: `un hallazgo ${sev}`, severity: sev };
    assert.equal(
      bloqueantes([f]).length, 1,
      `'${sev}' dejo de bloquear: no hay severidad tolerable, y esta se acaba de perdonar`,
    );
  }
});

test('un hallazgo FUERA de la escala no bloquea por accidente', () => {
  // `critical`/`high` son de un scanner ajeno. Traducirlos a la escala del repo
  // es trabajo de policy/security.json ANTES de llegar aqui; colarlos por este
  // filtro seria una segunda autoridad sobre la severidad.
  const fuera = ['critical', 'high', 'moderate', undefined, null, '', 'P6'];
  for (const severity of fuera) {
    assert.equal(bloqueantes([{ file: 'a', symbol: 'b', claim: 'c', severity }]).length, 0,
      `'${severity}' no esta en la escala y no debe bloquear sin traducir`);
  }
});

// ── EL VEREDICTO NO PUEDE DEPENDER DEL ORDEN DE LLEGADA ─────────────────────
//
// MEDIDO por `third` sobre c4ab1850 y reproducido antes de tocar nada: dos
// lentes que caen en la misma `findingKey` traen cada una SU veredicto --la
// etapa 7 refuta ANTES de la 8-- y la fusion conservaba el del PRIMERO. Un P0
// CONFIRMED atravesaba la puerta segun el orden de llegada.
const mismo = (extra) => ({ file: 'src/a.ts', symbol: 'f', claim: 'el mismo', severity: 'P0', ...extra });

test('un CONFIRMED no se pierde por llegar el segundo', () => {
  const ind = mismo({ verdict: 'UNDECIDED', lostVotes: 0 });
  const con = mismo({ verdict: 'CONFIRMED', lostVotes: 0 });
  assert.equal(converge([ind, con])[0].verdict, 'CONFIRMED');
  assert.equal(converge([con, ind])[0].verdict, 'CONFIRMED', 'y tampoco por llegar el primero');
});

test('un UNREVIEWED tampoco: lo no revisado no lo tapa un indeciso', () => {
  const ind = mismo({ verdict: 'UNDECIDED', lostVotes: 0 });
  const sin = mismo({ verdict: 'UNREVIEWED', lostVotes: 0 });
  assert.equal(converge([ind, sin])[0].verdict, 'UNREVIEWED');
  assert.equal(converge([sin, ind])[0].verdict, 'UNREVIEWED');
});

test('entre CONFIRMED y UNREVIEWED gana el que AFIRMA algo', () => {
  const con = mismo({ verdict: 'CONFIRMED' });
  const sin = mismo({ verdict: 'UNREVIEWED' });
  assert.equal(converge([sin, con])[0].verdict, 'CONFIRMED', 'alguien lo juzgo: eso es mas que nadie');
  assert.equal(converge([con, sin])[0].verdict, 'CONFIRMED');
});

test('el veredicto y su recuento viajan JUNTOS: el artefacto no se contradice', () => {
  // Mi primer arreglo acumulaba `lostVotes` con Math.max y dejaba counts/why del
  // primero: `lostVotes: 2` junto a `counts.lost: 0`. Dos cifras del mismo hecho
  // y ninguna manera de saber cual manda.
  const limpio = mismo({ verdict: 'UNDECIDED', lostVotes: 0, counts: { confirmed: 1, refuted: 0, abstained: 2, lost: 0 }, why: 'solo 1 voto de 2' });
  const perdido = mismo({ verdict: 'UNDECIDED', lostVotes: 2, counts: { confirmed: 1, refuted: 0, abstained: 0, lost: 2 }, why: 'el harness tiro el voto' });
  for (const orden of [[limpio, perdido], [perdido, limpio]]) {
    const m = converge(orden)[0];
    assert.equal(m.lostVotes, 2, 'fail-closed: gana el que bloquea');
    assert.equal(m.counts.lost, m.lostVotes, 'y su recuento es EL SUYO, no el del otro');
    assert.match(m.why, /tiro el voto/);
  }
});

test('la severidad sigue acumulandose aparte: son ejes distintos', () => {
  // El veredicto se toma del ganador; la severidad NO se toma, se acumula. Si
  // esto cayera, un P0 de una lente se perderia al fundir con el P4 de otra.
  const p0 = mismo({ severity: 'P0', verdict: 'UNDECIDED', lostVotes: 0 });
  const p4 = mismo({ severity: 'P4', verdict: 'CONFIRMED' });
  const m = converge([p0, p4])[0];
  assert.equal(m.verdict, 'CONFIRMED', 'el veredicto del que mas bloquea');
  assert.equal(m.severity, 'P0', 'y la PEOR severidad de las dos');
  assert.equal(m.seenBy, 2);
});

// ── LOS DOS INVARIANTES QUE CIERRAN EL BARRIDO DE LA FUSION ─────────────────
//
// `third` barrio la fusion buscando un cuarto campo con el agujero de
// «se conserva el del primero» y concluyo que NO HAY. Su conclusion es correcta
// --comprobada aparte-- pero descansaba en dos invariantes que NO fijaba nadie.
// Un invariante que solo vive en un argumento se cumple hasta que alguien tiene
// prisa, que es la misma leccion que la del indice de `memory/`.

test('`arrastrar` y `converge` deduplican con la MISMA identidad', async () => {
  // Si `arrastrar` dedujera por `fingerprint` --mas grueso-- un arrastrado y un
  // fresco de la misma clave PODRIAN coexistir, fundirian, y el orden decidiria
  // si el artefacto dice `carried: true` sobre algo que la ronda SI reporto.
  // Hoy es imposible porque las dos llaman a `findingKey`. Eso es lo que se fija.
  const { arrastrar } = await import('./adversarial.mjs');
  const f = { file: 'src/a.ts', symbol: 'g', claim: 'el mismo defecto', severity: 'P2' };
  const fresco = { ...f };
  const pendiente = { ...f, verdict: 'CONFIRMED', findingId: 'x' };

  const salida = arrastrar([fresco], [pendiente]);
  assert.equal(salida.length, 1, 'el arrastrado NO se anade: la ronda si lo reporto');
  assert.equal(salida[0].carried, undefined, 'y el que queda es el fresco, sin la marca historica');

  // Y la clave es estable entre las dos etapas: `tally` anade veredicto y
  // recuento, no toca file/symbol/claim. Si los tocara, la deduplicacion de
  // arriba dejaria de casar y el arrastrado reaparecería como fresco.
  const votado = { ...f, verdict: 'UNDECIDED', counts: { confirmed: 1, refuted: 0, abstained: 2, lost: 0 } };
  assert.equal(findingKey(votado), findingKey(f), 'votar no cambia la identidad');
});

test('`findingKey` es estrictamente mas fino que `fingerprint`', async () => {
  // Consecuencia: dos registros que FUNDEN tienen siempre el mismo fingerprint,
  // asi que el estado del ciclo de vida (`transiciones`, que clasifica por
  // fingerprint) no puede depender de cual de los dos gano la fusion.
  const { fingerprint, scopeKey } = await import('./findings.mjs');
  const A = { file: 'src/a.ts', symbol: 'parse', claim: 'El parseo, tautologico: devuelve undefined!' };
  const B = { file: 'src/a.ts', symbol: 'parse', claim: 'el parseo tautologico devuelve undefined' };
  assert.equal(findingKey(A), findingKey(B), 'la puntuacion y las mayusculas no crean dos hallazgos');
  assert.equal(fingerprint(A), fingerprint(B));
  assert.equal(scopeKey(A), scopeKey(B));

  // La implicacion misma, sobre todas las parejas de un conjunto que varia solo
  // en lo que `norm` colapsa. Cero violaciones o el barrido queda abierto.
  const claims = ['a b c', 'a, B! c', '  a   b   c  ', 'x y z', 'X, Y; Z'];
  let pares = 0, violaciones = 0;
  for (const c1 of claims) for (const c2 of claims) {
    const p = { file: 's.ts', symbol: 'g', claim: c1 };
    const q = { file: 's.ts', symbol: 'g', claim: c2 };
    if (findingKey(p) === findingKey(q)) { pares++; if (fingerprint(p) !== fingerprint(q)) violaciones++; }
  }
  assert.ok(pares >= 13, `el conjunto tiene que producir colisiones para medir algo (${pares})`);
  assert.equal(violaciones, 0, 'mismo findingKey con fingerprint distinto abriria el agujero');
});
