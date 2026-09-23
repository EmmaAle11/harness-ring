// Frontmatter — texto -> { data, body }.
//
// Subconjunto de YAML: escalares, listas inline `[a, b]`, listas con guion y
// mapas anidados UN nivel (`permissions:` -> `  write: [...]`).
// Es TODO lo que usan los agentes. Un parser completo seria una dependencia
// para un problema que no tenemos (ver .kiro/specs/harness/design.md).
//
// El nivel de anidamiento se anadio para el CapabilityManifest: una frontera
// necesita decir `permissions.write` y `permissions.execute` por separado, y
// aplanarlo a `permissions_write` habria sido inventar una sintaxis propia para
// no escribir diez lineas.
//
// Puro: sin E/S. Su test vive al lado.

const unquote = (s) => s.trim().replace(/^['"]|['"]$/g, '');
const coerce = (v) => (v === 'true' ? true : v === 'false' ? false : v);
const lista = (v) => v.replace(/^\[|\]$/g, '').split(',').map(unquote).filter(Boolean);

export function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { data: {}, body: text.trim() };

  const data = {};
  let key = null;        // clave de primer nivel
  let anidado = null;    // subclave viva dentro de un mapa anidado

  for (const raw of m[1].split(/\r?\n/)) {
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue;

    // `  - item` continua la lista de la clave anterior — de primer nivel o de
    // una subclave dentro de un mapa anidado.
    const item = /^\s+-\s+(.*)$/.exec(raw);
    if (item && key) {
      const destino = anidado ? data[key][anidado] : data[key];
      if (Array.isArray(destino)) destino.push(unquote(item[1]));
      else if (anidado) data[key][anidado] = [unquote(item[1])];
      else data[key] = [unquote(item[1])];
      continue;
    }

    // `  subclave: valor` dentro de una clave declarada vacia
    const sub = /^\s+([A-Za-z_][\w-]*):\s*(.*)$/.exec(raw);
    if (sub && key && data[key] && !Array.isArray(data[key]) && typeof data[key] === 'object') {
      anidado = sub[1];
      const v = sub[2].trim();
      data[key][anidado] = v === '' ? [] : v.startsWith('[') ? lista(v) : coerce(unquote(v));
      continue;
    }
    // Primera subclave: la clave se declaro como lista vacia y resulta ser mapa.
    if (sub && key && Array.isArray(data[key]) && data[key].length === 0) {
      data[key] = {};
      anidado = sub[1];
      const v = sub[2].trim();
      data[key][anidado] = v === '' ? [] : v.startsWith('[') ? lista(v) : coerce(unquote(v));
      continue;
    }

    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(raw);
    if (!kv) continue;
    key = kv[1];
    anidado = null;
    const v = kv[2].trim();

    if (v === '') data[key] = [];                     // lista o mapa: lo dice la linea siguiente
    else if (v.startsWith('[')) data[key] = lista(v);
    else data[key] = coerce(unquote(v));
  }

  return { data, body: m[2].trim() };
}
