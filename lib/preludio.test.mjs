import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { preludio, LENTES, POR_CLASE, METODO } from '../policy/preludio.mjs';

const RAIZ = new URL('../../', import.meta.url).pathname;
const cap = (n) => readFileSync(`${RAIZ}harness/capabilities/${n}.md`, 'utf8');

test('EL HUECO que motiva esto: el builder no tiene ningun lente propio', () => {
  // Medido el 2026-09-17. Si alguien mete los lentes en builder.md, este test
  // falla y hay que decidir cual es la autoridad -- no puede haber dos.
  const t = cap('builder');
  for (const s of ['ACID', 'Zero Trust', 'CTQ', 'BPM', 'AMEF']) {
    assert.ok(!t.includes(s), `builder.md ya menciona ${s}: hay dos autoridades`);
  }
});

test('el reviewer SI los tiene: el preludio no los duplica, los adelanta', () => {
  const t = cap('reviewer');
  for (const s of ['ACID', 'CIA', 'Zero Trust', 'CTQ', 'BPM', 'AMEF']) assert.ok(t.includes(s));
});

test('`edit` recibe los lentes de integridad y de seguridad', () => {
  const p = preludio('edit', { capacidad: 'builder' });
  for (const s of ['ACID', 'CIA', 'Zero Trust', 'YAGNI']) {
    assert.ok(p.includes(s), `falta ${s} en el preludio de edit`);
  }
  assert.ok(p.includes('builder'), 'nombra la capacidad');
  assert.ok(p.includes('ADR-003'), 'dice quien le va a revisar y por que');
});

test('`read` NO carga los doce: el contexto que se infla es el que se ignora', () => {
  const p = preludio('read');
  assert.ok(!p.includes('AMEF'), 'inventariar no necesita analisis de modos de falla');
  assert.ok(!p.includes('ACID'));
  assert.ok(p.includes('Funcional'));
  assert.ok(p.length < preludio('edit').length);
});

test('`review` carga TODOS los lentes declarados', () => {
  assert.equal(POR_CLASE.review.length, Object.keys(LENTES).length);
});

test('una clase desconocida devuelve cadena vacia, no un encabezado hueco', () => {
  // Un titulo sin contenido gasta contexto y no dice nada.
  assert.equal(preludio('no-existe'), '');
  assert.equal(preludio(null), '');
  assert.equal(preludio(undefined), '');
});

test('los lentes se piden como PREGUNTA, no como sigla', () => {
  // «Aplica ACID» no cambia una linea; «¿que pasa si falla a la mitad?» si.
  assert.match(LENTES.acid, /falla a la mitad/i);
  assert.match(LENTES.zeroTrust, /NUNCA confies en la variable que controla el atacado/);
  assert.match(LENTES.arquitectonico, /el codigo que no existe no falla/);
});

test('el METODO incluye las cuatro reglas que este repo ya pago', () => {
  const t = METODO.join('\n');
  assert.match(t, /MIDE ANTES DE AFIRMAR/);
  assert.match(t, /LA AUTORIDAD NO ES LA PROSA/);
  assert.match(t, /NO PUDE MIRAR NO ES ESTA BIEN/);
  assert.match(t, /PARAR ES UN RESULTADO VALIDO/);
});

test('PARAR ES UN RESULTADO VALIDO describe lo que el builder ya hizo bien', () => {
  // h-008: el builder midio, vio que la spec no se sostenia y se nego. Esa
  // conducta vale reforzarla en el primer contexto, no solo premiarla despues.
  assert.match(METODO.join(' '), /reporta que no se sostiene y por que, con la cita/);
});

test('lentes explicitos ganan a la clase', () => {
  const p = preludio('read', { lentes: ['amef'] });
  assert.ok(p.includes('AMEF'));
});

test('CABLEADO REAL: el prompt del builder ya lleva el preludio', async () => {
  // La prueba que importa: no que la funcion exista, sino que el prompt que
  // SALE hacia el modelo lo lleve. La clase la declara la propia capacidad
  // (frontmatter `model_class`), no un mapa nuevo al lado.
  const { buildPrompt } = await import('./invoke.mjs');
  const { loadCapabilities } = await import('./capabilities.mjs');
  const builder = loadCapabilities().find((c) => c.id === 'builder');
  assert.equal(builder.model_class, 'edit');

  const p = buildPrompt(builder, { stage: 'Execution', inputs: {} });
  assert.ok(p.includes('Como se juzga este trabajo'), 'el builder no recibe el preludio');
  assert.ok(p.includes('ACID') && p.includes('Zero Trust'));
  assert.ok(p.includes('MIDE ANTES DE AFIRMAR'));
  assert.ok(p.indexOf('Como se juzga') < p.indexOf('## Etapa:'), 'el preludio va ANTES de la tarea');
});

test('el researcher (`read`) no carga los lentes del que escribe', async () => {
  const { buildPrompt } = await import('./invoke.mjs');
  const { loadCapabilities } = await import('./capabilities.mjs');
  const r = loadCapabilities().find((c) => c.id === 'researcher');
  assert.equal(r.model_class, 'read');
  const p = buildPrompt(r, { stage: 'Knowledge', inputs: {} });
  assert.ok(!p.includes('- **ACID**'), 'inventariar no necesita el lente de atomicidad');
});

test('toda clave de POR_CLASE existe en LENTES', () => {
  for (const [clase, ks] of Object.entries(POR_CLASE)) {
    for (const k of ks) assert.ok(LENTES[k], `${clase} pide un lente inexistente: ${k}`);
  }
});

test('el preludio de `edit` cabe en un contexto razonable', () => {
  // Un preludio que compite en tamaño con la tarea deja de ser preludio.
  assert.ok(preludio('edit').length < 2600, 'demasiado largo para ser un preludio');
});
