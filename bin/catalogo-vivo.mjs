#!/usr/bin/env node
/**
 * EL GUARDA DEL CATALOGO, cableado al gate.
 *
 * `catalogo-vivo.mjs` es puro: recibe lo que el proveedor sirve. Este binario es
 * la parte SUCIA -- pregunta por red-- y traduce el resultado a un veredicto.
 *
 * DOS VECES nos mordio el mismo defecto (ver
 * memory/failures/el-modelo-preferido-dejo-de-existir-otra-vez.md): un catalogo
 * escrito a mano diverge del proveedor y nadie lo mide hasta que una vuelta se
 * queda sin revisor a mitad del anillo.
 *
 * DISTINGUE TRES COSAS, y esa es toda la gracia:
 *   FANTASMA       el proveedor respondio y ese modelo NO esta -> FAIL
 *   NO COMPROBADO  no se pudo preguntar (sin clave, sin red, CLI) -> WARN
 *   VIVO           respondio y esta -> PASS
 *
 * Un NO COMPROBADO NO es un aprobado: el repo ya tiene escrito lo que cuesta
 * confundir «no pude mirar» con «esta bien»
 * (memory/failures/el-instrumento-que-confunde-error-con-vacio.md). Por eso sale
 * WARN y nunca PASS, y por eso el `exit 0` de ese caso lleva su motivo impreso.
 *
 * Los proveedores por CLI (claude) no tienen /models: no se preguntan y no se
 * juzgan. Declararlos fantasmas seria inventar un fallo.
 *
 * USO:  node harness/bin/catalogo-vivo.mjs [--json]
 * SALE: 0 si no hay fantasmas (aunque haya no comprobados), 1 si los hay.
 */
import { readFileSync } from 'node:fs';
import { fantasmas, resumen } from '../lib/catalogo-vivo.mjs';

const RAIZ = new URL('../../', import.meta.url).pathname;
const leer = (p) => JSON.parse(readFileSync(`${RAIZ}${p}`, 'utf8'));

/**
 * Proveedores que EXPONEN un catalogo por HTTP. `claude` no esta: es un CLI.
 * `env` ausente del entorno => no se pregunta => NO COMPROBADO.
 */
const ENDPOINTS = {
  deepseek: { url: 'https://api.deepseek.com/models', env: 'DEEPSEEK_API_KEY' },
  gemini: {
    url: 'https://generativelanguage.googleapis.com/v1beta/models',
    env: 'GEMINI_API_KEY',
    query: true, // la clave va en la URL, no en Authorization
    ids: (j) => (j.models ?? []).map((m) => String(m.name).replace(/^models\//, '')),
  },
};

async function servidosDe(nombre, cfg, ms = 8000) {
  const clave = process.env[cfg.env];
  if (!clave) return { motivo: `sin ${cfg.env} en el entorno` };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const url = cfg.query ? `${cfg.url}?key=${clave}&pageSize=200` : cfg.url;
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: cfg.query ? {} : { Authorization: `Bearer ${clave}` },
    });
    if (!r.ok) return { motivo: `HTTP ${r.status}` };
    const j = await r.json();
    const ids = cfg.ids ? cfg.ids(j) : (j.data ?? []).map((m) => m.id);
    // Una lista vacia NO es «no sirve ninguno»: es una respuesta que no entendemos.
    if (!ids.length) return { motivo: 'el proveedor respondio sin modelos' };
    return { ids };
  } catch (e) {
    return { motivo: e.name === 'AbortError' ? `sin respuesta en ${ms} ms` : e.message };
  } finally {
    clearTimeout(t);
  }
}

const router = leer('harness/policy/router.json');
const catalog = leer('harness/policy/catalog.json');

const servidos = {};
const porQueNo = {};
for (const [nombre, cfg] of Object.entries(ENDPOINTS)) {
  const r = await servidosDe(nombre, cfg);
  if (r.ids) servidos[nombre] = r.ids;
  else porQueNo[nombre] = r.motivo;
}

const r = fantasmas(router, catalog, servidos);
const lineas = resumen(r);
const consultados = Object.keys(servidos);

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ ...r, consultados, porQueNo }, null, 2));
} else if (r.fantasmas.length) {
  console.log(lineas.join('\n'));
} else {
  const vistos = consultados.length ? `consultados: ${consultados.join(', ')}` : 'ninguno consultado';
  const mudos = Object.entries(porQueNo).map(([p, m]) => `${p} (${m})`);
  console.log(
    `sin fantasmas · ${vistos}`
    + (mudos.length ? ` · NO COMPROBADOS, que no es un aprobado: ${mudos.join(', ')}` : ''),
  );
}

process.exit(r.fantasmas.length ? 1 : 0);
