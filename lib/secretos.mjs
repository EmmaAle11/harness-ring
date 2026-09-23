// node --test harness/lib/secretos.test.mjs
//
// UNA AUTORIDAD PARA LOS PATRONES. Vivian dentro de `trace.mjs`, que importa
// `artifact.mjs`; para redactar al ESCRIBIR hacia falta el sentido contrario, y
// eso es un ciclo. Copiar la lista al otro lado habria sido la segunda autoridad
// de siempre, sobre el hecho «que parece un secreto».
import { createHash } from 'node:crypto';

const SECRETOS = [
  [/\bAKIA[0-9A-Z]{16}\b/g, 'clave de acceso AWS'],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, 'clave de API estilo sk-'],
  [/\bghp_[A-Za-z0-9]{36}\b/g, 'token de GitHub'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./g, 'JWT'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/g, 'clave privada'],
  [/\b(?:authorization|api[_-]?key|secret)["'\s:=]+[A-Za-z0-9_\-.]{16,}/gi, 'credencial en clave/valor'],
];

/**
 * ¿Esto esta limpio de secretos?
 *
 * @returns [] si lo esta, o un hallazgo por patron encontrado.
 */
export function sinSecretos(objeto) {
  const texto = typeof objeto === 'string' ? objeto : JSON.stringify(objeto ?? {});
  return SECRETOS
    .filter(([re]) => { re.lastIndex = 0; return re.test(texto); })
    .map(([re, que]) => {
      re.lastIndex = 0;
      return { kind: que, sample: String(re.exec(texto)?.[0] ?? '').slice(0, 12) + '…' };
    });
}

/**
 * REDACTA conservando la comparabilidad.
 *
 * `sinSecretos` DETECTA y no impide nada: el artefacto se escribe con la clave
 * dentro y la deteccion sale meses despues, cuando alguien corre `doxia trace`.
 * Y el comentario de esa funcion ya decia por que importa: «una traza existe para
 * compartirse -- se sube como artefacto de CI».
 *
 * MEDIDO en H-20260824-fa058d63: la credencial que el harness SIEMBRA para h-007
 * aparece 19 veces en 3 artefactos (07-execution 7, 14-observability 6,
 * trace.json 6). Hoy es sintetica y no es una fuga -- pero el conducto ya esta
 * montado, y un escaner de secretos sobre los artefactos de CI va a morder por
 * algo que no es un defecto. Un falso positivo en un control compartido ensena a
 * ignorar el control. (lo midio third)
 *
 * NO se sustituye por una cadena fija: dos valores distintos quedarian iguales y
 * se perderia poder decir «este de aqui es el mismo de alla», que es justo lo que
 * hace falta para auditar una semilla. Va su sha256 corto.
 *
 * Se aplica al ESCRIBIR A DISCO, no al objeto que viaja entre etapas: Security
 * tiene que VER la credencial para cazarla; el artefacto no tiene que GUARDARLA.
 */
export function redactarSecretos(texto) {
  let t = String(texto ?? '');
  for (const [re, que] of SECRETOS) {
    re.lastIndex = 0;
    t = t.replace(re, (m) => {
      const h = createHash('sha256').update(m).digest('hex').slice(0, 8);
      return `«REDACTADO ${que} sha256:${h}»`;
    });
  }
  return t;
}
