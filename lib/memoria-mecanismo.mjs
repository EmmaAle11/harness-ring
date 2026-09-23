// ¿QUÉ MEMORIA TIENE UN MECANISMO QUE LA HAGA CUMPLIR, Y CUÁL ESPERA A QUE ALGUIEN TROPIECE?
//
// El 2026-08-30 tres memorias de este mismo árbol mordieron el mismo día: el cerrojo de `--full`
// (escrita el 27), las tres del inodo (el 28) y el techo de tiempo contra un cuelgue (el 27). Las
// tres decían exactamente qué hacer. Ninguna se había hecho.
//
// Y NO ES QUE EL CORPUS NO SE MECANICE — sí lo hace a veces: «nunca ordenes evidencia por nombre»
// está cumplida en `harness-status.sh`, y la clase de la sonda inalcanzable la vigila
// `scripts-portables.spec.ts`. El defecto es más fino: **nada distingue una memoria que ya tiene
// guarda de una que espera un incidente**. Las dos se leen igual y las dos ponen `status: active`.
// La diferencia se descubre el día que muerde.
//
// Así que la memoria declara su mecanismo, o declara que no puede tenerlo. Es la misma regla que
// este repo aplica a su puerta: lo que no se puede comprobar SE DECLARA, no se aprueba. Una memoria
// sin el campo cuenta hoy como cubierta POR SILENCIO, que es la forma exacta del defecto que
// `controles` persigue una capa más abajo.
//
// Hallazgo de `third` (2026-08-30).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * El vocabulario de `status`. Cerrado a propósito: hoy conviven DIEZ valores para lo que parecen
 * cuatro estados (`fixed`, `resolved`, `closed` y `applied` dicen lo mismo). Un enum sin autoridad
 * falla abierto y nadie se entera — la forma que este repo ya conoce.
 */
export const ESTADOS = new Set([
  'active',      // todavía puede pasar
  'mitigated',   // hay algo que lo contiene, no lo elimina
  'fixed',       // la causa ya no existe
  'accepted',    // se convive con ello a sabiendas
  'demonstrated',// una capacidad probada (VALIDATION)
  'superseded',  // la sustituye otra entrada
]);

/** Sólo las `active` necesitan mecanismo: son las que dicen «esto todavía puede pasar». */
export const EXIGEN_MECANISMO = new Set(['active']);

function ficheros(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) ficheros(p, out);
    else if (e.endsWith('.md') && e !== 'README.md') out.push(p);
  }
  return out;
}

/** Los campos del frontmatter YAML de primer nivel. Sin dependencias: son cinco claves planas. */
export function frontmatter(texto) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(texto);
  if (!m) return {};
  const out = {};
  for (const linea of m[1].split('\n')) {
    const c = /^([a-zA-Z_][\w-]*):\s*(.*)$/.exec(linea);
    if (c) out[c[1]] = c[2].replace(/\s+#.*$/, '').trim();
  }
  return out;
}

export function auditar(raiz) {
  const sinMecanismo = [];
  const estadosRaros = [];
  let total = 0;
  let activas = 0;
  for (const f of ficheros(raiz)) {
    const fm = frontmatter(readFileSync(f, 'utf8'));
    if (!fm.status) continue;
    total += 1;
    const rel = f.slice(raiz.length + 1);
    if (!ESTADOS.has(fm.status)) estadosRaros.push({ fichero: rel, status: fm.status });
    if (!EXIGEN_MECANISMO.has(fm.status)) continue;
    activas += 1;
    if (!fm.mecanismo) sinMecanismo.push(rel);
  }
  return { total, activas, sinMecanismo: sinMecanismo.sort(), estadosRaros };
}

if (process.argv[2]) {
  const raiz = process.argv[2];
  // El TECHO es un trinquete, como la deuda de eslint: sólo puede bajar. Bloquear hoy con 73
  // entradas heredadas garantizaría que alguien desactive la comprobación, y una comprobación
  // desactivada es peor que no tenerla.
  const techo = Number(process.argv[3] ?? Infinity);
  const r = auditar(raiz);
  console.log(
    `${r.total} memorias · ${r.activas} active · ${r.sinMecanismo.length} sin mecanismo declarado` +
    (r.estadosRaros.length ? ` · ${r.estadosRaros.length} con status fuera del vocabulario` : ''),
  );
  for (const e of r.estadosRaros) console.log(`  status desconocido: ${e.status} — ${e.fichero}`);
  if (r.sinMecanismo.length > techo) {
    console.log(`SUBIO: ${r.sinMecanismo.length} > techo ${techo}`);
    process.exit(1);
  }
  process.exit(0);
}
