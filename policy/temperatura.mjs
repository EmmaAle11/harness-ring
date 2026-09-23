/**
 * LA TEMPERATURA NO ES UNA CONSTANTE DEL PROVEEDOR: ES UNA PROPIEDAD DE LA TAREA.
 *
 * Los tres adaptadores que la aceptan llevaban `temperature: 0.1` escrito a mano,
 * sin justificacion registrada. Y 0.1 no es lo mismo para inventariar que para
 * refutar: `read` cuenta ficheros --una respuesta correcta-- y `review` busca lo
 * que el escritor NO vio, que es exactamente donde un poco de dispersion ayuda.
 *
 * MEDIDO el 2026-09-15 (h-008, 3 vueltas por brazo):
 *
 *   temp 0.1 -> 7,00 etapas ejecutadas de media · s^2 inter-vuelta 0,00
 *   temp 0.5 -> 5,00 etapas ejecutadas de media · s^2 inter-vuelta 2,00
 *               (-28,57%; una vuelta murio en la etapa 1)
 *
 * Asi que 0.5 es demasiado PARA TODO. Lo que no se probo es si 0.5 era demasiado
 * para `review` o solo para las clases donde un desvio se propaga. Esta tabla
 * separa las dos preguntas y deja cada clase con un valor que se puede refutar
 * por separado.
 *
 * EL LIMITE, declarado: `claude` es un CLI (`claude -p`) y NO acepta temperatura.
 * Las clases `plan`, `design` y `edit` estan servidas por claude segun
 * `policy/router.json`, asi que esta tabla NO las gobierna hoy -- se declaran
 * igualmente para que el dia que un proveedor con API cubra esas clases el valor
 * ya este escrito y medido, en vez de heredar el 0.1 por defecto.
 */

/**
 * @type {Record<string, {t: number, why: string}>}
 */
const POR_CLASE = {
  read: {
    t: 0.0,
    why: 'Inventariar, contar, leer 1:1. Hay UNA respuesta correcta y la dispersion solo puede alejarse de ella.',
  },
  review: {
    t: 0.3,
    why: 'Refutar exige ver lo que el escritor no vio. 0.5 degrado el anillo un 28,57%; 0.3 es un paso MEDIDO hacia abajo desde el valor que fallo, no una apuesta nueva.',
  },
  plan: {
    t: 0.1,
    why: 'Decide el orden, no el contenido. Hoy lo sirve claude (CLI): declarado, no aplicado.',
  },
  design: {
    t: 0.1,
    why: 'El error se propaga a todo lo que cuelga de la spec. Hoy lo sirve claude (CLI): declarado, no aplicado.',
  },
  edit: {
    t: 0.0,
    why: 'El error entra al arbol y es el unico escritor. Hoy lo sirve claude (CLI): declarado, no aplicado.',
  },
};

/** El valor de siempre, para lo que no declara clase. */
export const TEMPERATURA_POR_DEFECTO = 0.1;

/**
 * @param {string|null|undefined} clase
 * @returns {number} temperatura en [0,1]
 */
export function temperaturaDe(clase) {
  const e = POR_CLASE[String(clase ?? '').toLowerCase()];
  return e ? e.t : TEMPERATURA_POR_DEFECTO;
}

/** Por que ese numero. Para que el artefacto lo pueda citar. */
export function motivoDeTemperatura(clase) {
  const e = POR_CLASE[String(clase ?? '').toLowerCase()];
  return e ? e.why : 'clase no declarada: se usa el valor por defecto';
}

/** Las clases con temperatura declarada. */
export function clasesConTemperatura() {
  return Object.keys(POR_CLASE);
}
