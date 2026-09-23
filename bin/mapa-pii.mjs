#!/usr/bin/env node
/**
 * ¿QUE TEST DICE DISTINGUIR DOS IDENTIDADES Y RECIBE LA MISMA?
 *
 * El barrido de PII sustituyo cada RFC real por el MISMO literal sintetico. Eso
 * no rompe un test que solo usa el RFC de decorado --como parte de un
 * storagePath, o en un comentario-- pero SI rompe cualquiera que compare dos
 * identidades: pasa a comparar una consigo misma y deja de probar lo que dice.
 *
 * Tres ficheros lo sufrieron (expedienteBackup.spec.ts, identidad-domicilio.
 * test.ts, Expedientes.grupo.test.tsx) y estan arreglados. Esto localiza
 * cualquier caso nuevo: la SEÑAL es un nombre de test que promete distinguir
 * algo, con un unico literal disponible para hacerlo.
 *
 * NO ES UNA PUERTA DE GATE, Y ES DELIBERADO. Un regex no puede decidir si un RFC
 * dentro de un storagePath se compara con algo; convertirlo en puerta produciria
 * falsos positivos que alguien acabaria silenciando, y un guarda silenciado es
 * peor que ninguno. Señala; el dictamen exige leer el test.
 *
 * USO: node harness/bin/mapa-pii.mjs [--json]
 * SALE: 0 siempre.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = fileURLToPath(new URL('../../', import.meta.url));
const SRC = join(RAIZ, 'src');
const RFC = /ZZZ[0-9]{6}[A-Za-z0-9]{3}/g;
const SENAL = /\b(distint|otra|otro|ajen|NO coincide|no comparten|cross|fuga|diferente|segundo|ambos)\b/i;

function ficheros(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) ficheros(p, out);
    else if (/\.(test|spec)\.(ts|tsx)$/.test(e)) out.push(p);
  }
  return out;
}

const riesgo = [];
let conRfc = 0;
for (const p of ficheros(SRC)) {
  const t = readFileSync(p, 'utf8');
  const lits = [...new Set(t.match(RFC) ?? [])];
  if (!lits.length) continue;
  conRfc += 1;
  const nombres = [...t.matchAll(/(?:it|test|describe)\(\s*['"`]([^'"`]{10,160})/g)].map((m) => m[1]);
  const sospechosos = nombres.filter((n) => SENAL.test(n));
  if (lits.length === 1 && sospechosos.length) {
    riesgo.push({ fichero: relative(RAIZ, p), literales: lits.length, sospechosos });
  }
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ conRfc, riesgo }, null, 2));
} else {
  console.log(`${conRfc} ficheros de test contienen un RFC sintetico`);
  console.log(`${riesgo.length} con UN literal y un test que dice distinguir algo:\n`);
  for (const r of riesgo) {
    console.log(`  ${r.fichero}`);
    for (const s of r.sospechosos.slice(0, 3)) console.log(`      - ${s.slice(0, 100)}`);
  }
  console.log('\nCADA UNO EXIGE LECTURA: un RFC en un comentario o en un storagePath');
  console.log('no se compara con nada. El regex señala, no dictamina.');
}
