// node --test harness/lib/
//
// Lo que estos tests fijan es la REGLA DE SEGURIDAD de la Fase 7: el modelo nunca
// ejecuta una herramienta del sistema. Pide, y el harness decide.
//
// Cada caso esta aislado a proposito. Un test que pasa porque OTRA regla rechazo
// la llamada antes no prueba la regla que dice medir --
// memory/failures/el-test-que-pasa-por-el-orden-de-la-lista.md.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  authorize, runTool, resolveInside, toolRegistry, toolCatalogText,
  reduccionDe, maxOutputTokensDe, reasoningEffortDe, reasoningEffortTruncado, loadToolPolicy,
  revisarParche,
} from './tools.mjs';
import { loadCapabilities, RUNTIME } from './capabilities.mjs';
import { ENV_LIMPIO } from './sandbox.mjs';

const WS = { kind: 'worktree', path: join(RUNTIME, 'workspaces', 'test-tools'), rollback: 'HEAD' };
const builder = () => loadCapabilities().find((c) => c.id === 'builder');
const researcher = () => loadCapabilities().find((c) => c.id === 'researcher');

before(() => {
  rmSync(WS.path, { recursive: true, force: true });
  mkdirSync(join(WS.path, 'src', 'lib'), { recursive: true });
  // `git init` propio: sin el, `git grep` y `git status` operarian sobre el
  // repositorio padre y estos tests medirian el arbol principal.
  const g = (...a) => execFileSync('git', a, { cwd: WS.path, env: ENV_LIMPIO(), stdio: 'pipe' });
  g('init', '-q');
  g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  writeFileSync(join(WS.path, 'src', 'lib', 'base.ts'), 'export const uno = 1;\n');
  // package.json propio. `npm run` SUBE por el arbol buscando uno, asi que sin
  // este fichero el workspace habria heredado el de la raiz y `run_typecheck`
  // habria validado el repositorio entero -- el mismo defecto que Evidence2 tuvo
  // con gate.sh, aparecido otra vez por otra puerta.
  writeFileSync(join(WS.path, 'package.json'), JSON.stringify({
    name: 'ws-test', private: true, scripts: { typecheck: 'node -e "process.exit(3)"' },
  }) + '\n');
  g('add', '-A'); g('commit', '-qm', 'base');
});
after(() => rmSync(WS.path, { recursive: true, force: true }));

// ── Contencion ───────────────────────────────────────────────────────────────
test('resolveInside RECHAZA todo lo que sale del workspace', () => {
  for (const r of ['../fuera.ts', '../../etc/passwd', '/etc/passwd', 'src/../../x', 'src/lib/../../../y']) {
    assert.throws(() => resolveInside(WS, r), /FUERA del workspace/, `deberia rechazar '${r}'`);
  }
});

test('resolveInside ACEPTA lo de dentro, incluido un `..` que no escapa', () => {
  assert.equal(resolveInside(WS, 'src/lib/x.ts'), resolve(WS.path, 'src/lib/x.ts'));
  assert.equal(resolveInside(WS, 'src/lib/../base.ts'), resolve(WS.path, 'src/base.ts'));
});

// ── Registro ─────────────────────────────────────────────────────────────────
test('una herramienta fuera del registro NO EXISTE para el modelo', () => {
  const a = authorize(builder(), { tool: 'curl', args: { url: 'http://x' } }, WS);
  assert.equal(a.allowed, false);
  assert.equal(a.rule, 'registry');
});

test('el catalogo del prompt sale del registro, no de una lista escrita a mano', () => {
  const texto = toolCatalogText();
  for (const id of toolRegistry().keys()) assert.match(texto, new RegExp(`\\b${id}\\(`), `falta ${id}`);
  assert.equal(texto.split('\n').length, toolRegistry().size);
});

test('faltar un argumento obligatorio se rechaza por CONTRATO, no por reventar', () => {
  const a = authorize(builder(), { tool: 'create_file', args: { path: 'src/x.ts' } }, WS);
  assert.equal(a.allowed, false);
  assert.equal(a.rule, 'contract');
  assert.match(a.detail, /'content'/);
});

// ── La frontera de ESCRITURA ─────────────────────────────────────────────────
test('el builder NO puede escribir fuera de permissions.write', () => {
  // `docs/` no esta en su lista y tampoco en denyPaths: la unica regla que puede
  // rechazarlo es permissions.write. Si el veredicto viniera de denyPaths, este
  // test estaria midiendo otra cosa.
  const a = authorize(builder(), { tool: 'create_file', args: { path: 'docs/x.md', content: 'x' } }, WS);
  assert.equal(a.allowed, false);
  assert.equal(a.rule, 'permissions.write');
});

test('denyPaths gana a permissions.write', () => {
  const a = authorize(builder(), { tool: 'create_file', args: { path: 'harness/policy/router.json', content: '{}' } }, WS);
  assert.equal(a.allowed, false);
  assert.equal(a.rule, 'denyPaths');
});

test('move_file comprueba las DOS rutas, no solo el origen', () => {
  // El origen es legitimo (`src/`) y el destino no. Comprobar solo `path` dejaria
  // pasar exactamente esta llamada: sacar un fichero de la zona permitida.
  const a = authorize(builder(), { tool: 'move_file', args: { source: 'src/lib/base.ts', destination: 'harness/policy/base.ts' } }, WS);
  assert.equal(a.allowed, false);
  assert.equal(a.rule, 'denyPaths');
});

test('una capacidad SIN permiso de escritura no escribe nada', () => {
  // `docs/` y no `src/`: el researcher tiene `src` en denyPaths, asi que ese caso
  // lo rechazaria la regla equivocada y el test no mediria la lista vacia.
  const a = authorize(researcher(), { tool: 'create_file', args: { path: 'docs/x.md', content: 'x' } }, WS);
  assert.equal(a.allowed, false);
  assert.equal(a.rule, 'permissions.write');
  assert.match(a.detail, /fuera de \[nada\]/);
});

// ── La frontera de ACCION ────────────────────────────────────────────────────
test('el researcher NO puede ejecutar run_build: no esta en permissions.execute', () => {
  const a = authorize(researcher(), { tool: 'run_build', args: {} }, WS);
  assert.equal(a.allowed, false);
  assert.equal(a.rule, 'permissions.execute');
});

test('el builder SI puede correr los tests: es la capacidad que la Fase 7 abre', () => {
  for (const id of ['run_test', 'run_typecheck', 'run_lint', 'run_build', 'git_status', 'git_diff']) {
    assert.equal(authorize(builder(), { tool: id, args: {} }, WS).allowed, true, `${id} deberia estar permitido`);
  }
});

// ── Ejecucion real ───────────────────────────────────────────────────────────
test('create_file + read_file: el ciclo escribir/observar dentro del sandbox', async () => {
  const r = await runTool({ tool: 'create_file', args: { path: 'src/lib/nuevo.ts', content: 'export const dos = 2;\n' } }, { cap: builder(), ws: WS });
  assert.equal(r.ok, true);
  assert.equal(readFileSync(join(WS.path, 'src/lib/nuevo.ts'), 'utf8'), 'export const dos = 2;\n');

  const l = await runTool({ tool: 'read_file', args: { path: 'src/lib/nuevo.ts' } }, { cap: builder(), ws: WS });
  assert.match(l.output, /^1\texport const dos = 2;/m, 'el contenido vuelve numerado por linea');
});

test('una llamada RECHAZADA no toca el disco', async () => {
  const fuera = resolve(WS.path, '..', 'fuga.ts');
  const r = await runTool({ tool: 'create_file', args: { path: '../fuga.ts', content: 'x' } }, { cap: builder(), ws: WS });
  assert.equal(r.allowed, false);
  assert.equal(r.rule, 'sandbox');
  assert.equal(existsSync(fuera), false, 'la ruta de fuera del workspace NO se creo');
});

test('search y git_status leen el workspace, no el arbol principal', async () => {
  const s = await runTool({ tool: 'search', args: { pattern: 'export const uno' } }, { cap: builder(), ws: WS });
  assert.match(s.output, /src\/lib\/base\.ts/);

  const st = await runTool({ tool: 'git_status', args: {} }, { cap: builder(), ws: WS });
  assert.doesNotMatch(st.output, /harness\/lib\/tools\.mjs/, 'estaria mirando el repositorio padre');
});

test('search entiende la regex que un modelo escribe, no la basica de git', async () => {
  // `git grep` sin -E usa regex BASICA: `\(` abre grupo y sale 128 sin buscar
  // nada. Un modelo que busca una llamada escribe `uno\(` o `uno|dos`, y las dos
  // formas fallaban.
  const llamada = await runTool({ tool: 'search', args: { pattern: 'uno = 1;' } }, { cap: builder(), ws: WS });
  assert.equal(llamada.exitCode, 0);

  const grupo = await runTool({ tool: 'search', args: { pattern: 'const \\(uno|dos\\)' } }, { cap: builder(), ws: WS });
  assert.notEqual(grupo.exitCode, 128, `git respondio fatal: ${grupo.output}`);

  const alternancia = await runTool({ tool: 'search', args: { pattern: 'export (const|function)' } }, { cap: builder(), ws: WS });
  assert.equal(alternancia.exitCode, 0, 'la alternancia es la forma mas comun de buscar dos simbolos');
});

test('search sin coincidencias es un RESULTADO, no un fallo', async () => {
  const r = await runTool({ tool: 'search', args: { pattern: 'zzz-no-existe-zzz' } }, { cap: builder(), ws: WS });
  assert.equal(r.ok, true, 'la herramienta funciono');
  assert.equal(r.exitCode, 1, 'el comando no encontro nada, y eso se reporta aparte');
});

test('inspect_file da tamano y hash sin gastar el contenido', async () => {
  const r = await runTool({ tool: 'inspect_file', args: { path: 'src/lib/base.ts' } }, { cap: builder(), ws: WS });
  assert.match(r.output, /22 bytes .* sha [0-9a-f]{16}/);
  assert.doesNotMatch(r.output, /export const uno/, 'inspect no vuelca el fichero');
});

test('apply_patch aplica un diff de verdad', async () => {
  const patch = [
    '--- a/src/lib/base.ts', '+++ b/src/lib/base.ts',
    '@@ -1 +1,2 @@', ' export const uno = 1;', '+export const tres = 3;',
  ].join('\n');
  const { hash } = await runTool({ tool: 'read_file', args: { path: 'src/lib/base.ts' } }, { cap: builder(), ws: WS });
  const r = await runTool({ tool: 'apply_patch', args: { path: 'src/lib/base.ts', patch, baseHash: hash } }, { cap: builder(), ws: WS });
  assert.equal(r.exitCode, 0, r.output);
  assert.match(readFileSync(join(WS.path, 'src/lib/base.ts'), 'utf8'), /export const tres = 3;/);
  assert.equal(existsSync(join(WS.path, '.harness-patch.diff')), false, 'el temporal no queda en el ChangeSet');
});

test('un patch que no aplica NO revienta: vuelve con su motivo para que el modelo se corrija', async () => {
  const { hash } = await runTool({ tool: 'read_file', args: { path: 'src/lib/base.ts' } }, { cap: builder(), ws: WS });
  const r = await runTool({ tool: 'apply_patch', args: { path: 'src/lib/base.ts', baseHash: hash, patch: '--- a/x\n+++ b/x\n@@ -9 +9 @@\n-nada\n+algo\n' } }, { cap: builder(), ws: WS });
  assert.equal(r.ok, true);
  assert.notEqual(r.exitCode, 0);
  assert.ok(r.output.length, 'el modelo recibe por que fallo');
});

test('un comando que falla es una tool que FUNCIONO: ok=true, exitCode!=0', async () => {
  // El `typecheck` del workspace sale con 3. Es exactamente el hecho que el
  // builder necesita observar cuando sus tests estan en rojo: confundirlo con
  // "la herramienta se rompio" le oculta el resultado.
  const r = await runTool({ tool: 'run_typecheck', args: {} }, { cap: builder(), ws: WS });
  assert.equal(r.ok, true, 'la tool corrio');
  assert.notEqual(r.exitCode, 0, 'y el comando fallo, que es otra cosa');
});

// ── Mutation Protocol (Fase 8) ──────────────────────────────────────────────
// Los seis casos que la fase exige: se aplica lo valido, se rechaza lo de fuera
// del sandbox, se rechaza el hash incorrecto, se rechaza el patch invalido, se
// puede revertir, y el resultado es observable.
const T = (cap, ws) => (tool, args) => runTool({ tool, args }, { cap: cap(), ws });

test('read_file entrega el hash CON el contenido: es el token para escribir', async () => {
  const r = await runTool({ tool: 'read_file', args: { path: 'src/lib/base.ts' } }, { cap: builder(), ws: WS });
  assert.match(r.output, /^\[sha [0-9a-f]{16}\]/, 'la primera linea es el hash');
  assert.equal(r.hash.length, 16);
  // Sin esto el modelo gastaria una llamada extra en inspect_file por cada
  // escritura, y el bucle ya esta atado por latencia, no por iteraciones.
  const i = await runTool({ tool: 'inspect_file', args: { path: 'src/lib/base.ts' } }, { cap: builder(), ws: WS });
  assert.equal(i.hash, r.hash, 'los dos caminos dan el mismo hash');
});

test('1 · una mutacion valida SE APLICA, y deja hash antes y despues', async () => {
  // Fichero propio: estos casos comparten workspace y un fichero que otro test ya
  // modifico hace que el parche falle por CONTEXTO y no por la regla que se mide.
  const t = T(builder, WS);
  await t('create_file', { path: 'src/lib/mut1.ts', content: 'export const uno = 1;\n' });
  const { hash } = await t('read_file', { path: 'src/lib/mut1.ts' });
  const patch = ['--- a/src/lib/mut1.ts', '+++ b/src/lib/mut1.ts', '@@ -1 +1,2 @@',
    ' export const uno = 1;', '+export const cuatro = 4;'].join('\n');

  const r = await t('apply_patch', { path: 'src/lib/mut1.ts', patch, baseHash: hash });
  assert.equal(r.exitCode, 0, r.output);
  assert.equal(r.mutation.before, hash);
  assert.notEqual(r.mutation.after, hash);
  assert.equal(r.mutation.changed, true);
  assert.equal(r.mutation.authorizedBy, 'builder', 'quien autorizo queda en el registro');
});

test('3 · un baseHash INCORRECTO se rechaza y no toca el fichero', async () => {
  const t = T(builder, WS);
  const antes = readFileSync(join(WS.path, 'src/lib/base.ts'), 'utf8');
  const r = await t('apply_patch', {
    path: 'src/lib/base.ts', baseHash: '0000000000000000',
    patch: '--- a/src/lib/base.ts\n+++ b/src/lib/base.ts\n@@ -1 +1,2 @@\n export const uno = 1;\n+export const cinco = 5;\n',
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'MUTATION_CONFLICT');
  assert.equal(readFileSync(join(WS.path, 'src/lib/base.ts'), 'utf8'), antes, 'el fichero NO se toco');
});

test('sin baseHash no se parchea: nada se aplica contra una version desconocida', async () => {
  const r = await T(builder, WS)('apply_patch', {
    path: 'src/lib/base.ts',
    patch: '--- a/src/lib/base.ts\n+++ b/src/lib/base.ts\n@@ -1 +1,2 @@\n export const uno = 1;\n+export const seis = 6;\n',
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'MUTATION_UNVERSIONED');
});

test('4 · un patch INVALIDO no revienta: vuelve con su motivo y `changed: false`', async () => {
  const t = T(builder, WS);
  const { hash } = await t('read_file', { path: 'src/lib/base.ts' });
  const r = await t('apply_patch', { path: 'src/lib/base.ts', baseHash: hash, patch: '--- a/x\n+++ b/x\n@@ -9 +9 @@\n-no\n+si\n' });
  assert.equal(r.ok, true, 'la herramienta corrio');
  assert.notEqual(r.exitCode, 0, 'y el comando fallo');
  assert.equal(r.mutation.changed, false, 'el registro dice que no cambio nada');
  assert.equal(r.mutation.before, r.mutation.after);
});

test('create_file no pisa lo que ya existe salvo que se declare', async () => {
  const t = T(builder, WS);
  const r = await t('create_file', { path: 'src/lib/base.ts', content: 'PISADO\n' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'MUTATION_EXISTS');
  assert.doesNotMatch(readFileSync(join(WS.path, 'src/lib/base.ts'), 'utf8'), /PISADO/);

  const { hash } = await t('read_file', { path: 'src/lib/base.ts' });
  const ok = await t('create_file', { path: 'src/lib/base.ts', content: 'DECLARADO\n', baseHash: hash });
  assert.equal(ok.ok, true);
  assert.equal(readFileSync(join(WS.path, 'src/lib/base.ts'), 'utf8'), 'DECLARADO\n');
});

test('move_file no sobrescribe el destino sin declararlo', async () => {
  const t = T(builder, WS);
  await t('create_file', { path: 'src/lib/origen.ts', content: 'A\n' });
  await t('create_file', { path: 'src/lib/destino.ts', content: 'B\n' });
  const { hash } = await t('read_file', { path: 'src/lib/origen.ts' });

  const choque = await t('move_file', { source: 'src/lib/origen.ts', destination: 'src/lib/destino.ts', baseHash: hash });
  assert.equal(choque.ok, false);
  assert.equal(choque.code, 'MUTATION_EXISTS');
  assert.equal(readFileSync(join(WS.path, 'src/lib/destino.ts'), 'utf8'), 'B\n', 'el destino sigue intacto');

  const ok = await t('move_file', { source: 'src/lib/origen.ts', destination: 'src/lib/movido.ts', baseHash: hash });
  assert.equal(ok.ok, true);
  assert.equal(ok.mutation.after, hash, 'mover no cambia el contenido: el hash sobrevive al viaje');
  assert.equal(existsSync(join(WS.path, 'src/lib/origen.ts')), false);
});

test('delete_file exige haber visto lo que borra', async () => {
  const t = T(builder, WS);
  await t('create_file', { path: 'src/lib/temp.ts', content: 'temporal\n' });
  const ciego = await t('delete_file', { path: 'src/lib/temp.ts' });
  assert.equal(ciego.code, 'MUTATION_UNVERSIONED');
  assert.equal(existsSync(join(WS.path, 'src/lib/temp.ts')), true, 'sigue ahi');

  const { hash } = await t('read_file', { path: 'src/lib/temp.ts' });
  const ok = await t('delete_file', { path: 'src/lib/temp.ts', baseHash: hash });
  assert.equal(ok.ok, true);
  assert.equal(ok.mutation.after, null, 'despues de borrar no hay hash, y eso es el registro correcto');
  assert.equal(existsSync(join(WS.path, 'src/lib/temp.ts')), false);
});

test('2 · una mutacion fuera del sandbox se rechaza ANTES de mirar hashes', async () => {
  const r = await T(builder, WS)('apply_patch', { path: '../fuga.ts', patch: 'x', baseHash: 'abc' });
  assert.equal(r.allowed, false);
  assert.equal(r.rule, 'sandbox', 'la contencion va primero: sin ella el hash no significa nada');
});

test('la salida se recorta y se DICE que se recorto', async () => {
  await runTool({ tool: 'create_file', args: { path: 'src/lib/largo.ts', content: 'x'.repeat(50000) } }, { cap: builder(), ws: WS });
  const r = await runTool({ tool: 'read_file', args: { path: 'src/lib/largo.ts' } }, { cap: builder(), ws: WS });
  // DERIVADO de la politica, no cableado: el `< 12000` de antes era el reflejo
  // del tope de 8 000 y se quedo mintiendo el dia que el tope subio a 20 000. La
  // propiedad que se mide --no se manda un fichero entero al contexto-- no
  // depende del numero, asi que la asercion tampoco debe.
  const tope = loadToolPolicy().loop.maxToolResultChars;
  assert.ok(r.output.length < 50000, 'no se manda el fichero ENTERO, que es lo que se prueba');
  assert.ok(r.output.length <= tope + 500, `se recorta al tope vigente (${tope}), no a uno de hace tres semanas`);
  assert.match(r.output, /recortados por el harness/);
});

// ── La siembra deliberada (Fase 10) ─────────────────────────────────────────
test('sandboxStage siembra los ficheros del manifiesto DENTRO del workspace', async () => {
  const { sandboxStage } = await import('./stages-deterministic.mjs');
  const sandbox = await import('./sandbox.mjs');
  const ctx = {
    executionId: 'test-seed',
    manifest: { task: { seed: [{ path: 'src/sembrado.ts', content: 'export const x = 1;\n', why: 'demo' }] } },
  };
  const r = await sandboxStage(ctx);
  try {
    assert.equal(readFileSync(join(r.payload.path, 'src/sembrado.ts'), 'utf8'), 'export const x = 1;\n');
    // El `why` viaja en el artefacto: una vulnerabilidad que aparece en un
    // workspace sin que conste quien la puso es indistinguible de una real.
    assert.equal(r.payload.seeded[0].why, 'demo');
  } finally {
    sandbox.remove(r.payload);
  }
});

test('una semilla FUERA del workspace se rechaza como cualquier otra escritura', async () => {
  const { sandboxStage } = await import('./stages-deterministic.mjs');
  const sandbox = await import('./sandbox.mjs');
  const ctx = {
    executionId: 'test-seed-fuga',
    manifest: { task: { seed: [{ path: '../fuga.ts', content: 'x' }] } },
  };
  // Sembrar no es una excepcion a la contencion: el manifiesto tampoco puede
  // escribir fuera del sandbox.
  await assert.rejects(() => sandboxStage(ctx), /FUERA del workspace/);
  try { sandbox.remove({ path: join(RUNTIME, 'workspaces', 'test-seed-fuga') }); } catch { /* ya no existe */ }
});

// ── run_gate: el builder puede verificar lo que cambia ──────────────────────
//
// H-20260817-f00dd8f2 murio por esto. La tarea incluia `scripts/gate.sh` -subir
// el piso es parte de anadir un test- y el revisor exigio, TRES rondas seguidas,
// evidencia de que el piso nuevo lo valida el gate y no solo `run_test`. Tenia
// razon: cuentan de forma distinta. Y el builder no tenia con que: 14 tools y
// ninguna corria la puerta.
//
// Es la misma familia que un hallazgo cuyo remedio cae fuera del allowlist -- una
// exigencia correcta que el sistema hace imposible de satisfacer-- pero el remedio
// no es acotar la revision: es dar la herramienta.
test('existe una herramienta que ejecuta la AUTORIDAD del DoD', () => {
  const t = toolRegistry().get('run_gate');
  assert.ok(t, 'sin run_gate, un cambio al gate no se puede verificar desde dentro del bucle');
  assert.equal(t.kind, 'exec');
  assert.ok(t.cmd.join(' ').includes('scripts/gate.sh'), 'invoca el gate, no reimplementa sus comprobaciones');
});

test('run_gate NO acepta rutas: la puerta se corre entera o no se corre', () => {
  // `acceptsPaths` dejaria al modelo acotar el gate a los ficheros que le
  // convienen, que es exactamente como se pasa una puerta sin pasarla.
  assert.notEqual(toolRegistry().get('run_gate').acceptsPaths, true);
});

test('run_gate esta AUTORIZADO en el contrato del builder, no solo en el registro', () => {
  // Se anadio al registro y no al allowlist, y el bucle lo rechazo en vivo:
  //   DENY run_gate  permissions.execute: 'bash scripts/gate.sh' no esta en [...]
  //
  // Es la separacion funcionando -- quien autoriza es el contrato de la capacidad,
  // no el registro-- y a la vez la trampa: una tool nueva son DOS pasos, y el
  // segundo no falla hasta que un modelo la pide.
  const builder = loadCapabilities().find((c) => c.id === 'builder');
  const r = authorize(builder, { tool: 'run_gate', args: {} }, { path: '/tmp/x' });
  assert.equal(r.allowed, true, r.rule ?? 'run_gate rechazado por el contrato del builder');
});

// ── La eleccion de modo: lista blanca, no argumento libre ───────────────────
//
// `run_gate` corria siempre `--fast`, y los pisos FE/BE viven DENTRO de
// `if [ "$MODE" = "full" ]`. Un builder que los cambia y solo corre --fast nunca
// ejecuta la rama que modifico. El revisor lo exigio dos veces en
// H-20260817-009c7621 -- con razon -- y la vuelta murio ahi.
test('run_gate ofrece el modo, y el catalogo se lo dice al modelo', () => {
  const t = toolRegistry().get('run_gate');
  assert.deepEqual(Object.keys(t.choice.values), ['fast', 'full']);
  assert.equal(t.choice.default, 'fast');
  assert.ok(!t.cmd.includes('--fast'), 'el modo NO va fijado en el cmd: lo elige la llamada');

  const catalogo = toolCatalogText().split('\n').find((l) => l.startsWith('- run_gate'));
  assert.match(catalogo, /mode\?/, 'una tool cuyo modo el modelo no sabe que existe es una tool a medias');
  assert.match(catalogo, /fast\|full/);
});

test('un modo fuera de la lista se RECHAZA, no cae al defecto en silencio', () => {
  // Un `mode: "ful"` que corriera --fast dejaria al modelo creyendo que verifico
  // algo que no verifico. Ese es el defecto que este repo persigue.
  const builder = loadCapabilities().find((c) => c.id === 'builder');
  const ws = { path: '/tmp/x' };

  assert.equal(authorize(builder, { tool: 'run_gate', args: { mode: 'full' } }, ws).allowed, true);
  assert.equal(authorize(builder, { tool: 'run_gate', args: {} }, ws).allowed, true, 'omitirlo vale: hay defecto');

  const malo = authorize(builder, { tool: 'run_gate', args: { mode: 'ful' } }, ws);
  assert.equal(malo.allowed, false);
  assert.equal(malo.rule, 'choice');
  assert.match(malo.detail, /fast, full/);
});

// ── C-3 · el presupuesto de SALIDA ───────────────────────────────────────────
// `loop` declaraba seis limites de ENTRADA y cero de salida, y el que mataba las
// vueltas era el de salida: tres murieron con OUTPUT_TRUNCATED.

test('la reduccion la declara el CONTRATO, y dice un NUMERO', () => {
  // El ruego -- «responde MUCHO mas corto» -- se midio y no funciona: los dos
  // intentos de H-20260818-040baf77 se cortaron igual. Lo que reduce es una cifra.
  assert.match(reduccionDe('FindingSet'), /MAXIMO 3 hallazgos/);
  assert.match(reduccionDe('WorkPackage'), /MAXIMO 4 ficheros/);

  // Y NO es la misma para todos: «maximo 3 hallazgos» no significa nada para un
  // DecisionRecord. Una reduccion global habria sido el ruego con otro nombre.
  assert.notEqual(reduccionDe('DecisionRecord'), reduccionDe('FindingSet'));
  assert.doesNotMatch(reduccionDe('DecisionRecord'), /hallazgo/i);
});

test('las NUEVE llamadas a un modelo tienen reduccion declarada, no solo la etapa 8', () => {
  // El defecto que cierra C-3: la reduccion vivia cableada en `pedirValidacion`,
  // asi que valia para UNA etapa y las otras ocho caian al aviso generico.
  const usados = readFileSync(resolve(import.meta.dirname, 'stages-model.mjs'), 'utf8')
    .matchAll(/contract: '(\w+)'/g);
  const contratos = [...new Set([...usados].map((m) => m[1]))];

  assert.ok(contratos.length >= 8, `se esperaban las nueve llamadas, hay ${contratos.length}`);
  const sin = contratos.filter((c) => !reduccionDe(c));
  assert.deepEqual(sin, [], `contratos sin reduccion declarada: ${sin.join(', ')}`);
});

test('ninguna etapa se inventa su propia reduccion', () => {
  // Si vuelve a aparecer una en stages-model.mjs habra dos autoridades sobre el
  // mismo hecho, que es el defecto dominante de este repositorio.
  const src = readFileSync(resolve(import.meta.dirname, 'stages-model.mjs'), 'utf8');
  assert.doesNotMatch(src, /^\s*reduccion:/m);
});

test('el techo de salida sale de la politica, y `null` NO es un numero por defecto', () => {
  assert.equal(maxOutputTokensDe('deepseek'), 32768);
  assert.equal(maxOutputTokensDe('ollama'), 8192);

  // Los CLIs no aceptan techo en la invocacion: declarar uno seria una politica
  // que nadie puede hacer cumplir.
  assert.equal(maxOutputTokensDe('claude'), null);
  assert.equal(maxOutputTokensDe('nunca-existio'), null);
});

test('el esfuerzo de razonamiento sale de la politica, y el revisor SIGUE razonando', () => {
  // `low`, no `none`. Una revision adversarial que no piensa no es una revision:
  // con `none` la API contesta en 6 tokens. Lo que se acota es que piense SIN
  // TECHO, que es lo que se midio.
  assert.equal(reasoningEffortDe('deepseek'), 'low');

  // Los CLIs gobiernan su propio razonamiento y ollama no expone el parametro:
  // `null` significa NO ACEPTA EL CAMPO, no «no lo sabemos».
  assert.equal(reasoningEffortDe('claude'), null);
  assert.equal(reasoningEffortDe('opencode'), null);
  assert.equal(reasoningEffortDe('nunca-existio'), null);
});

test('tras un truncado se APAGA el pensamiento, que es la unica palanca medida', () => {
  // MEDIDO en H-20260819-4b5c6d6d: 32768 de salida, 32768 de razonamiento, cero
  // de respuesta. Un contrato mas corto acota lo que se responde; aqui no se
  // llego a responder. Reintentar con el mismo esfuerzo repite el desbordamiento.
  assert.equal(reasoningEffortTruncado(), 'none');
});

test('el adaptador MANDA el esfuerzo, y el reintento lo baja', () => {
  // Sin esto la politica seria una declaracion que nadie envia -- el defecto que
  // `el-fix-que-no-existe` describe, aplicado a un campo de la peticion.
  const ad = readFileSync(resolve(import.meta.dirname, '..', 'adapters', 'models', 'deepseek.mjs'), 'utf8');
  assert.match(ad, /reasoning_effort:/);
  assert.match(ad, /reasoningEffort \?\? reasoningEffortDe\(name\)/);

  // Y el que lo BAJA es el bucle de reintento, solo cuando hubo truncado.
  const inv = readFileSync(resolve(import.meta.dirname, 'invoke.mjs'), 'utf8');
  assert.match(inv, /truncado \? \{ reasoningEffort: reasoningEffortTruncado\(\) \}/);
});

test('el techo NO sube una cuarta vez', () => {
  // 8192 -> 16384 -> 32768 ya esta escrito. El siguiente escalon es un contrato
  // mas corto, no un numero mas grande. Este test es el cerrojo.
  const techos = Object.values(loadToolPolicy().output.maxOutputTokens).filter((v) => v != null);
  for (const t of techos) assert.ok(t <= 32768, `${t} supera el techo medido`);
});

test('el adaptador NO cablea su propio techo', () => {
  // Estaba en deepseek.mjs, que es el unico sitio donde una politica de coste no
  // se puede leer ni cambiar sin tocar codigo.
  for (const a of ['deepseek', 'ollama']) {
    const src = readFileSync(resolve(import.meta.dirname, '..', 'adapters', 'models', `${a}.mjs`), 'utf8');
    assert.doesNotMatch(src, /(max_tokens|num_predict):\s*\d/, `${a} cablea su techo`);
    assert.match(src, /maxOutputTokensDe/, `${a} no lee la politica`);
  }
});

// ── C-2 · la unidad de lectura es el SIMBOLO ─────────────────────────────────
//
// `read_file` sin `limit` sobre `aafa.service.ts` devolvia el 0,70 % del fichero
// y no lo decia. La mitad de escritura estaba resuelta -- `apply_patch` exige
// `baseHash`-- y la de lectura no: un builder que no puede leer no deberia poder
// escribir, y podia.

const GRANDE = 'src/lib/grande.ts';

before(() => {
  // Un fichero con un simbolo lejos del principio, que es la forma del problema:
  // el metodo util esta detras de miles de lineas que no interesan.
  const relleno = Array.from({ length: 400 }, (_, i) => `// relleno ${i}`).join('\n');
  writeFileSync(join(WS.path, GRANDE), [
    'export class Servicio {',
    relleno,
    '  emitirCarta(id: string) {',
    '    return `carta ${id}`;',
    '  }',
    '}',
    '',
  ].join('\n'));
  execFileSync('git', ['add', '-A'], { cwd: WS.path, env: ENV_LIMPIO(), stdio: 'pipe' });
  execFileSync('git', ['commit', '-qm', 'grande'], { cwd: WS.path, env: ENV_LIMPIO(), stdio: 'pipe' });
});

test('read_symbol trae SOLO el simbolo, con su rango y el sha del fichero', async () => {
  const r = await runTool({ tool: 'read_symbol', args: { symbol: 'emitirCarta' } }, { cap: researcher(), ws: WS });
  assert.equal(r.exitCode, 0, r.output);
  assert.match(r.output, /emitirCarta/);
  assert.doesNotMatch(r.output, /relleno 200/, 'las 400 lineas de relleno no viajan');
  assert.ok(r.from > 400 && r.to > r.from, `rango ${r.from}-${r.to}`);
  assert.equal(r.totalLines, 406);
  assert.ok(r.hash, 'sin sha, quien lea el rango no puede comprobar que es el mismo fichero');
});

test('read_file DECLARA la ventana: cuanto hay, que trozo tienes', async () => {
  // El 0,70 % mudo era el defecto. Ahora el modelo sabe que esta viendo una
  // ventana, que es la diferencia entre leer un trozo y creer que leiste el
  // fichero.
  const r = await runTool({ tool: 'read_file', args: { path: GRANDE, offset: 10, limit: 5 } }, { cap: researcher(), ws: WS });
  assert.equal(r.totalLines, 406);
  assert.deepEqual([r.from, r.to], [10, 14]);
  assert.match(r.output, /lineas 10-14 de 406/);
});

test('un simbolo que el indice no conoce NO se inventa, y lo dice sin afirmar de mas', async () => {
  const r = await runTool({ tool: 'read_symbol', args: { symbol: 'noExiste' } }, { cap: researcher(), ws: WS });
  assert.equal(r.exitCode, 1);
  assert.match(r.output, /no prueba que no exista/, 'el indice dice donde esta lo que hay, no que no haya nada');
});

test('un simbolo AMBIGUO se dice, no se adivina', async () => {
  // Adivinar cual queria el modelo es como sale un parche en el fichero
  // equivocado. Se enumeran los sitios y se le pide `path`.
  writeFileSync(join(WS.path, 'src', 'lib', 'otro.ts'), 'export function comun() {\n  return 1;\n}\n');
  writeFileSync(join(WS.path, 'src', 'lib', 'otro2.ts'), 'export function comun() {\n  return 2;\n}\n');
  execFileSync('git', ['add', '-A'], { cwd: WS.path, env: ENV_LIMPIO(), stdio: 'pipe' });

  const r = await runTool({ tool: 'read_symbol', args: { symbol: 'comun' } }, { cap: researcher(), ws: WS });
  assert.equal(r.exitCode, 1);
  assert.match(r.output, /2 sitios/);

  const uno = await runTool({ tool: 'read_symbol', args: { symbol: 'comun', path: 'src/lib/otro2.ts' } }, { cap: researcher(), ws: WS });
  assert.equal(uno.exitCode, 0);
  assert.match(uno.output, /return 2/);
});

test('F-3: el recorte deja RASTRO en el ToolResult, no solo un aviso al modelo', async () => {
  // Un `search` recortado y uno completo daban el mismo ToolResult a ojos de
  // Validation, Adversarial y Convergence. MEDIDO sobre el god-service: 29.018
  // chars devueltos, 8.000 vistos, 111 de 244 coincidencias.
  const pequeno = { loop: { maxToolResultChars: 120 } };
  const r = await runTool({ tool: 'read_file', args: { path: GRANDE } }, { cap: researcher(), ws: WS, policy: { ...loadToolPolicy(), ...pequeno } });
  assert.equal(r.truncated, true);
  assert.ok(r.omittedChars > 0 && r.totalChars > r.omittedChars);

  const entero = await runTool({ tool: 'read_file', args: { path: 'src/lib/base.ts' } }, { cap: researcher(), ws: WS });
  assert.equal(entero.truncated, false, 'lo que cabe entero NO se marca truncado');
});

test('read_symbol esta en el registro: una tool que el modelo no ve no existe', () => {
  assert.ok(toolRegistry().has('read_symbol'));
  assert.match(toolCatalogText(), /^- read_symbol\(symbol, path\?\)/m);
});

test('run_test_backend existe, corre jest y lo hace DESDE backend/', () => {
  // MEDIDO en H-20260819-e62bf69e, la primera vuelta del anillo que toco
  // `backend/src`: el builder llamo a `run_test` 40 veces --vitest desde la
  // raiz, que no ve un spec de jest--, siempre en rojo, agoto el tope de
  // iteraciones y la vuelta murio con ROLLBACK en la etapa 7. El techo estaba
  // ESCRITO como trabajo aplazado en el `$ceiling` de `run_test`.
  const t = toolRegistry().get('run_test_backend');
  assert.ok(t, 'no esta en el registro: una tool que el modelo no ve no existe');
  assert.deepEqual(t.cmd, ['npx', 'jest']);
  assert.equal(t.cwd, 'backend');
  assert.ok(t.acceptsPaths);
  assert.match(toolCatalogText(), /^- run_test_backend/m);
});

test('siguen siendo DOS tools, nunca un parametro: los runners no corren a la vez', () => {
  // La regla del repo es que jest y vitest NUNCA corren simultaneos. Dos
  // comandos separados no se pueden invocar juntos por accidente; un
  // `run_test(runner)` si, y el dia que alguien pase el valor equivocado el
  // fallo seria silencioso.
  const fe = toolRegistry().get('run_test');
  assert.deepEqual(fe.cmd, ['npx', 'vitest', 'run']);
  assert.equal(fe.cwd, undefined, 'run_test corre en la raiz, sin cwd declarado');
  assert.equal(fe.choice, undefined, 'el runner NO es una eleccion dentro de una sola tool');
});

test('el `cwd` del registro se HONRA al ejecutar, no solo se declara', () => {
  // Sin esto la entrada de `run_test_backend` seria una declaracion que nadie
  // lee: el defecto de `el-fix-que-no-existe`, aplicado a un campo del registro.
  const src = readFileSync(resolve(import.meta.dirname, 'tools.mjs'), 'utf8');
  assert.match(src, /const dir = t\.cwd \? join\(ws\.path, t\.cwd\) : ws\.path;/);
  assert.match(src, /cwd: dir,/);
});

test('git_diff ensena EL MISMO diff que se le va a medir, no uno parecido', () => {
  // Habia DOS diffs. El ChangeSet se construye con `git add -N` + `git diff -M
  // HEAD`; la tool corria `git diff HEAD` a secas. Sin `add -N` los ficheros
  // NUEVOS no salen, y sin `-M` un renombrado se lee como un borrado entero mas
  // una creacion entera: el builder miraba su trabajo por una ventana distinta
  // de la que usan la etapa 7 para medir y el revisor para juzgar.
  //
  // Muerde en la clase `move`, que vale por `similarity index 100%`: un builder
  // que comprobara su renombrado con esta tool no veria ni un `rename from`.
  const src = readFileSync(resolve(import.meta.dirname, 'tools.mjs'), 'utf8');
  assert.match(src, /case 'git_diff':[\s\S]{0,1400}diffDelWorkspace\(ws\)/);
  // Y el defecto exacto no vuelve: la tool ya no arma su propio `git diff HEAD`.
  assert.doesNotMatch(src, /gitEn\(ws, \['diff', 'HEAD'\], tope\)/);
});

test('list_files entrega el sha que la mutacion va a exigir, no solo el nombre', async () => {
  // `read_file` y `search` ya llevaban el hash CON el contenido, y el comentario
  // que lo justifica lleva escrito ahi desde entonces: evita gastar una llamada
  // en `inspect_file` solo para poder escribir. `list_files` -- la tool que
  // enumera lo que se va a MOVER-- era la unica de las tres que no lo llevaba.
  //
  // Y muerde justo donde no se ve: un `move_file` no necesita leer el fichero,
  // solo moverlo, asi que en una mudanza el builder no tiene ningun otro motivo
  // para pedir su contenido. MEDIDO en H-20260820-bd6fe99e: 40 iteraciones
  // agotadas, 3 de ellas DENY por MUTATION_UNVERSIONED sobre ficheros que nadie
  // habia leido porque nadie necesitaba leerlos.
  const t = T(builder, WS);
  await t('create_file', { path: 'src/lib/inventario.ts', content: 'export const x = 1;\n' });

  const r = await t('list_files', { path: 'src/lib' });
  assert.equal(r.exitCode, 0);
  const linea = r.output.split('\n').find((l) => l.startsWith('src/lib/inventario.ts'));
  const sha = /\tsha ([0-9a-f]{16})$/.exec(linea ?? '')?.[1];
  assert.ok(sha, `list_files no entrego el sha: ${JSON.stringify(linea ?? r.output.slice(0, 200))}`);

  // Y ES EL MISMO que el Mutation Protocol acepta. Sin esta segunda mitad el
  // ahorro seria falso: un hash que no sirve de `baseHash` no ahorra la llamada.
  const mv = await t('move_file', {
    source: 'src/lib/inventario.ts', destination: 'src/lib/inventario-movido.ts', baseHash: sha,
  });
  assert.equal(mv.ok, true, `el sha de list_files no valio como baseHash: ${mv.code ?? ''} ${mv.error ?? ''}`);
  assert.equal(existsSync(join(WS.path, 'src/lib/inventario.ts')), false);
});

// ── Un parche que no puede aplicar se rechaza AQUI, y diciendo por que ────────
//
// Los dos parches de este test son LITERALES de H-20260820-4d51dd67, llamadas 12
// y 13: el mismo cambio, sobre el mismo fichero, con segundos de diferencia. La
// unica diferencia es el contexto, y decide entre `exit=1` y `exit=0`.
const SIN_CONTEXTO = [
  '--- a/src/app/aafa/archivero/ArchiveroWrapper.tsx',
  '+++ b/src/app/aafa/archivero/ArchiveroWrapper.tsx',
  '@@ -5,5 +5,5 @@',
  '-import { useAuth } from "../../auth/AuthContext";',
  '+import { useAuth } from "../../../auth/AuthContext";',
  '',
].join('\n');

const CON_CONTEXTO = [
  '--- a/src/app/aafa/archivero/ArchiveroWrapper.tsx',
  '+++ b/src/app/aafa/archivero/ArchiveroWrapper.tsx',
  '@@ -3,8 +3,8 @@',
  ' import { useState, useEffect, useCallback } from "react";',
  ' import { useNavigate } from "react-router-dom";',
  '-import { useAuth } from "../../auth/AuthContext";',
  '+import { useAuth } from "../../../auth/AuthContext";',
  ' import { ArchiveroModule } from "./ArchiveroModule";',
  '',
].join('\n');

test('un hunk SIN contexto se rechaza: git lo situa por las lineas que no cambian', () => {
  const mal = revisarParche(SIN_CONTEXTO);
  assert.match(mal, /CONTEXTO/, `deberia rechazarse: ${mal}`);
  assert.equal(revisarParche(CON_CONTEXTO), null, 'el mismo cambio CON contexto es valido');
});

test('un parche vacio o sin cabecera se rechaza por su nombre, no con «no aplica»', () => {
  // Dos llamadas de esa vuelta mandaron la cadena vacia y otra un `@@` suelto.
  // Git contestaba exit=128 y «No hay parches validos», que no dice cual de las dos.
  assert.match(revisarParche(''), /VACIO/);
  assert.match(revisarParche('   \n '), /VACIO/);
  assert.match(revisarParche('@@\n-import { useAuth } from "x";\n'), /cabecera del diff/);
  assert.match(revisarParche('--- a/x\n+++ b/x\n-uno\n+dos\n'), /cabecera de hunk/);
});

test('un fichero NUEVO no tiene contexto que dar, y ahi la ausencia es correcta', () => {
  assert.equal(revisarParche('--- /dev/null\n+++ b/x.ts\n@@ -0,0 +1 @@\n+export const x = 1;\n'), null);
});

test('el rechazo llega al modelo por la tool, no solo por la funcion', async () => {
  // Una validacion exportada y no cableada es `el-fix-que-no-existe`.
  const t = T(builder, WS);
  const { hash } = await t('read_file', { path: 'src/lib/base.ts' });
  const r = await t('apply_patch', { path: 'src/lib/base.ts', patch: '', baseHash: hash });
  assert.equal(r.exitCode, 1, 'la tool funciono; el comando no se llego a ejecutar');
  assert.match(r.output, /RECHAZADO antes de git/);
  assert.match(r.output, /VACIO/);
});

test('el registro DECLARA el contexto que la tool exige', () => {
  // Sin esto la regla solo existe en el rechazo: el modelo la aprende fallando.
  const t = toolRegistry().get('apply_patch');
  assert.match(t.why, /3 lineas de contexto/);
});

test('list_files DICE cual de sus rutas ya no existe en disco', async () => {
  // `git ls-files` lista el INDICE. `move_file` renombra en disco sin tocarlo, asi
  // que tras una mudanza el origen sigue apareciendo. Callarlo manda al modelo a
  // leer una ruta muerta: en H-20260820-481ff307 el builder lo descubrio solo, con
  // `git_status`, y lo dejo escrito en su resumen como una rareza de la tool.
  const t = T(builder, WS);
  await t('create_file', { path: 'src/lib/fantasma.ts', content: 'export const f = 1;\n' });
  const { hash } = await t('read_file', { path: 'src/lib/fantasma.ts' });
  await t('move_file', { path: 'src/lib/fantasma.ts', source: 'src/lib/fantasma.ts', destination: 'src/lib/reaparecido.ts', baseHash: hash });

  const r = await t('list_files', { path: 'src/lib' });
  const linea = r.output.split('\n').find((l) => l.startsWith('src/lib/fantasma.ts'));
  if (linea) assert.match(linea, /AUSENTE/, `la ruta muerta se sirve como si existiera: ${linea}`);

  const vivo = r.output.split('\n').find((l) => l.startsWith('src/lib/reaparecido.ts'));
  assert.match(vivo ?? '', /sha [0-9a-f]{16}/, 'el destino si lleva su sha');
});

// ── El parche escribe donde diga su cabecera, no donde diga `path` ───────────
//
// `git apply` nunca recibe el `path` declarado: obedece a `--- a/<ruta>` y
// `+++ b/<ruta>`. Mientras nadie los comparaba, una llamada podia declarar la
// version de A y escribir en B -- con la contencion, el `baseHash` y la bitacora
// entera mirando a A--, que es el agujero exacto que el Mutation Protocol existe
// para tapar.
test('el parche que dice tocar OTRO fichero se rechaza antes de llegar a git', () => {
  const patch = [
    '--- a/src/lib/otro.ts', '+++ b/src/lib/otro.ts',
    '@@ -1 +1,2 @@', ' export const uno = 1;', '+export const dos = 2;', '',
  ].join('\n');

  const mal = revisarParche(patch, 'src/lib/base.ts');
  assert.match(mal ?? '', /src\/lib\/otro\.ts/, `deberia nombrar la ruta ajena: ${mal}`);
  assert.match(mal ?? '', /baseHash/, 'y decir por que importa, no solo que no');

  assert.equal(revisarParche(patch, 'src/lib/otro.ts'), null,
    'el mismo parche, declarando SU ruta, es valido');
  assert.equal(revisarParche(patch), null,
    'sin ruta declarada no hay nada que comparar: el resto de la revision no cambia');
});

test('un parche con la cabecera de otro fichero no escribe en ese fichero', async () => {
  // La mitad que de verdad prueba el defecto: la funcion pura puede estar bien y
  // no estar cableada -- `el-fix-que-no-existe`. Antes de esto el parche llegaba
  // a git, git lo aplicaba sobre 'ajeno.ts' (existe en disco, aunque nadie
  // declarase su version), la bitacora media 'base.ts' -- intacto, `changed:
  // false`-- y git veia cambiado un fichero que la bitacora no nombraba. Las dos
  // autoridades del ChangeSet, describiendo ficheros distintos.
  const t = T(builder, WS);
  await t('create_file', { path: 'src/lib/ajeno.ts', content: 'export const ajeno = 1;\n' });
  const { hash } = await t('read_file', { path: 'src/lib/base.ts' });

  const r = await t('apply_patch', {
    path: 'src/lib/base.ts', baseHash: hash,
    patch: '--- a/src/lib/ajeno.ts\n+++ b/src/lib/ajeno.ts\n@@ -1 +1,2 @@\n export const ajeno = 1;\n+export const colado = 2;\n',
  });

  assert.equal(r.exitCode, 1, 'la tool funciono; el comando no se llego a ejecutar');
  assert.match(r.output, /RECHAZADO antes de git/);
  assert.doesNotMatch(
    readFileSync(join(WS.path, 'src/lib/ajeno.ts'), 'utf8'), /colado/,
    'el fichero cuya version NADIE declaro no se toca',
  );
  assert.equal(r.mutation.changed, false, 'y la bitacora no registra un cambio que no hubo');
});

test('un listado GRANDE: shas en lo que vuelve, y la cuenta sobre la poblacion ENTERA', async () => {
  // Dos defectos en el mismo sitio, los dos cazados por third.
  //
  // 1. El contador que habia aqui (50, luego 200) acotaba la POBLACION EQUIVOCADA:
  //    contaba lo que `list_files` devuelve, y lo unico comparable contra el era lo
  //    que la spec DECLARA. Una tarea de 10 ficheros que liste `src/` se traia 900
  //    rutas sin sha con el contador en verde.
  //
  // 2. El recorte era DOBLE. `gitEn` cortaba por caracteres y anadia un marcador
  //    detras; el bucle del sha cortaba otra vez. MEDIDO sobre `src backend/src`:
  //    718 ficheros listados, 166 supervivientes del primer corte, `omittedFiles`
  //    reportando 41. Los 551 perdidos antes no entraban en la cuenta -- y un
  //    conteo que sub-reporta es peor que ninguno, porque la etapa de abajo se lo
  //    cree. Ademas el `pop()` se llevaba el MARCADOR y dejaba dentro la ruta
  //    partida, que salia como `AUSENTE`: una afirmacion falsa que culpa a git de
  //    un corte del harness.
  //
  // Este caso tiene la salida cruda POR ENCIMA del presupuesto a proposito: con
  // rutas cortas `gitEn` no llegaba a recortar y el defecto no se veia.
  const N = 500;
  const dir = join(WS.path, 'src/muchos');
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < N; i++) {
    writeFileSync(join(dir, `componente-inventariado-${String(i).padStart(3, '0')}.ts`), `export const n = ${i};\n`);
  }

  const r = await T(builder, WS)('list_files', { path: 'src/muchos' });
  const lineas = r.output.split('\n').filter(Boolean);

  assert.ok(lineas.length > 0, 'listado vacio');
  for (const l of lineas) {
    assert.match(l, /\tsha [0-9a-f]{16}$/, `una linea sin sha: ${l}`);
    assert.doesNotMatch(l, /AUSENTE/, `una ruta partida por el recorte, culpando a git: ${l}`);
  }
  // LA CUENTA, sobre los N que hay de verdad -- no sobre los que sobrevivieron a
  // un primer recorte del que esta cuenta no sabia nada.
  assert.equal(r.omittedFiles, N - lineas.length,
    `omittedFiles=${r.omittedFiles} pero faltan ${N - lineas.length}: la cuenta se mide sobre una poblacion ya recortada`);
  assert.equal(r.truncated, true);
  rmSync(dir, { recursive: true, force: true });
});

test('sin `path` no se hashea: eso es orientacion, no inventario de una tarea', async () => {
  // El sha son 21 chars por linea. En un barrido del repo --que es lo que hace el
  // researcher-- le quitan sitio a rutas que si necesita, y ninguna se va a mutar.
  const r = await T(researcher, WS)('list_files', {});
  assert.equal(r.exitCode, 0);
  assert.doesNotMatch(r.output, /\tsha [0-9a-f]{16}/, 'un listado de orientacion gastando 21 chars por linea en un hash que nadie va a usar');
});

test('un rechazo del Protocolo dice TAMBIEN que el parche estaba vacío', async () => {
  // MEDIDO en H-20260823-4e052d0a, llamada 86: `apply_patch` con `baseHash: null`
  // Y `patch: ''`. El Protocolo contestó «sin baseHash» —correcto— y el modelo
  // gastó la iteración siguiente en conseguir el hash de un parche que no podía
  // aplicar nunca. `revisarParche` lo dice en una línea, pero vive dentro del
  // `case` y el `case` no llegó a correr.
  //
  // El orden no se toca: el Protocolo va antes que todo cuerpo de caso, porque una
  // regla que cada caso decide si aplicar no es una regla. Lo que se añade es que
  // el rechazo lleve las DOS verdades, que lo son a la vez.
  const r = await T(builder, WS)('apply_patch', { path: 'src/lib/base.ts', patch: '' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'MUTATION_UNVERSIONED');
  assert.match(r.error, /sin baseHash/, 'se perdió la razón del Protocolo');
  assert.match(r.error, /VACIO/i, 'el modelo se va a buscar un hash para un parche que no puede aplicar');
});
