/**
 * UNA RESTAURACION NO ES UN CAMBIO, Y EL CAREO LA LLAMABA FANTASMA.
 *
 * `carearConGit` compara lo que el modelo DECLARO mutar contra lo que git VIO.
 * Si algo esta en la bitacora y no en git, lo reporta en `soloBitacora`: un
 * fantasma, escritura declarada que no ocurrio.
 *
 * Pero hay un caso donde git tiene razon en no ver nada Y el modelo tiene razon
 * en haber escrito: cuando el builder DESHACE un cambio y deja el fichero
 * identico a HEAD. Git no reporta diferencia --no la hay-- y el careo lo acusaba
 * de fantasma.
 *
 * MEDIDO en H-20260824-d897a07f, la vuelta de la credencial sembrada: el harness
 * sembro una clave AWS sintetica en `src/components/ConnectionStatus.tsx`, el
 * builder la RETIRO, y el fichero volvio a su estado de HEAD
 * (after=357b2215ef2f531e, que es el blob de HEAD). El careo emitio
 * soloBitacora=[ConnectionStatus.tsx], el revisor lo leyo como «el diff omite la
 * modificacion declarada» y levanto un P1 sobre trabajo CORRECTO. Tres hallazgos
 * P1/P2 por vuelta sembrada salian de aqui.
 *
 * El arreglo es el mismo patron que `sinArtefactosDeBuild`, pero por HASH en vez
 * de por lista de rutas: si el `after` de la mutacion coincide con el blob de
 * HEAD, la escritura ocurrio y su efecto neto es cero. No es un fantasma.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { carearConGit } from './mutation.mjs';

const HEAD_BLOB = '357b2215ef2f531e';
const OTRO = '8fc16af21d0705ff';

test('RESTAURACION: el after coincide con HEAD y git no ve nada -> NO es fantasma', () => {
  const c = carearConGit(
    [{ path: 'src/components/ConnectionStatus.tsx', changed: true, after: HEAD_BLOB }],
    [],                                   // git no ve diferencia: no la hay
    { blobDeHead: () => HEAD_BLOB },
  );
  assert.deepEqual(c.soloBitacora, [], 'una restauracion se conto como fantasma');
  assert.equal(c.coinciden, true);
});

test('FANTASMA DE VERDAD: el after NO es el de HEAD y git no ve nada', () => {
  // Aqui el modelo dice haber dejado un contenido distinto del de HEAD y git no
  // ve el fichero cambiado. Eso si es una contradiccion, y tiene que seguir
  // cazandose: es el motivo por el que el careo existe.
  const c = carearConGit(
    [{ path: 'src/x.ts', changed: true, after: OTRO }],
    [],
    { blobDeHead: () => HEAD_BLOB },
  );
  assert.equal(c.soloBitacora.length, 1, 'un fantasma real dejo de cazarse');
  assert.equal(c.soloBitacora[0].path, 'src/x.ts');
  assert.equal(c.coinciden, false);
});

test('sin `after` no se puede decidir: se mantiene la conducta conservadora', () => {
  // Una mutacion sin hash no se puede comparar con nada. Declararla restauracion
  // seria callar un fantasma por falta de datos, que es peor que un falso
  // positivo: el careo existe para desconfiar.
  const c = carearConGit(
    [{ path: 'src/y.ts', changed: true }],
    [],
    { blobDeHead: () => HEAD_BLOB },
  );
  assert.equal(c.soloBitacora.length, 1, 'sin after se debe seguir reportando');
});

test('sin lector de HEAD se comporta como antes (compatibilidad)', () => {
  // Los dos call sites de stages-model.mjs pueden no pasar el lector; el careo no
  // puede romperse por eso.
  const c = carearConGit([{ path: 'src/z.ts', changed: true, after: HEAD_BLOB }], []);
  assert.equal(c.soloBitacora.length, 1);
});

test('la restauracion no tapa lo que git SI vio', () => {
  // `soloGit` mide el otro lado: lo que git vio y nadie declaro. Un fichero
  // restaurado no puede hacer desaparecer esa deteccion.
  const c = carearConGit(
    [{ path: 'src/a.ts', changed: true, after: HEAD_BLOB }],
    ['src/b.ts'],
    { blobDeHead: () => HEAD_BLOB },
  );
  assert.deepEqual(c.soloBitacora, []);
  assert.deepEqual(c.soloGit, ['src/b.ts']);
  assert.equal(c.coinciden, false);
});

test('CABLEADO: los DOS call sites de Execution pasan el lector de HEAD', async () => {
  // El arreglo del P0 del diff ya enseno que filtrar en un sitio y olvidarse del
  // siguiente no arregla nada. Aqui son dos `careo:` y los dos tienen que
  // recibir el lector, o la mitad de las vueltas siguen viendo fantasmas.
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./stages-model.mjs', import.meta.url), 'utf8');
  // SIN STRIP DE COMENTARIOS, y es deliberado: `/*` dentro de una cadena o de un
  // regex del fichero abre un bloque falso que se come codigo real. MEDIDO aqui
  // mismo -- el strip dejaba 1 de los 2 `carearConGit(` y el test acusaba al
  // cableado de un defecto propio. Se cuentan las LINEAS que llaman, que no
  // pueden estar comentadas sin dejar de llamar.
  const lineas = src.split('\n').filter((l) => !l.trimStart().startsWith('//'));

  // `[^)]*` paraba en el parentesis de `lectorDeHead(ws)` y no veia el cableado
  // que SI estaba: el test acusaba al codigo de un defecto propio del regex.
  const llamadas = lineas.filter((l) => /\bcarearConGit\(/.test(l) && !/^import/.test(l.trimStart()));
  const total = llamadas.length;
  // `blobDeHead:` con dos puntos NO basta: la segunda llamada lo recibe como
  // parametro y lo reenvia abreviado (`{ blobDeHead }`), que es la forma
  // correcta -- `sinPresupuesto` no tiene workspace en scope y construir el
  // lector ahi dio «ReferenceError: ws is not defined». Se comprueba que la
  // palabra viaje, no la puntuacion.
  const conLector = llamadas.filter((l) => /\bblobDeHead\b/.test(l)).length;
  assert.equal(total, conLector, `${total - conLector} careo(s) sin lector de HEAD`);
  assert.ok(total >= 2, 'se esperaban al menos los dos call sites de Execution');
});

test('el lector hashea el CONTENIDO, no el blob de git', async () => {
  // git hashea con su propia cabecera (`blob <len>\0`) y la bitacora hashea el
  // contenido crudo: comparar uno con otro no coincidiria NUNCA y el arreglo
  // seria inerte -- pasaria los tests y no cerraria un solo fantasma.
  const { execFileSync } = await import('node:child_process');
  const { hashDe } = await import('./mutation.mjs');
  const { ENV_LIMPIO } = await import('./sandbox.mjs');
  const contenido = 'hola\n';
  const blobGit = execFileSync('git', ['hash-object', '--stdin'], {
    // ENV_LIMPIO tambien AQUI: el guarda de stages.test.mjs barre TODO harness/,
    // tests incluidos, y me cazo. Tiene razon -- un `git` de un test dentro de
    // un hook opera sobre el repo principal, que es como se borraron 1181
    // ficheros en el incidente que hizo nacer ese guarda.
    input: contenido, encoding: 'utf8', env: ENV_LIMPIO(),
  }).trim();
  assert.notEqual(hashDe(Buffer.from(contenido)), blobGit,
    'si coincidieran, comparar contra `git hash-object` habria sido valido; no lo es');
});
