/**
 * EL CATALOGO CONTRA EL PROVEEDOR: ¿pedimos modelos que existen?
 *
 * DOS VECES, y la segunda con el aviso de la primera escrito al lado:
 *
 *   2026-08-xx  `deepseek-chat` y `deepseek-reasoner` dejan de existir.
 *   2026-09-15  `deepseek-v4-flash` deja de existir. El `prefer` de `read`,
 *               `plan` y `review` lo seguia pidiendo, y `catalog.json` lo
 *               declaraba con todas sus capacidades, como si estuviera vivo.
 *
 * El comentario de `router.json` ya decia «DEJARON DE EXISTIR» -- y aun asi
 * nadie comparaba la lista contra el proveedor. Un catalogo escrito a mano
 * diverge sin avisar; lo que faltaba no era la leccion, era el instrumento.
 *
 * POR QUE IMPORTA MAS EN `review`: esa clase prohibe `claude:*` por ADR-003, asi
 * que su `prefer` es la unica red que tiene. Con el segundo escalon muerto, si
 * `deepseek-v4-pro` cae la vuelta se queda sin revisor de otra familia.
 *
 * PURA: recibe el router, el catalogo y lo que el proveedor dice servir.
 * `servidos` se obtiene fuera (una llamada de red no va en una funcion que se
 * prueba sin red).
 */

/** Los modelos que el router PIDE, por proveedor. */
export function modelosPedidos(router) {
  const out = {};
  for (const [clase, cfg] of Object.entries(router?.classes ?? {})) {
    for (const p of cfg?.prefer ?? []) {
      if (!p?.provider || !p?.model) continue;
      (out[p.provider] ??= new Map()).set(p.model, [...(out[p.provider].get(p.model) ?? []), clase]);
    }
  }
  return out;
}

/** Los modelos que el catalogo DECLARA, por proveedor. */
export function modelosDeclarados(catalog) {
  const out = {};
  for (const m of catalog?.models ?? []) {
    if (!m?.provider || !m?.model_id) continue;
    (out[m.provider] ??= new Set()).add(m.model_id);
  }
  return out;
}

/**
 * @param {object} router
 * @param {object} catalog
 * @param {Record<string,string[]>} servidos  proveedor -> ids que la API sirve HOY.
 *        Un proveedor AUSENTE de este objeto no se juzga: no se pudo preguntar,
 *        y eso NO es «esta bien» (el-instrumento-que-confunde-error-con-vacio).
 * @returns {{fantasmas: object[], noComprobados: string[], ok: boolean}}
 */
export function fantasmas(router, catalog, servidos = {}) {
  const pedidos = modelosPedidos(router);
  const declarados = modelosDeclarados(catalog);
  const fant = [];
  const noComprobados = [];

  for (const [prov, mapa] of Object.entries(pedidos)) {
    const vivos = servidos[prov];
    if (!Array.isArray(vivos)) { noComprobados.push(prov); continue; }
    const set = new Set(vivos);
    for (const [model, clases] of mapa) {
      if (!set.has(model)) {
        fant.push({
          provider: prov,
          model,
          clases: [...new Set(clases)].sort(),
          enCatalogo: declarados[prov]?.has(model) ?? false,
          // `review` prohibe claude: su prefer es la unica red de ADR-003.
          critico: clases.includes('review'),
        });
      }
    }
  }
  return { fantasmas: fant, noComprobados, ok: fant.length === 0 };
}

/** Una linea por fantasma, para el artefacto del gate. */
export function resumen({ fantasmas: fant, noComprobados }) {
  const l = fant.map((f) =>
    `${f.provider}:${f.model} — pedido por [${f.clases.join(', ')}]`
    + `${f.enCatalogo ? ', declarado en catalog.json' : ''}`
    + `${f.critico ? ' · CRITICO: `review` no tiene otra familia' : ''}`);
  if (noComprobados.length) l.push(`NO COMPROBADOS (no es un aprobado): ${noComprobados.join(', ')}`);
  return l;
}
