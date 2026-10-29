import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { auditar } from '../../lib/memoria-mecanismo.mjs';

// El corpus REAL de memory/ vive en el anfitrion. Se comprueba aqui, en el adaptador
// DoxIA, para que el motor no afirme cosas sobre un arbol que no trae.
const MEMORY = fileURLToPath(new URL('../../../memory', import.meta.url));

test('el parser SIGUE CASANDO con el corpus real', (t) => {
  if (!existsSync(MEMORY)) { t.skip('sin memory/: este arbol no es el anfitrion DoxIA'); return; }
  // Sin esto, un cambio de formato daria 0 memorias, 0 hallazgos y un verde que no mira nada.
  const r = auditar(MEMORY);
  assert.ok(r.total > 100, `solo ${r.total} memorias reconocidas: el parser dejo de casar`);
  assert.ok(r.activas > 0, 'ninguna active reconocida: el parser dejo de casar');
});
