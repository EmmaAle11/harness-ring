/**
 * Las rutas que DEPLOY.md declara y que git no puede ver.
 *
 * EL DEFECTO, medido por el agente de S3 el 2026-08-21 y comprobado aqui:
 *
 *   DEPLOY.md:261  «MIGRATION OBLIGATORIA PRE-DEPLOY:
 *                   ai/aws/migrations/2026-05-28-rfc-history-and-liberado-status.sql»
 *   .gitignore:304  ai/
 *
 * Los tres ficheros que ya viven en `ai/aws/` siguen rastreados --ignorar no
 * desrastrea-- asi que HOY no rompe nada, y por eso nadie lo va a ver. El fallo
 * aparece cuando alguien escriba el SIGUIENTE `.sql` ahi: no entrara en el
 * commit, y se descubrira en un despliegue.
 *
 * POR ESO SE PREGUNTA POR UN FICHERO NUEVO. `git check-ignore` sin `--no-index`
 * no marca lo ya rastreado, asi que preguntar por los ficheros existentes
 * responde «visible» por la razon equivocada. La pregunta correcta es si el
 * DIRECTORIO admitiria uno nuevo.
 *
 * MEDIDO: `ai/aws/migrations/` y `ai/audits/` ignorados; `migration/` y
 * `scripts/` visibles.
 *
 * PURO: recibe el texto y un predicado. La E/S es de quien llama.
 */

/** Rutas del repositorio que el documento nombra. Ignora URLs y rutas absolutas. */
export function rutasDeclaradas(texto) {
  const re = /\b((?:ai|migration|migrations|scripts|backend|src|docker|harness)\/[A-Za-z0-9._/-]+\.[A-Za-z0-9]{1,5})\b/g;
  const out = new Set();
  for (const m of String(texto ?? '').matchAll(re)) {
    if (!/^https?:/.test(m[1])) out.add(m[1]);
  }
  return [...out].sort();
}

/** El directorio de cada ruta, que es lo que decide si un fichero NUEVO entra. */
export const directoriosDe = (rutas) =>
  [...new Set((rutas ?? []).map((r) => r.split('/').slice(0, -1).join('/')).filter(Boolean))].sort();

/**
 * Los directorios donde un fichero nuevo seria invisible para git.
 *
 * @param texto      el contenido de DEPLOY.md
 * @param ignoraNuevo (dir) => boolean — «¿un fichero nuevo aqui estaria ignorado?»
 */
export function invisibles(texto, ignoraNuevo) {
  return directoriosDe(rutasDeclaradas(texto)).filter((d) => ignoraNuevo(d));
}
