import { readFileSync } from 'node:fs';
// Change Surface — cuanto pretende cambiar el agente, ANTES de dejarle hacerlo.
//
// LA TESIS, y esta medida en este repositorio. H-20260817-f00dd8f2 dejo la frase
// que abre la Fase 11: «cada correccion escribe codigo nuevo y el revisor
// encuentra hallazgos nuevos EN EL, ~2 por ronda, sostenido». Si cada linea
// nueva es superficie donde aparecen hallazgos, entonces la superficie no es una
// metrica de estilo: es la variable que gobierna si la vuelta converge.
//
//   ChangeSet pequeno -> menos superficie -> menos hallazgos nuevos
//                     -> menos reworks    -> mas probabilidad de cerrar
//
// DOS MOMENTOS, y hacen falta los dos, porque cada limite se puede comprobar
// donde existe su dato:
//
//   PLANIFICADA  del WorkPackage, ANTES de Execution
//                ficheros, modulos, dominios, superficie de test
//   MEDIDA       del ChangeSet, DESPUES
//                lo anterior + lineas anadidas y borradas
//
// Las lineas no se pueden conocer antes de escribirlas, y fingir que si --pedirle
// al modelo que las estime-- seria dejar que el modelo declare su propio limite,
// que es lo que la fase prohibe explicitamente.
//
// PURO: sin E/S. La politica entra como argumento.

/**
 * LA TAXONOMIA ES CONFIGURACION, NO CODIGO.
 *
 * Aqui vivian `SISTEMAS = ['aafa', 'sipca', ...]`, `ALIAS_DE_SISTEMA` y un regex
 * con `src/app|backend/src`: las tres cosas ciertas para DoxIA y falsas para
 * cualquier otro repo. Un harness que aspira a ser el cuerpo donde cualquier
 * sistema se automatice no puede traer los organos de uno solo.
 *
 * Y fallaba EN SILENCIO: con otra disposicion de carpetas todo caia a
 * `plataforma`, que cuenta 0 dominios, asi que `maxDomains` --el guard que impide
 * que una vuelta toque dos sistemas a la vez-- aprobaba cualquier cosa.
 *
 * El motor LEE la taxonomia; no la sabe. Se edita `harness/policy/dominios.json`.
 * El razonamiento de cada entrada (por que existe el alias `archivero`, por que
 * `plataforma` no es un sistema) viaja en ese fichero, junto al dato.
 */
const RUTA_DOMINIOS = new URL('../policy/dominios.json', import.meta.url);

/**
 * Normaliza una taxonomia. Acepta un objeto suelto --para tests y para un
 * proyecto que la construya en memoria-- o lee el fichero de policy.
 *
 * NO ADIVINA: sin `sistemas` declarados, todo es `plataforma`. Inventar dominios
 * a partir del nombre de la carpeta haria que `maxDomains` contara sistemas que
 * nadie declaro, que es peor que no contar ninguno: un guard que se inventa su
 * propia unidad de medida no protege nada.
 */
export function cargarDominios(cfg) {
  const raw = cfg ?? JSON.parse(readFileSync(RUTA_DOMINIOS, 'utf8'));
  return {
    sistemas: Array.isArray(raw.sistemas) ? raw.sistemas : [],
    alias: raw.alias && typeof raw.alias === 'object' ? raw.alias : {},
    basePaths: Array.isArray(raw.basePaths) && raw.basePaths.length ? raw.basePaths : [],
  };
}

let _porDefecto = null;
const porDefecto = () => (_porDefecto ??= cargarDominios());

/** Compatibilidad: la lista viva de sistemas del proyecto configurado. */
export const SISTEMAS = new Proxy([], {
  get: (_, k) => Reflect.get(porDefecto().sistemas, k),
  has: (_, k) => Reflect.has(porDefecto().sistemas, k),
  ownKeys: () => Reflect.ownKeys(porDefecto().sistemas),
  getOwnPropertyDescriptor: (_, k) =>
    Reflect.getOwnPropertyDescriptor(porDefecto().sistemas, k),
});

/**
 * El sistema al que pertenece una ruta, o `plataforma` si es transversal.
 *
 * `plataforma` NO es un sistema: es la ausencia de uno. La distincion la midio
 * el test antes que la lectura -- contandola como dominio propio, la tarea H-001
 * daba 2 dominios (`src/lib` + `src/app/admin`) y el presupuesto bloqueaba la
 * unica forma de cambio que este repo declara como buena: el fichero puro
 * extraido y su llamante. Lo que `maxDomains` protege es que una vuelta no toque
 * DOS SISTEMAS a la vez, no que no toque codigo compartido.
 */
export function dominioDe(path, cfg) {
  const { sistemas, alias, basePaths } = cfg ?? porDefecto();
  const ruta = String(path ?? '');
  for (const base of basePaths) {
    const pref = `${base}/`;
    if (!ruta.startsWith(pref)) continue;
    const seg = ruta.slice(pref.length).split('/')[0];
    if (!seg) continue;
    const d = alias[seg] ?? seg;
    return sistemas.includes(d) ? d : 'plataforma';
  }
  return 'plataforma';
}

export const esSistema = (d, cfg) => (cfg ?? porDefecto()).sistemas.includes(d);

/**
 * El modulo: los dos primeros segmentos, o TRES cuando los dos primeros son un
 * `basePath` --`src/app/admin` es un modulo, `src/app` no es nada--.
 *
 * Los basePaths salen de la config, no de un regex duplicado aqui: tenerlos en
 * dos sitios garantizaba que un dia divergieran, y el dia que divergieran
 * `modulesTouched` y `domainsTouched` contarian universos distintos sin avisar.
 */
export function moduloDe(path, cfg) {
  const { basePaths } = cfg ?? porDefecto();
  const p = String(path ?? '').replace(/^\.\//, '').split('/');
  const dos = p.slice(0, 2).join('/');
  return p.slice(0, basePaths.includes(dos) ? 3 : 2).join('/');
}

export const esTest = (path) => /\.(spec|test)\.[cm]?[jt]sx?$/.test(String(path ?? ''));

/**
 * El diff, partido por fichero. `git diff -M` es quien detecta los renombrados;
 * sin `-M` un `git mv` se ve como un borrado entero mas una creacion entera, que
 * es justo la lectura que hace imposible la clase `move`.
 */
export function bloquesDelDiff(diff) {
  const texto = String(diff ?? '');
  const cortes = [...texto.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)];
  return cortes.map((m, i) => ({
    path: m[2],
    from: m[1],
    cuerpo: texto.slice(m.index, i + 1 < cortes.length ? cortes[i + 1].index : texto.length),
  }));
}

/**
 * DELTA SEMANTICO, y es el hallazgo que desbloquea el cambio masivo.
 *
 * Un renombrado que `git diff -M` reporta con `similarity index 100%` cambia CERO
 * reglas: la puerta -- tsc, lint, los tests de las dos capas -- es juez suficiente
 * y no hace falta que nadie lo comprenda. El presupuesto plano contaba sus lineas
 * igual que las de una edicion en el corazon de la emision de cartas, asi que
 * rechazaba mover 200 ficheros y admitia tocar 40 lineas donde mas duele.
 * Estaba midiendo lo que no importa.
 */
export function clasificarDelDiff(diff) {
  const renamed = [], created = [], deleted = [], modified = [];
  for (const b of bloquesDelDiff(diff)) {
    if (/^similarity index 100%$/m.test(b.cuerpo) && /^rename from /m.test(b.cuerpo)) renamed.push(b.path);
    else if (/^new file mode /m.test(b.cuerpo)) created.push(b.path);
    else if (/^deleted file mode /m.test(b.cuerpo)) deleted.push(b.path);
    else modified.push(b.path);
  }
  return { renamed, created, deleted, modified };
}

/**
 * Cuenta lineas SALTANDO los ficheros que no las gastan.
 *
 * `(?!\+\+)` y `(?!--)` descartan las cabeceras `+++`/`---` del propio diff: sin
 * eso, cada fichero sumaba una linea fantasma en cada lado.
 */
const cuentaLineas = (diff, ignorar = new Set()) => {
  let linesAdded = 0, linesRemoved = 0;
  const bloques = bloquesDelDiff(diff);
  // Un diff sin cabeceras `diff --git` -- los de los tests -- se cuenta entero.
  const trozos = bloques.length ? bloques.filter((b) => !ignorar.has(b.path)) : [{ cuerpo: String(diff ?? '') }];
  for (const b of trozos) {
    linesAdded += (b.cuerpo.match(/^\+(?!\+\+)/gm) ?? []).length;
    linesRemoved += (b.cuerpo.match(/^-(?!--)/gm) ?? []).length;
  }
  return { linesAdded, linesRemoved };
};

/**
 * La superficie de un conjunto de ficheros. `diff` es opcional: sin el se
 * devuelve la superficie PLANIFICADA, con el la MEDIDA.
 */
export function superficie(files, diff = null, { ignorar = new Set(), cfg } = {}) {
  // `.map(moduloDe)` le pasaba el INDICE como segundo argumento y, desde que
  // estas funciones aceptan una taxonomia opcional ahi, el indice se colaba como
  // config. Las llamadas van con lambda explicita: una funcion con parametro
  // opcional NO puede viajar suelta dentro de un `.map`.
  const tax = cfg ?? porDefecto();
  const fs = [...new Set((files ?? []).map((f) => String(f).replace(/^\.\//, '')))];
  const clases = diff === null ? null : clasificarDelDiff(diff);
  return {
    files: fs.length,
    // Los ficheros que SI gastan presupuesto. Sin diff no se puede saber, y
    // fingir que todos gastan seria el error contrario al que se corrige.
    semanticFiles: clases === null ? null : fs.filter((f) => !ignorar.has(f)).length,
    ...(clases === null ? {} : { renamed: clases.renamed, created: clases.created, ignored: [...ignorar] }),
    modulesTouched: new Set(fs.map((f) => moduloDe(f, tax))).size,
    // Cuenta SISTEMAS. `plataforma` viaja en `domains` para poder auditarlo, y
    // no suma: ver `dominioDe`.
    domainsTouched: new Set(fs.map((f) => dominioDe(f, tax)).filter((d) => esSistema(d, tax))).size,
    testsTouched: fs.filter(esTest).length,
    ...(diff === null ? { linesAdded: null, linesRemoved: null } : cuentaLineas(diff, ignorar)),
    paths: fs,
    domains: [...new Set(fs.map((f) => dominioDe(f, tax)))].sort(),
    modules: [...new Set(fs.map((f) => moduloDe(f, tax)))].sort(),
  };
}

/**
 * El PRESUPUESTO de esta tarea. Dos fuentes, y ninguna es un numero suelto:
 *
 *  · Lo que ya declara la TAREA. `maxFiles` sale de `task.files.length` y
 *    `maxTestSurface` de cuantos de esos ficheros son specs. La tarea ya es la
 *    autoridad de su propio alcance -- copiar ese numero a una policy habria
 *    creado la segunda autoridad de siempre.
 *  · Lo que la tarea NO dice. Lineas, modulos y dominios: eso viene de
 *    `policy/surface.json`, con su medida detras.
 */
/**
 * LA CLASE DE CAMBIO. Sin ella habia un solo presupuesto para cinco formas de
 * trabajo distintas, y el unico calibrado era el de la extraccion.
 */
export function claseDe(task, policy) {
  return task?.changeClass ?? policy?.defaultClass ?? 'extraction';
}

export function limitesDeClase(clase, policy) {
  // Una policy SIN `classes` no es una policy con una clase desconocida: es la
  // forma anterior a C-5, y sus tres limites planos siguen siendo un presupuesto
  // valido. Distinguirlo importa -- tratarlas igual obligaria a declarar cinco
  // clases en cada policy de prueba para comprobar algo que no va de clases.
  if (!policy?.classes) return {};
  const c = policy.classes[clase];
  if (!c) {
    throw new Error(
      `clase de cambio desconocida: '${clase}'. Las declaradas: `
      + `${Object.keys(policy.classes).join(', ')}`,
    );
  }
  return c;
}

/**
 * Los ficheros que NO gastan techo de lineas en esta clase.
 *
 * Los renombrados R100 no gastan NUNCA, en ninguna clase: delta semantico cero es
 * cero se llame como se llame la vuelta. Lo demas lo decide `unbounded`.
 */
export function sinCoste(clase, policy, clasificacion) {
  const c = policy?.classes?.[clase] ?? {};
  const fuera = new Set(clasificacion?.renamed ?? []);
  for (const k of c.unbounded ?? []) for (const f of clasificacion?.[k] ?? []) fuera.add(f);
  return fuera;
}

export function presupuesto(task, policy) {
  const files = task?.files ?? [];
  // La CLASE gana a la policy base, y la TAREA gana a la clase. El orden no es
  // arbitrario: de lo general a lo particular, y cada escalon queda registrado en
  // `origen` -- una vuelta que se dio 130 lineas y otra que heredo 80 se leian
  // IGUAL en el trace, y `Learning` deriva confianza de que dos corridas vieran lo
  // mismo. Dos corridas con presupuestos distintos no vieron lo mismo.
  const clase = claseDe(task, policy);
  const c = limitesDeClase(clase, policy);
  const base = {
    maxLinesPerFile: c.maxLinesPerFile ?? policy.maxLinesPerFile,
    maxModules: 'maxModules' in c ? c.maxModules : policy.maxModules,
    maxDomains: 'maxDomains' in c ? c.maxDomains : policy.maxDomains,
  };
  const propio = task?.surfaceBudget ?? {};
  const origen = (k, deClase) => (k in propio ? 'task' : deClase ? 'class' : 'policy');

  return {
    changeClass: clase,
    notARing: c.notARing === true,
    maxFiles: files.length,
    maxTestSurface: files.filter(esTest).length,
    // UNA TASA, NO UN TOTAL, y por un error medido.
    //
    // Era un `maxLines` plano de 80, calibrado sobre las 13 ejecuciones que
    // habia en .harness/runs/. El techo observado era 76 y parecia una medida
    // solida. No lo era: esas 13 eran en su mayoria INTENTOS FALLIDOS, y la
    // unica que habia convergido escribio 2-3 ficheros -- nunca los dos specs
    // que la aceptacion exige. Se calibro sobre trabajo incompleto.
    //
    // Resultado, en H-20260818-d161dc60 y -2b842dba: el presupuesto rechazo dos
    // veces la PRIMERA ejecucion que cumplia la aceptacion entera (105 y 116
    // lineas), con `run_test`, `run_typecheck`, `run_lint` y `run_gate` en verde.
    // Un limite que rechaza el exito y admite el fracaso mide la poblacion
    // equivocada.
    //
    // La tasa escala con el alcance que la tarea DECLARA, igual que `maxFiles`.
    // Cuatro ficheros no pueden caber en el mismo presupuesto que uno.
    maxLines: files.length * base.maxLinesPerFile,
    maxModules: base.maxModules,
    maxDomains: base.maxDomains,
    ...propio,                            // una tarea puede ESTRECHAR el suyo
    // F-1: QUIEN puso cada limite. Sin esto el presupuesto efectivo es el mismo
    // numero viniera de donde viniera, y nadie puede comparar dos corridas.
    origen: {
      maxFiles: 'task',
      maxTestSurface: 'task',
      maxLines: origen('maxLines', c.maxLinesPerFile != null),
      maxModules: origen('maxModules', 'maxModules' in c),
      maxDomains: origen('maxDomains', 'maxDomains' in c),
    },
  };
}

/**
 * `[id, clave del presupuesto, como se mide, quien puso el limite]`.
 *
 * LA CUARTA COLUMNA DECIDE QUE PUNTUA RIESGO, y se corrigio dos veces por la
 * misma razon. Todos BLOQUEAN al excederse; no todos INFORMAN al acercarse.
 *
 *   task          `files` y `tests`. Gastar el 100% de lo que tu propia tarea
 *                 declaro es lo que se te pidio hacer, no una senal.
 *   arquitectura  `modules` y `domains`. Son enteros PEQUENOS donde usarlos
 *                 todos es la forma DISENADA, no un aviso: la regla de logica
 *                 pura extraida (CLAUDE.md) toca exactamente dos modulos --el
 *                 fichero puro y su llamante-- y un cambio dentro de un sistema
 *                 toca exactamente un dominio.
 *   policy        `lines`. El unico CONTINUO, y el unico que se acerca a su
 *                 techo de forma informativa.
 *
 * MEDIDO en las vueltas 8a y 9a: `modules` 2/2 y `domains` 1/1 en las dos, con
 * 127 y 96 lineas. Puntuando la arquitectura, las dos daban MEDIUM antes de
 * escribir una linea y 31 lineas de diferencia no movian el indicador. Un riesgo
 * que vale lo mismo pase lo que pase no es un riesgo: es una constante con
 * nombre de metrica. Con `lines` solo: 96/180 -> LOW, 127/180 -> MEDIUM.
 *
 * Es el mismo defecto que el comentario anterior daba por corregido para `files`
 * y `tests`, reintroducido por la otra puerta.
 */
export const LIMITES = [
  ['files', 'maxFiles', (s) => s.files, 'task'],
  ['modules', 'maxModules', (s) => s.modulesTouched, 'arquitectura'],
  ['domains', 'maxDomains', (s) => s.domainsTouched, 'arquitectura'],
  ['tests', 'maxTestSurface', (s) => s.testsTouched, 'task'],
  ['lines', 'maxLines', (s) => (s.linesAdded === null ? null : s.linesAdded + s.linesRemoved), 'policy'],
];

/**
 * ¿Cabe en su presupuesto?
 *
 * Un limite cuyo dato todavia no existe --las lineas, antes de Execution-- no se
 * aprueba ni se rechaza: se declara PENDIENTE. Darlo por bueno seria aprobar sin
 * medir, que es la forma de mentira que este harness persigue.
 */
export function comprobar(s, budget) {
  const checks = LIMITES.map(([id, k, get, fuente]) => {
    const valor = get(s);
    const limite = budget[k];
    if (valor === null || limite === undefined || limite === null) {
      return { id, fuente, valor, limite: limite ?? null, status: 'PENDING' };
    }
    return { id, fuente, valor, limite, status: valor <= limite ? 'OK' : 'EXCEEDED' };
  });
  const excedidos = checks.filter((c) => c.status === 'EXCEEDED');
  // Solo los CONTINUOS: ver `LIMITES`. Los de la tarea y los de la arquitectura
  // siguen BLOQUEANDO si se exceden -- eso es salirse del alcance declarado o de
  // la unidad de aislamiento -- pero usarlos al 100% es la forma disenada, no un
  // aviso, y puntuarlos dejaba el riesgo clavado en MEDIUM para siempre.
  const medidos = checks.filter((c) => c.status !== 'PENDING' && c.fuente === 'policy');
  const uso = medidos.length ? Math.max(...medidos.map((c) => c.valor / Math.max(1, c.limite))) : 0;

  return {
    ok: excedidos.length === 0,
    checks,
    exceeded: excedidos.map((c) => `${c.id} ${c.valor} > ${c.limite}`),
    // El riesgo sale del USO del presupuesto, no de una opinion. Nada que
    // declarar a mano y nada que un modelo pueda inflar o rebajar.
    risk: excedidos.length ? 'HIGH' : uso > 0.6 ? 'MEDIUM' : 'LOW',
  };
}

/**
 * El analisis completo, que es lo que va al artefacto y a la traza.
 * @param files  ficheros planificados (WorkPackage) o cambiados (ChangeSet)
 * @param diff   el diff real, o null si todavia no existe
 */
export function analizar(files, { task, policy, diff = null } = {}) {
  const b = presupuesto(task, policy);
  // Lo que no gasta presupuesto solo se sabe con el diff delante: un renombrado
  // R100 no se puede prometer, se comprueba.
  const ignorar = diff === null ? new Set() : sinCoste(b.changeClass, policy, clasificarDelDiff(diff));
  const s = superficie(files, diff, { ignorar });
  const v = comprobar(s, b);

  // `architecture` NO ES UNA VUELTA, y se rechaza aqui en vez de dejar que un
  // builder autonomo lo intente y muera con el reloj agotado a los 45 minutos.
  // Es la unica clase que no falla por un numero.
  const noEsUnaVuelta = b.notARing
    ? [`clase '${b.changeClass}': no cabe en una vuelta — se planifica como campana`]
    : [];

  return {
    phase: diff === null ? 'PLANNED' : 'MEASURED',
    changeClass: b.changeClass,
    ...s,
    risk: noEsUnaVuelta.length ? 'HIGH' : v.risk,
    budget: b,
    checks: v.checks,
    exceeded: [...noEsUnaVuelta, ...v.exceeded],
    ok: v.ok && !noEsUnaVuelta.length,
  };
}

/**
 * El gate. LANZA cuando la politica dice que bloquee.
 *
 * `enforce` vive en la policy y no en el codigo por una razon concreta: durante
 * la calibracion interesa MEDIR sin bloquear, y esa decision tiene que ser
 * visible en un fichero versionado en vez de estar comentada en una funcion.
 * Lo que NO es negociable es que el modelo no pueda tocarla: `policy/` esta en
 * `forbiddenPaths` de la tarea y en `denyPaths` del builder.
 */
export function assertSuperficie(analisis, policy) {
  if (analisis.ok || !policy.enforce) return analisis;
  throw new Error(
    `superficie de cambio fuera de presupuesto (${analisis.phase}): ${analisis.exceeded.join(' · ')}. `
    + `Toca ${analisis.files} fichero(s) en ${analisis.modulesTouched} modulo(s) y `
    + `${analisis.domainsTouched} dominio(s) [${analisis.domains.join(', ')}]`,
  );
}
