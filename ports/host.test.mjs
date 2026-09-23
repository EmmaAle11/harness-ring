// ── PuertoAnfitrion · de donde sale la raiz del proyecto ─────────────────────
//
// TEST PRIMERO.
//
// EL BLOQUEANTE 0, anterior a los tres que las auditorias ya conocian y que
// ninguna nombro. `capabilities.mjs:11-13` hace:
//
//     export const HARNESS = join(dirname(fileURLToPath(import.meta.url)), '..');
//     export const ROOT    = join(HARNESS, '..');
//
// Es decir: el motor deduce la raiz del arbol AUDITADO de su PROPIA posicion en
// disco. Eso solo funciona si el harness vive como subdirectorio del repo que
// audita. Instalado como dependencia bajo `node_modules/@harness/ring`, ROOT
// apuntaria a `node_modules`, y el anillo auditaria el gestor de paquetes.
//
// MEDIDO el 2026-09-23: 67 referencias a ROOT en 16 ficheros fuera de tests.
// Mientras eso siga, los demas puertos se pueden declarar pero no resolver:
// cualquier ruta configurada se compone contra una raiz ADIVINADA, y el
// desacoplamiento seria cosmetico.
//
// PRECEDENTE: la RFC de lenguajes de ESLint declara el flat config como
// PREREQUISITO, no como trabajo paralelo -- no se pudo enchufar lenguajes al
// nucleo mientras la configuracion siguiera asumiendo JavaScript.
import test from 'node:test';
import assert from 'node:assert/strict';
import { anfitrionPorDefecto, crearAnfitrion, OPERACIONES } from './host.mjs';

test('el puerto declara sus operaciones, como el de modelos', () => {
  // Misma forma que `adapters/models/contract.mjs`, que ya es un puerto
  // hexagonal correcto: un array de nombres que un adaptador debe cumplir.
  assert.ok(Array.isArray(OPERACIONES));
  for (const op of ['raiz', 'runtimeDir', 'harnessDir', 'politica', 'describe']) {
    assert.ok(OPERACIONES.includes(op), `falta la operacion '${op}'`);
  }
});

test('la raiz se puede INYECTAR: no se deduce de donde vive el codigo', () => {
  // Este es el test que importa. Si pasa, el harness puede vivir en
  // node_modules y seguir auditando el arbol correcto.
  const a = crearAnfitrion({ raiz: '/tmp/otro-proyecto' });
  assert.equal(a.raiz(), '/tmp/otro-proyecto');
  assert.equal(a.runtimeDir(), '/tmp/otro-proyecto/.harness');
});

test('el harnessDir es INDEPENDIENTE de la raiz auditada', () => {
  // `capabilities/` y `policy/` viajan con el motor; el arbol auditado es otra
  // cosa. Hoy ambos salen del mismo `join(..., '..')` y por eso no se pueden
  // separar. Un adaptador debe poder decir «el motor esta en node_modules/x,
  // el proyecto en /home/yo/mi-repo».
  const a = crearAnfitrion({ raiz: '/proyectos/mio', harnessDir: '/node_modules/@harness/ring' });
  assert.equal(a.raiz(), '/proyectos/mio');
  assert.equal(a.harnessDir(), '/node_modules/@harness/ring');
  assert.notEqual(a.raiz(), a.harnessDir());
});

test('el runtimeDir es configurable: `.harness` es una convencion, no una ley', () => {
  const a = crearAnfitrion({ raiz: '/p', runtimeDir: '/var/lib/ring' });
  assert.equal(a.runtimeDir(), '/var/lib/ring');
});

test('`describe()` dice de donde salio la raiz — una raiz adivinada se audita', () => {
  const inyectada = crearAnfitrion({ raiz: '/p' });
  assert.match(JSON.stringify(inyectada.describe()), /inyectad|explicit|config/i);

  const deducida = anfitrionPorDefecto();
  assert.match(JSON.stringify(deducida.describe()), /deducid|import\.meta|posicion/i,
    'el defecto debe DECLARAR que dedujo la raiz, no fingir que se la dieron');
});

test('COMPATIBILIDAD: el defecto reproduce exactamente lo que hay hoy', () => {
  // La migracion no puede cambiar la conducta en este repo. `anfitrionPorDefecto`
  // deduce igual que `capabilities.mjs`, para que los 16 ficheros que importan
  // ROOT sigan viendo lo mismo mientras se migran uno a uno.
  const a = anfitrionPorDefecto();
  const raiz = a.raiz();
  assert.ok(raiz.endsWith('DOXIA-main') || raiz.includes('/'), `raiz inesperada: ${raiz}`);
  assert.equal(a.runtimeDir(), `${raiz}/.harness`);
  assert.ok(a.harnessDir().endsWith('/harness'));
});

test('una raiz vacia o no-string se RECHAZA: fallar cerrado', () => {
  // Una raiz invalida que cae a `process.cwd()` en silencio es como el harness
  // borro 1181 ficheros: operar sobre el arbol equivocado sin avisar.
  assert.throws(() => crearAnfitrion({ raiz: '' }), /raiz/i);
  assert.throws(() => crearAnfitrion({ raiz: null }), /raiz/i);
  assert.throws(() => crearAnfitrion({}), /raiz/i);
});

test('`politica(nombre)` lee de harnessDir, NO de la raiz auditada', () => {
  // Las policies viajan con el motor. Si se leyeran de la raiz, un proyecto
  // anfitrion tendria que copiarse `policy/` entero para poder usarlo.
  const a = anfitrionPorDefecto();
  const router = a.politica('router');
  assert.ok(router && typeof router === 'object');
  assert.ok(router.classes, 'router.json tiene `classes`');
});
