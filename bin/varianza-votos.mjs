#!/usr/bin/env node
// ── ¿Cuanto varia el MISMO juez sobre el MISMO artefacto? ────────────────────
//
// ESTA MEDICION DECIDE LA REGLA DEL QUORUM, y el criterio queda fijado ANTES de
// ver el resultado para que el numero no se interprete a conveniencia:
//
//   rango 0     -> ESTRICTA. El umbral es estable: los cuatro >= 9 es exigible.
//   rango 1     -> MIXTA. Exigir que los CUATRO superen 9 en la MISMA corrida
//                  seria loteria: un commit legitimo caeria por un dado, y uno
//                  flojo pasaria por suerte.
//   rango >= 2  -> ese juez NO sirve como puerta. Se sustituye antes de usarlo.
//
// Es el mismo procedimiento que refuto theta=0.6 en el rho-gate: el umbral sale
// de los datos. La diferencia con aquel caso es que aqui el ruido no es del
// sistema medido sino del INSTRUMENTO -- un LLM no es determinista ni con
// temperature 0.1, y esta medicion cuantifica exactamente cuanto.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { parsearVoto } from '../lib/votacion.mjs';
import { redactarSecretos } from '../lib/secretos.mjs';

const ROOT = resolve(process.argv[2] ?? process.cwd());
const ARTEFACTO = process.argv[3];
const K = Number(process.argv[4] ?? 5);
if (!ARTEFACTO || !existsSync(ARTEFACTO)) {
  console.error('uso: node harness/bin/varianza-votos.mjs <raiz> <artefacto.md> [k=5]');
  process.exit(2);
}

const POL = JSON.parse(readFileSync(join(ROOT, 'harness/policy/votacion.json'), 'utf8'));
const EVID = readFileSync(ARTEFACTO, 'utf8');
const HASH = createHash('sha256').update(EVID).digest('hex').slice(0, 12);

const RUBRICA = `
Puntua de 0 a 10 el RIGOR DE INGENIERIA del trabajo descrito, segun:
  A. VERIFICACION  las afirmaciones se respaldan ejecutando, no razonando
  B. HONESTIDAD    los errores propios y las cifras incomodas se publican
  C. SEGURIDAD     los guardarrailes se prueban con mutacion, no se asumen
  D. DISENO        las decisiones de NO hacer algo estan justificadas con datos

NO premies el volumen de trabajo. Penaliza toda afirmacion sin medicion.

Responde EXACTAMENTE con estas tres lineas y nada mas antes de ellas:
PUNTAJE: <entero 0-10>
FORTALEZA: <una linea>
DEBILIDAD: <una linea, obligatoria>
`;

async function preguntar(modelo) {
  try {
    const r = await fetch('http://localhost:11434/api/generate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelo, prompt: EVID + '\n' + RUBRICA, stream: false,
                             options: { temperature: POL.muestreo.temperature, seed: POL.muestreo.seed,
                                        top_k: POL.muestreo.topK, top_p: POL.muestreo.topP } }),
    });
    if (!r.ok) return null;
    return parsearVoto((await r.json()).response ?? '').puntaje;
  } catch { return null; }
}

// POR VOTANTE, NO POR CORRIDA: se carga el modelo UNA vez y se le pregunta k
// veces antes de descargarlo. Asi se mide su dispersion sin pagar k recargas.
const porModelo = {};
for (const v of POL.votantes) {
  const serie = [];
  for (let i = 0; i < K; i++) {
    const p = await preguntar(v.modelo);
    serie.push(p);
    console.error(`  ${v.modelo} corrida ${i + 1}/${K} -> ${p ?? 'NULO'}`);
  }
  try { execFileSync('ollama', ['stop', v.modelo], { stdio: 'ignore', timeout: 60_000 }); } catch { /* ya fuera */ }
  const val = serie.filter(Number.isInteger);
  const media = val.length ? val.reduce((a, b) => a + b, 0) / val.length : null;
  porModelo[v.modelo] = {
    familia: v.familia, serie,
    validos: val.length, nulos: serie.length - val.length,
    min: val.length ? Math.min(...val) : null,
    max: val.length ? Math.max(...val) : null,
    rango: val.length ? Math.max(...val) - Math.min(...val) : null,
    media: media === null ? null : Number(media.toFixed(2)),
    // varianza muestral: sigma^2 = sum((x-media)^2) / (n-1)
    varianza: val.length > 1
      ? Number((val.reduce((a, b) => a + (b - media) ** 2, 0) / (val.length - 1)).toFixed(3))
      : null,
  };
}

const rangos = Object.values(porModelo).map((m) => m.rango).filter(Number.isInteger);
const rangoMax = rangos.length ? Math.max(...rangos) : null;
const REGLA = rangoMax === null ? 'INDETERMINADO'
  : rangoMax === 0 ? 'estricta'
  : rangoMax === 1 ? 'mixta'
  : 'SUSTITUIR_JUEZ';

const salida = { hash: HASH, artefacto: ARTEFACTO, k: K, fecha: new Date().toISOString(),
                 temperature: POL.muestreo.temperature, porModelo,
                 rangoMaximo: rangoMax, reglaRecomendada: REGLA,
                 criterio: 'rango 0 -> estricta · rango 1 -> mixta · rango >=2 -> sustituir juez' };
const dir = join(ROOT, '.harness', 'votaciones');
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, `varianza-${HASH}.json`), redactarSecretos(JSON.stringify(salida, null, 2)) + '\n');

console.log('');
console.log('modelo                     serie              rango  media  sigma2');
for (const [m, d] of Object.entries(porModelo)) {
  console.log(`${m.padEnd(26)} ${String(d.serie.map((x) => x ?? 'N').join(',')).padEnd(18)} ${String(d.rango ?? '?').padStart(5)} ${String(d.media ?? '?').padStart(6)} ${String(d.varianza ?? '?').padStart(6)}`);
}
console.log('');
console.log(`rango maximo entre jueces: ${rangoMax}`);
console.log(`REGLA RECOMENDADA POR LA MEDICION: ${REGLA}`);
console.log(`-> .harness/votaciones/varianza-${HASH}.json`);
