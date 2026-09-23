// C-1 · El INDICE del repositorio — el que lee el 100 % es el harness.
//
// LA MEDIDA QUE DECIDE LA FORMA. 997 ficheros de codigo, 10,22 MB, contra una
// transcripcion de 60 000 chars: 170 transcripciones. Y el reparto es peor que el
// total -- 19 ficheros (1,9 %) contienen el 36,3 % de los bytes, empezando por
// `backend/src/aafa/aafa.service.ts` con 1,14 MB.
//
// «Leer el 100 %» NO puede significar «meter el repositorio en un contexto».
// Esta a 170x, y subir los topes de ENTRADA mata mas vueltas, no menos: mas
// entrada produce mas hallazgos y mas hallazgos revientan el techo de SALIDA
// (F-5, tres vueltas muertas con OUTPUT_TRUNCATED).
//
// La unica forma que escala: EL HARNESS LEE EL 100 %, EL MODELO LEE LA SELECCION.
// Un programa determinista no tiene limite de contexto.
//
// FRONTERA CON ADR-006, y no es una nota al pie. El indice es NAVEGACION, no
// evidencia. Dice DONDE esta un simbolo, nunca QUE hace ni si esta bien. Ninguna
// afirmacion del anillo puede citarlo como prueba, igual que Graphify: un hallazgo
// que se apoya en el indice se apoya en nada. Por eso `nota` viaja dentro del
// propio artefacto -- una regla que solo vive en un comentario no la lee nadie.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { redactarSecretos } from './secretos.mjs';
import { ROOT, RUNTIME } from './capabilities.mjs';
import { moduloDe, dominioDe } from './surface.mjs';
import { ENV_LIMPIO } from './sandbox.mjs';

/**
 * LA VERSION DEL INDEXADOR ENTRA EN LA CLAVE DE CACHE.
 *
 * Sin esto, mejorar el extractor de simbolos no invalida nada: los ficheros no
 * cambiaron, sus sha son los mismos y el indice sigue sirviendo lo que entendio
 * la version anterior. Es la misma clase de defecto que un test que pasa porque
 * nunca llego a correr.
 */
export const VERSION = 5;

export const INDICE = join(RUNTIME, 'index', 'repo.json');

/** Lo que este indexador sabe leer. Lo demas se cuenta, pero no se despieza. */
const CODIGO = /\.(m?[jt]sx?|cjs)$/;

const NOTA_ADR006 = 'NAVEGACION, NO EVIDENCIA (ADR-006): dice donde esta un simbolo, '
  + 'nunca que hace. Un hallazgo que se apoya en el indice se apoya en nada.';

/**
 * `git ls-files -s` da el sha del blob GRATIS, ya calculado por git. Hacerlo a
 * mano con `hash-object` por fichero son 997 procesos para llegar al mismo numero.
 */
/**
 * Parsea `git ls-files -s`. PURA, para poder probar sin repo el caso que importa.
 *
 * Formato: `<modo> <sha> <etapa>\t<ruta>`. En un arbol sano la etapa es SIEMPRE 0.
 * Durante un merge conflictivo git devuelve la MISMA ruta tres veces --etapas 1
 * (base), 2 (nuestro) y 3 (suyo)-- con tres shas distintos.
 *
 * Con `.map()` eso producia tres entradas para una ruta y el sha que sobrevivia
 * al consumidor era el ultimo: el del OTRO lado del conflicto. El indice de
 * simbolos quedaba apuntando a codigo que no esta en el disco, en silencio.
 *
 * MEDIDO el 2026-08-24: fusionar el tronco en feat/harness con una vuelta del
 * anillo corriendo dejaba 6 rutas duplicadas en el inventario del orquestador,
 * que indexa el CLON PRINCIPAL y no el workspace aislado.
 *
 * No se filtran las conflictivas: eso las haria DESAPARECER, que es la otra forma
 * de mentir. Un arbol a medio fusionar no tiene una respuesta correcta que dar,
 * asi que se DECLARA -- la misma regla que la puerta aplica a lo que no puede
 * comprobar.
 */
export function entradasDeLsFiles(salida) {
  const filas = String(salida ?? '').split('\n').filter(Boolean).map((l) => {
    const [meta, path] = l.split('\t');
    const [, sha, etapa] = meta.split(' ');
    return { sha, path, etapa };
  });
  const enConflicto = [...new Set(filas.filter((f) => f.etapa !== '0').map((f) => f.path))];
  if (enConflicto.length) {
    throw new Error(
      `el arbol esta A MEDIO FUSIONAR: ${enConflicto.length} ruta(s) con etapas 1/2/3 en el indice `
      + `(${enConflicto.slice(0, 3).join(', ')}${enConflicto.length > 3 ? ', …' : ''}). `
      + 'Un inventario sacado de aqui repetiria cada una tres veces con tres shas distintos. '
      + 'Resuelve el merge o `git merge --abort` antes de indexar',
    );
  }
  return filas.map(({ sha, path }) => ({ sha, path }));
}

export function ficherosDeGit(root = ROOT) {
  const salida = execFileSync('git', ['ls-files', '-s'], {
    // ENV_LIMPIO NO ES DECORATIVO. Dentro de un hook de git, `GIT_INDEX_FILE`
    // viene exportada y es ABSOLUTA -- apunta al `index.lock` del repositorio que
    // esta commiteando, no al de `root`. Sin limpiarla, esto indexa los ficheros
    // PREPARADOS del commit en curso en vez del arbol que se le pide, y el indice
    // de simbolos sale con el contenido equivocado.
    //
    // MEDIDO el 2026-08-23: la suite del harness en rojo dentro del pre-commit
    // --`read_symbol` no encontraba un simbolo de su propio fixture-- y la puerta
    // bloqueando commits en esta rama.
    cwd: root, env: ENV_LIMPIO(), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  return entradasDeLsFiles(salida);
}

/**
 * El rango de un simbolo, por BALANCE DE LLAVES desde su linea.
 *
 * ponytail: cuenta llaves sin entender el lenguaje, asi que una llave dentro de
 * una cadena o de un comentario le miente. Es suficiente para NAVEGAR -- que es
 * todo lo que este indice promete-- y el consumidor verifica el sha antes de
 * usar el rango. Si algun dia hace falta exactitud, el escalon es un parser de
 * verdad, no mas regex.
 */
function rango(lineas, desde) {
  let prof = 0, visto = false;
  for (let i = desde; i < lineas.length; i++) {
    for (const ch of lineas[i]) {
      if (ch === '{') { prof++; visto = true; } else if (ch === '}') prof--;
    }
    if (visto && prof <= 0) return i + 1;
    // Una declaracion de una linea sin llaves termina donde empieza.
    if (!visto && /;\s*$/.test(lineas[i])) return i + 1;
  }
  return lineas.length;
}

/**
 * TAMBIEN lo NO exportado, y lo midio este repositorio.
 *
 * `src/app/archivero/ArchiveroModule.tsx` son 3.190 lineas y el indice le
 * encontraba DOS simbolos: en un modulo React los ayudantes son `const` de
 * primer nivel SIN `export` -- 44 de ellos aqui-- porque solo el componente sale
 * del fichero. Un indice que solo mira los `export` responde «esta en el
 * fichero» justo en la clase de fichero que motiva todo esto.
 *
 * `exported` viaja en el simbolo: no es lo mismo navegar a algo que el resto del
 * repo puede importar que a algo privado del modulo, y quien mueva codigo
 * necesita saberlo antes de tocarlo.
 */
const DECL = new RegExp(
  '^(?<ind>\\s*)(?<exp>export\\s+(?:default\\s+)?)?(?:async\\s+)?'
  + '(?<kind>function|class|const|let|var|interface|type|enum)\\s+(?<name>[A-Za-z_$][\\w$]*)',
);

/**
 * Los METODOS de una clase, que es la unidad de navegacion REAL de este repo.
 *
 * MEDIDO, y cambia el diseno: `backend/src/aafa/aafa.service.ts` exporta DOS
 * simbolos, y uno de ellos --`AafaService`-- ocupa las lineas 195 a 20 522. Un
 * indice que solo mira los `export` responde «esta en el fichero», que es lo que
 * ya sabiamos. En un god-service, lo que hace falta localizar es el metodo.
 *
 * Se excluyen las palabras de control: `if (`, `for (`, `catch (` casan con la
 * misma forma que una firma y no son simbolos.
 */
const MIEMBRO = /^ {2}(?:(?:public|private|protected|static|async|readonly|override)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(/;
const CONTROL = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'do', 'else', 'function', 'constructor']);

/** Los simbolos EXPORTADOS y su rango de lineas. Un fichero, ~1 linea por simbolo. */
export function simbolosDe(texto) {
  const lineas = String(texto ?? '').split('\n');
  const out = [];
  for (let i = 0; i < lineas.length; i++) {
    const m = DECL.exec(lineas[i]);
    // Solo PRIMER NIVEL: sin la guarda de indentacion entrarian los `const` de
    // dentro de cada funcion y el indice pasaria de mapa a ruido.
    if (!m || m.groups.ind.length) continue;
    const { kind, name } = m.groups;
    const hasta = rango(lineas, i);
    out.push({ name, kind, from: i + 1, to: hasta, ...(m.groups.exp ? { exported: true } : {}) });

    if (kind !== 'class') continue;
    for (let j = i + 1; j < hasta; j++) {
      const mm = MIEMBRO.exec(lineas[j]);
      if (!mm || CONTROL.has(mm[1])) continue;
      out.push({ name: mm[1], kind: 'method', parent: name, from: j + 1, to: rango(lineas, j) });
    }
  }
  return out;
}

/** De donde depende. Basta para responder «quien usa esto» sin abrir nada. */
export function importsDe(texto) {
  return [...new Set(
    [...String(texto ?? '').matchAll(/(?:^|\s)(?:from|import|require\()\s*['"]([^'"]+)['"]/g)]
      .map((m) => m[1]),
  )];
}

export function indexarFichero(path, texto) {
  const lineas = String(texto ?? '').split('\n').length;
  return {
    bytes: Buffer.byteLength(texto ?? ''),
    lines: lineas,
    module: moduloDe(path),
    domain: dominioDe(path),
    ...(CODIGO.test(path)
      ? { symbols: simbolosDe(texto), imports: importsDe(texto) }
      // Un .md o un .sql se cuenta pero NO se despieza. Declararlo es mas util
      // que devolver una lista vacia que se lee como «no exporta nada».
      : { symbols: null, imports: null, why: 'no es codigo: no se despieza' }),
  };
}

/**
 * Construye o REFRESCA el indice. Solo se recalcula lo que cambio de sha, y todo
 * si cambio `VERSION`.
 *
 * @returns {{version, builtFrom, nota, files, stats}}
 */
export function indexar({ root = ROOT, previo = leer() } = {}) {
  const reutilizable = previo?.version === VERSION ? (previo.files ?? {}) : {};
  const files = {};
  // LOS TRES DESENLACES SE CUENTAN, ninguno se deriva por resta. `reused` era
  // `total - releidos`, y con eso un fichero que no se pudo leer no era ni relectura
  // ni reutilizacion: caia en `reused` por descarte, afirmando que se habia
  // aprovechado una entrada que en realidad no se pudo comprobar.
  //
  // MEDIDO en H-20260820-79575b3b: tras mover 6 ficheros, `reused` valia 6 con el
  // indexador releyendo el repositorio ENTERO por cambio de version. Los seis eran
  // las rutas de origen, que git sigue listando -- `renameSync` no marca el borrado
  // en el indice-- y el disco ya no tiene.
  let releidos = 0;
  let reutilizados = 0;
  let ilegibles = 0;

  for (const { sha, path } of ficherosDeGit(root)) {
    const antes = reutilizable[path];
    if (antes?.sha === sha) { files[path] = antes; reutilizados++; continue; }
    let texto;
    try {
      texto = readFileSync(join(root, path), 'utf8');
    } catch {
      // Un binario o un fichero que git conoce y el disco no: se declara, no se
      // omite. Un indice que calla lo que no pudo leer miente por omision.
      //
      // Y SE DISTINGUEN. Los dos casos venian con el mismo motivo -- «ilegible como
      // utf8»-- que solo describe el primero: de un fichero que no esta, dice algo
      // falso sobre su codificacion en vez de decir que no esta.
      files[path] = {
        sha, bytes: null,
        why: existsSync(join(root, path))
          ? 'ilegible como utf8'
          : 'git lo indexa y el disco no lo tiene',
      };
      ilegibles++;
      continue;
    }
    files[path] = { sha, ...indexarFichero(path, texto) };
    releidos++;
  }

  const conCodigo = Object.values(files).filter((f) => f.symbols);
  return {
    version: VERSION,
    nota: NOTA_ADR006,
    builtFrom: 'git ls-files -s',
    files,
    stats: {
      files: Object.keys(files).length,
      reread: releidos,
      reused: reutilizados,
      unreadable: ilegibles,
      symbols: conCodigo.reduce((n, f) => n + f.symbols.length, 0),
      bytes: Object.values(files).reduce((n, f) => n + (f.bytes ?? 0), 0),
    },
  };
}

export function leer(file = INDICE) {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function guardar(indice, file = INDICE) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, redactarSecretos(JSON.stringify(indice)));
  return file;
}

/**
 * DONDE esta un simbolo. La pregunta que el indice existe para responder en una
 * llamada en vez de en veinte.
 *
 * Devuelve tambien el `sha` del fichero: quien lea el rango tiene con que
 * comprobar que sigue siendo el mismo fichero que se indexo.
 */
export function localizar(indice, nombre, { path = null } = {}) {
  const out = [];
  for (const [p, f] of Object.entries(indice?.files ?? {})) {
    if (path && p !== path) continue;
    for (const s of f.symbols ?? []) {
      if (s.name === nombre) out.push({ path: p, sha: f.sha, ...s });
    }
  }
  return out;
}
