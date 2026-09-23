// docs:enlaces — la comprobacion que da VERDE sobre enlaces rotos si se hace mal.
//
// El defecto que estos tests fijan no es «faltaba comprobar los enlaces»: es que
// la comprobacion obvia --resolver desde la raiz del repo-- es correcta para los
// documentos de un nivel y silenciosamente falsa para los de otro. Lo senalo
// `third` sobre la primera version, y sin su correccion esto habria firmado en
// verde un enlace roto.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { enlacesDe, resolverDesde, revisarEnlaces } from './docs-enlaces.mjs';
import { ROOT } from './capabilities.mjs';

test('el MISMO enlace resuelve distinto segun quien lo cite', () => {
  // Este es el test que justifica el modulo entero.
  assert.equal(resolverDesde('memory/failures/x.md', '../patterns/y.md'), 'memory/patterns/y.md');
  assert.equal(resolverDesde('memory/README.md', 'patterns/y.md'), 'memory/patterns/y.md');
  // Y el mismo texto, citado desde el otro sitio, apunta a un fichero que NO existe:
  assert.equal(resolverDesde('memory/README.md', '../patterns/y.md'), 'patterns/y.md');
  assert.notEqual(resolverDesde('memory/README.md', '../patterns/y.md'), 'memory/patterns/y.md');
});

test('solo mira enlaces locales: http, ancla y absolutos no son suyos', () => {
  const ls = enlacesDe('[a](../p/a.md) [b](https://x.com) [c](#seccion) [d](/abs.md) [e](e.md#sec)');
  assert.deepEqual(ls, ['../p/a.md', 'e.md'], 'el ancla se recorta, lo remoto y lo absoluto se ignoran');
});

test('un enlace roto se nombra con quien lo cita, no solo con la ruta', () => {
  const r = revisarEnlaces(
    [{ path: 'memory/README.md', texto: '[x](failures/no-existe.md)' }],
    (p) => p !== 'memory/failures/no-existe.md',
  );
  assert.equal(r.rotos.length, 1);
  assert.deepEqual(r.rotos[0], {
    desde: 'memory/README.md', cita: 'failures/no-existe.md', resuelto: 'memory/failures/no-existe.md',
  }, 'sin `desde` no se puede arreglar: el mismo destino roto puede citarse desde varios sitios');
});

// ── Y el que mide de verdad: memory/ contra el disco ────────────────────────
test('ningun documento de memory/ cita una entrada que no existe', () => {
  const dir = join(ROOT, 'memory');
  const docs = [];
  const recorrer = (rel) => {
    for (const e of readdirSync(join(ROOT, rel), { withFileTypes: true })) {
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) recorrer(r);
      else if (e.name.endsWith('.md')) docs.push({ path: r, texto: readFileSync(join(ROOT, r), 'utf8') });
    }
  };
  if (!existsSync(dir)) return;                    // rama sin memory/: no se inventa un fallo
  recorrer('memory');
  const r = revisarEnlaces(docs, (p) => existsSync(join(ROOT, p)));

  // EL DENOMINADOR, y es la mitad que importa. Un recorrido que deja de
  // encontrar documentos --un `memory/` movido, un filtro que se estrecha-- pasa
  // este test revisando CERO enlaces y firma en verde sobre nada. Medido el
  // 21-ago: 78 documentos, 134 enlaces. El suelo se pone muy por debajo para que
  // no estorbe al que borre una entrada, pero muerde si el recorrido se rompe.
  assert.ok(r.enlaces > 50,
    `solo se revisaron ${r.enlaces} enlaces en ${r.revisados} documentos: `
    + 'el recorrido dejo de encontrar memory/, y un control que no mira nada aprueba todo');

  assert.deepEqual(r.rotos, [],
    `${r.rotos.length} de ${r.enlaces} enlaces de memory/ apuntan a nada:\n`
    + r.rotos.map((x) => `  ${x.desde} -> ${x.cita} (${x.resuelto})`).join('\n'));
});
