// node --test harness/lib/
//
// La politica de mutacion, sin tocar disco. Lo que se fija aqui es que NUNCA se
// aplica un cambio contra una version desconocida, y que las cuatro formas de
// «el disco no es lo que el modelo cree» se distinguen entre si: un conflicto no
// es lo mismo que un fichero ausente, y tratarlos igual le quita al modelo la
// informacion que necesita para corregirse.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkMutation, hashDe, mutationRecord, MutationCode, EXIGEN_BASE, HASH_LEN, carearConGit } from './mutation.mjs';

const H = (s) => hashDe(s);

test('el hash discrimina un cambio de un caracter', () => {
  assert.equal(H('export const uno = 1;\n').length, HASH_LEN);
  assert.notEqual(H('export const uno = 1;\n'), H('export const uno = 2;\n'));
  assert.equal(H('mismo'), H('mismo'), 'y es estable: sin el, cada lectura seria un conflicto');
});

// ── El caso que da nombre al protocolo ──────────────────────────────────────
test('MUTATION_CONFLICT: el fichero cambio debajo del modelo', () => {
  const v = checkMutation({
    op: 'apply_patch', path: 'src/a.ts',
    exists: true, currentHash: H('nuevo'), baseHash: H('viejo'),
  });
  assert.equal(v.ok, false);
  assert.equal(v.code, MutationCode.MUTATION_CONFLICT);
  assert.match(v.detail, /cambio debajo de ti/);
});

test('el mismo hash SI aplica: el protocolo no bloquea, discrimina', () => {
  const h = H('igual');
  for (const op of ['apply_patch', 'delete_file', 'move_file']) {
    const v = checkMutation({ op, path: 'src/a.ts', exists: true, currentHash: h, baseHash: h });
    assert.equal(v.ok, true, `${op} deberia aplicar`);
  }
});

// ── Version desconocida ─────────────────────────────────────────────────────
test('sin baseHash NO se parchea, ni se borra, ni se mueve', () => {
  for (const op of EXIGEN_BASE) {
    const v = checkMutation({ op, path: 'src/a.ts', exists: true, currentHash: H('x') });
    assert.equal(v.ok, false, `${op} sin baseHash deberia rechazarse`);
    assert.equal(v.code, MutationCode.MUTATION_UNVERSIONED);
  }
});

test('un fichero ausente no es un conflicto: es otra cosa, y se dice', () => {
  const v = checkMutation({ op: 'apply_patch', path: 'src/no.ts', exists: false, currentHash: null, baseHash: H('x') });
  assert.equal(v.code, MutationCode.MUTATION_MISSING);
});

// ── create: la afirmacion es la ausencia ────────────────────────────────────
test('create_file SIN baseHash afirma que no existe, y se rechaza si existe', () => {
  const v = checkMutation({ op: 'create_file', path: 'src/a.ts', exists: true, currentHash: H('algo') });
  assert.equal(v.ok, false);
  assert.equal(v.code, MutationCode.MUTATION_EXISTS);
  assert.match(v.detail, /declara su baseHash/, 'y le dice como hacerlo bien');

  assert.equal(checkMutation({ op: 'create_file', path: 'src/b.ts', exists: false, currentHash: null }).ok, true);
});

test('create_file CON baseHash es una reescritura declarada, y obedece al hash', () => {
  const h = H('viejo');
  assert.equal(checkMutation({ op: 'create_file', path: 'src/a.ts', exists: true, currentHash: h, baseHash: h }).ok, true);
  assert.equal(
    checkMutation({ op: 'create_file', path: 'src/a.ts', exists: true, currentHash: H('otro'), baseHash: h }).code,
    MutationCode.MUTATION_CONFLICT,
  );
  assert.equal(
    checkMutation({ op: 'create_file', path: 'src/a.ts', exists: false, currentHash: null, baseHash: h }).code,
    MutationCode.MUTATION_MISSING,
    'declarar el hash de algo que no existe es una afirmacion falsa, no una creacion',
  );
});

// ── El registro ─────────────────────────────────────────────────────────────
test('el registro contesta las preguntas del protocolo, incluida la incomoda', () => {
  const m = mutationRecord({
    op: 'apply_patch', path: 'src/a.ts', baseHash: H('v1'),
    before: H('v1'), after: H('v2'), capability: 'builder', workspace: '/ws',
  });
  assert.deepEqual(Object.keys(m).sort(),
    ['after', 'appliedIn', 'authorizedBy', 'baseHash', 'before', 'changed', 'op', 'path']);
  assert.equal(m.changed, true);
  assert.equal(m.authorizedBy, 'builder');
});

test('una mutacion que no cambio nada se REGISTRA como tal', () => {
  // Un `git apply` que no aplica deja el fichero igual. Sin `changed`, la traza
  // mostraria una mutacion indistinguible de una que si hizo algo.
  const m = mutationRecord({ op: 'apply_patch', path: 'src/a.ts', before: H('v1'), after: H('v1'), capability: 'builder', workspace: '/ws' });
  assert.equal(m.changed, false);
});

// ── El careo entre la bitacora y git ────────────────────────────────────────
//
// El ChangeSet publica dos autoridades sobre «que se toco» y hasta ahora no
// publicaba ninguna relacion entre ellas. En H-20260820-c9a55e79 el revisor leyo
// una, el builder leyo la otra, los dos tenian razon y el item cm-4 gasto cuatro
// rondas en una discusion que ningun dato del artefacto podia cerrar.
test('cuando las dos autoridades dicen lo mismo, el careo lo AFIRMA', () => {
  const c = carearConGit(
    [{ op: 'apply_patch', path: 'src/a.ts', changed: true, after: H('v2') }],
    ['src/a.ts'],
  );
  assert.equal(c.coinciden, true);
  assert.deepEqual(c.soloBitacora, []);
  assert.deepEqual(c.soloGit, []);
  // La ruta se normaliza: `./src/a.ts` y `src/a.ts` son la misma, y hacerlas
  // discrepar seria fabricar el fantasma que esto cierra.
  assert.equal(carearConGit([{ path: './src/a.ts', changed: true }], ['src/a.ts']).coinciden, true);
});

test('lo que la BITACORA da por cambiado y git no ve queda nombrado', () => {
  // El caso de c9a55e79, exacto: la mutacion registro el cambio y el arbol no lo
  // tiene. Ni «el revisor miente» ni «el builder miente»: son dos preguntas
  // distintas, y la unica salida es que el artefacto diga que discrepan.
  const c = carearConGit(
    [
      { op: 'apply_patch', path: 'src/Admin.tsx', changed: true, after: '6efddf6e00000000' },
      { op: 'create_file', path: 'src/Admin.spec.tsx', changed: true, after: 'aaaa000000000000' },
    ],
    ['src/Admin.spec.tsx'],
  );
  assert.equal(c.coinciden, false);
  assert.deepEqual(c.soloBitacora, [{ path: 'src/Admin.tsx', after: '6efddf6e00000000' }]);
  assert.deepEqual(c.soloGit, [], 'lo que git ve tambien estaba en la bitacora');
});

test('lo que GIT ve y ninguna mutacion registro tambien queda nombrado', () => {
  // La direccion contraria, y no es teorica: una herramienta de EJECUCION ensucia
  // el arbol sin pasar por el protocolo -- `run_build` regenera version.json-- y
  // eso llega a la frontera de `task.files`, que LANZA y se lleva el workspace.
  //
  // Y un `move_file` son DOS rutas: si solo contase `path`, el destino saldria
  // aqui como si lo hubiera escrito un fantasma.
  const c = carearConGit(
    [{ op: 'move_file', path: 'src/a.ts', destination: 'src/b.ts', changed: false }],
    ['src/a.ts', 'src/b.ts', 'public/version.json'],
  );
  assert.deepEqual(c.soloGit, ['public/version.json']);
  assert.deepEqual(c.soloBitacora, [], 'un renombrado no deja rastro en la bitacora: before === after');
  assert.equal(c.coinciden, false);
});
