// node --test harness/lib/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFrontmatter } from './frontmatter.mjs';
import { loadCapabilities } from './capabilities.mjs';

test('separa frontmatter de cuerpo', () => {
  const { data, body } = parseFrontmatter('---\nid: x\ntitle: Hola\n---\nEl prompt.\n');
  assert.equal(data.id, 'x');
  assert.equal(data.title, 'Hola');
  assert.equal(body, 'El prompt.');
});

test('lista inline y lista con guion', () => {
  const { data } = parseFrontmatter(
    '---\ntools: [Read, Edit, Bash]\nrelated:\n  - a.md\n  - b.md\n---\ncuerpo',
  );
  assert.deepEqual(data.tools, ['Read', 'Edit', 'Bash']);
  assert.deepEqual(data.related, ['a.md', 'b.md']);
});

test('lista vacia no se confunde con cadena vacia', () => {
  const { data } = parseFrontmatter('---\nwrites: []\ndenied: []\n---\nx');
  assert.deepEqual(data.writes, []);
  assert.deepEqual(data.denied, []);
});

test('booleanos se convierten; las comillas se quitan', () => {
  const { data } = parseFrontmatter("---\nenforced: true\noff: false\nq: 'con comillas'\n---\nx");
  assert.equal(data.enforced, true);
  assert.equal(data.off, false);
  assert.equal(data.q, 'con comillas');
});

test('sin frontmatter devuelve el texto entero como cuerpo', () => {
  const { data, body } = parseFrontmatter('solo texto');
  assert.deepEqual(data, {});
  assert.equal(body, 'solo texto');
});

// ── Contrato de las capacidades reales ──────────────────────────────────────────
test('las 7 capacidades cargan con los campos que el harness necesita', () => {
  const caps = loadCapabilities();
  assert.equal(caps.length, 7, 'trigger, researcher, architect, builder, reviewer, security, release');

  for (const a of caps) {
    assert.ok(a.id, `${a.source}: sin id`);
    assert.ok(a.title, `${a.id}: sin title (es la description de los adaptadores)`);
    assert.ok(a.model_class, `${a.id}: sin model_class`);
    assert.ok(a.prompt.length > 200, `${a.id}: el cuerpo ES el prompt; esta vacio o es un esbozo`);
    assert.equal(a.type, 'CAPABILITY', `${a.id}: type debe ser CAPABILITY`);
  }
});

test('solo el builder escribe codigo de produccion', () => {
  const escriben = loadCapabilities().filter((a) =>
    (a.permissions?.write ?? []).some((p) => p === 'src' || p === 'backend/src'),
  );
  assert.deepEqual(
    escriben.map((a) => a.id),
    ['builder'],
    'invariante 1: un solo escritor. Quien encuentra un defecto no lo arregla.',
  );
});

test('ninguna capacidad puede commitear, pushear ni desplegar', () => {
  for (const a of loadCapabilities()) {
    const d = (a.forbidden ?? []).join(' ');
    assert.match(d, /commit/, `${a.id}: falta prohibir 'commit' (regla #16)`);
    assert.match(d, /push/, `${a.id}: falta prohibir 'push' (regla #16)`);
  }
});
