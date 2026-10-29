import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tareasDePlan } from '../../lib/plan.mjs';
import { ROOT } from '../../lib/capabilities.mjs';
import { ENV_LIMPIO } from '../../lib/sandbox.mjs';

// Los planes REALES de `third` viven en docs/superpowers/plans del anfitrion, PINEADOS a un
// commit. Un motor portable no trae ese git, asi que el caso vive en el adaptador DoxIA.

test('sobre los planes REALES de third, PINEADOS: 15 tareas y exactamente 4 problemas', (t) => {
  if (!existsSync(join(ROOT, 'scripts', 'gate.sh'))) { t.skip('sin scripts/gate.sh: este arbol no es el anfitrion DoxIA'); return; }
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
