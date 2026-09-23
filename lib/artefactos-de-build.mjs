/**
 * LO QUE EL BUILD REGENERA Y AL BUILDER SE LE IMPUTA.
 *
 * MEDIDO en H-20260917-fef6f11b: la vuelta recorrio 12 etapas --Execution OK,
 * Security OK, Adversarial OK-- y murio en el rework con
 *
 *   frontera violada por 'builder': 'public/version.json' esta fuera de
 *   [src, backend/src, scripts, migration, docker/init-db]
 *
 * El builder NO escribio ese fichero. Lo regenera vite: `vite.config.ts` corre
 * el plugin `versionManifest()` ANTES que react, y ese plugin llama a
 * `scripts/generate-version-manifest.mjs`, que escribe los dos ficheros de
 * abajo. Ocurre cada vez que el builder usa `run_test` o `run_typecheck` -- dos
 * tools que el propio harness le entrega.
 *
 * LA FRONTERA NO SOBRA: es la misma guarda que impide que el builder toque
 * `backend/` o `harness/policy`. Lo que se corrige es la IMPUTACION.
 *
 * ES EL SEGUNDO FALLO DEL MISMO DIA CON LA MISMA FORMA: una herramienta que
 * responde por el ARBOL cuando se le pregunta por un CAMBIO. El primero fue
 * `run_test` sin ruta devolviendo el rojo de todo el repo
 * (memory/failures/noventa-iteraciones-arreglando-lo-que-ya-estaba-roto.md).
 * En los dos, el modelo hizo lo correcto y lo hundio el instrumental.
 *
 * LISTA CERRADA, NO UN PATRON. `public/**` eximiria `public/index.html`, y
 * `src/generated/**` cualquier fichero futuro de ese directorio. Dos rutas
 * exactas y ninguna mas: una exencion que crece sola deja de ser una exencion.
 */

/** Las rutas EXACTAS que `scripts/generate-version-manifest.mjs` escribe. */
export const ARTEFACTOS_DE_BUILD = Object.freeze([
  'public/version.json',
  'src/generated/current-version.ts',
]);

const norm = (p) => String(p ?? '').replace(/\\/g, '/').replace(/^\.\//, '');

/** @returns {boolean} true solo para las rutas exactas declaradas arriba. */
export function esArtefactoDeBuild(ruta) {
  const r = norm(ruta);
  return r !== '' && ARTEFACTOS_DE_BUILD.includes(r);
}

/** El ChangeSet sin los artefactos que regenera el build. Conserva el orden. */
export function sinArtefactosDeBuild(rutas) {
  return (Array.isArray(rutas) ? rutas : []).filter((r) => !esArtefactoDeBuild(r));
}

/**
 * EL MISMO DESCUENTO, SOBRE EL DIFF.
 *
 * Filtrar la LISTA de ficheros no basta: el revisor no lee la lista, lee el
 * diff. MEDIDO en H-20260918-9a093b28: de los 5 bloques del diff, 2 eran
 * `public/version.json` y `src/generated/current-version.ts` --1.523 de 15.321
 * caracteres-- y el revisor los recibia como trabajo del builder.
 *
 * No cambia ningun veredicto: el careo ya salia limpio. Cambia lo que el modelo
 * LEE, que es la mitad de la vuelta que nadie estaba mirando.
 *
 * Corta por los encabezados `diff --git a/<ruta> b/<ruta>`, que es como git
 * separa los ficheros. Si el diff viene vacio o no es texto, devuelve ''.
 */
export function diffSinArtefactosDeBuild(diff) {
  const txt = String(diff ?? '');
  if (!txt.trim()) return txt;
  const partes = txt.split(/^diff --git /m);
  const cabecera = partes.shift() ?? '';
  const propios = partes.filter((bloque) => {
    const m = bloque.match(/^a\/(\S+)/);
    return !(m && esArtefactoDeBuild(m[1]));
  });
  return cabecera + propios.map((b) => `diff --git ${b}`).join('');
}
