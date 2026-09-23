/**
 * EL P0 SE CIERRA EN LOS CUATRO PUNTOS O NO SE CIERRA.
 *
 * `sandbox.changedFiles(ws)` devuelve tambien `public/version.json` y
 * `src/generated/current-version.ts`, que NO los escribe el builder: los
 * regenera vite cada vez que el builder corre `run_test` o `run_typecheck`.
 *
 * El primer arreglo (2026-09-18) filtro DOS de los cinco consumidores y dejo
 * tres sin filtrar. Una auditoria lo cazo simulando H-20260917-fef6f11b:
 * «718 PASA, 721 LANZA». Eximir en un sitio y volver a juzgar lo crudo en el
 * siguiente no es eximir.
 *
 * Este test NO prueba la logica --eso ya lo hace artefactos-de-build.test.mjs--
 * sino que NO QUEDE NINGUN consumidor sin filtrar. Si manana alguien añade un
 * sexto uso de la lista cruda, cae aqui.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('./stages-model.mjs', import.meta.url), 'utf8');

// La palabra «cambiados» aparece en prosa de comentarios («esos 17 ficheros YA
// cambiados delante»), asi que contarla a secas mide el castellano, no el codigo.
// Lo que importa es que no quede una VARIABLE con la lista cruda.
const SIN_COMENTARIOS = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

test('no queda ninguna variable con la lista cruda', () => {
  const usos = [...SIN_COMENTARIOS.matchAll(/\bcambiados\b/g)].length;
  assert.equal(usos, 0, `'cambiados' aparece ${usos} veces en codigo: es un consumidor sin filtrar`);
});

test('TODA llamada a changedFiles va envuelta en el filtro', () => {
  // Tres ramas distintas la llaman (NO_CHANGE_REQUIRED, sin-presupuesto y
  // Execution). No sobra ninguna: lo que no puede haber es una SIN envolver.
  const total = [...SIN_COMENTARIOS.matchAll(/sandbox\.changedFiles\(ws\)/g)].length;
  const envueltas = [...SIN_COMENTARIOS.matchAll(/sinArtefactosDeBuild\(sandbox\.changedFiles\(ws\)\)/g)].length;
  assert.equal(
    total, envueltas,
    `${total} llamadas a changedFiles y solo ${envueltas} filtradas: ${total - envueltas} entra(n) cruda(s)`,
  );
});

test('los CINCO consumidores reciben la lista filtrada', () => {
  for (const patron of [
    /assertWithinBoundary\(builderCap, propios\)/,
    /for \(const f of propios\)/,
    /analizar\(propios,/,
    // Sin el `)` final: la llamada gano un tercer argumento --el lector de HEAD
    // que distingue una restauracion de un fantasma-- y atar el test al texto
    // exacto lo convierte en obstaculo para la mejora que el propio test pide.
    // Lo que importa es que reciba `propios`, no como se escribe el resto.
    /carearConGit\(r\.mutations, propios\b/,
    /files: propios,/,
  ]) {
    assert.match(SRC, patron, `falta un consumidor filtrado: ${patron}`);
  }
});

test('el filtro se aplica UNA sola vez: no se repite en cada consumidor', () => {
  // Filtrar en cada sitio funciona y es fragil: basta olvidarse en el siguiente.
  // La lista se calcula una vez, al obtenerla de git.
  const veces = [...SRC.matchAll(/sinArtefactosDeBuild\(/g)].length;
  assert.ok(veces <= 4, `sinArtefactosDeBuild se llama ${veces} veces: una por rama que llame a git, no mas`);
});
