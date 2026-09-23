#!/usr/bin/env node
/**
 * EL VECTOR QUE YA EXISTIA. La etapa Plan escribe en cada vuelta
 * `changeSurface.{files, modulesTouched, domainsTouched, testsTouched}`: cuatro
 * enteros. Es el UNICO vector real del anillo -- las demas etapas emiten texto,
 * o tienen n=5 y no sostienen un estadistico (medido sobre 33 vueltas).
 *
 * Esto NO inventa dato: lee lo escrito y lo empareja con el `reason_code` de la
 * misma vuelta (harness/lib/reason-code.mjs), que es la etiqueta.
 *
 * USO: node harness/bin/vectores-plan.mjs [--json|--csv]
 */
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { veredicto } from '../lib/reason-code.mjs';

const RAIZ = new URL('../../', import.meta.url).pathname;
const BASE = join(RAIZ, '.harness/runs');
const DIMS = ['files', 'modulesTouched', 'domainsTouched', 'testsTouched'];

const filas = [];
const sinPlan = [];
for (const id of readdirSync(BASE).sort()) {
  const plan = join(BASE, id, '04-plan.json');
  const trace = join(BASE, id, 'trace.json');
  if (!existsSync(plan)) { sinPlan.push(id); continue; }
  let cs;
  let etiqueta = null;
  try {
    cs = (JSON.parse(readFileSync(plan, 'utf8')).payload ?? {}).changeSurface;
  } catch { sinPlan.push(`${id} (plan ilegible)`); continue; }
  if (!cs) { sinPlan.push(`${id} (sin changeSurface)`); continue; }
  if (existsSync(trace)) {
    try { etiqueta = veredicto(JSON.parse(readFileSync(trace, 'utf8'))); } catch { /* sin etiqueta */ }
  }
  const v = DIMS.map((d) => Number(cs[d] ?? 0));
  if (v.some((x) => !Number.isFinite(x))) { sinPlan.push(`${id} (dimension no numerica)`); continue; }
  filas.push({
    executionId: id,
    vector: v,
    reason_code: etiqueta?.reason_code ?? 'SIN_TRAZA',
    culpa: etiqueta?.culpa ?? null,
    etapasRecorridas: etiqueta?.etapasRecorridas ?? null,
  });
}

const centro = (vs) => DIMS.map((_, i) => vs.reduce((a, v) => a + v[i], 0) / vs.length);
const dist = (a, b) => Math.hypot(...a.map((x, i) => x - b[i]));

const grupos = new Map();
for (const f of filas) {
  if (!grupos.has(f.reason_code)) grupos.set(f.reason_code, []);
  grupos.get(f.reason_code).push(f.vector);
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ dims: DIMS, filas, sinPlan }, null, 2));
} else if (process.argv.includes('--csv')) {
  console.log(['executionId', ...DIMS, 'reason_code', 'culpa', 'etapas'].join(','));
  for (const f of filas) {
    console.log([f.executionId, ...f.vector, f.reason_code, f.culpa ?? '', f.etapasRecorridas ?? ''].join(','));
  }
} else {
  console.log(`${filas.length} vueltas con changeSurface · ${sinPlan.length} sin plan utilizable`);
  console.log(`dims: ${DIMS.join(', ')}\n`);
  const orden = [...grupos].sort((a, b) => b[1].length - a[1].length);
  for (const [c, vs] of orden) {
    const m = centro(vs).map((x) => x.toFixed(1));
    const aviso = vs.length < 5 ? '  <- n<5: NO decide nada' : '';
    console.log(`  ${String(vs.length).padStart(3)}  ${c.padEnd(24)} centroide [${m.join(', ')}]${aviso}`);
  }
  console.log('\nDISTANCIAS entre centroides (crudas, sin normalizar):');
  for (let i = 0; i < orden.length; i += 1) {
    for (let j = i + 1; j < orden.length; j += 1) {
      const [ca, va] = orden[i]; const [cb, vb] = orden[j];
      const d = dist(centro(va), centro(vb));
      console.log(`  ${d.toFixed(2).padStart(7)}  ${ca} <-> ${cb}`);
    }
  }
  if (sinPlan.length) console.log(`\nsin plan: ${sinPlan.join(', ')}`);
}
