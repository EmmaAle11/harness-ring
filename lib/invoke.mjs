// Invocacion de una capacidad — capacidad + entrada -> artefacto tipado.
//
// MECANICA. El prompt se arma con tres piezas y en este orden:
//   1. el cuerpo del .md de la capacidad  (ES el prompt; ADR-001)
//   2. los artefactos que consume
//   3. la forma EXACTA del contrato que debe producir
//
// Un modelo local no siempre devuelve JSON limpio. Se extrae el primer objeto o
// array del texto y se reintenta una vez pidiendo solo JSON. Exigir obediencia
// perfecta al formato hace fallar corridas por una coma, no por el trabajo.
import { invoke as invokeModel } from '../adapters/models/index.mjs';
import { CONTRACTS, validate } from './artifact.mjs';
import { reduccionDe, reasoningEffortTruncado } from './tools.mjs';
import { preludio } from '../policy/preludio.mjs';

/** Describe el contrato al modelo con sus campos obligatorios. */
export function contractSpec(name) {
  const c = CONTRACTS.contracts[name];
  if (!c) throw new Error(`contrato desconocido: '${name}'`);
  const enums = Object.entries(c)
    .filter(([k, v]) => Array.isArray(v) && !['required', 'optional'].includes(k))
    .map(([k, v]) => `  ${k}: uno de ${JSON.stringify(v)}`);
  return [
    `Devuelve SOLO un objeto JSON con la forma del contrato '${name}'.`,
    `Proposito: ${c.why}`,
    `Campos OBLIGATORIOS: ${(c.required ?? []).join(', ')}`,
    c.optional?.length ? `Opcionales: ${c.optional.join(', ')}` : null,
    enums.length ? `Valores permitidos:\n${enums.join('\n')}` : null,
    c.$note ? `Nota: ${c.$note}` : null,
    'Sin texto alrededor del JSON.',
  ].filter(Boolean).join('\n');
}

/**
 * Lo que se le dice al modelo en el SEGUNDO intento.
 *
 * UNA REDUCCION, NO UN RUEGO. Decia «responde MUCHO mas corto» y nada mas, que
 * es pedir moderacion a quien acaba de gastar 32.768 tokens de salida. En
 * H-20260818-040baf77 el segundo intento se corto igual que el primero y la
 * vuelta murio en la etapa 9 con los dos agotados.
 *
 * `reduccion` la resuelve el CONTRATO, no el llamante: «maximo 3 hallazgos»
 * significa algo para un FindingSet y nada para un DecisionRecord. Vivio cableada
 * en la etapa 8 de stages-model.mjs, donde era una excepcion de una etapa; ahora
 * la declara `policy/tools.json:output.reduccion` y vale para las nueve.
 *
 * Aqui no se inventa -- sin ella queda el aviso generico, que es lo unico honesto
 * sin conocer el contrato.
 *
 * PURO y exportado: comprobarlo a traves de `invokeCapability` exigiria un
 * proveedor, y los modulos ESM no se pueden parchear.
 */
export function avisoDeReintento({ ultimo, truncado = false, reduccion } = {}) {
  return [
    `Tu respuesta anterior no se pudo usar: ${ultimo}. `,
    truncado
      ? `Te quedaste sin espacio de salida. ${reduccion ?? 'Responde MUCHO mas corto: solo lo mas grave, sin repetir el codigo citado. '}`
      : '',
    'Devuelve SOLO el JSON.',
  ].join('');
}

export function buildPrompt(capability, { stage, inputs = {}, extra = '', clase = null }) {
  // EL PRELUDIO VA ANTES DE LA TAREA, no despues en forma de hallazgo.
  // Medido el 2026-09-17 sobre harness/capabilities/: el `reviewer` declara los
  // 12 lentes y el `builder` NO declara ninguno -- quien escribe el codigo es el
  // unico que no sabe con que se le va a juzgar, y lo descubre en la etapa 09
  // cuando ya escribio. No son pesos: son reglas de entrada (noTraining intacto).
  const cls = clase ?? capability.model_class ?? null;
  const pre = cls ? preludio(cls, { capacidad: capability.id }) : '';
  const partes = [capability.prompt];
  if (pre) partes.push('\n\n---\n\n', pre);
  partes.push('\n\n---\n\n## Etapa: ', stage, '\n');
  for (const [nombre, art] of Object.entries(inputs)) {
    const cuerpo = JSON.stringify(art?.payload ?? art, null, 2);
    partes.push(`\n### Entrada — ${nombre}\n\n\`\`\`json\n${cuerpo.slice(0, 24000)}\n\`\`\`\n`);
  }
  if (extra) partes.push(`\n${extra}\n`);
  return partes.join('');
}

/** Primer objeto o array del texto. Mas robusto que exigir salida perfecta. */
export function parseJSON(raw) {
  const s = String(raw ?? '');
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(s);
  const cuerpo = fence ? fence[1] : s;
  const m = /[{[][\s\S]*[}\]]/.exec(cuerpo);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

/**
 * Invoca la capacidad y devuelve un payload que CUMPLE su contrato, o un error.
 * Un reintento: el primero suele fallar por formato, no por contenido.
 */
/**
 * La REDUCCION no es un parametro: sale del contrato. Pasarla desde la etapa
 * dejaba a cada llamante inventarse la suya -- ocho de nueve no la pasaban -- y
 * convertia en excepcion lo que es una propiedad del artefacto.
 */
// QUE DEVOLVIO, no solo que no valia.
//
// Un fallo por parseo se reportaba como 'no devolvio JSON reconocible' y `raw` se
// perdia ahi mismo: el unico dato que distingue un modelo que se fue por las ramas
// de un prompt roto, de una respuesta vacia, de una disculpa en prosa. Sin el, la
// etapa falla con un motivo INFALSIFICABLE -- y la regla #0 de este repo dice que
// sin evidencia no hay avance.
//
// MEDIDO en H-20260820-e6415189: la etapa 1 murio con 2 llamadas, `failed: 0` y
// 240 s. El proveedor respondio las dos veces y no quedo ni un caracter de lo que
// dijo, asi que no habia forma de saber si la causa estaba en el modelo o en un
// cambio del harness hecho quince minutos antes.
//
// Se recorta a 300: es una MUESTRA para diagnosticar, no la respuesta. Un `raw` de
// 30 KB dentro del motivo de fallo llenaria la traza con lo que ya se descarto.
const MUESTRA_RAW = 300;
export const muestraDe = (raw) => {
  const t = String(raw ?? '').trim();
  if (!t) return 'la respuesta venia VACIA';
  return t.length <= MUESTRA_RAW
    ? `devolvio: ${JSON.stringify(t)}`
    : `devolvio ${t.length} chars, empiezan por: ${JSON.stringify(t.slice(0, MUESTRA_RAW))}`;
};

export async function invokeCapability(
  capability, assignment, { stage, contract, inputs, extra, timeoutMs, exige, clase } = {},
) {
  const base = buildPrompt(capability, { stage, inputs, extra, clase });
  const reduccion = reduccionDe(contract);
  let ultimo = null;

  let truncado = false;

  for (const intento of [1, 2]) {
    const prompt = intento === 1
      ? `${base}\n\n${contractSpec(contract)}`
      : `${base}\n\n${contractSpec(contract)}\n\n${avisoDeReintento({ ultimo, truncado, reduccion })}`;

    let raw;
    try {
      // El adaptador devuelve un ExecutionResult normalizado; aqui solo interesa
      // el texto. Que sea la MISMA forma para los cuatro proveedores es lo que
      // permite que este bucle no sepa a cual esta llamando.
      // EL SEGUNDO INTENTO NO REPITE EL MISMO ESFUERZO. Si el primero se trunco,
      // lo medido es que el presupuesto se fue en RAZONAMIENTO -- 32768 de 32768
      // en H-20260819-4b5c6d6d, cero tokens de respuesta--, y contra eso un
      // prompt mas corto no puede nada: acota lo que se responde, no lo que se
      // piensa. Se apaga el pensamiento y se cobra la respuesta.
      //
      // Solo tras el truncado, y solo para esta llamada: `low` sigue siendo la
      // politica por defecto porque una revision adversarial TIENE que razonar.
      ({ text: raw } = await invokeModel(assignment, prompt, {
        timeoutMs,
        ...(truncado ? { reasoningEffort: reasoningEffortTruncado() } : {}),
      }));
    } catch (e) {
      // `code` viene normalizado (AUTH_FAILURE, TIMEOUT, CONTEXT_OVERFLOW...).
      // Un fallo NO reintentable no mejora repitiendo el prompt: se corta aqui en
      // vez de gastar el segundo intento en un error determinista.
      ultimo = `fallo al invocar ${assignment.provider}: [${e.code ?? 'DESCONOCIDO'}] ${e.detail ?? e.message}`;
      truncado = e.code === 'OUTPUT_TRUNCATED';
      if (e.retryable === false) break;
      continue;
    }

    const payload = parseJSON(raw);
    if (!payload) { ultimo = `no devolvio JSON reconocible; ${muestraDe(raw)}`; continue; }

    // EL CONTRATO ESTATICO Y LO QUE EXIGE ESTA VUELTA, por la misma puerta.
    //
    // `contracts.json` declara la FORMA -- que campos hay-- y no puede declarar lo
    // que depende de la corrida: «cita el executionId de la vuelta anterior» nombra
    // un id que no existe hasta que la vuelta empieza. Sin este hueco, esa clase de
    // requisito solo podia vivir en el texto del prompt, donde nadie la comprueba.
    //
    // Va por el MISMO camino que `validate` a proposito: lo que falta vuelve al
    // modelo con `avisoDeReintento` y se reintenta, en vez de tumbar la etapa por
    // un olvido que una segunda pasada arregla.
    const faltan = [...validate(contract, payload), ...(exige?.(payload) ?? [])];
    if (faltan.length) { ultimo = `incumple ${contract}: ${faltan.join(', ')}`; continue; }

    return { ok: true, payload, raw, intento };
  }

  // Se agota y se REPORTA. No se inventa un payload por defecto: un artefacto
  // fabricado para que la etapa avance es el peor resultado posible.
  return { ok: false, error: ultimo };
}
