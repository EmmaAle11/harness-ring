// LO QUE EL ROUTER PROMETE Y EL CATALOGO NO SABE RAZONAR.
//
// El 2026-08-27 se dio de alta `gemini` como tercera familia: adaptador escrito,
// `doctor` diciendo VIVO con 39 modelos, y entrada en `review.prefer`. Todo
// verde. La vuelta del anillo siguio parando igual:
//
//   gemini:gemini-2.5-pro (catalog: no existe en el catalogo:
//                          no se puede razonar sobre sus capacidades)
//
// Faltaban las fichas POR MODELO en `catalog.models` -- se habian anadido las del
// PROVEEDOR y la familia, que son otra cosa. Tres sitios donde dar de alta un
// modelo y sólo dos comprobados: la clase de `una-autoridad-por-hecho` cuando la
// autoridad esta repartida y nadie cruza las piezas.
//
// Coste de no tenerlo: una corrida entera del anillo para descubrirlo, y el
// diagnostico solo estaba en el `reason` de la etapa 5. Coste de tenerlo: 4 ms.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './capabilities.mjs';
import { PROVIDERS } from '../adapters/models/index.mjs';

const leer = (f) => JSON.parse(readFileSync(join(ROOT, 'harness', 'policy', f), 'utf8'));

test('todo modelo que el router prefiere existe en el catalogo', () => {
  const router = leer('router.json');
  const catalog = leer('catalog.json');
  const enCatalogo = new Set(catalog.models.map((m) => `${m.provider}:${m.model_id}`));

  const huerfanos = Object.entries(router.classes ?? {}).flatMap(([clase, c]) =>
    (c.prefer ?? [])
      .map((p) => `${p.provider}:${p.model}`)
      .filter((id) => !enCatalogo.has(id))
      .map((id) => `${clase} prefiere ${id}`));

  assert.deepEqual(huerfanos, [],
    'el router lo promete y el catalogo no lo conoce, asi que Compute lo RECHAZA en silencio '
    + 'hasta que alguien lee el `reason` de la etapa 5:\n  ' + huerfanos.join('\n  '));
});

test('todo proveedor del catalogo declara su familia', () => {
  const catalog = leer('catalog.json');
  const sinFamilia = [...new Set(catalog.models.map((m) => m.provider))]
    .filter((p) => !catalog.providerFamily?.[p]);
  // Sin familia, ADR-003 no se puede evaluar: dos modelos sin nombre de familia
  // parecen la MISMA, y la diversidad se cae sin decirlo.
  assert.deepEqual(sinFamilia, [], `sin entrada en providerFamily: ${sinFamilia.join(', ')}`);
});

test('todo proveedor que el router declara vivo tiene adaptador', () => {
  const router = leer('router.json');
  // `expected-available` es una PROMESA del fichero; el adaptador es lo que la
  // cumple. Declarado != cableado, y esa distincion es la que evita un mecanismo
  // que parece existir y no existe.
  const prometidos = Object.entries(router.providers ?? {})
    .filter(([, p]) => p.status === 'expected-available')
    .map(([id]) => id);
  const sinAdaptador = prometidos.filter((id) => !PROVIDERS[id]);
  assert.deepEqual(sinAdaptador, [],
    `el router los da por disponibles y no tienen adaptador: ${sinAdaptador.join(', ')}`);
});
