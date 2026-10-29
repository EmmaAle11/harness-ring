// EL ESCRITOR DE MEMORIA — el unico que puede dejar huella en memory/.
//
// Learning decide (PROMOTE | REJECT | REVIEW) y NUNCA escribe: eso es correcto y
// se queda asi. Pero el escritor no existia, y sin el la cadena se corta en el
// ultimo paso:
//
//   Evidence -> capture -> classify -> promote -> [NADIE] -> memory/
//
// El anillo decidia que un aprendizaje merecia guardarse y lo dejaba en
// `.harness/learning/<id>.json`, donde ninguna vuelta posterior lo leia: la
// vuelta N+1 arranca leyendo `memory/`, no `.harness/`. Asi que el anillo
// "aprendia" y volvia a proponer el mismo candidato cada vuelta.
//
// LO QUE ESTE MODULO NO HACE, A PROPOSITO:
//   - no decide: recibe el veredicto ya tomado por promote()
//   - no escribe REVIEW ni REJECT en memory/: solo PROMOTE
//   - no inventa un mecanismo: si no hay guarda, lo DECLARA
//
// El ultimo punto es el que mas importa. `memoria-mecanismo.mjs` exige que toda
// entrada `active` declare `mecanismo:`. Un escritor que omita el campo mete
// entradas que rompen su propia puerta; uno que invente "cubierto por tests"
// miente en el corpus que la vuelta siguiente lee como premisa. Declarar
// NINGUNO AUTOMATICO es lo unico honesto que una maquina puede escribir ahi.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { rutaDe, cuerpoDe, escribir, ESTADO_POR_TIPO, MECANISMO_SIN_GUARDA } from './memoria-escritor.mjs';
import { frontmatter, ESTADOS, EXIGEN_MECANISMO, auditar } from './memoria-mecanismo.mjs';

const POLICY = {
  version: 1,
  excluded: ['AGENT_BEHAVIOR', 'USER_PREFERENCE', 'EPHEMERAL_SESSION_CONTEXT'],
  maxConfidence: 0.9,
  confidenceByRuns: { 1: 0.5, 2: 0.75, 3: 0.9 },
  types: {
    FAILURE: { autoPromote: true, minConfidence: 0.75, dir: 'memory/failures' },
    VALIDATION: { autoPromote: true, minConfidence: 0.75, dir: 'memory/validations' },
    CODING_PATTERN: { autoPromote: true, minConfidence: 0.9, dir: 'memory/patterns' },
    ARCHITECTURE_DECISION: { autoPromote: false, minConfidence: 0.9, dir: 'memory/decisions' },
  },
};

const candidato = (over = {}) => ({
  type: 'FAILURE',
  key: 'la-etapa-build-fallo-por-oom',
  candidate: "la etapa 'build' fallo: OOM al cargar dos modelos de 13 GB",
  confidence: 0.75,
  repeatable: true,
  novel: true,
  contradiction: false,
  evidence: ['run-001', 'run-002'],
  paths: [],
  worthKeeping: true,
  decision: { verdict: 'PROMOTE', reason: 'FAILURE con confianza 0.75', dir: 'memory/failures' },
  provenance: {
    origin: 'harness', execution_id: 'run-002', evidence: ['run-001', 'run-002'],
    date: '2026-10-29', agent: 'trigger', model: 'deepseek-v4-pro',
    confidence: 0.75, promoted_by: 'trigger',
  },
  ...over,
});

const raizTmp = () => mkdtempSync(join(tmpdir(), 'mem-escritor-'));

// ── rutaDe ──────────────────────────────────────────────────────────────────

test('la ruta sale de la POLITICA, no del tipo hardcodeado', () => {
  const r = rutaDe(candidato(), POLICY, '/R');
  assert.equal(r, '/R/memory/failures/la-etapa-build-fallo-por-oom.md');
});

test('un tipo sin dir en la politica no se escribe en una ruta inventada', () => {
  assert.throws(
    () => rutaDe(candidato({ type: 'DESCONOCIDO', decision: { verdict: 'PROMOTE' } }), POLICY, '/R'),
    /sin dir declarado/,
  );
});

test('la clave se usa como nombre de fichero y no puede escapar del directorio', () => {
  for (const malo of ['../../etc/passwd', '/absoluto', 'con/barra', '..']) {
    assert.throws(
      () => rutaDe(candidato({ key: malo }), POLICY, '/R'),
      /clave no utilizable/,
      `la clave ${JSON.stringify(malo)} debe rechazarse: escribir fuera de memory/ es escritura arbitraria`,
    );
  }
});

// ── cuerpoDe ────────────────────────────────────────────────────────────────

test('el cuerpo lleva frontmatter que SATISFACE a memoria-mecanismo', () => {
  const texto = cuerpoDe(candidato(), POLICY);
  const fm = frontmatter(texto);

  assert.ok(ESTADOS.has(fm.status), `status '${fm.status}' debe estar en el vocabulario cerrado`);
  if (EXIGEN_MECANISMO.has(fm.status)) {
    assert.ok(fm.mecanismo, 'una entrada active SIN mecanismo rompe el propio gate del repo');
  }
  assert.equal(fm.type, 'FAILURE');
  assert.equal(fm.origin, 'harness');
});

test('NO inventa un mecanismo: cuando no hay guarda, lo declara', () => {
  const fm = frontmatter(cuerpoDe(candidato(), POLICY));
  assert.equal(fm.mecanismo, MECANISMO_SIN_GUARDA);
  assert.match(fm.mecanismo, /NINGUNO AUTOMATICO/,
    'un mecanismo inventado envenena el corpus que la vuelta siguiente lee como premisa');
});

test('si el candidato TRAE una guarda verificada, se escribe esa y no la declaracion', () => {
  const fm = frontmatter(cuerpoDe(candidato({ mecanismo: 'lib/sandbox.test.mjs' }), POLICY));
  assert.equal(fm.mecanismo, 'lib/sandbox.test.mjs');
});

test('la PROVENANCE viaja entera: sin origen una entrada no se puede revisar ni retirar', () => {
  const texto = cuerpoDe(candidato(), POLICY);
  const fm = frontmatter(texto);
  assert.equal(fm.execution_id, 'run-002');
  assert.equal(fm.confidence, '0.75');
  assert.equal(fm.promoted_by, 'trigger');
  assert.match(texto, /run-001/, 'las corridas que lo sostienen deben quedar citadas');
});

test('VALIDATION no es active: es una capacidad demostrada', () => {
  const fm = frontmatter(cuerpoDe(candidato({
    type: 'VALIDATION', decision: { verdict: 'PROMOTE', dir: 'memory/validations' },
  }), POLICY));
  assert.equal(fm.status, ESTADO_POR_TIPO.VALIDATION);
  assert.equal(fm.status, 'demonstrated');
});

test('el enunciado se escribe tal cual, sin reinterpretarlo', () => {
  const c = candidato();
  assert.match(cuerpoDe(c, POLICY), new RegExp(c.candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

// ── escribir ────────────────────────────────────────────────────────────────

test('PROMOTE escribe el fichero', () => {
  const R = raizTmp();
  const r = escribir([candidato()], POLICY, { raiz: R });
  assert.equal(r.escritos.length, 1);
  assert.ok(existsSync(r.escritos[0].path));
});

test('REJECT y REVIEW NO escriben en memory/ — ese es el filtro entero', () => {
  const R = raizTmp();
  const r = escribir([
    candidato({ decision: { verdict: 'REJECT', reason: 'ya existe' } }),
    candidato({ key: 'otra', decision: { verdict: 'REVIEW', reason: 'un ADR necesita criterio' } }),
  ], POLICY, { raiz: R });

  assert.equal(r.escritos.length, 0);
  assert.equal(r.omitidos.length, 2);
  assert.ok(!existsSync(join(R, 'memory')), 'ni siquiera debe crear el arbol si no hay nada que promover');
});

test('un veredicto que no es ninguno de los tres NO se trata como PROMOTE', () => {
  const R = raizTmp();
  const r = escribir([candidato({ decision: { verdict: 'QUIZA' } })], POLICY, { raiz: R });
  assert.equal(r.escritos.length, 0, 'fallar ABIERTO aqui es escribir memoria no decidida');
});

test('NO sobreescribe una entrada existente: eso seria reescribir la memoria', () => {
  const R = raizTmp();
  const c = candidato();
  escribir([c], POLICY, { raiz: R });
  const antes = readFileSync(rutaDe(c, POLICY, R), 'utf8');

  const r2 = escribir([{ ...c, candidate: 'TEXTO DISTINTO QUE NO DEBE PISAR' }], POLICY, { raiz: R });

  assert.equal(r2.escritos.length, 0);
  assert.equal(r2.omitidos[0].motivo, 'ya existe');
  assert.equal(readFileSync(rutaDe(c, POLICY, R), 'utf8'), antes, 'el fichero en disco no cambio');
});

test('la clase EXCLUIDA por el repo no entra aunque venga con PROMOTE', () => {
  const R = raizTmp();
  const r = escribir([candidato({
    type: 'USER_PREFERENCE',
    decision: { verdict: 'PROMOTE', dir: 'memory/patterns' },
  })], POLICY, { raiz: R });
  assert.equal(r.escritos.length, 0);
  assert.match(r.omitidos[0].motivo, /excluida/);
});

test('seco (dry) decide y reporta sin tocar el disco', () => {
  const R = raizTmp();
  const r = escribir([candidato()], POLICY, { raiz: R, seco: true });
  assert.equal(r.escritos.length, 1, 'reporta lo que HARIA');
  assert.ok(!existsSync(r.escritos[0].path), 'pero no lo escribe');
});

// ── el contrato que cierra el circulo ───────────────────────────────────────

test('CIERRA EL CIRCULO: lo escrito es leible como memoria vigente', () => {
  const R = raizTmp();
  escribir([candidato()], POLICY, { raiz: R });

  // Lo que `stages.leerMemoriaVigente()` necesita para que `novel` signifique algo.
  const dir = join(R, 'memory', 'failures');
  const f = readdirSync(dir).find((x) => x.endsWith('.md'));
  const fm = frontmatter(readFileSync(join(dir, f), 'utf8'));

  assert.ok(fm.title, 'sin title, la vuelta N+1 no puede saber que esto ya se aprendio');
  assert.equal(fm.title, candidato().candidate);
});

test('NO ROMPE SU PROPIA PUERTA: lo escrito pasa la auditoria de mecanismo', () => {
  const R = raizTmp();
  escribir([
    candidato(),
    candidato({ key: 'otra-leccion', type: 'VALIDATION', decision: { verdict: 'PROMOTE', dir: 'memory/validations' } }),
  ], POLICY, { raiz: R });

  const a = auditar(join(R, 'memory'));
  assert.equal(a.sinMecanismo.length, 0, `estas entradas subirian el techo del gate: ${a.sinMecanismo}`);
  assert.equal(a.estadosRaros.length, 0, `status fuera del vocabulario: ${JSON.stringify(a.estadosRaros)}`);
  assert.equal(a.total, 2);
});

test('la escritura es IDEMPOTENTE sobre la serie: dos vueltas iguales no duplican', () => {
  const R = raizTmp();
  const uno = escribir([candidato()], POLICY, { raiz: R });
  const dos = escribir([candidato()], POLICY, { raiz: R });
  assert.equal(uno.escritos.length, 1);
  assert.equal(dos.escritos.length, 0);
  assert.equal(readdirSync(join(R, 'memory', 'failures')).length, 1);
});

test('los secretos no llegan al corpus', () => {
  const R = raizTmp();
  const r = escribir([candidato({
    candidate: 'el despliegue fallo con DEEPSEEK_API_KEY=sk-abc123def456ghi789jkl012mno345pqr',
  })], POLICY, { raiz: R });
  const texto = readFileSync(r.escritos[0].path, 'utf8');
  assert.ok(!texto.includes('sk-abc123def456ghi789jkl012mno345pqr'),
    'memory/ se versiona: un secreto aqui queda en el historial para siempre');
});
