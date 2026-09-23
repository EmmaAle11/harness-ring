#!/usr/bin/env node
// Un SBOM PASS solo dice que el comando no fallo. Esto comprueba que el ARTEFACTO sirve para lo que
// existe: responder «que codigo de terceros corre en produccion». Produccion es el BACKEND -- el
// frontend es un bundle estatico en S3 --, asi que un inventario sin los paquetes de runtime del
// backend no es un inventario incompleto: es el inventario del arbol equivocado.
import { readFileSync } from 'node:fs';

// Testigos: paquetes que SOLO viven en backend/ y que corren en produccion. Si el SBOM del backend
// no los trae, no esta mirando ese arbol. No es una lista de dependencias permitidas: son sondas.
export const TESTIGOS_BE = ['pdfjs-dist', '@napi-rs/canvas'];

export const revisar = (fe, be, testigos = TESTIGOS_BE) => {
  const nombres = (s) => new Set((s?.components ?? []).map((c) => c.name));
  const nFe = nombres(fe), nBe = nombres(be);
  const fallos = [];
  if (nFe.size === 0) fallos.push('el SBOM de la raiz no trae componentes');
  if (nBe.size === 0) fallos.push('el SBOM del backend no trae componentes');
  for (const t of testigos) {
    if (!nBe.has(t)) fallos.push(`el SBOM del backend no contiene \`${t}\`: no esta inventariando ese arbol`);
  }
  // El fallo que motivo esto: emitir DOS VECES el mismo arbol y creer que son dos.
  if (nBe.size > 0 && nFe.size > 0 && nBe.size === nFe.size && [...nBe].every((x) => nFe.has(x))) {
    fallos.push('los dos SBOM tienen el MISMO contenido: se genero el mismo arbol dos veces');
  }
  return fallos;
};

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*?(?=\/)/, ''))) {
  const [, , rutaFe, rutaBe] = process.argv;
  const leer = (r) => { try { return JSON.parse(readFileSync(r, 'utf8')); } catch { return null; } };
  const fallos = revisar(leer(rutaFe), leer(rutaBe));
  if (fallos.length) { console.error(fallos.map((f) => `  - ${f}`).join('\n')); process.exit(1); }
  process.exit(0);
}
