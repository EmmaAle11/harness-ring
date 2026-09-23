// La comprobación que distingue una memoria CON guarda de una que espera un incidente.
//
// Se prueba sobre un corpus sintético —para fijar la regla— y además sobre `memory/` de verdad,
// porque un parser de frontmatter que deja de casar devuelve cero entradas, cero hallazgos y un
// verde que no mira nada (`memory/failures/el-cableado-mide-presencia-no-ejecucion.md`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditar, frontmatter, ESTADOS } from './memoria-mecanismo.mjs';

const MEMORY = resolve(fileURLToPath(new URL('../../memory', import.meta.url)));

/** Un corpus de mentira con las entradas que se le pasen: `{ 'x.md': '---\n...' }`. */
function conCorpus(entradas, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'doxia-memoria-'));
  try {
    mkdirSync(join(dir, 'failures'), { recursive: true });
    for (const [rel, txt] of Object.entries(entradas)) writeFileSync(join(dir, rel), txt);
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const entrada = (status, extra = '') =>
  `---\nid: x\ntype: FAILURE\ntitle: T\nscope: repo\nstatus: ${status}\n${extra}---\n\ncuerpo\n`;

test('una `active` SIN mecanismo es el hallazgo', () => {
  conCorpus({ 'failures/a.md': entrada('active') }, (dir) => {
    const r = auditar(dir);
    assert.deepEqual(r.sinMecanismo, ['failures/a.md']);
    assert.equal(r.activas, 1);
  });
});

test('con mecanismo declarado, deja de serlo', () => {
  conCorpus({ 'failures/a.md': entrada('active', 'mecanismo: gate.sh etapa X\n') }, (dir) => {
    assert.deepEqual(auditar(dir).sinMecanismo, []);
  });
});

test('«ninguno, y por que» TAMBIEN cuenta: declarar no es callar', () => {
  // Es el punto entero. No todas las lecciones se pueden automatizar; lo que no vale es que no
  // se sepa cuales. Una entrada que dice «no se puede, porque X» esta cubierta.
  conCorpus({ 'failures/a.md': entrada('active', 'mecanismo: ninguno — hace falta ver cuatro ramas a la vez\n') },
    (dir) => assert.deepEqual(auditar(dir).sinMecanismo, []));
});

test('solo se le exige a `active`: las demas ya dicen lo que son', () => {
  conCorpus({
    'failures/a.md': entrada('mitigated'),
    'failures/b.md': entrada('fixed'),
    'failures/c.md': entrada('accepted'),
  }, (dir) => {
    const r = auditar(dir);
    assert.equal(r.activas, 0);
    assert.deepEqual(r.sinMecanismo, []);
  });
});

test('un `status` fuera del vocabulario se NOMBRA, no se traga', () => {
  // `fixed`, `resolved`, `closed` y `applied` dicen lo mismo. Un enum sin autoridad falla abierto.
  conCorpus({ 'failures/a.md': entrada('resolved') }, (dir) => {
    const r = auditar(dir);
    assert.equal(r.estadosRaros.length, 1);
    assert.equal(r.estadosRaros[0].status, 'resolved');
  });
});

test('el README no se audita a si mismo', () => {
  conCorpus({ 'README.md': entrada('active'), 'failures/a.md': entrada('active') }, (dir) => {
    assert.deepEqual(auditar(dir).sinMecanismo, ['failures/a.md']);
  });
});

test('un fichero sin frontmatter no cuenta como memoria rota', () => {
  conCorpus({ 'failures/a.md': '# solo un titulo\n' }, (dir) => {
    assert.equal(auditar(dir).total, 0);
  });
});

test('el comentario del ejemplo no se cuela como valor', () => {
  // El propio README trae `status: active   # active | superseded | mitigated`, y sin recortar el
  // comentario ese valor entra al vocabulario como si fuera un estado real.
  assert.equal(frontmatter('---\nstatus: active   # active | mitigated\n---\n').status, 'active');
});

test('el parser SIGUE CASANDO con el corpus real', () => {
  // Sin esto, un cambio de formato daria 0 memorias, 0 hallazgos y un verde que no mira nada.
  const r = auditar(MEMORY);
  assert.ok(r.total > 100, `solo ${r.total} memorias reconocidas: el parser dejo de casar`);
  assert.ok(r.activas > 0, 'ninguna active reconocida: el parser dejo de casar');
});

test('el vocabulario es cerrado y `active` esta dentro', () => {
  assert.ok(ESTADOS.has('active'));
  assert.ok(!ESTADOS.has('resolved'), 'si se admite `resolved`, el enum vuelve a fallar abierto');
});
