// node --test harness/lib/
//
// Los SEIS tests de capability. Todos corren SIN invocar un modelo, y eso es la
// tesis entera de este bloque: el modelo puede fallar, y el harness no debe
// depender de que "entienda" sus limites.
//
//   Contract · Permission · Input · Output · Boundary · Evidence
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCapabilities } from './capabilities.mjs';
import {
  validateManifest, checkWriteBoundary, checkAction, puedeEnEtapa,
  assertWithinBoundary, dentroDe, CAMPOS_OBLIGATORIOS, PROHIBIDO_SIEMPRE,
} from './capability-contract.mjs';

const caps = loadCapabilities();
const byId = Object.fromEntries(caps.map((c) => [c.id, c]));
const builder = byId.builder;
const researcher = byId.researcher;

// ── 1 · CapabilityContractTest ──────────────────────────────────────────────
test('CONTRACT: los 7 manifiestos declaran el contrato completo', () => {
  assert.equal(caps.length, 7);
  for (const c of caps) {
    assert.deepEqual(validateManifest(c), [], `'${c.id}' incompleto`);
  }
});

test('CONTRACT: un manifiesto incompleto se detecta al CARGAR, no al invocar', () => {
  const cojo = { id: 'x', version: 1 };
  const p = validateManifest(cojo);
  assert.ok(p.length >= CAMPOS_OBLIGATORIOS.length - 2);
  assert.ok(p.some((x) => x.includes('purpose')));
  // Y no vale declarar la frontera a medias.
  assert.ok(validateManifest({ ...builder, permissions: ['src'] })
    .some((x) => x.includes('debe declarar read/write/execute')));
});

test('CONTRACT: la version es obligatoria y entera', () => {
  assert.ok(validateManifest({ ...builder, version: 'v1' }).some((x) => x.includes('version')));
});

// ── 2 · CapabilityPermissionTest ────────────────────────────────────────────
test('PERMISSION: commit, push y deploy estan prohibidos para TODA capacidad', () => {
  for (const c of caps) {
    for (const a of PROHIBIDO_SIEMPRE) {
      assert.equal(checkAction(c, a).allowed, false, `'${c.id}' podria '${a}'`);
      assert.equal(checkAction(c, `git ${a}`).allowed, false, `'${c.id}' podria 'git ${a}'`);
    }
  }
});

test('PERMISSION: una capacidad no puede renunciar a la prohibicion global', () => {
  // AISLADO. Con el builder real, `git push` caeria igual por permissions.execute
  // (no esta en su lista), asi que el test pasaria sin comprobar la prohibicion
  // global. Aqui la capacidad permite EJECUTARLO TODO y no prohibe nada: si la
  // lista global no mandara, `git push` estaria permitido.
  const tramposo = {
    id: 'tramposo', version: 1,
    forbidden: [],
    permissions: { read: ['repository'], write: [], execute: ['*'] },
  };
  assert.equal(checkAction(tramposo, 'npm test').allowed, true, 'el comodin permite lo demas');
  for (const a of PROHIBIDO_SIEMPRE) {
    const r = checkAction(tramposo, `git ${a}`);
    assert.equal(r.allowed, false, `'git ${a}' deberia estar prohibido pese al comodin`);
    assert.equal(r.rule, 'PROHIBIDO_SIEMPRE');
  }
  // Y validateManifest lo denuncia en vez de dejarlo pasar.
  assert.ok(validateManifest({ ...builder, forbidden: [] }).some((x) => x.includes('forbidden')));
});

test('PERMISSION: solo se ejecuta lo declarado en permissions.execute', () => {
  assert.equal(checkAction(builder, 'npm test').allowed, true);
  assert.equal(checkAction(builder, 'rm -rf /').allowed, false);
  assert.equal(checkAction(builder, 'node deploy.mjs').allowed, false);
  // El researcher no escribe ni construye: no tiene por que correr npm run.
  assert.equal(checkAction(researcher, 'npm run build').allowed, false);
  assert.equal(checkAction(researcher, 'git log --oneline').allowed, true);
});

// ── 3 · CapabilityInputTest ─────────────────────────────────────────────────
test('INPUT: todo `inputs` es un contrato que existe en contracts.json', async () => {
  const { readFileSync } = await import('node:fs');
  const C = JSON.parse(readFileSync(new URL('../contracts/contracts.json', import.meta.url), 'utf8'));
  for (const c of caps) {
    for (const i of c.inputs ?? []) {
      assert.ok(C.contracts[i], `'${c.id}' consume '${i}', que no existe en contracts.json`);
    }
  }
});

test('INPUT: `requiredContracts` cubre lo que la capacidad consume y produce', () => {
  for (const c of caps) {
    for (const x of [...(c.inputs ?? []), ...(c.outputs ?? [])]) {
      assert.ok((c.requiredContracts ?? []).includes(x),
        `'${c.id}' usa '${x}' sin declararlo en requiredContracts`);
    }
  }
});

// ── 4 · CapabilityOutputTest ────────────────────────────────────────────────
test('OUTPUT: quien escribe declara salidas; quien no escribe, no las inventa', () => {
  for (const c of caps) {
    const escribe = (c.permissions?.write ?? []).length > 0;
    if (escribe) assert.ok((c.outputs ?? []).length, `'${c.id}' escribe y no declara outputs`);
  }
  assert.deepEqual(researcher.permissions.write, [], 'el researcher no escribe: es su definicion');
});

test('OUTPUT: toda capacidad declara con que evidencia cierra', () => {
  for (const c of caps) {
    assert.ok(c.evidence && String(c.evidence).length > 3, `'${c.id}' sin evidencia declarada`);
  }
});

// ── 5 · CapabilityBoundaryTest ──────────────────────────────────────────────
test('BOUNDARY: el builder escribe en src/ y NO en harness/policy', () => {
  assert.deepEqual(checkWriteBoundary(builder, ['src/app/x.tsx', 'backend/src/y.ts']), []);

  const v = checkWriteBoundary(builder, ['harness/policy/router.json']);
  assert.equal(v.length, 1);
  assert.equal(v[0].rule, 'denyPaths');
});

test('BOUNDARY: denyPaths GANA aunque la ruta tambien estuviera permitida', () => {
  // Si no ganara, una lista de denegacion no significaria nada.
  const raro = { ...builder, permissions: { ...builder.permissions, write: ['harness'] }, denyPaths: ['harness/policy'] };
  const v = checkWriteBoundary(raro, ['harness/policy/router.json']);
  assert.equal(v[0].rule, 'denyPaths');
  assert.deepEqual(checkWriteBoundary(raro, ['harness/lib/x.mjs']), []);
});

test('BOUNDARY: el prefijo se compara por SEGMENTO, no por texto', () => {
  // `src` no puede cubrir `srcreto/`: comparar con startsWith a pelo abriria la
  // frontera a cualquier directorio que empiece igual.
  assert.equal(dentroDe('src/a.ts', 'src'), true);
  assert.equal(dentroDe('srcreto/a.ts', 'src'), false);
  assert.equal(checkWriteBoundary(builder, ['srcreto/a.ts']).length, 1);
});

test('BOUNDARY: el researcher no puede escribir NADA', () => {
  const v = checkWriteBoundary(researcher, ['memory/architecture/x.md']);
  assert.equal(v.length, 1);
  assert.equal(v[0].rule, 'permissions.write');
});

test('BOUNDARY: salir de la frontera LANZA, no avisa', () => {
  assert.throws(() => assertWithinBoundary(builder, ['memory/decisions/ADR-006.md']),
    /frontera violada por 'builder'/);
  assert.doesNotThrow(() => assertWithinBoundary(builder, ['src/a.ts']));
});

test('BOUNDARY: una capacidad solo corre en las etapas que declara', () => {
  assert.equal(puedeEnEtapa(builder, 'Execution'), true);
  assert.equal(puedeEnEtapa(builder, 'Security'), false);
  assert.equal(puedeEnEtapa(byId.security, 'Security'), true);
});

// ── 6 · CapabilityEvidenceTest ──────────────────────────────────────────────
test('EVIDENCE: toda etapa declarada existe en el anillo real', async () => {
  const { readFileSync } = await import('node:fs');
  const M = JSON.parse(readFileSync(
    new URL('../../.kiro/specs/h-001-ring-execution/h-001.json', import.meta.url), 'utf8'));
  const delAnillo = new Set(M.stages.map((s) => s.stage));
  // `Orchestration` es del trigger y vive FUERA del anillo: se declara aparte.
  const fuera = new Set(['Orchestration', 'Evidence2']);
  for (const c of caps) {
    for (const s of c.allowedStages ?? []) {
      assert.ok(delAnillo.has(s) || fuera.has(s),
        `'${c.id}' declara la etapa '${s}', que no existe en el anillo`);
    }
  }
});

test('EVIDENCE: cada capacidad declara su politica de fallo y de memoria', () => {
  const fallos = new Set(['STOP', 'ROLLBACK', 'CONTINUE', 'REWORK']);
  const memorias = new Set(['none', 'read-only', 'propose', 'write']);
  for (const c of caps) {
    assert.ok(fallos.has(c.failurePolicy), `'${c.id}': failurePolicy '${c.failurePolicy}' desconocida`);
    assert.ok(memorias.has(c.memoryPolicy), `'${c.id}': memoryPolicy '${c.memoryPolicy}' desconocida`);
  }
});

test('EVIDENCE: nadie escribe en memory/decisions — un ADR lo aprueba una persona', () => {
  for (const c of caps) {
    assert.deepEqual(checkWriteBoundary(c, ['memory/decisions/ADR-999.md']).length, 1,
      `'${c.id}' podria escribir un ADR por su cuenta`);
  }
});

// ── El manifiesto es la UNICA autoridad ─────────────────────────────────────
test('el modelo requerido por la capacidad existe en la clase que declara', async () => {
  const { readFileSync } = await import('node:fs');
  const router = JSON.parse(readFileSync(new URL('../policy/router.json', import.meta.url), 'utf8'));
  for (const c of caps) {
    const cls = router.classes[c.model_class];
    assert.ok(cls, `'${c.id}' declara model_class '${c.model_class}' inexistente`);
    // Lo que la capacidad exige debe estar cubierto por lo que su clase exige:
    // si no, Compute podria darle un modelo que no le sirve.
    for (const k of c.requiredModelCapabilities ?? []) {
      assert.ok((cls.requires ?? []).includes(k),
        `'${c.id}' exige '${k}' pero su clase '${c.model_class}' no lo pide a Compute`);
    }
  }
});
