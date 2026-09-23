#!/usr/bin/env node
/**
 * ETIQUETA EL HISTORICO — el conjunto sale de lo que ya se corrio.
 *
 * Lee cada `.harness/runs/<id>/trace.json`, lo pasa por el clasificador y emite
 * una fila por vuelta. No vuelve a correr nada: las 28 vueltas del histórico se
 * etiquetan con lo que ya escribieron.
 *
 * Las vueltas SIN `trace.json` se cuentan aparte y NO se descartan en silencio:
 * `main` ya lo dejo escrito — «no son vueltas fallidas: son vueltas que no se
 * pueden juzgar, y eso tambien es el dato».
 *
 * USO:  node harness/bin/etiquetar-historico.mjs [--json] [--csv]
 */
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { veredicto, determinismo, CODIGOS } from '../lib/reason-code.mjs';

const RAIZ = new URL('../../', import.meta.url).pathname;
const BASE = join(RAIZ, '.harness/runs');

const filas = [];
const sinTraza = [];
for (const id of readdirSync(BASE).sort()) {
  const t = join(BASE, id, 'trace.json');
  if (!existsSync(t)) { sinTraza.push(id); continue; }
  try {
    filas.push({ ...veredicto(JSON.parse(readFileSync(t, 'utf8'))), executionId: id });
  } catch (e) {
    sinTraza.push(`${id} (traza ilegible: ${e.message})`);
  }
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ filas, sinTraza, determinismo: determinismo(filas) }, null, 2));
} else if (process.argv.includes('--csv')) {
  console.log('executionId,verdict,reason_code,culpa,etapa,etapasRecorridas');
  for (const f of filas) {
    console.log([f.executionId, f.verdict, f.reason_code, f.culpa ?? '', f.etapa ?? '', f.etapasRecorridas].join(','));
  }
} else {
  const porCodigo = new Map();
  const porCulpa = new Map();
  for (const f of filas) {
    porCodigo.set(f.reason_code, (porCodigo.get(f.reason_code) ?? 0) + 1);
    const c = f.culpa ?? (f.verdict === 'PASSED' ? '(exito)' : '(sin culpa)');
    porCulpa.set(c, (porCulpa.get(c) ?? 0) + 1);
  }
  console.log(`${filas.length} vueltas etiquetadas · ${sinTraza.length} sin traza (NO se pueden juzgar)\n`);
  console.log('por reason_code:');
  for (const [k, v] of [...porCodigo].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(v).padStart(3)}  ${k.padEnd(26)} ${CODIGOS[k]?.desc ?? ''}`);
  }
  console.log('\npor culpa:');
  for (const [k, v] of [...porCulpa].sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(3)}  ${k}`);
  if (sinTraza.length) console.log(`\nsin traza: ${sinTraza.join(', ')}`);
}
