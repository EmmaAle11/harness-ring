// node --test harness/lib/findings.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  claimStem, scopeKey, fingerprint, transiciones, convergencia, avisoDeCicloDeVida, veredictosInestables,
} from './findings.mjs';
import { findingKey } from './converge.mjs';

const f = (file, symbol, claim, extra = {}) => ({ file, symbol, claim, severity: 'P4', ...extra });

// ── identidad ────────────────────────────────────────────────────────────────

test('el esqueleto sobrevive a la reformulacion del mismo defecto', () => {
  const a = 'el indice sale negativo y u[-1] devuelve undefined';
  const b = 'devuelve undefined porque el indice resulta negativo';
  assert.equal(claimStem(a), claimStem(b), 'mismo vocabulario, otro orden -> mismo esqueleto');
});

test('el esqueleto NO fusiona dos defectos distintos del mismo simbolo', () => {
  assert.notEqual(
    claimStem('el indice negativo devuelve undefined'),
    claimStem('la asercion compara la funcion consigo misma: tautologica'),
  );
});

test('TECHO: otro vocabulario da otro fingerprint, y `displaced` lo caza', () => {
  // No se finge que el esqueleto sea inmune a un sinonimo. Lo que se comprueba
  // es que la red estructural sigue debajo: mismo simbolo -> mismo scope.
  const a = f('src/a.ts', 'fmt', 'el indice negativo devuelve undefined');
  const b = f('src/a.ts', 'fmt', 'la unidad sale vacia con fracciones pequenas');
  assert.notEqual(fingerprint(a), fingerprint(b), 'el techo existe y se declara');
  assert.equal(scopeKey(a), scopeKey(b), 'y por debajo hay una identidad que no depende del texto');
  assert.deepEqual(convergencia([[a], [b]]).displaced, ['src/a.ts|fmt']);
});

test('scopeKey no contiene una sola palabra del modelo', () => {
  const a = f('./src/lib/x.ts', 'formatFileSize', 'da undefined con bytes fraccionarios');
  const b = f('src/lib/x.ts', 'formatFileSize', 'la asercion es tautologica y no prueba nada');
  assert.equal(scopeKey(a), scopeKey(b), 'mismo fichero y simbolo -> mismo scope');
  assert.notEqual(fingerprint(a), fingerprint(b), 'el esqueleto los separa');
});

test('el fingerprint es MAS GRUESO que findingKey, nunca al reves', () => {
  // Dos redacciones del mismo defecto: findingKey las separa (es su trabajo
  // dentro de una ronda), fingerprint las une (es el suyo entre rondas).
  const a = f('src/a.ts', 'g', 'el indice sale negativo y devuelve undefined');
  const b = f('src/a.ts', 'g', 'devuelve undefined cuando el indice es negativo');
  assert.notEqual(findingKey(a), findingKey(b));
  assert.equal(fingerprint(a), fingerprint(b));
});

// ── transiciones ─────────────────────────────────────────────────────────────

test('NEW, UNCHANGED, CARRIED, REGRESSED y FIXED, cada uno en su sitio', () => {
  const A = f('src/a.ts', 'x', 'defecto alfa alfa');
  const B = f('src/b.ts', 'y', 'defecto beta beta');
  const C = f('src/c.ts', 'z', 'defecto gamma gamma');

  const t = transiciones(
    [A, { ...B, carried: true }, C],
    { previas: [A, B, f('src/d.ts', 'w', 'defecto delta delta')], historia: new Set([fingerprint(C)]) },
  );

  const st = Object.fromEntries(t.findings.map((x) => [x.file, x.status]));
  assert.equal(st['src/a.ts'], 'UNCHANGED', 'el revisor lo volvio a reportar');
  assert.equal(st['src/b.ts'], 'CARRIED', 'sobrevive solo por el arrastre');
  assert.equal(st['src/c.ts'], 'REGRESSED', 'estuvo, se fue y ha vuelto');
  assert.equal(t.fixed.length, 1);
  assert.equal(t.fixed[0].file, 'src/d.ts');
  assert.equal(t.counts.fixed, 1);
});

test('un hallazgo nunca visto es NEW, no REGRESSED', () => {
  const t = transiciones([f('src/n.ts', 'n', 'defecto nuevo nuevo')], { previas: [], historia: new Set() });
  assert.equal(t.findings[0].status, 'NEW');
});

// ── convergencia ─────────────────────────────────────────────────────────────

test('CONVERGED cuando la ultima ronda no deja bloqueantes', () => {
  const A = f('src/a.ts', 'x', 'defecto alfa alfa');
  const r = convergencia([[A, f('src/b.ts', 'y', 'defecto beta beta')], [A], []]);
  assert.equal(r.status, 'CONVERGED');
  assert.equal(r.progress.last, 0);
});

test('CONVERGING cuando el problema se reduce de verdad', () => {
  const A = f('src/a.ts', 'x', 'defecto alfa alfa');
  const B = f('src/b.ts', 'y', 'defecto beta beta');
  const r = convergencia([[A, B], [A]]);
  assert.equal(r.status, 'CONVERGING');
  assert.equal(r.progress.net, 1);
});

test('OSCILLATING: la secuencia del ciclo, provocada a proposito', () => {
  // R1: A B   R2: B C   R3: A C   R4: B A
  // A se va en R2 y vuelve en R3; B se va en R3 y vuelve en R4. Eso NO es
  // «rework 4»: es un ciclo, y una ronda mas da mas ciclo.
  const A = f('src/a.ts', 'a', 'defecto alfa alfa');
  const B = f('src/b.ts', 'b', 'defecto beta beta');
  const C = f('src/c.ts', 'c', 'defecto gamma gamma');
  const r = convergencia([[A, B], [B, C], [A, C], [B, A]]);

  assert.equal(r.status, 'OSCILLATING');
  assert.equal(r.reappeared.length, 2, 'A y B reaparecen tras un hueco');
  assert.ok(r.reappeared.includes(fingerprint(A)));
  assert.ok(r.reappeared.includes(fingerprint(B)));
});

test('DISPLACING: se cierra uno, se abre otro, y el total no baja', () => {
  const r = convergencia([
    [f('src/a.ts', 'a', 'defecto alfa alfa')],
    [f('src/b.ts', 'b', 'defecto beta beta')],
  ]);
  assert.equal(r.status, 'DISPLACING');
  assert.equal(r.progress.fixed, 1);
  assert.equal(r.progress.net, 0, 'uno menos y uno mas es cero, no progreso');
});

test('el desplazamiento DENTRO del mismo simbolo queda registrado', () => {
  const r = convergencia([
    [f('src/a.ts', 'fmt', 'el indice negativo devuelve undefined')],
    [f('src/a.ts', 'fmt', 'la asercion resulta tautologica siempre')],
  ]);
  assert.deepEqual(r.displaced, ['src/a.ts|fmt'], 'mismo simbolo, otro claim: se movio, no se cerro');
});

test('sin rondas no se inventa un veredicto', () => {
  assert.equal(convergencia([]).status, 'UNKNOWN');
  assert.equal(convergencia(null).status, 'UNKNOWN');
});

// ── el aviso ─────────────────────────────────────────────────────────────────

test('el aviso nombra lo que no es nuevo, y calla cuando todo lo es', () => {
  assert.equal(avisoDeCicloDeVida([{ file: 'a', symbol: 'b', status: 'NEW' }]), '');
  const t = avisoDeCicloDeVida([
    { file: 'src/a.ts', symbol: 'x', status: 'REGRESSED' },
    { file: 'src/b.ts', symbol: 'y', status: 'CARRIED' },
  ]);
  assert.match(t, /REGRESSED: src\/a\.ts:x/);
  assert.match(t, /CARRIED: src\/b\.ts:y/);
});

test('un veredicto que se invierte sobre el MISMO claim no es un hallazgo resuelto', () => {
  // MEDIDO en H-20260824-fa058d63 (h-007) con la refutacion DEGRADADA:
  //   ronda 1  P1 CONFIRMED · P2 CONFIRMED · P3 CONFIRMED
  //   ronda 2  P1 REFUTED   · P2 REFUTED   · P3 REFUTED
  // Claims identicos byte a byte, mismos ficheros cambiados. Tres de tres. La
  // vuelta convergio con eso y salio PASSED.
  //
  // `convergencia()` no puede verlo: solo recibe BLOQUEANTES, y un hallazgo que
  // se va porque lo arreglaron y uno que se va porque cambio el voto bajan igual.
  const r1 = [
    { file: 'a.tsx', symbol: 's', claim: 'el arbol final contiene una modificacion', verdict: 'CONFIRMED' },
    { file: 'gate.sh', symbol: 'g', claim: 'el incremento no corresponde', verdict: 'CONFIRMED' },
  ];
  const r2 = [
    { file: 'a.tsx', symbol: 's', claim: 'el arbol final contiene una modificacion', verdict: 'REFUTED' },
    { file: 'gate.sh', symbol: 'g', claim: 'el incremento no corresponde', verdict: 'REFUTED' },
  ];
  const inest = veredictosInestables([r1, r2]);
  assert.equal(inest.length, 2, 'los dos cambiaron de veredicto sobre el mismo claim');
  assert.deepEqual(inest[0].votos, ['r1:CONFIRMED', 'r2:REFUTED']);
  assert.match(inest[0].claim, /modificacion/);

  // Un veredicto ESTABLE no es inestable, aunque aparezca en las dos rondas.
  assert.deepEqual(veredictosInestables([[r1[0]], [r1[0]]]), []);

  // Un hallazgo de una sola ronda no puede ser inestable: no hay con que comparar.
  assert.deepEqual(veredictosInestables([r1]), []);

  // Y un claim DISTINTO cambia el fingerprint: eso es desplazamiento, no inversion.
  const otro = { ...r1[0], claim: 'otra cosa completamente', verdict: 'REFUTED' };
  assert.deepEqual(veredictosInestables([[r1[0]], [otro]]), []);

  // EL CABLEADO. Escribi este detector y NADIE LO LLAMABA: existia, pasaba sus
  // tests y no detectaba nada. «El fix que no existe», cometido por mi el mismo
  // dia en que lo estaba cerrando en otros sitios.
  //
  // Y donde se cablea importa: `ctx.rondas` lleva BLOQUEANTES, y un hallazgo
  // REFUTADO no es bloqueante -- mirar ahi no puede ver una inversion, justamente
  // porque invertirla lo saca de esa lista. Por eso va sobre `crudosPorRonda`.
  const det = readFileSync(new URL('./stages-deterministic.mjs', import.meta.url), 'utf8');
  assert.match(det, /unstableVerdicts: veredictosInestables\(ctx\.crudosPorRonda\)/,
    'Convergence no publica los veredictos inestables: el detector no detecta nada');
  assert.match(det, /ctx\.crudosPorRonda = \[\.\.\.\(ctx\.crudosPorRonda \?\? \[\]\), crudos\]/,
    'no se acumulan los crudos por ronda: con solo bloqueantes la inversion es invisible');
});
