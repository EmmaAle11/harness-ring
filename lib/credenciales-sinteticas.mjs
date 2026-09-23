/**
 * Credenciales SINTETICAS para sembrar, generadas al vuelo y nunca versionadas.
 *
 * EL PROBLEMA, y explica por que el criterio «secret scanning bloquea una
 * credencial sembrada» lleva desde siempre en ✘: es INTESTABLE por construccion
 * si la credencial vive en la spec.
 *
 *   scripts/gate.sh:284   busca los patrones con `git grep` sobre LO VERSIONADO
 *   .husky/pre-commit     bloquea patrones de secreto en el staged diff
 *
 * Una spec con `seed.content` conteniendo `AKIA…` no se puede ni commitear; y si
 * se commiteara, el escaneo la encontraria EN LA SPEC -- no en el fichero
 * sembrado-- y el hallazgo seria sobre el sitio equivocado. La puerta estaria
 * cazando su propio material de pruebas.
 *
 * LA SALIDA: la spec declara el TIPO, no el valor. El harness sintetiza la
 * cadena al sembrar, dentro del workspace, que no se versiona. Lo unico que viaja
 * en git es la palabra `aws`.
 *
 * DETERMINISTA A PROPOSITO: la misma semilla da la misma cadena, para que dos
 * corridas de la misma vuelta sean comparables. No hay aleatoriedad que explique
 * una diferencia entre trazas.
 *
 * NO SON SECRETOS. Son cadenas con la FORMA de un secreto: cumplen el patron que
 * el escaner busca y no abren nada. Esa es exactamente la propiedad que hace
 * util una semilla.
 */

const ALFA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const alnum = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/** Determinista: el mismo `sal` da la misma cadena. Sin Math.random. */
const relleno = (sal, largo, juego) => {
  let h = 0;
  for (let i = 0; i < String(sal).length; i++) h = (h * 31 + String(sal).charCodeAt(i)) >>> 0;
  let out = '';
  for (let i = 0; i < largo; i++) {
    h = (h * 1103515245 + 12345) >>> 0;
    out += juego[h % juego.length];
  }
  return out;
};

/**
 * Las formas que `gate.sh` busca. Si alguien anade un patron alli y no aqui, el
 * criterio deja de poder probarse para ese patron -- y un test lo dice.
 */
const B64 = `${alnum}_-`;

// El PEM por PARTES, a proposito. La puerta busca `-----BEGIN [A-Z ]*PRIVATE KEY`
// y este fichero esta en lo versionado: escrito de una pieza, el escaner cazaria
// al GENERADOR en vez de a lo sembrado -- que es el defecto entero que este modulo
// existe para evitar, apareciendo por dentro.
const PEM = ['-----BEGIN', 'RSA', 'PRIVATE', 'KEY-----'];

export const TIPOS = {
  aws: (sal) => `AKIA${relleno(sal, 16, ALFA)}`,
  github: (sal) => `ghp_${relleno(sal, 36, alnum)}`,
  openai: (sal) => `sk-${relleno(sal, 32, alnum)}`,
  // Los tres de abajo faltaban, y el test que decia cubrirlo miraba AL REVES:
  // recorria los generadores preguntando si la puerta los busca, cuando el modo de
  // fallo que su propio comentario nombraba es el contrario -- un patron en la
  // puerta sin generador aqui. Cobertura real cuando lo midio third: 3 de 6.
  jwt: (sal) => `eyJ${relleno(sal, 24, B64)}.eyJ${relleno(`${sal}p`, 24, B64)}.${relleno(`${sal}s`, 32, B64)}`,
  slack: (sal) => `xoxb-${relleno(sal, 20, `${alnum}-`)}`,
  privatekey: (sal) => `${PEM.join(' ')}\n${relleno(sal, 64, B64)}\n`,
  // Los DOS de abajo llegaron con la puerta del tronco al fusionar el 2026-09-07, y sin ellos el
  // test de cobertura caia con razon: la puerta busca ocho formas y aqui habia seis generadores.
  // Es el mismo modo de fallo que ya cazo `third` --un patron en la puerta sin semilla aqui-- solo
  // que provocado por una FUSION en vez de por un anadido. El trinquete funciono: la puerta se lee.
  //
  // Partidos a proposito, como el PEM: escritos de una pieza, el escaner cazaria AL GENERADOR.
  literal: (sal) => `${['PASS','WORD'].join('')}${' '}= "${relleno(sal, 20, B64)}"`,
  realm: (sal) => `"${['ty','pe'].join('')}": "${['pass','word'].join('')}"  ${relleno(sal, 4, ALFA)}`,
};

/**
 * El hueco de la plantilla, y por que NO es `{}`.
 *
 * Una plantilla es un fichero REAL con un sitio donde va la credencial -- esa es
 * la propiedad que hace que la semilla sea codigo vivo y no un fichero suelto,
 * que es lo que tumbo las tres primeras versiones de H-002. Y en codigo real
 * `{}` aparece: MEDIDO, 110 ficheros del FE lo contienen (`catch {}`, `=> {}`,
 * tipos vacios). Con `{}` como marcador, sembrar cualquiera de esos 110 mete la
 * credencial en cada llave vacia del fichero.
 *
 * Un marcador tiene que ser algo que el codigo que se siembra no pueda contener.
 */
const HUECO = '{{CREDENCIAL}}';

/**
 * @returns la cadena sintetica, o null si el tipo no existe (y eso se dice, no se inventa).
 *
 * EL DETERMINISMO ES DELIBERADO, y tiene una consecuencia que hay que decir: hace
 * la REDACCION REVERSIBLE. `artifact.mjs` sustituye el valor por su sha256 corto
 * al escribir, pero la sal es el `executionId` y ese viaja DENTRO del propio
 * artefacto -- asi que quien tenga el artefacto y este codigo re-deriva el valor
 * exacto que se redacto.
 *
 * El sha256 corto NO protege un secreto: protege contra un VISTAZO, y las dos
 * cosas se confunden con facilidad seis meses despues.
 *
 * Por eso esto vale SOLO para valores sinteticos, que es para lo que existe. Si
 * algun dia se siembra con algo real --o alguien reutiliza esto para otra cosa--
 * la propiedad que hace util el determinismo es la misma que lo abre. Aviso de
 * third.
 */
export const credencialSintetica = (tipo, sal = 'doxia') =>
  (TIPOS[tipo] ? TIPOS[tipo](sal) : null);

/**
 * Resuelve el contenido de UNA semilla.
 *
 * `content` literal sigue funcionando --es lo que usa la semilla de XSS-- y
 * `generate` es lo nuevo: la spec dice QUE tipo y el harness pone el valor.
 * Los dos a la vez es un error, no una precedencia silenciosa: quien escribio la
 * spec no sabia cual quería.
 */
export function contenidoDeSemilla(s, { sal = 'doxia' } = {}) {
  const tieneContent = typeof s?.content === 'string';
  const tieneGenerate = typeof s?.generate === 'string';
  if (tieneContent && tieneGenerate) {
    throw new Error(`semilla '${s.path}': declara 'content' Y 'generate'. Elige uno`);
  }
  if (tieneGenerate) {
    const v = credencialSintetica(s.generate, sal);
    if (!v) throw new Error(`semilla '${s.path}': tipo '${s.generate}' desconocido. Hay: ${Object.keys(TIPOS).join(', ')}`);
    const plantilla = String(s.plantilla ?? `const CLAVE = "${HUECO}";\n`);
    // Sin hueco la credencial no entra en ninguna parte: la semilla siembra un
    // fichero LIMPIO, la puerta no muerde y el artefacto dice `detectada: false`
    // -- indistinguible de una puerta rota. Falla aqui, que es donde se ve.
    if (!plantilla.includes(HUECO)) {
      throw new Error(`semilla '${s.path}': la plantilla no tiene ${HUECO} donde poner la credencial`);
    }
    // `replaceAll` y no `replace`: con dos huecos, `replace` deja el segundo
    // literal dentro del fichero sembrado, o sea codigo roto por sorpresa.
    return plantilla.replaceAll(HUECO, v);
  }
  if (tieneContent) return s.content;
  throw new Error(`semilla '${s.path}': sin 'content' ni 'generate'`);
}
