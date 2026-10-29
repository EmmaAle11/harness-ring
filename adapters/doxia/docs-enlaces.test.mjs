// El UMBRAL ABSOLUTO del corpus de memory/ — una afirmacion sobre DoxIA.
//
// `lib/docs-enlaces.test.mjs` comprueba que ningun enlace de memory/ apunta a
// nada, y que el recorrido vio todos los documentos que encontro. Eso vale en
// cualquier repo.
//
// Lo que NO vale en cualquier repo es el PISO: «mas de 50 enlaces revisados».
// Ese numero se calibro sobre el memory/ de DoxIA (78 documentos, 134 enlaces
// medidos el 21-ago-2026) y su proposito es cazar un recorrido que se rompe —
// un `memory/` movido, un filtro que se estrecha— porque un control que revisa
// cero enlaces firma en verde sobre nada.
//
// MEDIDO: al nacer `memory/` en el motor con UN documento y cero enlaces, el
// test fallaba por falta de corpus y no por estar roto. Un umbral calibrado
// sobre un arbol concreto es, por definicion, un test del adaptador.
//
// Aqui se queda, y se SALTA con motivo cuando el arbol de DoxIA no esta: ausencia
// de que comprobar y comprobacion correcta son estados distintos.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { revisarEnlaces } from '../../lib/docs-enlaces.mjs';

const RAIZ = fileURLToPath(new URL('../../', import.meta.url));

// El marcador canonico del anfitrion DoxIA, el mismo que usan los demas adapters.
const HAY_DOXIA = existsSync(join(RAIZ, 'scripts', 'gate.sh'));

/** El corpus que este test mide. Medido el 21-ago-2026: 78 documentos, 134 enlaces. */
const PISO_ENLACES = 50;

test('DoxIA: el corpus de memory/ no encoge por debajo de su piso medido', (t) => {
  if (!HAY_DOXIA) {
    return t.skip('sin el arbol de DoxIA: el piso de 50 enlaces solo describe su corpus');
  }
  const dir = join(RAIZ, 'memory');
  if (!existsSync(dir)) return t.skip('sin memory/ en el anfitrion');

  const docs = [];
  const recorrer = (rel) => {
    for (const e of readdirSync(join(RAIZ, rel), { withFileTypes: true })) {
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) recorrer(r);
      else if (e.name.endsWith('.md')) docs.push({ path: r, texto: readFileSync(join(RAIZ, r), 'utf8') });
    }
  };
  recorrer('memory');
  const r = revisarEnlaces(docs, (p) => existsSync(join(RAIZ, p)));

  assert.ok(r.enlaces > PISO_ENLACES,
    `solo se revisaron ${r.enlaces} enlaces en ${r.revisados} documentos: `
    + 'el recorrido dejo de encontrar memory/, y un control que no mira nada aprueba todo');
});
