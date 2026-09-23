/**
 * Las variables que el bundle de produccion EXIGE, y si estan.
 *
 * EL DEFECTO QUE LO MOTIVA, medido el 2026-08-21: un despliegue dejo el frontend
 * de produccion EN BLANCO para todos los usuarios porque faltaba
 * `.env.production` en el arbol desde el que se compilo. El build TERMINO CON
 * EXITO. Se comprobo que el bundle subio, que el `buildId` era correcto, que
 * `index.html` daba 200 y que las cadenas esperadas estaban dentro: cuatro
 * comprobaciones ciertas y ninguna medía si la aplicacion ARRANCA.
 *
 * EL MECANISMO. `src/config/adminPath.ts` hace, a nivel de MODULO:
 *
 *     if (_ENV.PROD && !RAW_PATH) throw new Error('[adminPath] … es obligatorio en prod');
 *
 * Lanza al IMPORTARSE, asi que el bundle muere antes de pintar nada. El `throw`
 * es deliberado y correcto --degradar a un fallback filtraria la ruta de admin en
 * el bundle-- pero deja el fallo donde ninguna puerta lo ve: el navegador del
 * cliente.
 *
 * LO QUE LO HACE SILENCIOSO SON LOS FALLBACKS. De las seis `VITE_*` que consume
 * el codigo, cuatro tienen `|| 'http://localhost:…'`. Sin `.env.production` el
 * build no falla NI avisa: produce un bundle de produccion que apunta a
 * localhost. Un valor por defecto pensado para desarrollo se convierte, en un
 * build de produccion, en lo que oculta que falta la configuracion.
 *
 * PURO: recibe los ficheros ya leidos y el texto del .env. Sin E/S.
 */

const TOKEN = /VITE_[A-Z0-9_]+/g;

/**
 * Quita comentarios de linea y de bloque: una variable citada en una nota no se
 * consume.
 *
 * SE NORMALIZA CRLF PRIMERO, y no es cosmetico. En JavaScript `.` no casa `\r`
 * --es un terminador de linea-- asi que `/\/\/.*$/` NO CASA NADA en un fichero
 * con finales de linea de Windows: el limpiador se quedaba mudo y toda variable
 * citada en un comentario contaba como consumida.
 *
 * MEDIDO: `VITE_TURNSTILE_SITE_KEY` aparece UNA vez en todo `src/`, dentro de un
 * comentario de `DoxIALanding.tsx`, y salia en la lista de obligatorias. Un falso
 * positivo en una puerta de despliegue cuesta un despliegue detenido por nada,
 * que es la forma mas rapida de que alguien la desactive.
 */
export function sinComentarios(texto) {
  return String(texto ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n');
}

/**
 * TODAS las `VITE_*` que el codigo consume, tengan o no valor por defecto.
 *
 * ESTA es la lista que `.env.production` tiene que definir, y el criterio de
 * «solo las que no tienen fallback» era demasiado estrecho -- lo corrigio `third`
 * auditando, y tenia razon. Medido en las dos ramas: 5 consumidas, y sus cuatro
 * fallbacks son:
 *
 *   VITE_API_URL       || 'http://localhost:3000/api/v1'
 *   VITE_KEYCLOAK_URL  || 'http://localhost:8080'
 *   VITE_KEYCLOAK_REALM     || 'doxia'
 *   VITE_KEYCLOAK_CLIENT_ID || 'doxia-frontend'
 *
 * Los dos primeros gritan: un bundle de produccion apuntando a localhost falla a
 * la primera llamada. LOS DOS ULTIMOS NO. Degradan a valores que PARECEN de
 * produccion, y un realm equivocado no se distingue de uno correcto mirando el
 * bundle: la sesion simplemente no autentica contra quien deberia.
 *
 * Un fallback es una comodidad de DESARROLLO. En un build de produccion, apoyarse
 * en cualquiera de ellos es configuracion que falta, y los que menos ruido hacen
 * son los peores.
 */
export function consumidas(ficheros = []) {
  const vistas = new Set();
  for (const f of ficheros ?? []) {
    // LOS SPECS NO CONSUMEN: nombran. Un test que afirma «esta variable NO es
    // obligatoria» la menciona, y contarla como consumida convierte una prueba
    // sobre la lista en una entrada de la lista.
    //
    // MEDIDO: en el tronco `VITE_TURNSTILE_SITE_KEY` aparece cuatro veces --un
    // comentario y tres lineas de dos specs-- y NI UNA en codigo de produccion.
    // Un `grep` crudo cuenta seis variables; el bundle consume cinco. Yo contaba
    // cinco en mi rama y seis habria contado en el tronco, por esto.
    if (/\.(spec|test)\.tsx?$/.test(String(f?.path ?? ''))) continue;
    for (const m of sinComentarios(f?.texto).matchAll(TOKEN)) vistas.add(m[0]);
  }
  return [...vistas].sort();
}

/**
 * Las que el codigo consume SIN valor por defecto: si faltan, el bundle REVIENTA
 * al cargar en vez de degradar en silencio. Es un SUBCONJUNTO de `consumidas`, y se
 * publica aparte porque distingue dos fallos distintos: pagina en blanco (esta
 * lista) contra configuracion silenciosamente equivocada (el resto).
 */
export function exigidas(ficheros = []) {
  const usos = new Map();
  for (const f of ficheros ?? []) {
    const t = sinComentarios(f?.texto);
    for (const m of t.matchAll(TOKEN)) {
      const v = m[0];
      const cola = t.slice(m.index + v.length, m.index + v.length + 60);
      // `||` o `??` inmediatos, o tras un cast/cierre de parentesis: hay defecto.
      const conDefecto = /^\s*(\)|\s*as\s+[^)]*\))?\s*(\|\||\?\?)/.test(cola);
      const d = usos.get(v) ?? { total: 0, sinDefecto: 0 };
      d.total += 1;
      if (!conDefecto) d.sinDefecto += 1;
      usos.set(v, d);
    }
  }
  return [...usos].filter(([, d]) => d.sinDefecto > 0).map(([v]) => v).sort();
}

/** Las que el .env NO define. `X=` cuenta como ausente: vacio no es configurado. */
export function faltantes(necesarias, envTexto) {
  const definidas = new Set(
    String(envTexto ?? '').split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
      .map((l) => { const i = l.indexOf('='); return i < 0 ? null : [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
      .filter((kv) => kv && kv[1] !== '')
      .map((kv) => kv[0]),
  );
  return (necesarias ?? []).filter((v) => !definidas.has(v));
}

/**
 * La comprobacion COMPLETA sobre un arbol: lee el codigo, lee el `.env.production`
 * si existe, y devuelve lo que falta.
 *
 * POR QUE EXISTE Y NO BASTA CON `faltantes`. La primera version de esto vivia solo
 * en un test, y ese test se SALTABA cuando no habia `.env.production` -- que es
 * EXACTAMENTE el caso del incidente. Comprobaba «el .env.production que hay esta
 * completo» y lo que paso fue que no habia ninguno.
 *
 * Lo encontro `third` auditando, y es la leccion de
 * `el-build-en-verde-y-la-pagina-en-blanco` un nivel mas arriba: alli fueron
 * cuatro comprobaciones ciertas que no median el ARRANQUE; aqui, una comprobacion
 * cierta que no medía la AUSENCIA.
 *
 * `t.skip` es razonable en CI --alli no debe haber `.env.production`-- pero
 * convierte «no aplica aqui» en «pasa», y son cosas distintas. Por eso esto NO
 * devuelve un booleano: devuelve `{existe, faltan}` y quien llama decide que
 * significa cada uno en SU contexto. En CI, `existe: false` no es un fallo; en el
 * arbol desde el que se compila para produccion, lo es -- y ahi tiene que vivir la
 * puerta, no aqui.
 *
 * @param leer   (ruta) => string|null   — null si el fichero no existe
 * @param listar () => [{path, texto}]   — los ficheros de src/
 */
export function revisarArbol({ leer, listar }) {
  const envTexto = leer('.env.production');
  const necesarias = consumidas(listar());
  return {
    existe: envTexto !== null && envTexto !== undefined,
    necesarias,
    // El fichero ausente cuenta como TODAS ausentes. Para un build de produccion
    // «no esta» y «esta incompleto» valen lo mismo, y colapsarlos es lo correcto.
    faltan: faltantes(necesarias, envTexto ?? ''),
  };
}
