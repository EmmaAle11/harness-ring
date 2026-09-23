import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// `memory/README.md` prohibe datos personales --«rutas de una maquina, correos, RFC, nombres»-- y
// hasta hoy NADA lo comprobaba: la regla vivia en prosa y se rompio. El 2026-09-03 `third` encontro
// un RFC completo en el cuerpo de una entrada, versionado y empujado a tres ramas.
// El barrido de secretos de la puerta no lo cubre: busca claves de proveedor, no PII de clientes.
const RAIZ = new URL('../../../', import.meta.url).pathname;

// Un RFC de persona moral son 3 letras + 6 digitos de fecha + 3 de homoclave; el de persona fisica, 4.
const RFC = /\b[A-ZÑ&]{3,4}[0-9]{6}[A-Z0-9]{3}\b/g;
const CORREO = /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g;
// Alias de import del repo (`@aafa/…`) y el correo de atribucion no son PII.
const CORREO_OK = /^@|noreply@|example\.(com|org)$/;

export const barrer = (texto) => {
  const hallazgos = [];
  for (const m of texto.match(RFC) ?? []) hallazgos.push(`RFC: ${m.slice(0, 3)}…`);
  for (const m of texto.match(CORREO) ?? []) {
    if (!CORREO_OK.test(m)) hallazgos.push(`correo: ${m.split('@')[0].slice(0, 2)}…@…`);
  }
  return hallazgos;
};

// PEREZOSO: este barrido recorria `memory/` al CARGAR el modulo, asi que el
// fichero entero moria donde ese directorio no existe. Los 5 casos no fallaban:
// no se ejecutaban, y la corrida agregada ni los contaba.
const listarFicheros = () => {
  const acc = [];
  (function walk(dir) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const r = join(dir, e.name);
      if (e.isDirectory()) walk(r);
      else if (e.name.endsWith('.md')) acc.push(r);
    }
  })(join(RAIZ, 'memory'));
  return acc;
};

test('hay entradas de memoria que barrer', () => {
  assert.ok(listarFicheros().length > 100, `solo ${listarFicheros().length} listarFicheros(): el barrido no esta mirando memory/`);
});

test('ninguna entrada de memory/ contiene RFC ni correos de clientes', () => {
  const malas = listarFicheros()
    .map((f) => [f.slice(RAIZ.length), barrer(readFileSync(f, 'utf8'))])
    .filter(([, h]) => h.length);
  assert.deepEqual(malas, [],
    `memory/README.md prohibe datos personales. Redacta conservando la trazabilidad:\n` +
    malas.map(([f, h]) => `  ${f}: ${h.join(', ')}`).join('\n'));
});

test('el barrido DETECTA lo que prohibe (si no, el verde de arriba no dice nada)', () => {
  // Control positivo: sin esto, un regex roto daria cero hallazgos y pareceria limpieza.
  assert.match(barrer('El expediente ZZZ900101000 emitia cartas').join(), /RFC/);
  assert.match(barrer('escribio a juan.perez@cliente.com.mx ayer').join(), /correo/);
});

test('no marca lo que NO es PII: alias de import y el correo de atribucion', () => {
  assert.deepEqual(barrer("import x from '@aafa/carta-modelos';"), []);
  assert.deepEqual(barrer('Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>'), []);
});

test('el hallazgo se reporta TRUNCADO: el guarda no puede filtrar lo que persigue', () => {
  const h = barrer('ZZZ900101000');
  // `barrer` conserva los TRES primeros caracteres del RFC y trunca el resto, asi
  // que el prefijo del hallazgo lo fija el input. La asercion pedia `ASK…` sobre
  // una entrada que empieza por `ZZZ`: comprobaba un valor que ninguna llamada de
  // este test podia producir. Se fija lo que el test existe para fijar --que el
  // RFC no se reimprima entero-- contra el input que realmente se le pasa.
  assert.match(h[0], /^RFC: ZZZ…$/);
  assert.ok(!h.join().includes('900101000'), 'el mensaje del test reimprimiria el RFC en el log de CI');
});
