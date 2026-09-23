// node --test harness/lib/
//
// El builder no sabia POR QUE volvia. En un REWORK se le reenviaba el mismo
// WorkPackage y nada mas -- ni los hallazgos que bloquearon ni el veredicto de
// seguridad -- asi que corregia a ciegas. Explica buena parte de los reintentos
// que se agotaron sin converger: se le pedia arreglar algo que no se le dijo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { motivoDelRework } from './stages-model.mjs';

test('en la primera pasada no hay motivo que dar', () => {
  assert.equal(motivoDelRework({ rework: 0 }), '');
});

test('los hallazgos que bloquearon llegan al prompt, con severidad y cita', () => {
  const t = motivoDelRework({
    rework: 1,
    pendientes: [{ severity: 'P3', file: 'src/a.ts', symbol: 'f', claim: 'el test no discrimina' }],
  });
  assert.match(t, /POR QUE VUELVES — rework 1/);
  assert.match(t, /\[P3\] src\/a\.ts:f — el test no discrimina/);
  assert.match(t, /no rehagas lo que ya estaba bien/);
});

test('el bloqueo de seguridad llega CON su remediacion', () => {
  const t = motivoDelRework({
    rework: 1,
    artifacts: { Security: { payload: { blocked: [{
      severity: 'P1', rule: 'xss-innerhtml-sin-sanitizar', path: 'src/a.tsx', location: '9:7',
      impact: 'inyeccion de HTML sin sanitizar', remediation: 'usa dangerousHtml()',
    }] } } },
  });
  assert.match(t, /Seguridad — la politica BLOQUEA/);
  assert.match(t, /xss-innerhtml-sin-sanitizar en src\/a\.tsx:9:7/);
  // Sin la remediacion, el builder sabe que esta mal y no que hacer: el hallazgo
  // ya la trae desde `metadata.seguro` de la regla.
  assert.match(t, /arreglo: usa dangerousHtml\(\)/);
});

test('un rework sin hallazgos registrados lo DICE en vez de callar', () => {
  const t = motivoDelRework({ rework: 2 });
  assert.match(t, /No hay hallazgos registrados/);
  // Callar aqui devolveria al builder al estado ciego que este cambio corrige.
});

test('se le recuerda que `blocked` existe: ignorar un hallazgo falso no es opcion', () => {
  const t = motivoDelRework({ rework: 1, pendientes: [{ severity: 'P4', file: 'a', symbol: 'b', claim: 'c' }] });
  assert.match(t, /responde `blocked` con el motivo/);
});

// ── El `gate` de la etapa 4 lo ejecuta alguien ──────────────────────────────
// El manifiesto llevaba escrito «sus ficheros estan dentro de task.files» desde
// el principio, y era prosa. En H-20260817-35ad84ae el architect planifico sobre
// una ruta fuera de la lista y otra PROHIBIDA; el builder llego a Execution con
// un paquete imposible y la vuelta ya estaba perdida cuatro etapas antes.
test('un plan que sale de task.files falla en la etapa 4, no en la 7', async () => {
  const { assertPlanDentroDelAlcance } = await import('./stages-model.mjs');
  const task = { files: ['src/a.ts', 'src/a.spec.ts'] };

  assert.doesNotThrow(() => assertPlanDentroDelAlcance({ files: ['src/a.ts'] }, task));
  assert.doesNotThrow(() => assertPlanDentroDelAlcance({ goal: 'x' }, task), 'un plan sin `files` no es un plan fuera de alcance');

  assert.throws(
    () => assertPlanDentroDelAlcance({ files: ['src/a.ts', 'scripts/gate.sh'] }, task),
    /fuera de task\.files: scripts\/gate\.sh/,
  );
});

test('el error nombra lo permitido: sin eso, el architect no sabe a que atenerse', async () => {
  const { assertPlanDentroDelAlcance } = await import('./stages-model.mjs');
  try {
    assertPlanDentroDelAlcance({ files: ['otro.ts'] }, { files: ['src/a.ts'] });
    assert.fail('deberia lanzar');
  } catch (e) {
    assert.match(e.message, /Permitidos: src\/a\.ts/);
  }
});

// ── La PREGUNTA del rework, no solo su respuesta ─────────────────────────────
//
// C-3 acoto el FORMATO de la salida y ahi se quedo: en un rework se seguian
// pidiendo los 12 lentes sobre TODO el cambio y luego un resumen en 3 hallazgos.
// El trabajo mental era el mismo. MEDIDO en H-20260818-72a39e18: la etapa 9 del
// rework agoto los 32.768 tokens DOS VECES, con la reduccion aplicada, la misma
// entrada (+2 % de diff) y el mismo modelo que habia pasado la ronda anterior.

const PREVIO = [
  { status: 'CARRIED', verdict: 'CONFIRMED', severity: 'P4', file: 'src/lib/a.ts', symbol: 'f', claim: 'la validacion rompe los anios 0-99' },
  { status: 'FIXED', verdict: 'CONFIRMED', severity: 'P3', file: 'src/lib/b.ts', symbol: 'g', claim: 'ya corregido en la ronda anterior' },
];

test('ronda 0 pide los 12 lentes; un rework pide DOS preguntas', async () => {
  const { preguntaDeValidacion } = await import('./stages-model.mjs');

  const cero = preguntaDeValidacion({ lifecycle: [] });
  assert.match(cero, /12 lentes/, 'la primera revision es la revision entera');
  assert.doesNotMatch(cero, /REWORK/);

  const re = preguntaDeValidacion({ lifecycle: PREVIO });
  assert.doesNotMatch(re, /con los 12 lentes/, 'un rework NO redescubre el cambio: ya se reviso entero');
  assert.match(re, /REWORK/);
  assert.match(re, /se corrigio cada uno/);
  assert.match(re, /introdujo alguno nuevo/);
  // Y cuenta solo lo que sigue ABIERTO: el FIXED no vuelve.
  assert.match(re, /1 hallazgo\(s\) que seguian abiertos/);
});

test('el contexto del rework NO lleva lo ya cerrado', async () => {
  const { contextoDeRevision, abiertosDe } = await import('./stages-model.mjs');

  // `FIXED` ya no esta y `REFUTED` nunca estuvo: mandarlos otra vez es pedirle al
  // revisor que vuelva a pensar sobre lo cerrado, y pensar es lo que gasta.
  assert.deepEqual(abiertosDe(PREVIO).map((f) => f.symbol), ['f']);

  const c = contextoDeRevision({ lifecycle: PREVIO, artifacts: {} });
  assert.equal(c.Contexto.payload.rondaAnterior.length, 1);
  assert.equal(c.Contexto.payload.rondaAnterior[0].symbol, 'f');
});

test('MEDIDO, y el numero NO dice lo que uno querria: el enunciado del rework CRECE', async () => {
  // Se pidio medir el tamano antes y despues, y decirlo si no baja. NO BAJA:
  // el enunciado del rework es MAS LARGO en caracteres --explica que no repita la
  // revision y enumera las dos preguntas-- y solo el Contexto encoge.
  //
  // Eso NO invalida el cambio, pero cambia lo que se puede afirmar de el: lo que
  // se acota es el TRABAJO PEDIDO, no los bytes enviados. Si `completion_tokens`
  // se va en razonamiento, es el trabajo lo que hay que acotar; si se fuera en
  // texto de entrada, este cambio no serviria de nada. La medicion de
  // `reasoning_tokens` es la que resuelve cual de las dos.
  const { preguntaDeValidacion, contextoDeRevision } = await import('./stages-model.mjs');
  const enunciado = (ctx) => preguntaDeValidacion(ctx).length;
  const contexto = (ctx) => JSON.stringify(contextoDeRevision(ctx)).length;

  const c0 = { lifecycle: [], artifacts: {} };
  const c1 = { lifecycle: PREVIO, artifacts: {} };

  assert.ok(enunciado(c1) > enunciado(c0), 'el enunciado del rework CRECE, y hay que decirlo');
  // Lo unico que encoge de verdad: el contexto, que ya no arrastra lo cerrado.
  const todos = { lifecycle: PREVIO.map((f) => ({ ...f, status: 'CARRIED' })), artifacts: {} };
  assert.ok(contexto(c1) < contexto(todos), 'el contexto del rework SI encoge: solo lo abierto');
});

test('la instruccion de revision completa desaparece en el rework', async () => {
  // Es el cambio de FORMA, y es lo que este bloque existe para fijar.
  const { preguntaDeValidacion } = await import('./stages-model.mjs');
  assert.match(preguntaDeValidacion({ lifecycle: [] }), /con los 12 lentes/);
  assert.doesNotMatch(preguntaDeValidacion({ lifecycle: PREVIO }), /con los 12 lentes/);
});
