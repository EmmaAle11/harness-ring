/**
 * docs:enlaces — los enlaces entre documentos, resueltos DESDE EL FICHERO QUE CITA.
 *
 * `memory/` es la autoridad del conocimiento durable y se cita a si misma sin
 * parar: 18 rutas en 10 documentos el 21-ago. Cuando una entrada se mueve o se
 * renombra, los enlaces que la nombraban se rompen EN SILENCIO -- nada falla,
 * simplemente el que llega sin contexto no encuentra la leccion. Y `memory/` se
 * movio tres veces esa misma manana.
 *
 * LA TRAMPA, y por que este fichero existe en vez de un `grep`: una comprobacion
 * que resuelve las rutas desde la RAIZ del repo da verde sobre enlaces rotos en
 * cuanto los documentos viven a profundidades distintas.
 * `memory/failures/x.md` citando `../patterns/y.md` resuelve a
 * `memory/patterns/y.md`; el mismo texto en `memory/README.md` resuelve a
 * `patterns/y.md`, que no existe. El mismo enlace es correcto en un fichero e
 * incorrecto en otro: la unica resolucion valida es RELATIVA A QUIEN CITA.
 *
 * Funcion pura: recibe los documentos ya leidos y un predicado de existencia.
 * No toca el disco -- por eso se puede probar sin montar un arbol de mentira.
 */

/** Los destinos locales de un markdown. Ignora http(s), mailto, anclas y absolutos. */
export function enlacesDe(texto) {
  const salida = [];
  const re = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let m;
  while ((m = re.exec(String(texto ?? ''))) !== null) {
    const crudo = m[1];
    if (/^(https?:|mailto:|#|\/)/i.test(crudo)) continue;
    salida.push(crudo.split('#')[0]);           // el ancla no es parte de la ruta
  }
  return salida.filter(Boolean);
}

/** Une `desde` (ruta del fichero que cita) con un destino relativo, sin tocar el disco. */
export function resolverDesde(desde, destino) {
  const base = String(desde).split('/').slice(0, -1);   // el DIRECTORIO del que cita
  const partes = [...base, ...String(destino).split('/')];
  const pila = [];
  for (const p of partes) {
    if (p === '' || p === '.') continue;
    if (p === '..') { pila.pop(); continue; }
    pila.push(p);
  }
  return pila.join('/');
}

/**
 * @param docs  [{ path: 'memory/README.md', texto: '…' }]
 * @param existe (ruta) => boolean
 * @returns { revisados, enlaces, rotos: [{ desde, cita, resuelto }] }
 */
export function revisarEnlaces(docs = [], existe = () => true) {
  const rotos = [];
  let enlaces = 0;
  for (const d of docs ?? []) {
    for (const cita of enlacesDe(d?.texto)) {
      enlaces++;
      const resuelto = resolverDesde(d.path, cita);
      if (!existe(resuelto)) rotos.push({ desde: d.path, cita, resuelto });
    }
  }
  return { revisados: (docs ?? []).length, enlaces, rotos };
}
