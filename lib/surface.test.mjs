// node --test harness/lib/surface.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dominioDe, moduloDe, esTest, superficie, presupuesto, comprobar, analizar, assertSuperficie,
} from './surface.mjs';
import { loadSurfacePolicy } from './capabilities.mjs';

// Tasa de prueba: 20/fichero x 4 ficheros = 80, el mismo total que la primera
// calibracion, para que las aserciones numericas midan el MECANISMO y no el valor.
const POLICY = { enforce: true, maxLinesPerFile: 20, maxModules: 2, maxDomains: 1 };
const TASK = {
  files: [
    'src/lib/formatFileSize.ts',
    'src/lib/formatFileSize.spec.ts',
    'src/app/admin/AdminRespaldosS3.tsx',
    'src/app/admin/AdminRespaldosS3.spec.tsx',
  ],
};

test('el dominio es el SISTEMA, y lo transversal es plataforma', () => {
  assert.equal(dominioDe('src/app/aafa/Encargos.tsx'), 'aafa');
  assert.equal(dominioDe('backend/src/sipca/sello.service.ts'), 'sipca');
  assert.equal(dominioDe('src/lib/apiClient.ts'), 'plataforma');
  assert.equal(dominioDe('src/app/noexiste/X.tsx'), 'plataforma', 'un directorio que no es un sistema no inventa uno');
});

test('el modulo agrupa por sistema cuando lo hay', () => {
  assert.equal(moduloDe('src/app/admin/AdminRespaldosS3.tsx'), 'src/app/admin');
  assert.equal(moduloDe('backend/src/aafa/x.ts'), 'backend/src/aafa');
  assert.equal(moduloDe('src/lib/formatFileSize.ts'), 'src/lib');
});

test('reconoce specs de las cuatro extensiones que usa el repo', () => {
  for (const f of ['a.spec.ts', 'a.spec.tsx', 'a.test.ts', 'a.test.mjs']) assert.ok(esTest(f), f);
  assert.equal(esTest('src/lib/formatFileSize.ts'), false);
});

test('las cabeceras del diff NO cuentan como lineas', () => {
  const diff = [
    'diff --git a/x.ts b/x.ts', '--- a/x.ts', '+++ b/x.ts', '@@ -1 +1,2 @@',
    '+una', '+dos', '-vieja',
  ].join('\n');
  const s = superficie(['x.ts'], diff);
  assert.equal(s.linesAdded, 2, '`+++` no es una linea anadida');
  assert.equal(s.linesRemoved, 1, '`---` no es una linea borrada');
});

test('sin diff, las lineas quedan PENDING: no se aprueban por no medirse', () => {
  const a = analizar(TASK.files, { task: TASK, policy: POLICY });
  assert.equal(a.phase, 'PLANNED');
  assert.equal(a.checks.find((c) => c.id === 'lines').status, 'PENDING');
  assert.equal(a.ok, true, 'lo que si se puede medir cabe');
});

test('maxFiles y maxTestSurface salen de la TAREA, no de la policy', () => {
  const b = presupuesto(TASK, POLICY);
  assert.equal(b.maxFiles, 4);
  assert.equal(b.maxTestSurface, 2);
  assert.equal(POLICY.maxFiles, undefined, 'la policy no declara lo que la tarea ya declara');
});

// La policy declara la TASA; la tarea declara el ALCANCE. Un total plano decia
// que cuatro ficheros caben en el mismo presupuesto que uno, y por eso rechazo
// dos veces la unica ejecucion que cumplia la aceptacion entera.
test('el presupuesto de lineas ESCALA con los ficheros declarados', () => {
  assert.equal(presupuesto(TASK, POLICY).maxLines, 80, '4 ficheros x 20');
  assert.equal(presupuesto({ files: ['a.ts'] }, POLICY).maxLines, 20, '1 fichero x 20');
  assert.equal(POLICY.maxLines, undefined, 'la policy ya no declara un total');
});

test('una tarea puede ESTRECHAR su presupuesto, y gana', () => {
  const b = presupuesto({ ...TASK, surfaceBudget: { maxLines: 20 } }, POLICY);
  assert.equal(b.maxLines, 20);
});

test('bloquea por lineas cuando el cambio se pasa del presupuesto', () => {
  const diff = ['diff --git a/x b/x', ...Array.from({ length: 81 }, (_, i) => `+linea ${i}`)].join('\n');
  const a = analizar(['src/lib/formatFileSize.ts'], { task: TASK, policy: POLICY, diff });
  assert.equal(a.ok, false);
  assert.equal(a.risk, 'HIGH');
  assert.match(a.exceeded.join(), /lines 81 > 80/);
  assert.throws(() => assertSuperficie(a, POLICY), /fuera de presupuesto \(MEASURED\)/);
});

test('bloquea por DOMINIO: dos sistemas a la vez es otra clase de cambio', () => {
  const files = ['src/app/aafa/A.tsx', 'src/app/sipca/B.tsx'];
  const a = analizar(files, { task: { files }, policy: POLICY });
  assert.equal(a.domainsTouched, 2);
  assert.equal(a.ok, false);
  assert.match(a.exceeded.join(), /domains 2 > 1/);
  assert.throws(() => assertSuperficie(a, POLICY), /PLANNED/);
});

test('un plan que se sale de task.files se pasa de maxFiles', () => {
  const a = analizar([...TASK.files, 'src/lib/otro.ts'], { task: TASK, policy: POLICY });
  assert.match(a.exceeded.join(), /files 5 > 4/);
});

test('con enforce en false se MIDE y no se bloquea', () => {
  const files = ['src/app/aafa/A.tsx', 'src/app/sipca/B.tsx'];
  const a = analizar(files, { task: { files }, policy: POLICY });
  assert.equal(assertSuperficie(a, { ...POLICY, enforce: false }).ok, false, 'sigue diciendo la verdad');
});

// La forma REAL de la tarea H-001 tiene que caber en la policy REAL. Un
// presupuesto que no deja pasar el trabajo para el que se calibro es un
// presupuesto mal calibrado, y esto lo pone en rojo en vez de descubrirlo a
// mitad de vuelta.
test('la policy versionada deja pasar la vuelta que ya converge', () => {
  const policy = loadSurfacePolicy();
  const diff = ['diff --git a/x b/x', ...Array.from({ length: 46 }, (_, i) => `+l${i}`), '-vieja'].join('\n');
  const a = analizar(
    ['src/lib/formatFileSize.ts', 'src/lib/formatFileSize.spec.ts', 'src/app/admin/AdminRespaldosS3.tsx'],
    { task: TASK, policy, diff },
  );
  assert.equal(a.ok, true, `la maxima ejecucion de H-20260817-2962fd70 no cabe: ${a.exceeded.join()}`);
  assert.equal(a.domainsTouched, 1);
});

// EL TEST QUE LA PRIMERA CALIBRACION NO TENIA, y que la habria tumbado el primer
// dia. Medido en H-20260818-2b842dba: la unica ejecucion jamas observada que
// cumple la aceptacion ENTERA de H-001 -- los cuatro ficheros, con `run_test`,
// `run_typecheck`, `run_lint` y `run_gate` en verde -- pesa +109/-7 = 116 lineas.
// Con el total plano de 80 se rechazaba. Un presupuesto que no admite el exito
// medido no es un presupuesto: es un tope arbitrario con aspecto de medida.
test('la policy versionada admite la ejecucion que SI cumplio la aceptacion entera', () => {
  const policy = loadSurfacePolicy();
  const diff = ['diff --git a/x b/x',
    ...Array.from({ length: 109 }, (_, i) => `+l${i}`),
    ...Array.from({ length: 7 }, (_, i) => `-v${i}`)].join('\n');
  const a = analizar(TASK.files, { task: TASK, policy, diff });

  assert.equal(a.linesAdded + a.linesRemoved, 116);
  assert.equal(a.ok, true, `se rechaza la unica ejecucion completa observada: ${a.exceeded.join()}`);
  // 4 x 120 desde el 2026-09-15. La cifra que este test defiende es 116 -- la
  // ejecucion medida--, no el techo: sigue cabiendo, con mas holgura.
  assert.equal(a.budget.maxLines, 480, '4 ficheros x 120');
});

test('y sigue bloqueando una fuga de verdad', () => {
  const policy = loadSurfacePolicy();
  // 300 lineas cabian en 480: la fuga que este test persigue tiene que crecer
  // con el presupuesto, o dejaria de probar nada. 600 es a 480 lo que 300 era
  // a 180 -- una vez y cuarto el techo.
  const diff = Array.from({ length: 600 }, (_, i) => `+l${i}`).join('\n');
  const a = analizar(TASK.files, { task: TASK, policy, diff });
  assert.equal(a.ok, false, 'la tasa da holgura, no impunidad');
  assert.match(a.exceeded.join(), /lines 600 > 480/);
});

test('el riesgo sale del USO del presupuesto, no de una opinion', () => {
  const B = { maxFiles: 4, maxLines: 80, maxModules: 2, maxDomains: 1, maxTestSurface: 2 };
  assert.equal(comprobar(superficie(['src/lib/a.ts'], '+una'), B).risk, 'LOW');
  const diff = Array.from({ length: 60 }, (_, i) => `+l${i}`).join('\n');
  assert.equal(comprobar(superficie(['src/lib/a.ts'], diff), B).risk, 'MEDIUM', '60 de 80 lineas es 0.75');
});

// Un indicador que nunca puede valer LOW no informa. `maxFiles` sale de
// `task.files`, asi que una vuelta que use sus cuatro ficheros -- lo que se le
// pidio -- estaba al 100% del presupuesto y salia MEDIUM SIEMPRE. El riesgo mide
// la cercania a los limites que la tarea NO eligio.
test('usar todos los ficheros que la tarea declara no es riesgo', () => {
  const files = ['src/lib/a.ts', 'src/lib/a.spec.ts'];
  const r = comprobar(superficie(files, '+una'), { maxFiles: 2, maxTestSurface: 1, maxLines: 80, maxModules: 2, maxDomains: 1 });
  assert.equal(r.risk, 'LOW', 'gastar el alcance declarado es cumplir la tarea, no arriesgarse');
  assert.equal(r.ok, true);
});

test('pero salirse del alcance declarado SIGUE bloqueando', () => {
  const files = ['src/lib/a.ts', 'src/lib/b.ts', 'src/lib/c.ts'];
  const r = comprobar(superficie(files, '+una'), { maxFiles: 2, maxTestSurface: 0, maxLines: 80, maxModules: 2, maxDomains: 1 });
  assert.equal(r.ok, false, 'no puntua riesgo, pero excederlo es salirse de la tarea');
  assert.match(r.exceeded.join(), /files 3 > 2/);
  assert.equal(r.risk, 'HIGH');
});

// ── El bloqueo tiene que poder auditarse ────────────────────────────────────
//
// MEDIDO EN H-20260818-d161dc60, la primera vuelta donde el presupuesto mordio
// de verdad: `assertSuperficie` lanzaba, `runRing` escribe `payload: null` para
// una etapa que lanza, y el `onFail` de Execution es ROLLBACK. Resultado: el
// harness bloqueo con «lines 105 > 80» y destruyo el diff, las 19 llamadas, las
// mutaciones y el propio analisis. Un veredicto que borra su evidencia no se
// puede auditar NI recalibrar.
//
// Revertir a `throw` deja este test en rojo por asercion.
test('al bloquear por superficie, el ChangeSet SOBREVIVE', async () => {
  const { conVeredictoDeSuperficie } = await import('./stages-model.mjs');
  const diff = ['diff --git a/x b/x', ...Array.from({ length: 105 }, (_, i) => `+l${i}`)].join('\n');
  const changeSurface = analizar(['src/lib/a.ts'], { task: TASK, policy: POLICY, diff });

  const r = conVeredictoDeSuperficie({
    payload: { files: ['src/lib/a.ts'], diff, changeSurface, toolCalls: [1, 2, 3], mutations: [1] },
    producedBy: { capability: 'builder' },
  }, POLICY);

  assert.equal(r.status, 'FAIL');
  assert.match(r.reason, /lines 105 > 80/);
  assert.equal(r.payload.diff, diff, 'el diff que motivo el bloqueo tiene que poder leerse');
  assert.equal(r.payload.toolCalls.length, 3);
  assert.equal(r.payload.changeSurface.linesAdded, 105);
  assert.equal(r.producedBy.capability, 'builder');
});

test('si la superficie cabe, la etapa pasa intacta', async () => {
  const { conVeredictoDeSuperficie } = await import('./stages-model.mjs');
  const changeSurface = analizar(['src/lib/a.ts'], { task: TASK, policy: POLICY, diff: '+una' });
  const dentro = { payload: { files: ['src/lib/a.ts'], changeSurface }, producedBy: {} };
  assert.equal(conVeredictoDeSuperficie(dentro, POLICY), dentro, 'no se toca lo que cumple');
});

// ── C-5 · clases de cambio ───────────────────────────────────────────────────
//
// Habia UN presupuesto para cinco formas de trabajo, y el unico calibrado era el
// de la extraccion. Rechazaba mover 200 ficheros que no cambian una regla y
// admitia 40 lineas en el corazon de la emision de cartas.

const REAL = loadSurfacePolicy();

const diffDe = (bloques) => bloques.join('\n');
const RENOMBRADO = (a, b) => [
  `diff --git a/${a} b/${b}`, 'similarity index 100%', `rename from ${a}`, `rename to ${b}`,
].join('\n');
const NUEVO = (f, lineas) => [
  `diff --git a/${f} b/${f}`, 'new file mode 100644', '--- /dev/null', `+++ b/${f}`,
  '@@ -0,0 +1 @@', ...Array.from({ length: lineas }, (_, i) => `+linea ${i}`),
].join('\n');
const EDITADO = (f, lineas) => [
  `diff --git a/${f} b/${f}`, `--- a/${f}`, `+++ b/${f}`, '@@ -1 +1 @@',
  ...Array.from({ length: lineas }, (_, i) => `+linea ${i}`),
].join('\n');

test('la policy REAL declara las SEIS clases: el fallback no puede tapar su ausencia', () => {
  // `extraction_grande` nace con h-009 (2026-09-22): la misma forma de cambio que
  // `extraction` pero 4,4x mayor --10 simbolos y ~179 lineas frente a 5 y 41-- asi
  // que su techo por fichero sube de 120 a 260. NO es un aflojamiento: el
  // presupuesto escala con el trabajo DECLARADO en la spec, y el fichero origen de
  // 7.331 lineas sigue sin caber en ningun techo de la tabla.
  //
  // La lista va literal a proposito: una clase nueva tiene que llegar aqui a
  // declararse, y quien la anade tiene que escribir por que existe.
  assert.deepEqual(
    Object.keys(REAL.classes).sort(),
    ['architecture', 'extraction', 'extraction_grande', 'feature', 'fix', 'move'],
  );
  assert.equal(REAL.defaultClass, 'extraction');
});

test('una clase que nadie declaro se RECHAZA, no cae al defecto en silencio', () => {
  assert.throws(() => presupuesto({ files: [], changeClass: 'invento' }, REAL), /clase de cambio desconocida/);
});

test('`move`: 60 renombrados R100 por 6 modulos y 2 sistemas CABEN', () => {
  // Lo que rechazaba el presupuesto plano no eran las lineas -- un R100 no tiene--
  // sino `maxModules: 2` y `maxDomains: 1`. Mover `src/app/aafa/` a otra topologia
  // toca por definicion muchos modulos, y ahi moria.
  const sitios = [
    'src/app/aafa/a', 'src/app/aafa/b', 'src/app/aafa/c',
    'backend/src/aafa/d', 'src/app/admin/e', 'src/lib/f',
  ];
  const files = Array.from({ length: 60 }, (_, i) => `${sitios[i % 6]}/C${i}.tsx`);
  const diff = diffDe(files.map((f, i) => RENOMBRADO(`viejo/C${i}.tsx`, f)));
  const a = analizar(files, { task: { files, changeClass: 'move' }, policy: REAL, diff });

  assert.equal(a.modulesTouched, 4, 'cuatro modulos: el plano admitia dos');
  assert.equal(a.domainsTouched, 2, 'dos sistemas: el plano admitia uno');
  assert.equal(a.ok, true, `bloqueado por ${a.exceeded.join(' · ')}`);
  assert.equal(a.renamed.length, 60);
  assert.equal(a.semanticFiles, 0, 'delta semantico cero es cero');

  // Y la misma superficie como `extraction` se rechaza: la manga ancha es de la
  // clase, no del harness.
  const como = analizar(files, { task: { files, changeClass: 'extraction' }, policy: REAL, diff });
  assert.equal(como.ok, false);
  assert.match(como.exceeded.join(' '), /modules|domains/);
});

test('un renombrado R100 no gasta lineas en NINGUNA clase', () => {
  // Delta semantico cero es cero se llame como se llame la vuelta. `move` lo
  // tiene ademas en `unbounded`; esto fija la regla para las otras cuatro.
  const files = ['src/lib/nuevo.ts', 'src/lib/tocado.ts'];
  const diff = diffDe([RENOMBRADO('src/lib/viejo.ts', files[0]), EDITADO(files[1], 30)]);
  const a = analizar(files, { task: { files, changeClass: 'extraction' }, policy: REAL, diff });
  assert.equal(a.linesAdded, 30, 'solo el editado');
  assert.equal(a.semanticFiles, 1);
});

test('`move`: un fichero con delta != 0 SI gasta, y se pasa como cualquier fix', () => {
  // «cualquier fichero con delta != 0 cae a la clase fix y hereda sus 45 lineas».
  const files = ['src/app/aafa/A.tsx', 'src/app/aafa/B.tsx'];
  const diff = diffDe([
    RENOMBRADO('src/app/aafa/viejo/A.tsx', 'src/app/aafa/A.tsx'),
    EDITADO('src/app/aafa/B.tsx', 200),
  ]);
  const a = analizar(files, { task: { files, changeClass: 'move' }, policy: REAL, diff });

  assert.equal(a.linesAdded, 200, 'lo reescrito SI se cuenta');
  assert.equal(a.ok, false);
  assert.match(a.exceeded.join(' '), /lines 200 > 90/);
});

test('`feature`: 500 lineas en un fichero NUEVO caben; en uno tocado, no', () => {
  // F4b no se rechazaba por dificil: se rechazaba por aritmetica.
  const files = ['src/app/aafa/F4bEditor.tsx', 'src/app/aafa/Dashboard.tsx'];
  const ok = analizar(files, {
    task: { files, changeClass: 'feature' }, policy: REAL,
    diff: diffDe([NUEVO(files[0], 500), EDITADO(files[1], 10)]),
  });
  assert.equal(ok.ok, true, `bloqueado por ${ok.exceeded.join(' · ')}`);
  assert.equal(ok.linesAdded, 10, 'solo cuentan las lineas de lo TOCADO');
  assert.deepEqual(ok.created, [files[0]]);

  const no = analizar(files, {
    task: { files, changeClass: 'feature' }, policy: REAL,
    diff: diffDe([NUEVO(files[0], 500), EDITADO(files[1], 500)]),
  });
  assert.equal(no.ok, false, 'un fichero EXISTENTE no se reescribe gratis por ser una feature');
});

test('`extraction` NO hereda la manga ancha: un fichero nuevo de 500 lineas la bloquea', () => {
  // Si `unbounded` se filtrara a la clase por defecto, C-5 habria levantado el
  // limite para todo el mundo en vez de para quien lo necesita.
  const files = ['src/lib/x.ts'];
  const a = analizar(files, { task: { files }, policy: REAL, diff: NUEVO(files[0], 500) });
  assert.equal(a.budget.changeClass, 'extraction');
  assert.equal(a.ok, false);
});

test('FE+BE del MISMO sistema es UN dominio; cruzar a otro son dos', () => {
  // No hace falta cambiar nada: los sistemas se repiten 1:1 en las tres capas.
  // El test existe para que nadie lo "arregle" creyendolo un descuido.
  const mismo = ['src/app/aafa/Encargos.tsx', 'backend/src/aafa/aafa.service.ts'];
  assert.equal(superficie(mismo).domainsTouched, 1);
  assert.equal(superficie([...mismo, 'src/app/admin/AdminGroups.tsx']).domainsTouched, 2);
});

test('`fix` toca N capas de UN sistema sin desbordar modulos', () => {
  const files = [
    'backend/src/aafa/aafa.controller.ts', 'backend/src/aafa/aafa.service.ts',
    'src/app/aafa/Encargos.tsx', 'src/lib/apiClient.ts',
  ];
  const a = analizar(files, { task: { files, changeClass: 'fix' }, policy: REAL, diff: EDITADO(files[0], 5) });
  assert.equal(a.modulesTouched, 3);
  assert.equal(a.budget.maxModules, null, 'sin techo: controller+service+FE es la forma normal de un fix');
  assert.equal(a.ok, true, `bloqueado por ${a.exceeded.join(' · ')}`);

  // Pero SIGUE siendo un sistema: cruzar a admin lo bloquea.
  const cruza = [...files, 'src/app/admin/AdminGroups.tsx'];
  assert.equal(analizar(cruza, { task: { files: cruza, changeClass: 'fix' }, policy: REAL, diff: '' }).ok, false);
});

test('`architecture` NO ES UNA VUELTA, y no falla por un numero', () => {
  const files = ['backend/src/aafa/aafa.service.ts'];
  const a = analizar(files, { task: { files, changeClass: 'architecture' }, policy: REAL, diff: '' });
  assert.equal(a.ok, false);
  assert.match(a.exceeded.join(' '), /no cabe en una vuelta/);
  assert.equal(a.risk, 'HIGH');
});

test('F-1: el presupuesto dice QUIEN puso cada limite', () => {
  // Una vuelta que se dio 130 lineas y otra que heredo 80 se leian IGUAL en el
  // trace, y `Learning` deriva confianza de que dos corridas vieran lo mismo.
  const files = ['src/lib/x.ts'];
  assert.equal(presupuesto({ files }, REAL).origen.maxLines, 'class');
  assert.equal(presupuesto({ files, surfaceBudget: { maxLines: 130 } }, REAL).origen.maxLines, 'task');
  assert.equal(presupuesto({ files }, { maxLinesPerFile: 20, maxModules: 2, maxDomains: 1 }).origen.maxLines, 'policy');
});

test('el LOW existe: dos vueltas con 31 lineas de diferencia NO puntuan igual', () => {
  // MEDIDO en las vueltas 8a y 9a: `modules` 2/2 y `domains` 1/1 en las dos, y
  // el riesgo clavado en MEDIUM antes de escribir una linea. Un indicador que
  // vale lo mismo pase lo que pase es una constante con nombre de metrica.
  //
  // RECALIBRADO el 2026-09-15: `extraction` paso de 45 a 120 lineas/fichero
  // (control-1 de h-008 midio `lines 310 > 135`), asi que el presupuesto de
  // cuatro ficheros pasa de 180 a 480. Las CIFRAS de las vueltas 8a y 9a son
  // historia y no cambian; lo que cambia es el porcentaje que representan. Se
  // conserva lo que el test existe para fijar -- que dos usos distintos NO
  // puntuen igual-- con dos puntos equivalentes sobre el presupuesto nuevo.
  const files = TASK.files;                       // 4 ficheros -> maxLines 480 con la policy real
  const con = (n) => analizar(files, {
    task: { files }, policy: REAL, diff: EDITADO('src/lib/formatFileSize.ts', n),
  }).risk;

  assert.equal(con(256), 'LOW', 'mismo 53% del presupuesto que los 96 de 180 de la 9a vuelta');
  assert.equal(con(339), 'MEDIUM', 'mismo 71% que los 127 de 180 de la 8a vuelta');
  assert.notEqual(con(256), con(339), 'el riesgo tiene que distinguirlas');
});

test('la arquitectura BLOQUEA al excederse aunque no puntue riesgo', () => {
  // No puntuar no es no importar: cruzar a dos sistemas sigue siendo otra clase
  // de cambio, y sale HIGH por excedido, no por cercania.
  const files = ['src/app/aafa/A.tsx', 'src/app/admin/B.tsx'];
  const a = analizar(files, { task: { files }, policy: REAL, diff: EDITADO(files[0], 5) });
  assert.equal(a.ok, false);
  assert.equal(a.risk, 'HIGH');
  assert.match(a.exceeded.join(' '), /domains 2 > 1/);
});

test('src/app/archivero NO es plataforma: es la capa FE de aafa', () => {
  // El Archivero Fiscal no es codigo compartido, es un sistema que se llamo de
  // otra forma. Cayendo a `plataforma`, el guard de dos sistemas no lo veia.
  assert.equal(dominioDe('src/app/archivero/ArchiveroModule.tsx'), 'aafa');
  assert.equal(dominioDe('src/app/archivero/lib/vigencias.ts'), 'aafa');

  // Y lo transversal DE VERDAD sigue siendo plataforma.
  assert.equal(dominioDe('src/lib/apiClient.ts'), 'plataforma');
  assert.equal(dominioDe('backend/src/common/audit.ts'), 'plataforma');
});

test('archivero + admin son DOS dominios, y el presupuesto los bloquea', () => {
  // MEDIDO: las vueltas 11a y 12a informaron `dominios 0` tocando el archivero.
  // EM-14, EM-16c y EM-17 de CAM-001 cruzan estos dos.
  const files = ['src/app/archivero/ArchiveroModule.tsx', 'src/app/admin/AdminGroups.tsx'];
  assert.equal(superficie(files).domainsTouched, 2);

  const a = analizar(files, { task: { files }, policy: REAL, diff: EDITADO(files[0], 5) });
  assert.equal(a.ok, false, 'dos sistemas a la vez es otra clase de cambio');
  assert.match(a.exceeded.join(' '), /domains 2 > 1/);

  // Y archivero solo sigue siendo UNO, no cero.
  assert.equal(superficie([files[0]]).domainsTouched, 1);
});
