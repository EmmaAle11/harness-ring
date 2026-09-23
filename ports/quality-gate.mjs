// ── PuertaDeCalidad (QualityGatePort) ────────────────────────────────────────
//
// El motor necesita saber DOS cosas de la puerta de calidad de un proyecto:
// si existe (antes de empezar) y que veredicto da (al terminar). Nada mas.
//
// POR QUE ASI DE PEQUENO. Aider resuelve esto con `--test-cmd`: un STRING de
// comando y un contrato de tres lineas --imprime en stdout/stderr y devuelve
// != 0--. Un puerto que preguntara «que framework de tests usas» reproduciria
// el acoplamiento en otra capa. Comando, codigo de salida, salida. Punto.
//
// La metrica de diseno que da el caso contrario: el Runtime abstracto de
// OpenHands crecio a 1.345 lineas antes de tener que extraerse a un repo aparte
// con aviso de deprecacion. Un puerto que necesita muchos metodos esta
// declarando que el nucleo se le esta filtrando dentro.
//
// LO QUE ESTE PUERTO ARREGLA: hoy `stages.mjs:32-34` compone
// join(ws,'scripts','gate.sh') en LOGICA y lanza si no existe -- en la etapa 15,
// tras 14 etapas y todas las llamadas al modelo. Con `disponible()` eso se
// pregunta en el segundo cero.

export const OPERACIONES = ['id', 'disponible', 'capabilities', 'ejecutar', 'rutaDeEvidencia', 'describe'];

/**
 * ADAPTADOR NULO — degradacion HONESTA.
 *
 * Responde NOT_CONFIGURED a todo y JAMAS devuelve PASS. Es el contrato que ya
 * estaba escrito en `divergencia-etapas.mjs:139` y `security-scan.mjs:98`
 * (`ausente()`), generalizado: un control que no corrio no es un control que
 * aprobo.
 *
 * El fallo que esto evita lo documenta `dominios.json` para este mismo repo:
 * con otra disposicion de carpetas todo caia a `plataforma`, que cuenta 0
 * dominios, y `maxDomains` aprobaba cualquier cosa en SILENCIO.
 */
export function puertaNula(porque = 'no hay puerta de calidad configurada') {
  return {
    id: () => 'nula',
    disponible: () => ({ ok: false, porque }),
    capabilities: () => ({ modos: [], escribeEvidencia: false }),
    ejecutar: () => ({
      veredicto: 'NOT_CONFIGURED', codigoSalida: null,
      stdout: '', stderr: porque, ms: 0,
    }),
    rutaDeEvidencia: () => null,
    describe: () => ({ id: 'nula', porque }),
  };
}

export function assertPuerta(p, quien = 'adaptador') {
  for (const op of OPERACIONES) {
    if (typeof p?.[op] !== 'function') {
      throw new Error(`${quien}: no cumple PuertaDeCalidad, falta '${op}()'`);
    }
  }
  return p;
}
