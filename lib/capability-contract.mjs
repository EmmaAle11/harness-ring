// CapabilityContract — una capacidad es un CONTRATO OPERATIVO, no un prompt con
// permisos.
//
// El manifiesto es el frontmatter de `harness/capabilities/<id>.md`, y sigue
// siendo UN fichero: la definicion y el prompt juntos (ADR-001). Separar el
// contrato a un `.yaml` aparte habria creado exactamente la duplicacion que este
// bloque existe para eliminar -- dos ficheros describiendo al mismo agente es
// como se llega a que uno diga que puede escribir y el otro que no.
//
// LA REGLA QUE GOBIERNA ESTE FICHERO:
//
//   El modelo puede fallar. El harness NO debe depender de que el modelo
//   "entienda" sus limites.
//
// Por eso la frontera se comprueba con funciones puras sobre rutas y acciones,
// fuera del modelo y sin invocarlo. Un limite que solo vive en un prompt es un
// limite que nadie hace cumplir (memory/failures/el-fix-que-no-existe.md).

/** Campos que TODO manifiesto debe declarar. Faltar uno es un error de carga. */
export const CAMPOS_OBLIGATORIOS = [
  'id', 'version', 'purpose', 'model_class',
  'inputs', 'outputs', 'allowedStages', 'requiredContracts',
  'permissions', 'forbidden', 'requiredModelCapabilities',
  'validation', 'evidence', 'failurePolicy', 'memoryPolicy',
];

/** Acciones que ninguna capacidad puede ejecutar jamas, declare lo que declare. */
export const PROHIBIDO_SIEMPRE = ['commit', 'push', 'deploy'];

const arr = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);

/**
 * Validacion ESTATICA del manifiesto (criterio 9: "validarse estaticamente").
 * Se corre al cargar, no al invocar: un manifiesto incompleto debe romper antes
 * de que nadie gaste un token.
 *
 * @returns [] si esta sano, o la lista de problemas.
 */
export function validateManifest(cap) {
  const p = [];
  const id = cap?.id ?? '(sin id)';

  for (const k of CAMPOS_OBLIGATORIOS) {
    if (cap?.[k] === undefined) p.push(`'${id}': falta el campo obligatorio '${k}'`);
  }
  if (!cap) return p;

  const perm = cap.permissions;
  if (perm && (Array.isArray(perm) || typeof perm !== 'object')) {
    p.push(`'${id}': 'permissions' debe declarar read/write/execute, no una lista`);
  } else if (perm) {
    for (const k of ['read', 'write', 'execute']) {
      if (perm[k] === undefined) p.push(`'${id}': falta 'permissions.${k}'`);
    }
  }

  // Un escritor que no declara donde escribe no tiene frontera: lo peor de los
  // dos mundos, porque parece acotado y no lo esta.
  if (perm && arr(perm.write).length && !arr(cap.outputs).length) {
    p.push(`'${id}': declara permiso de escritura y ningun 'outputs'`);
  }
  // La prohibicion global no es opcional ni renunciable.
  const faltan = PROHIBIDO_SIEMPRE.filter((a) => !arr(cap.forbidden).includes(a));
  if (faltan.length) p.push(`'${id}': 'forbidden' debe incluir ${faltan.join(', ')}`);

  if (cap.version === undefined || !/^\d+$/.test(String(cap.version))) {
    p.push(`'${id}': 'version' debe ser un entero`);
  }
  return p;
}

/** Normaliza una ruta a separadores POSIX y sin `./`, para comparar sin sorpresas. */
const norm = (r) => String(r).replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');

/** ¿`ruta` cae dentro de `prefijo`? Compara por SEGMENTO: `src` no cubre `srcX`. */
export const dentroDe = (ruta, prefijo) => {
  const r = norm(ruta), p = norm(prefijo).replace(/\/+$/, '');
  return r === p || r.startsWith(p + '/');
};

/**
 * BOUNDARY — ¿puede esta capacidad escribir estas rutas?
 *
 * `denyPaths` gana siempre a `permissions.write`: una ruta prohibida no se
 * "compensa" estando tambien permitida. Es la unica precedencia posible si la
 * lista de denegacion ha de significar algo.
 *
 * @returns [] si todo cae dentro, o una violacion por ruta.
 */
export function checkWriteBoundary(cap, rutas) {
  const permitidas = arr(cap?.permissions?.write);
  const negadas = arr(cap?.denyPaths);
  const v = [];

  for (const ruta of arr(rutas)) {
    const negada = negadas.find((d) => dentroDe(ruta, d));
    if (negada) {
      v.push({ path: ruta, rule: 'denyPaths', detail: `'${ruta}' cae en la zona prohibida '${negada}'` });
      continue;
    }
    if (!permitidas.some((w) => dentroDe(ruta, w))) {
      v.push({
        path: ruta, rule: 'permissions.write',
        detail: `'${ruta}' esta fuera de [${permitidas.join(', ') || 'nada'}]`,
      });
    }
  }
  return v;
}

/** BOUNDARY — ¿puede esta capacidad ejecutar esta accion? */
export function checkAction(cap, accion) {
  const a = String(accion).trim();
  if (PROHIBIDO_SIEMPRE.some((x) => a === x || a.startsWith(`git ${x}`) || a.startsWith(`${x} `))) {
    return { allowed: false, rule: 'PROHIBIDO_SIEMPRE', detail: `'${a}' esta prohibido para toda capacidad` };
  }
  if (arr(cap?.forbidden).some((f) => a === f || a.startsWith(`${f} `) || a.startsWith(`git ${f}`))) {
    return { allowed: false, rule: 'forbidden', detail: `'${a}' esta en la lista prohibida de '${cap.id}'` };
  }
  const exec = arr(cap?.permissions?.execute);
  if (!exec.length) return { allowed: false, rule: 'permissions.execute', detail: `'${cap?.id}' no declara nada ejecutable` };
  if (exec.includes('*')) return { allowed: true, rule: 'permissions.execute' };
  if (!exec.some((e) => a === e || a.startsWith(e))) {
    return { allowed: false, rule: 'permissions.execute', detail: `'${a}' no esta en [${exec.join(', ')}]` };
  }
  return { allowed: true, rule: 'permissions.execute' };
}

/** ¿Esta capacidad puede correr en esta etapa del anillo? */
export const puedeEnEtapa = (cap, stage) => arr(cap?.allowedStages).includes(stage);

/**
 * PARADA DURA. La usa la etapa Execution sobre el ChangeSet: el modelo dijo que
 * escribio estos ficheros, y aqui se comprueba contra el contrato ANTES de dar
 * la etapa por buena.
 */
export function assertWithinBoundary(cap, rutas) {
  const v = checkWriteBoundary(cap, rutas);
  if (v.length) {
    throw new Error(
      `frontera violada por '${cap?.id}': ${v.map((x) => x.detail).join(' · ')}`,
    );
  }
}
