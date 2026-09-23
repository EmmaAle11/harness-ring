// node --test harness/lib/plan.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { tareasDePlan, VERBOS_FILES, rutasContraElArbol } from './plan.mjs';
import { ROOT } from './capabilities.mjs';
import { ENV_LIMPIO } from './sandbox.mjs';

// Las muestras se ARMAN, nunca se escriben literales: escritas, cualquier barrido
// del repo leeria este fichero como un plan de verdad. Ya paso dos veces con el
// guard de ENV_LIMPIO en `stages.test.mjs`.
const BT = String.fromCharCode(96);
const ruta = (p) => `${BT}${p}${BT}`;
const plan = (...lineas) => ['## Task 1: prueba', '', '**Files:**', ...lineas, '', '**Interfaces:**', '- Consumes: nada'].join('\n');

test('los cinco verbos declarados se leen, y ninguno mas', () => {
  const l = Object.keys(VERBOS_FILES).map((v, i) => `- ${v}: ${ruta(`src/f${i}.ts`)}`);
  const { tareas, problemas } = tareasDePlan(plan(...l));
  assert.equal(problemas.length, 0, `los verbos declarados no pueden dar problema: ${problemas}`);
  assert.equal(tareas[0].files.length, Object.keys(VERBOS_FILES).length);
});

test('un verbo NO declarado es un problema, no una linea que se ignora', () => {
  // ESTE es el test del arreglo. El extractor que midio los planes de `third` el
  // 26-ago se escribio CINCO veces y las cinco dio un numero distinto, porque
  // cada version conocia un verbo menos del que el plan usaba -- y las cuatro
  // primeras parecian resultados. Un extractor que se salta lo que no entiende
  // no informa de lo que se salto, y su silencio se lee como ausencia.
  const { tareas, problemas } = tareasDePlan(plan(`- Rename: ${ruta('src/a.ts')}`));
  assert.equal(tareas[0].files.length, 0, 'no puede colarse como fichero');
  assert.equal(problemas.length, 1, 'el verbo desconocido tiene que SALIR, no desaparecer');
  assert.match(problemas[0], /NO DECLARADO 'Rename'/);
});

test('una referencia en prosa no es una ruta, y se dice', () => {
  const { tareas, problemas } = tareasDePlan(plan('- Modify: la ruta del FE que monta el selector'));
  assert.equal(tareas[0].files.length, 0);
  assert.match(problemas[0], /sin ruta, la referencia es prosa/);
});

test('una plantilla y un ancla con guion jamas casarian contra task.files', () => {
  // `task.files` compara por pertenencia EXACTA en los TRES sitios que la usan.
  // Una plantilla no es un formato feo: es una entrada que no casara nunca.
  const p1 = tareasDePlan(plan(`- Create: ${ruta('backend/migration/YYYYMMDD-x.sql')}`));
  assert.match(p1.problemas[0], /PLANTILLA/);
  assert.equal(p1.tareas[0].files.length, 0);

  const p2 = tareasDePlan(plan(`- Modify: ${ruta('backend/src/a.service.ts-17035')}`));
  assert.match(p2.problemas[0], /ancla con guion/);
  assert.equal(p2.tareas[0].files.length, 0);
});

test('las anclas de linea colapsan a la misma ruta, y `No tocar` va a forbiddenPaths', () => {
  const { tareas, problemas } = tareasDePlan(plan(
    `- Modify: ${ruta('backend/src/a.ts:356')}`,
    `- Modify: ${ruta('backend/src/a.ts:160-231')}`,
    `- **No tocar:** ${ruta('backend/src/b.ts')}`,
  ));
  assert.deepEqual(tareas[0].files, ['backend/src/a.ts'], 'dos anclas de la misma ruta son una ruta');
  assert.deepEqual(tareas[0].forbiddenPaths, ['backend/src/b.ts']);
  assert.deepEqual(problemas, []);
});

test('el bloque Files termina donde empieza el siguiente, y no se come Interfaces', () => {
  const { tareas, problemas } = tareasDePlan(plan(`- Create: ${ruta('src/a.ts')}`));
  assert.deepEqual(tareas[0].files, ['src/a.ts']);
  // `- Consumes: nada` vive bajo **Interfaces:** y NO es un verbo de Files. Si el
  // bloque no terminara, saldria como verbo no declarado y el ruido taparia los
  // problemas de verdad.
  assert.deepEqual(problemas, [], `se comio el bloque siguiente: ${problemas}`);
});

test('sobre los planes REALES de third, PINEADOS: 15 tareas y exactamente 4 problemas', () => {
  // El control que no es un fixture. Un parser probado solo contra muestras que
  // yo mismo escribo prueba mi idea del formato, no el formato.
  //
  // PINEADO A UN COMMIT, Y ESO ES ADR-005, QUE ESTE TEST INCUMPLIA. La primera
  // version apuntaba a `origin/feat/audit-doxia` -- una ref VIVA de la rama de
  // otro agente-- y el 2026-08-27 `third` anadio la Task C5 a su Plan C:
  //
  //   c825c000  14 tareas / 3 problemas
  //   6175a49b  15 tareas / 4 problemas   <- «entra Task C5»
  //
  // Mi puerta se puso en rojo por un documento ajeno, sin que cambiara una linea
  // de mi codigo. Un test cuya poblacion vive en la rama de otro no mide mi
  // parser: mide lo que otro escribio hoy.
  //
  // Y el arreglo NO es subir el numero cada vez: eso convierte una asercion en un
  // marcador que se ajusta a lo que salga, que es el defecto que
  // memory/failures/un-test-que-fija-la-carencia.md describe. Se PINEA -- que es
  // lo que ADR-005 manda para los planes-- y cambiar de commit pasa a ser una
  // decision deliberada, con su numero medido al lado.
  const REF = '56a109ce';   // feat/audit-doxia @ 2026-08-29, «S9 no filtra, ETIQUETA»
  const PLANES = ['2026-08-21-aafa-zip-nombres', '2026-08-21-correos-doxia', '2026-08-21-torre-de-control'];
  let textos;
  try {
    textos = PLANES.map((p) => execFileSync('git',
      ['show', `${REF}:docs/superpowers/plans/${p}.md`],
      { cwd: ROOT, env: ENV_LIMPIO(), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
  } catch (e) {
    // CIEGO, no «sin problemas». La ref puede no estar en este clon; eso no es un
    // resultado. Es la regla de `h006-preflight.sh` del mismo dia.
    assert.fail(`CIEGO: no se pudieron leer los planes de ${REF} (${String(e.message).slice(0, 90)}). `
      + `Esto NO es «el parser esta bien»: es que no se pudo mirar. Corre 'git fetch origin'. `
      + `Si el commit ya no existe en este clon, re-pinea a uno vivo Y vuelve a medir los numeros.`);
  }

  const r = textos.map(tareasDePlan);
  // RE-PINEADO el 2026-09-15. `a8da39e3` dejo de existir en este clon y el test
  // lo dijo como CIEGO, que es lo correcto: no se pudo mirar. Se re-pinea al
  // commit vivo mas cercano Y SE VUELVE A MEDIR, como manda su propio mensaje --
  // no se ajusta el numero viejo al nuevo arbol.
  //
  // MEDIDO sobre 56a109ce: 11 tareas, 6 problemas, 11 con fichero derivado.
  // Los numeros bajan de 15/4 porque es OTRA poblacion, no porque el parser
  // cambiara: entre el 27 y el 29 de agosto `third` reescribio sus planes.
  assert.equal(r.reduce((a, x) => a + x.tareas.length, 0), 11,
    'el numero de tareas cambio: el commit esta PINEADO, asi que esto significa que cambio el PARSER');

  const todos = r.flatMap((x) => x.problemas);
  assert.equal(todos.length, 6, `problemas encontrados:\n  ${todos.join('\n  ')}`);
  assert.ok(todos.some((p) => /PLANTILLA/.test(p)));
  assert.ok(todos.some((p) => /CERO bloques/.test(p)));
  assert.ok(todos.some((p) => /prosa/.test(p)));

  // Y CERO falsos: las 11 tienen que derivar fichero. Un parser que marca todo no
  // distingue nada, que es como se leia mi cuarta version --44 de 44--.
  assert.equal(r.reduce((a, x) => a + x.tareas.filter((t) => t.files.length).length, 0), 11,
    'toda tarea tiene que derivar al menos un fichero');
});

test('cero tareas NO es un plan limpio: se dice que no se supo verlas', () => {
  // MEDIDO al cablear `doxia plan --spec`: un plan narrativo de la boveda salio
  // «0 tarea(s) · 0 problema(s)», que se lee como exito. Un documento sin tareas
  // y uno que las declara con otro encabezado daban la MISMA salida. La primera
  // version de esta funcion tenia el hueco que la funcion existe para cerrar.
  const narrativo = ['# PLAN B — Torre de control', '', '## Las vueltas', 'texto', '## El diagnostico', 'mas texto'].join('\n');
  const { tareas, problemas } = tareasDePlan(narrativo);

  assert.equal(tareas.length, 0);
  assert.equal(problemas.length, 1, 'cero tareas sin problema es indistinguible de exito');
  assert.match(problemas[0], /CERO bloques/);
  // Y enseña lo que SÍ encontró, que es lo que deja al lector distinguir los dos
  // casos sin abrir el fichero.
  assert.match(problemas[0], /Las vueltas/);

  // Un plan CON tareas no arrastra ese problema.
  const conTarea = ['## Task 1: x', '', '**Files:**', `- Create: ${ruta('src/a.ts')}`].join('\n');
  assert.deepEqual(tareasDePlan(conTarea).problemas, []);
});

test('las rutas contra el arbol: modificar exige existir, crear exige NO existir', () => {
  const t = tareasDePlan(plan(
    `- Modify: ${ruta('src/vive.ts')}`,
    `- Create: ${ruta('src/nuevo.ts')}`,
    `- Delete: ${ruta('src/fantasma.ts')}`,
  )).tareas;
  const p = rutasContraElArbol(t, (r) => r === 'src/vive.ts');

  assert.equal(p.length, 1, `esperaba solo el borrado imposible: ${p}`);
  assert.match(p[0], /'borrar' sobre algo que NO existe/);

  // Y `Create` sobre algo que ya esta tambien habla: o el plan esta viejo, o va
  // a sobrescribir trabajo de otro.
  const p2 = rutasContraElArbol(t, () => true);
  assert.ok(p2.some((x) => /'Create' sobre algo que YA existe/.test(x)));
});

test('`Test:` NO produce veredicto, porque su estado esperado es ambiguo', () => {
  // LA PRIMERA VERSION LO METIA CON modificar/borrar, y sobre los planes reales
  // de `third` dio TRES hallazgos que eran los TRES falsos: son los tests que esa
  // tarea va a escribir. Un falso SPECIFICATION_BLOCKED bloquea antes de que nada
  // pueda desmentirlo, que es el peor fallo de un preflight.
  const t = tareasDePlan(plan(`- Test: ${ruta('src/a.spec.ts')}`)).tareas;
  assert.deepEqual(rutasContraElArbol(t, () => false), [], 'un test que aun no existe no es un defecto');
  assert.deepEqual(rutasContraElArbol(t, () => true), [], 'un test que ya existe tampoco');
});

test('sin predicado NO dice «las rutas estan bien»: dice CIEGO', () => {
  const p = rutasContraElArbol([{ n: 1, acciones: [{ verbo: 'modificar', ruta: 'x' }] }], null);
  assert.equal(p.length, 1);
  assert.match(p[0], /CIEGO/);
  // Y un predicado que devuelve `undefined` --no pudo mirar-- tampoco se lee
  // como «no existe».
  const q = rutasContraElArbol([{ n: 1, acciones: [{ verbo: 'modificar', ruta: 'x' }] }], () => undefined);
  assert.match(q[0], /no se pudo comprobar/);
});
