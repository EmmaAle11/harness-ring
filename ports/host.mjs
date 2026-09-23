// ── PuertoAnfitrion (HostPort) ───────────────────────────────────────────────
//
// De donde sale la raiz del proyecto AUDITADO, donde vive el motor, y donde
// escribe su runtime. Es el puerto que hay que resolver PRIMERO: mientras la
// raiz se deduzca de la posicion del codigo en disco, cualquier otro puerto
// compondra sus rutas contra una raiz adivinada y el desacoplamiento sera
// cosmetico.
//
// EL DEFECTO QUE CIERRA. `capabilities.mjs:11-13` hace:
//
//     export const HARNESS = join(dirname(fileURLToPath(import.meta.url)), '..');
//     export const ROOT    = join(HARNESS, '..');
//
// El motor deduce el arbol auditado de SU PROPIA ubicacion. Solo funciona si
// vive como subdirectorio del repo que audita. Bajo
// `node_modules/@harness/ring`, ROOT apuntaria a `node_modules` y el anillo
// auditaria el gestor de paquetes. MEDIDO: 67 referencias a ROOT en 16 ficheros.
//
// DOS RAICES QUE HOY SON UNA:
//   raiz()        el arbol AUDITADO -- cambia por proyecto
//   harnessDir()  donde viven capabilities/ y policy/ -- viaja con el motor
// Hoy ambas salen del mismo `join(..., '..')`, y por eso no se pueden separar.
//
// LA FORMA DEL PUERTO la copia de `adapters/models/contract.mjs`, que ya es un
// puerto hexagonal correcto en este repo: un array OPERACIONES y una funcion
// que comprueba conformidad. No se inventa un estilo nuevo.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Lo que un adaptador de anfitrion debe implementar. */
export const OPERACIONES = ['raiz', 'runtimeDir', 'harnessDir', 'politica', 'describe'];

/**
 * @param {object} cfg
 * @param {string} cfg.raiz        raiz del arbol AUDITADO (obligatoria)
 * @param {string} [cfg.harnessDir] donde vive el motor (defecto: este fichero/..)
 * @param {string} [cfg.runtimeDir] donde escribe (defecto: <raiz>/.harness)
 * @param {string} [cfg.origen]     como se supo la raiz, para la traza
 */
export function crearAnfitrion({ raiz, harnessDir, runtimeDir, origen = 'inyectada (config explicita)' } = {}) {
  // FALLA CERRADO. Una raiz invalida que cayera a `process.cwd()` en silencio es
  // exactamente como el harness borro 1181 ficheros: operar sobre el arbol
  // equivocado sin avisar. Mejor no arrancar.
  if (typeof raiz !== 'string' || !raiz.trim()) {
    throw new Error('PuertoAnfitrion: `raiz` es obligatoria y debe ser una ruta no vacia');
  }
  const R = resolve(raiz);
  const H = harnessDir ? resolve(harnessDir) : join(dirname(fileURLToPath(import.meta.url)), '..');
  const RT = runtimeDir ? resolve(runtimeDir) : join(R, '.harness');

  return {
    raiz: () => R,
    harnessDir: () => H,
    runtimeDir: () => RT,

    /**
     * Las policies viajan con el MOTOR, no con el arbol auditado: si se leyeran
     * de la raiz, cada proyecto anfitrion tendria que copiarse `policy/` entero.
     */
    politica(nombre) {
      const p = join(H, 'policy', `${nombre}.json`);
      if (!existsSync(p)) throw new Error(`PuertoAnfitrion: no existe la policy '${nombre}' en ${p}`);
      return JSON.parse(readFileSync(p, 'utf8'));
    },

    // Una raiz adivinada tiene que poder auditarse: `origen` viaja a la traza.
    describe: () => ({ raiz: R, harnessDir: H, runtimeDir: RT, origen }),
  };
}

/**
 * COMPATIBILIDAD. Reproduce exactamente lo que hace hoy `capabilities.mjs`, para
 * que los 16 ficheros que importan ROOT sigan viendo lo mismo mientras se migran
 * de uno en uno.
 *
 * DECLARA que dedujo la raiz en vez de fingir que se la dieron: un anfitrion
 * deducido y uno inyectado no son lo mismo, y la traza tiene que distinguirlos.
 */
export function anfitrionPorDefecto() {
  const H = join(dirname(fileURLToPath(import.meta.url)), '..');
  return crearAnfitrion({
    raiz: join(H, '..'),
    harnessDir: H,
    origen: 'deducida de import.meta.url (compatibilidad: el motor vive dentro del arbol auditado)',
  });
}

/** Comprueba que un objeto cumple el puerto. Misma forma que `assertConforms`. */
export function assertAnfitrion(a, quien = 'adaptador') {
  for (const op of OPERACIONES) {
    if (typeof a?.[op] !== 'function') {
      throw new Error(`${quien}: no cumple PuertoAnfitrion, falta '${op}()'`);
    }
  }
  return a;
}
