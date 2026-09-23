/**
 * EL GUARDA QUE FALTABA LAS DOS VECES.
 *
 * El caso que lo motiva es REAL y esta pineado: el 2026-09-15 el `prefer` de
 * `read`, `plan` y `review` pedia `deepseek-v4-flash` y la API servia
 * `deepseek-flash`. El fixture reproduce ese estado exacto.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fantasmas, resumen, modelosPedidos, modelosDeclarados } from './catalogo-vivo.mjs';

const ROOT = new URL('../../', import.meta.url).pathname;
const ROUTER = JSON.parse(readFileSync(`${ROOT}harness/policy/router.json`, 'utf8'));
const CATALOG = JSON.parse(readFileSync(`${ROOT}harness/policy/catalog.json`, 'utf8'));

// Lo que la API de DeepSeek devolvio el 2026-09-15 a GET /models.
const SERVIDOS_HOY = { deepseek: ['deepseek-v4-pro', 'deepseek-flash'] };

test('EL ARBOL DE HOY no pide ningun modelo fantasma de deepseek', () => {
  const r = fantasmas(ROUTER, CATALOG, SERVIDOS_HOY);
  assert.deepEqual(r.fantasmas, [], `fantasmas:\n  ${resumen(r).join('\n  ')}`);
});

test('reproduce el defecto del 15-sep: v4-flash pedido, flash servido', () => {
  const router = {
    classes: {
      read: { prefer: [{ provider: 'deepseek', model: 'deepseek-v4-flash' }] },
      review: { prefer: [
        { provider: 'deepseek', model: 'deepseek-v4-pro' },
        { provider: 'deepseek', model: 'deepseek-v4-flash' },
      ] },
    },
  };
  const r = fantasmas(router, CATALOG, SERVIDOS_HOY);
  assert.equal(r.ok, false);
  assert.equal(r.fantasmas.length, 1, 'un id muerto, aunque lo pidan dos clases');
  assert.deepEqual(r.fantasmas[0].clases, ['read', 'review']);
});

test('lo pedido por `review` se marca CRITICO: es la unica red de ADR-003', () => {
  const router = { classes: { review: { prefer: [{ provider: 'deepseek', model: 'muerto' }] } } };
  assert.equal(fantasmas(router, CATALOG, SERVIDOS_HOY).fantasmas[0].critico, true);
});

test('un fantasma DECLARADO en el catalogo se dice: la mentira esta en dos sitios', () => {
  const router = { classes: { read: { prefer: [{ provider: 'deepseek', model: 'deepseek-flash' }] } } };
  const r = fantasmas(router, CATALOG, { deepseek: ['deepseek-v4-pro'] });
  assert.equal(r.fantasmas[0].enCatalogo, true, 'catalog.json lo declara con sus capacidades');
});

test('un proveedor que no se pudo consultar NO cuenta como aprobado', () => {
  // el-instrumento-que-confunde-error-con-vacio: sin respuesta no hay veredicto.
  const router = { classes: { read: { prefer: [{ provider: 'gemini', model: 'lo-que-sea' }] } } };
  const r = fantasmas(router, CATALOG, {});
  assert.deepEqual(r.fantasmas, []);
  assert.deepEqual(r.noComprobados, ['gemini']);
  assert.match(resumen(r).join(), /NO COMPROBADOS \(no es un aprobado\)/);
});

test('los CLI no enumeran y no se juzgan: claude no aparece como fantasma', () => {
  const r = fantasmas(ROUTER, CATALOG, SERVIDOS_HOY);
  assert.ok(r.noComprobados.includes('claude'), 'claude es un CLI: no se le pregunta /models');
  assert.ok(!r.fantasmas.some((f) => f.provider === 'claude'));
});

test('modelosPedidos agrupa por proveedor y recuerda QUE clase lo pide', () => {
  const m = modelosPedidos(ROUTER);
  assert.ok(m.deepseek.has('deepseek-v4-pro'));
  assert.ok(m.deepseek.get('deepseek-v4-pro').includes('review'));
});

test('modelosDeclarados lee el catalogo real', () => {
  const d = modelosDeclarados(CATALOG);
  assert.ok(d.deepseek.has('deepseek-v4-pro'));
  assert.ok(d.deepseek.has('deepseek-flash'), 'el catalogo se corrigio el 15-sep');
  assert.ok(!d.deepseek.has('deepseek-v4-flash'), 'el id muerto no puede seguir declarado');
});
