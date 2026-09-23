// node --test harness/lib/
//
// «Sin hallazgos» es un resultado valido -- y tambien lo que devuelve una pasada
// perezosa, una truncada o una que se quedo sin espacio de salida. Leer la
// respuesta no distingue «no hay nada» de «no vi nada»: hay que preguntar otra vez.
//
// Y lo que bloqueo una ronda no muere por no volver a salir. Medido en
// H-20260816-e2ec5f67: un P5 confirmado por 2 de 3 desaparecio de la ronda
// siguiente y la vuelta acabo en PASSED sin que nadie lo refutara ni lo arreglara.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validation, entradasDeRevision } from './stages-model.mjs';

const H = (over = {}) => ({ file: 'src/a.ts', symbol: 'f', claim: 'algo', severity: 'P4', evidence: ['x'], ...over });

/** ctx con un reviewer de guion: devuelve la respuesta n-esima. */
function ctxCon(respuestas, { pendientes = [] } = {}) {
  const prompts = [];
  return {
    prompts,
    assignments: { reviewer: { provider: 'ficticio', model: 'ficticio', id: 'ficticio' } },
    artifacts: { Execution: { payload: { files: ['src/a.ts'], diff: 'x' } } },
    pendientes,
    invocations: {},
    // Se inyecta el `pedir` de la etapa: los tests del bucle no gastan un token,
    // y aqui tampoco. Lo que se prueba es la POLITICA, no el proveedor.
    __invoke: async (_ctx, sufijo) => {
      prompts.push(sufijo);
      return { payload: { findings: respuestas[prompts.length - 1] ?? [] }, producedBy: { capability: 'reviewer' } };
    },
  };
}

test('con hallazgos NO se pide segunda opinion: no cuesta nada el caso normal', async () => {
  const ctx = ctxCon([[H()]]);
  const r = await validation(ctx, ctx.__invoke);
  assert.equal(r.payload.passes, 1);
  assert.equal(r.payload.zeroCorroborated, null, 'no aplica: hubo hallazgos');
  assert.equal(ctx.prompts.length, 1);
});

test('un CERO se corrobora con una segunda pasada independiente', async () => {
  const ctx = ctxCon([[], []]);
  const r = await validation(ctx, ctx.__invoke);
  assert.equal(ctx.prompts.length, 2, 'la primera dijo cero: se pregunta otra vez');
  assert.equal(r.payload.passes, 2);
  assert.equal(r.payload.zeroCorroborated, true);
  assert.deepEqual(r.payload.findings, []);
});

test('si la segunda SI ve algo, el cero era falso y gana lo que se vio', async () => {
  const ctx = ctxCon([[], [H({ severity: 'P2' })]]);
  const r = await validation(ctx, ctx.__invoke);
  assert.equal(r.payload.zeroCorroborated, false);
  assert.equal(r.payload.findings.length, 1);
  assert.equal(r.status, 'WARN', 'que las dos pasadas discrepen no se calla');
});

test('a la segunda NO se le pide que confirme: se le pide que revise', async () => {
  const ctx = ctxCon([[], []]);
  await validation(ctx, ctx.__invoke);
  assert.match(ctx.prompts[1], /no te lo digo para que lo confirmes/);
  // Decirle «la otra no encontro nada» a secas es pedir corroboracion, no
  // revision, y dos pasadas que se anclan valen lo que una.
});

test('lo PENDIENTE se arrastra aunque la ronda no lo reporte', async () => {
  const ctx = ctxCon([[], []], { pendientes: [H({ severity: 'P3', findingId: 'H-X:f:1' })] });
  const r = await validation(ctx, ctx.__invoke);
  assert.equal(r.payload.findings.length, 1);
  assert.equal(r.payload.findings[0].carried, true);
  assert.equal(r.payload.carried, 1);
});

test('el arrastre NO enmascara la corroboracion del cero', async () => {
  // Si lo heredado contara como «hallazgo de esta ronda», el cero dejaria de
  // comprobarse justo cuando hay algo pendiente -- que es cuando mas importa.
  const ctx = ctxCon([[], []], { pendientes: [H({ findingId: 'H-X:f:1' })] });
  const r = await validation(ctx, ctx.__invoke);
  assert.equal(ctx.prompts.length, 2, 'se pregunto dos veces pese a haber pendientes');
  assert.equal(r.payload.zeroCorroborated, true);
});

test('el allowlist y los cambiados dejan de llamarse igual', () => {
  // MEDIDO en H-20260820-c9a55e79, item cm-4-security. Al revisor le llegaban DOS
  // payloads con una clave `files` cada uno:
  //   Plan.payload.files       lo que se PUEDE tocar (task.files)
  //   Execution.payload.files  lo que quedo CAMBIADO (git status)
  //
  // Levanto un P2 diciendo «el allowlist lo excluye» sobre un fichero que el
  // allowlist SI incluye -- era la SEMILLA de la vuelta. El builder leyo el diff,
  // no lo vio, y contesto «el hallazgo es FALSO». Ninguno mintio. Cuatro rondas.
  const plan = { stage: 'Plan', payload: { goal: 'g', acceptance: ['a'], files: ['src/a.tsx', 'src/a.spec.tsx'] } };
  const exec = { stage: 'Execution', payload: { files: ['src/a.spec.tsx'], diff: 'd', status: 'DONE' } };

  const e = entradasDeRevision(plan, exec);
  assert.deepEqual(e.Intencion.payload.allowlist, ['src/a.tsx', 'src/a.spec.tsx']);
  assert.deepEqual(e.ChangeSet.payload.changedFiles, ['src/a.spec.tsx']);

  // Y NINGUNO conserva la clave ambigua: dejarla es tener las dos cosas otra vez.
  assert.equal(e.Intencion.payload.files, undefined, 'el Plan sigue trayendo `files`');
  assert.equal(e.ChangeSet.payload.files, undefined, 'el ChangeSet sigue trayendo `files`');

  // El resto del payload viaja intacto: esto renombra, no filtra.
  assert.equal(e.Intencion.payload.goal, 'g');
  assert.deepEqual(e.ChangeSet.payload.diff, 'd');
  assert.equal(e.ChangeSet.payload.status, 'DONE');

  // Un artefacto sin `files` se devuelve tal cual, sin inventar la clave nueva.
  const sinFiles = { stage: 'Plan', payload: { goal: 'g' } };
  assert.deepEqual(entradasDeRevision(sinFiles, sinFiles).Intencion, sinFiles);
  assert.deepEqual(entradasDeRevision(null, null), { Intencion: null, ChangeSet: null });
});
