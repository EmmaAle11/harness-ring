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
import { dirname, join, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

test('COMPATIBILIDAD: la raiz se deduce de la FORMA del arbol, no del nombre del repo', () => {
  // Este test afirmaba `harnessDir().endsWith('/harness-ring')`, que hardcodea el
  // nombre del repositorio -- precisamente lo que un motor portable NO puede
  // asumir. Medido: al copiar el motor a `/tmp/portab/harness/` el test fallaba
  // aunque la deduccion era CORRECTA (raiz = /tmp/portab). El test era el bug.
  //
  // Lo que importa no es como se llama el directorio, sino la relacion entre las
  // dos raices, y esa es distinta en cada forma:
  //
  //   PLANO    <repo>/ports/host.mjs      harnessDir() === raiz()
  //   ANIDADO  <host>/harness/ports/...   harnessDir() === <raiz>/harness
  const a = anfitrionPorDefecto();
  const raiz = a.raiz();
  const motor = a.harnessDir();

  assert.ok(isAbsolute(raiz), `raiz debe ser absoluta: ${raiz}`);
  assert.equal(a.runtimeDir(), join(raiz, '.harness'));

  // El motor es la raiz, o es su hijo `harness/`. Nada mas es valido.
  const plano = motor === raiz;
  const anidado = motor === join(raiz, 'harness');
  assert.ok(plano || anidado,
    `harnessDir() debe ser la raiz o <raiz>/harness, y es ${motor} con raiz ${raiz}`);

  // Y el origen declarado tiene que COINCIDIR con la forma detectada: declarar
  // "plana" mientras se resuelve como anidada es la clase de mentira que hace
  // indepurable una raiz adivinada.
  assert.match(a.describe().origen, plano ? /plana/ : /anidado/);

  // En cualquier forma, el motor debe poder encontrar SUS policies.
  assert.ok(existsSync(join(motor, 'policy')),
    `las policies viajan con el motor y deben estar en ${join(motor, 'policy')}`);
});

test('ANIDADO: dentro de <host>/harness/, la raiz es el host', async () => {
  // Simula el motor copiado bajo un directorio `harness/` de un arbol ajeno.
  // Se comprueba que existe <candidato>/harness para deducir la raiz.
  const aqui = dirname(fileURLToPath(import.meta.url)); // <repo>/ports
  const repo = join(aqui, '..');                         // <repo>
  const host = mkdtempSync(join(tmpdir(), 'anfitrion-')); // <host>/
  const motor = join(host, 'harness');                    // <host>/harness
  // Copiamos SOLO ports/host.mjs: crearAnfitrion no necesita mas para deducir.
  mkdirSync(join(motor, 'ports'), { recursive: true });
  copyFileSync(join(repo, 'ports', 'host.mjs'), join(motor, 'ports', 'host.mjs'));
  // Importamos la COPIA para que import.meta.url resuelva dentro de <host>/harness.
  const mod = await import(pathToFileURL(join(motor, 'ports', 'host.mjs')).href);
  const a = mod.anfitrionPorDefecto();
  assert.equal(a.raiz(), host, 'raiz anidada debe ser el host, no el subdirectorio harness');
  assert.equal(a.harnessDir(), motor);
  rmSync(host, { recursive: true, force: true });
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
