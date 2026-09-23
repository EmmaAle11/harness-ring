// El bucle agentico — Execution deja de ser un disparo.
//
//   MODEL -> ToolCall -> POLICY -> SANDBOX -> ToolResult -> MODEL -> ...
//                                                              |
//                                                DONE | BLOCKED | FAILED
//
// LO QUE ESTO CIERRA. El revisor adversarial de la vuelta H-20260816-ec7c627f lo
// dijo antes que nadie: el builder no podia ejecutar los tests que escribia, asi
// que «los tests pasan» era siempre una afirmacion suya, nunca un hecho. Un
// modelo que no puede observar el resultado de su cambio no esta corrigiendo:
// esta adivinando con mas contexto.
//
// QUIEN MANDA. El bucle es del HARNESS. El modelo no controla cuantas vueltas
// da, ni cuanto tarda, ni que se ejecuta: propone una llamada y recibe un
// resultado. Los cuatro topes viven en policy/tools.json y ninguno es negociable
// desde el prompt -- un limite que el modelo puede pedir que se levante no es un
// limite.
//
// PURO salvo por `invoke`, que se inyecta: los tests del bucle no gastan un token.
import { parseJSON, muestraDe } from './invoke.mjs';
import { loadToolPolicy, runTool, toolCatalogText } from './tools.mjs';
import { invoke as invokeModel } from '../adapters/models/index.mjs';
import { loadCatalog } from './capabilities.mjs';
import { veredictoRho } from './rho-gate.mjs';

export const ESTADOS = ['DONE', 'BLOCKED', 'FAILED', 'NO_CHANGE_REQUIRED'];

/**
 * ¿Ese `done` esta respaldado?
 *
 * EL DEFECTO MEDIDO. H-20260817-009c7621 murio en su rework 4 porque el builder
 * declaro DONE tras 15 llamadas y CERO mutaciones. La etapa lo cazaba --pero
 * solo en un rework, y mirando el WORKSPACE, que en un reintento ya trae los
 * cambios del intento anterior. En la primera pasada el mismo `done` vacio
 * habria pasado, y el anillo habria recorrido 16 etapas sobre un diff prestado.
 *
 * Aqui la comprobacion es CONTRACTUAL y vive donde se emite el `done`, asi que
 * no depende ni de la etapa ni de que el modelo se porte bien. Y no es una
 * pared: el rechazo VUELVE al modelo con las dos salidas legitimas delante --
 * mutar, o declarar `no_change_required`.
 *
 * `NO_CHANGE_REQUIRED` no es un `done` mas barato: es una AFIRMACION distinta,
 * queda en el artefacto como tal, y la etapa decide si la tarea la admitia.
 * Fundirlas en un estado seria dejar que «no hice nada» y «no hacia falta hacer
 * nada» se escriban igual, que es exactamente lo que hay que poder distinguir.
 *
 * PURO y exportado: comprobarlo a traves de una vuelta costaria 45 minutos.
 *
 * @returns [] si el `done` se sostiene, o los motivos por los que no.
 */
export function faltaParaDone({ mutations = [], toolCalls = [] } = {}) {
  const faltan = [];
  if (!mutations.some((m) => m.changed !== false)) {
    faltan.push('no has aplicado ninguna mutacion: el workspace no registra un solo cambio tuyo');
  }
  if (!toolCalls.some((c) => c.allowed && /^run_/.test(String(c.tool)))) {
    faltan.push('no has EJECUTADO nada que lo demuestre: falta run_test, run_typecheck o run_gate');
  }
  return faltan;
}

/** El protocolo, generado del registro: si se anade una tool, el prompt la conoce. */
export const protocolo = () => [
  '## Herramientas\n\nNo escribes ficheros tu mismo: los PIDES. En cada turno devuelves',
  ' UN solo objeto JSON, sin texto alrededor, con una de estas tres formas:\n\n',
  '1. Pedir una herramienta:  {"tool":"read_file","args":{"path":"src/x.ts"}}\n',
  '2. Terminar:               {"done":true,"summary":"que hiciste y que lo demuestra"}\n',
  '3. Rendirte con motivo:    {"blocked":true,"reason":"por que no se puede"}\n\n',
  'Catalogo:\n\n', toolCatalogText(), '\n\n',
  'Todas las rutas son RELATIVAS a la raiz del workspace. Una ruta fuera del',
  ' workspace se rechaza y pierdes el turno. Una herramienta que no este en el',
  ' catalogo no existe.\n\n',
  'AQUI NO TIENES TUS PROPIAS HERRAMIENTAS. Si tu entorno te ofrece Write, Edit,',
  ' Bash o similares, en esta ejecucion NO funcionan: no hay nadie escuchandolas.',
  ' Que fallen no significa que no puedas escribir -- significa que estas usando',
  ' el canal equivocado. Tu unica forma de actuar es devolver el objeto JSON, y el',
  ' harness ejecuta por ti. Medido: una vuelta murio en `blocked` porque el builder',
  ' intento Write y Edit, se le rechazaron, y concluyo que no podia escribir nada.\n\n',
  '## Leer: el simbolo antes que el fichero\n\n',
  '`read_file` SIN `limit` te devuelve una VENTANA, y te dice cual: `[lineas 1-N de',
  ' TOTAL]`. Si TOTAL es mucho mayor que lo que ves, NO has leido el fichero.\n\n',
  'Para un fichero grande, pide `read_symbol`: el harness tiene indexado el',
  ' repositorio entero -- ficheros, simbolos exportados, metodos de clase y su rango',
  ' de lineas-- y te devuelve solo ese rango. Medido: `backend/src/aafa/aafa.service.ts`',
  ' son 20.523 lineas y exporta DOS simbolos, pero sus 223 metodos tienen una mediana',
  ' de 24 lineas. `read_symbol` es la diferencia entre poder tocar ese fichero y no.\n\n',
  'El indice dice DONDE, nunca QUE hace. No cites el indice como evidencia de nada:',
  ' para afirmar algo del codigo, hay que haberlo leido.\n\n',
  '## Escribir: baseHash\n\n',
  'No se aplica un cambio contra una version desconocida. Toda escritura sobre algo',
  ' que YA existe declara `baseHash`: el hash que viste. Lo obtienes de tres sitios,',
  ' y no hace falta gastar una llamada extra:\n\n',
  '- `read_file` lo devuelve en la primera linea, `[sha xxxx]`\n',
  '- `inspect_file` lo devuelve sin traerte el contenido\n',
  '- cada mutacion tuya devuelve el `after`, que es el `baseHash` de la siguiente\n\n',
  '`create_file` SIN `baseHash` afirma que el fichero no existe; si existe, se rechaza.',
  ' Para reescribir uno existente, pasa su `baseHash`.\n\n',
  'Si recibes MUTATION_CONFLICT, el fichero cambio debajo de ti: vuelve a leerlo antes',
  ' de reintentar. No insistas con el mismo hash.\n\n',
  '## Cuando terminar\n\n',
  '`done` es CONTRACTUAL, no una declaracion. Se rechaza si no viene con lo que lo',
  ' respalda: al menos una mutacion aplicada y al menos una ejecucion (`run_test`,',
  ' `run_typecheck` o `run_gate`). Si de verdad crees que la tarea no exige cambiar',
  ' nada, esa es OTRA respuesta y tiene su forma propia:\n\n',
  '   {"no_change_required":true,"reason":"por que el codigo ya cumple, con la evidencia que lo prueba"}\n\n',
  'Un `done` sin mutaciones NO es «no hacia falta cambiar nada»: son dos cosas',
  ' distintas y el harness no puede adivinar cual quisiste decir.\n\n',
  'No declares `done` sin haber EJECUTADO lo que lo demuestra: `run_test` en rojo',
  ' es un resultado util, inventarse que paso no lo es.\n\n',
  'Pero tampoco sigas despues de verde. En cuanto se cumplan las tres cosas a la vez',
  ' --toda la aceptacion cubierta, `run_test` en verde y `run_typecheck` en verde--',
  ' declara `done`. Medido: en H-20260816-d36ae6bc el builder alcanzo un estado verde',
  ' CUATRO veces, siguio tocando despues de cada uno y agoto el presupuesto sin',
  ' entregar nada. Un cambio que ya pasa y se sigue puliendo es trabajo que se pierde',
  ' entero, no trabajo de mas.\n\n',
  'Si crees que falta algo y no sabes como comprobarlo, es `done` con el summary',
  ' diciendolo, no una vuelta mas.\n',
].join('');

const N = (s) => String(s ?? '').length;

/**
 * Recorta el historial por el MEDIO. La cabeza es la tarea y la cola es lo
 * reciente; lo que sobra esta en medio. Recortar por el final le quitaria al
 * modelo justo lo que acaba de observar, y volveria a proponer lo que ya fallo.
 */
export function podar(turnos, tope) {
  let total = turnos.reduce((s, t) => s + N(t), 0);
  let i = 1;
  while (total > tope && i < turnos.length - 2) {
    total -= N(turnos[i]);
    turnos[i] = '[turno recortado por el limite de transcripcion del harness]';
    total += N(turnos[i]);
    i++;
  }
  return turnos;
}

/**
 * @param cap        el manifiesto de la capacidad (quien autoriza)
 * @param assignment {provider, model} que resolvio Compute
 * @param task       el texto de la tarea: objetivo, aceptacion, ficheros
 * @param workspace  el Workspace del sandbox
 * @returns {{status, iterations, toolCalls, ms, final, stop}}
 */
/**
 * El presupuesto del bucle, por CLASE DE CAMBIO.
 *
 * Habia un solo tope para las cinco formas de trabajo, y el unico calibrado era el
 * de una extraccion -- la nota de `policy/tools.json` lo dice: «una tarea de cuatro
 * ficheros necesita del orden de 20 llamadas». Una mudanza no tiene esa forma: son
 * DOS mutaciones por fichero (mover y recablear) mas los importadores externos, y
 * cada mutacion cuesta ademas la llamada que la situa.
 *
 * MEDIDO en H-20260820-02e22ced, la primera vuelta en que el trabajo se completo:
 * 14 mutaciones, 6 renombrados con `similarity index 100%`, 9 ficheros, typecheck
 * en VERDE y tests en VERDE... en la llamada 38 de la iteracion 40. El tope cayo
 * encima del ultimo verde y no quedo una sola llamada para declarar `done`.
 *
 * Esto NO es subir un numero contra un fallo sin diagnosticar, que es justo lo que
 * la calibracion de `tools.json` prohibe. Las cuatro causas de desperdicio se
 * corrigieron primero -- el sha en `list_files`, el contexto de `apply_patch`, la
 * evidencia que sobrevive y el manifiesto-- y el desperdicio bajo de 16 llamadas a
 * 7. Lo que queda es tamano de tarea, y el eje por el que se mide ya existe: es el
 * mismo `changeClass` con el que C-5 dimensiona la superficie.
 *
 * Las clases sin entrada propia NO se mueven.
 */
/**
 * EL TECHO DE TRANSCRIPCION ES DEL MODELO, no del bucle.
 *
 * `maxTranscriptChars` era UN numero global para once modelos cuyas ventanas de
 * contexto van de 32 768 a 262 144 tokens. Derivando la capacidad de cada uno, el
 * 60000 de siempre resulta ser el de `qwen2.5-coder` --61 728-- y ocho veces
 * corto para todos los demas. Es `el-limite-medido-sobre-la-poblacion-equivocada`
 * en el sitio que decide cuanto puede leer una vuelta.
 *
 * Y es el mismo argumento que ya gano `maxOutputTokens`, que se declara por
 * PROVEEDOR: el techo lo pone quien sirve el modelo, no quien lo usa.
 *
 * LA CAPACIDAD SALE DE CIFRAS QUE EL REPO YA TIENE, no de una fraccion inventada:
 *
 *   (ventana - lo que puede gastar en SALIDA - el prompt fijo) x chars por token
 *
 * `maxOutputTokens[proveedor]` en `null` significa NO LO ACEPTA --los CLI-- y no
 * «no gasta»: se reserva el mayor techo declarado, que es la lectura prudente.
 *
 * Y ARRIBA LO ACOTA `turnosUtiles`, que es lo que impide que esto se convierta en
 * meter el repositorio en el contexto -- justo lo que ADR-008 prohibe. `podar`
 * recorta por el MEDIO conservando cabeza y cola, asi que el bucle no necesita
 * recordar sus 140 llamadas: necesita que no se le borre lo que acaba de observar.
 *
 * PURO: recibe el catalogo y la politica. Quien los carga es el llamante.
 */
export function topeDeTranscripcion(assignment, { catalog, policy } = {}) {
  const suelo = policy?.loop?.maxTranscriptChars ?? 60000;
  const t = policy?.loop?.transcript ?? {};
  // UN TECHO FIJO MANDA SOBRE TODO LO DEMAS, y existe porque la clave anterior
  // hacia DOS trabajos: «cuanto doy cuando no se nada del modelo» y «cuanto se me
  // permite dar como maximo». Al derivar el segundo, el primero dejo de poder
  // bajar el tope -- y quien lo pusiera a proposito, por coste o en un test, se
  // lo encontraba ignorado. Un nombre para dos hechos opuestos, otra vez.
  if (typeof t.techoFijo === 'number') return t.techoFijo;
  const cpt = t.charsPorToken ?? 3;
  const margen = t.margenPromptTokens ?? 4000;
  const turnos = t.turnosUtiles ?? 10;

  const lista = catalog?.models ?? [];
  const m = lista.find((x) => x?.provider === assignment?.provider
    && (x?.model_id === assignment?.model || x?.model === assignment?.model));
  const ventana = m?.context_window;
  // DESCONOCIDO NO ES ILIMITADO. Un modelo que no esta en el catalogo, o que no
  // declara ventana, se queda en el suelo: es el unico numero que se sabe seguro.
  if (!ventana) return suelo;

  const techos = policy?.output?.maxOutputTokens ?? {};
  const declarados = Object.values(techos).filter((v) => typeof v === 'number');
  const salida = techos[assignment?.provider] ?? (declarados.length ? Math.max(...declarados) : 32768);

  const capacidad = Math.max(0, ventana - salida - margen) * cpt;
  const arriba = (policy?.loop?.maxToolResultChars ?? 8000) * turnos;
  return Math.max(suelo, Math.min(capacidad, arriba));
}

export function presupuestoDe(policy, clase) {
  const extra = policy?.loop?.byClass?.[clase];
  return extra ? { ...policy, loop: { ...policy.loop, ...extra } } : policy;
}

export async function toolLoop({
  cap, assignment, task, workspace, policy = loadToolPolicy(),
  invoke = invokeModel, log = () => {},
} = {}) {
  const L = policy.loop;
  // Del MODELO asignado, no del bucle. Se resuelve una vez: el assignment no
  // cambia dentro de una etapa, y recalcularlo por iteracion seria releer el
  // catalogo 140 veces para obtener el mismo numero.
  const topeTranscripcion = topeDeTranscripcion(assignment, { catalog: loadCatalog(), policy });
  const t0 = Date.now();
  const toolCalls = [];
  const mutations = [];
  // Uso REPORTADO por el proveedor, no estimado. deepseek y ollama lo publican en
  // `raw`; los CLI no. Queda `null` cuando nadie lo dijo, y esa es la respuesta
  // honesta -- un cero seria mentira y una estimacion pareceria una medida.
  let usage = null;
  const turnos = [`${cap.prompt}\n\n---\n\n${protocolo()}\n\n---\n\n## Tarea\n\n${task}`];

  let iterations = 0;
  let ilegibles = 0;
  let final = null;
  const parar = (status, stop) => ({ status, stop, iterations, toolCalls, mutations, usage, ms: Date.now() - t0, final });

  while (true) {
    if (iterations >= L.maxIterations) return parar('FAILED', `tope de ${L.maxIterations} iteraciones agotado`);
    if (toolCalls.length >= L.maxToolCalls) return parar('FAILED', `tope de ${L.maxToolCalls} llamadas agotado`);
    if (Date.now() - t0 >= L.maxWallMs) return parar('FAILED', `tope de ${L.maxWallMs} ms agotado`);

    // rho-gate: densidad de accion. Un builder que dejo de TOCAR el repositorio
    // no se recupera -- las 6 vueltas del historico que agotaron el tope ya lo
    // habian delatado con rho <= 0.375, frente al [0.900 .. 0.958] de las 14 que
    // acabaron en OK. Cortar aqui ahorra 342 de 663 iteraciones (51,6%).
    // Se consulta junto a los demas topes porque ES un tope: uno que mide
    // conducta en vez de contar. `L.rhoSombra` lo deja midiendo sin decidir.
    // El modo sombra se activa por ENTORNO, no editando la policy: el workspace
    // de la vuelta se construye desde HEAD, asi que un cambio en el arbol de
    // trabajo NO llegaria a la corrida. `DOXIA_RHO_SOMBRA=1` si viaja.
    const rhoSombra = L.rhoSombra === true || process.env.DOXIA_RHO_SOMBRA === '1';
    const rg = veredictoRho({ iterations, toolCalls: toolCalls.length, sombra: rhoSombra });
    if (rg.parar) return parar('FAILED', rg.reason);

    iterations++;
    podar(turnos, topeTranscripcion);

    let texto, res;
    try {
      // `cwd` en el workspace: los proveedores CLI traen sus propias tools y sin
      // esto las ejercerian sobre el arbol principal. El sandbox tiene que valer
      // tambien para lo que el harness no invoca.
      // Dos relojes, y hacen falta los dos: `maxCallMs` acota UNA llamada y
      // `maxWallMs` el bucle entero. Con uno solo, una invocacion colgada se come
      // el presupuesto de toda la etapa y el bucle nunca llega a reaccionar.
      res = await invoke(assignment, turnos.join('\n\n'), {
        timeoutMs: Math.max(1, Math.min(L.maxCallMs ?? L.maxWallMs, L.maxWallMs - (Date.now() - t0))),
        cwd: workspace?.path ?? null,
      });
      texto = res.text;
      // Del `usage` NORMALIZADO del adaptador, no de `raw`: `raw.total_tokens`
      // es la forma de deepseek y ollama nunca la tuvo, asi que el bucle contaba
      // cero tokens en toda vuelta local. La traduccion es del adaptador.
      if (res.usage?.totalTokens != null) {
        usage ??= { totalTokens: 0, tokensInput: 0, tokensOutput: 0, calls: 0 };
        usage.totalTokens += res.usage.totalTokens;
        usage.tokensInput += res.usage.tokensInput ?? 0;
        usage.tokensOutput += res.usage.tokensOutput ?? 0;
        usage.calls++;
      }
    } catch (e) {
      // Un fallo determinista no mejora repitiendo: se corta aqui en vez de
      // gastar el resto del presupuesto en el mismo error.
      if (e.retryable === false) return parar('FAILED', `[${e.code}] ${e.detail ?? e.message}`);
      turnos.push(`[el proveedor fallo: ${e.code ?? 'DESCONOCIDO'}. Reintenta con una peticion mas pequena]`);
      continue;
    }

    const msg = parseJSON(texto);
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      if (++ilegibles >= L.maxConsecutiveUnparsable) {
        // QUE DEVOLVIO, no solo que no valia. Es el mismo hueco que `invokeCapability`
        // ya cerro esta manana, sin cerrar en este bucle: `texto` moria en esta linea
        // y el motivo quedaba infalsificable -- no distingue un modelo que se fue por
        // las ramas de una respuesta vacia o de un prompt roto.
        //
        // MEDIDO en H-20260820-5d727519, dentro de la primera campana: el item
        // cm-3-por-simbolo cayo aqui con 8 llamadas ya aplicadas y no quedo un solo
        // caracter de las tres respuestas que lo tumbaron. `gate-cambiado-consumidores-
        // olvidados` aplicado a un patron: se arreglo en una puerta y no en la de al lado.
        return parar('FAILED', `${ilegibles} respuestas seguidas sin JSON reconocible; ${muestraDe(texto)}`);
      }
      turnos.push('[tu respuesta no era un objeto JSON. Devuelve SOLO el objeto, sin texto alrededor]');
      continue;
    }
    ilegibles = 0;

    if (msg.no_change_required) {
      final = msg;
      return parar('NO_CHANGE_REQUIRED', msg.reason ?? 'sin motivo');
    }
    if (msg.done) {
      const faltan = faltaParaDone({ mutations, toolCalls });
      if (!faltan.length) { final = msg; return parar('DONE', null); }
      // Se RECHAZA y se le dice por que, con las dos salidas legitimas delante.
      // Contarlo como iteracion perdida seria castigar sin ensenar; devolverselo
      // es lo que convierte el contrato en algo que puede cumplir.
      turnos.push(
        `[DONE RECHAZADO por el harness] ${faltan.join(' · ')}.\n`
        + 'O aplicas el cambio y lo ejecutas, o declaras {"no_change_required":true,"reason":"..."} '
        + 'si sostienes que la tarea no exige tocar nada. Un `done` vacio no es ninguna de las dos.',
      );
      continue;
    }
    if (msg.blocked) { final = msg; return parar('BLOCKED', msg.reason ?? 'sin motivo'); }
    if (!msg.tool) {
      turnos.push('[ni `tool`, ni `done`, ni `blocked`. Elige una de las tres formas]');
      continue;
    }

    const r = await runTool({ tool: msg.tool, args: msg.args ?? {} }, { cap, ws: workspace, policy });
    toolCalls.push({ n: toolCalls.length + 1, iteration: iterations, ...r });
    if (r.mutation) mutations.push({ n: mutations.length + 1, toolCall: toolCalls.length, ...r.mutation });

    const negado = !r.allowed || r.rule === 'mutation';
    log(`      ${negado ? 'DENY' : 'tool'} ${String(msg.tool).padEnd(14)} `
      + (negado ? `${r.code ?? r.rule}: ${String(r.error).slice(0, 90)}` : `exit=${r.exitCode ?? 0} ${r.ms}ms`));

    // El rechazo VUELVE al modelo. Esa es la diferencia entre una politica que
    // ensena y una que solo castiga: si no ve por que se le nego, repite.
    //
    // Y el `after` vuelve tambien: es el baseHash de la mutacion siguiente, asi
    // que darselo aqui evita una relectura por cada escritura encadenada.
    turnos.push(
      `[peticion ${toolCalls.length}] ${JSON.stringify({ tool: msg.tool, args: msg.args ?? {} })}\n`
      + (negado
        ? `[RECHAZADO por el harness · ${r.code ?? `regla '${r.rule}'`}]\n${r.error}`
        : `[resultado exit=${r.exitCode}]${r.mutation ? ` [sha ahora ${r.mutation.after}]` : ''}\n${r.output ?? ''}`),
    );
  }
}
