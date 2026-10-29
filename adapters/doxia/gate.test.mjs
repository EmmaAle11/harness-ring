// ── La puerta de DoxIA, leida desde su FUENTE ────────────────────────────────
//
// Estos tests dependen de `scripts/gate.sh` y `.husky/pre-commit` del ARBOL
// ANFITRION, que no viajan con el motor. Viven en el adaptador DoxIA, no en el
// nucleo: un motor portable no puede afirmar cosas sobre la puerta de un host.
//
// Se extrajeron de lib/stages.test.mjs en la limpieza de arquitectura: alli
// fallaban en cualquier repo sin DoxIA. Aqui su dependencia es honesta.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HAY_GATE = existsSync(fileURLToPath(new URL('../../../scripts/gate.sh', import.meta.url)));

//
// El test lee el FUENTE de la puerta a proposito. Es el unico sitio donde vive
// la regla --`gate.sh` es la autoridad unica del definition_of_done-- y un check
// que desaparece de ahi no rompe ningun otro test: se iria en silencio, que es
// como se pierden las puertas.

test('la puerta comprueba el arbol contra su manifiesto, y lo hace en --fast', (t) => {
  if (!HAY_GATE) { t.skip('sin scripts/gate.sh: este arbol no es el anfitrion DoxIA'); return; }
  const src = readFileSync(new URL('../../../scripts/gate.sh', import.meta.url), 'utf8');
  assert.match(src, /record deps:hygiene/, 'el check desaparecio de la puerta');
  assert.match(src, /npm ls --depth=0/, 'ya no mira el disco');
  assert.match(src, /invalid\|extraneous/, 'dejo de buscar las dos formas de arbol sucio');

  // En --fast: MEDIDO en 0,798 s para los dos proyectos. Si cayera dentro del
  // `if MODE = full`, el pre-commit --que es quien tiene delante el arbol local
  // sucio-- dejaria de verlo, y en CI (donde se acaba de hacer `npm ci`) nunca
  // hay nada que encontrar. El check correcto en el modo equivocado no comprueba
  // nada.
  const full = src.indexOf('if [ "$MODE" = "full" ]');
  assert.ok(full > 0, 'no se encontro el guardia de modo');
  assert.ok(src.indexOf('record deps:hygiene') < full,
    'deps:hygiene cayo dentro de --full: en CI el arbol siempre esta limpio y no comprobaria nada');
});

test('deps:hygiene NO se pronuncia sobre un node_modules prestado', (t) => {
  if (!HAY_GATE) { t.skip('sin scripts/gate.sh: este arbol no es el anfitrion DoxIA'); return; }
  // El sandbox del anillo ENLAZA `node_modules` del arbol principal, y npm marca
  // como `extraneous` todo lo que hay dentro de un symlink: 422 falsos en el FE
  // la primera vez que una vuelta llego a la etapa 15. Un WARN que sale en TODAS
  // las vueltas no informa de nada -- es el mismo ruido que 3.617 warnings de
  // lint-- y ademas la pregunta no tiene sentido: el arbol no es suyo.
  //
  // Se DECLARA SKIP con su motivo. Lo que no se puede comprobar no se aprueba.
  const src = readFileSync(new URL('../../../scripts/gate.sh', import.meta.url), 'utf8');
  assert.match(src, /if \[ -L "\$ROOT\/\$proj\/node_modules" \]/,
    'dejo de detectar el enlace: el WARN falso vuelve a cada vuelta');
  assert.match(src, /record deps:hygiene SKIP[\s\S]{0,140}prestado/,
    'un arbol prestado se declara SKIP, no PASS: aprobar lo que no se miro es peor que no mirarlo');
});

// DOS GUARDIAS SE CONTRADECIAN, y la fusion del 2026-09-07 los puso frente a frente: `controles`
// (del tronco) exige que toda etapa PUEDA fallar; esta asercion prohibia que `deps:hygiene` fallara
// nunca. Las dos tenian razon sobre COSAS DISTINTAS y la palabra «sucio» las confundia:
//
//   extraneous / invalid  -> deuda local (un `npm i` a medias, otro lockfile). WARN, y con motivo:
//                            bloquear por eso deja la puerta roja de nacimiento y nadie la usa.
//   dependencia AUSENTE   -> el manifiesto la pide y el arbol no la tiene. Eso no es deuda: es un
//                            arbol que no puede correr. Paso hoy con `@firecrawl/pdf-inspector` y
//                            lo cazo `architecture`, no esta etapa.
//
// Asi que la asercion no se relaja, se AFINA: sigue exigiendo el WARN para lo primero y ahora
// exige tambien el FAIL para lo segundo. Una regla que no distingue los dos casos protege al
// equivocado.
test('deps:hygiene DECLARA la deuda local y BLOQUEA la dependencia ausente', (t) => {
  if (!HAY_GATE) { t.skip('sin scripts/gate.sh: este arbol no es el anfitrion DoxIA'); return; }
  const src = readFileSync(new URL('../../../scripts/gate.sh', import.meta.url), 'utf8');
  assert.match(src, /record deps:hygiene WARN/,
    'un arbol sucio es deuda local, no un defecto del cambio en curso: '
    + 'bloquear por eso deja la puerta roja de nacimiento y nadie la usa');
  assert.match(src, /record deps:hygiene FAIL/,
    'una dependencia declarada y ausente no es deuda local: es un arbol que no puede correr');
  assert.match(src, /D_AUSENTE/,
    'el FAIL tiene que colgar de la AUSENCIA, no del recuento de extraneous');
});

// ── El techo de warnings, que era una nota y no una regla ───────────────────
//
// La comprobacion de lint llevaba desde que se escribio la nota «deuda: solo
// debe bajar», y NADIE la hacia cumplir. Costo dos imports muertos en
// `ExpedienteScreen.tsx` que el lint SI senalaba: eran 2 lineas entre 3.649. Un
// canal con relacion senal/ruido de 1 entre 3.649 esta encendido y no dice nada,
// que es peor que estar apagado, porque parece que dice.
test('los warnings de lint tienen TECHO, y romperlo es FAIL', (t) => {
  if (!HAY_GATE) { t.skip('sin scripts/gate.sh: este arbol no es el anfitrion DoxIA'); return; }
  const src = readFileSync(new URL('../../../scripts/gate.sh', import.meta.url), 'utf8');
  const m = /^LINT_WARN_MAX=(\d+)$/m.exec(src);
  assert.ok(m, 'el techo desaparecio de la puerta: la deuda vuelve a poder crecer');
  assert.ok(Number(m[1]) > 0 && Number(m[1]) < 100000, `techo absurdo: ${m[1]}`);
  assert.match(src, /record lint FAIL[\s\S]{0,120}TECHO ROTO/,
    'pasarse del techo tiene que ser FAIL: un WARN sobre 3.617 warnings es otro warning');
});

test('el techo AVISA cuando sobra, o deja de apretar', (t) => {
  if (!HAY_GATE) { t.skip('sin scripts/gate.sh: este arbol no es el anfitrion DoxIA'); return; }
  // Un techo que se queda muy por encima de la realidad vuelve a ser una nota.
  // Si la deuda baja de verdad, la puerta lo dice para que el techo la siga.
  const src = readFileSync(new URL('../../../scripts/gate.sh', import.meta.url), 'utf8');
  assert.match(src, /BAJA EL TECHO a/);
});

test('lo que el piso dice sobre los tests condicionales es CIERTO', (t) => {
  if (!HAY_GATE) { t.skip('sin scripts/gate.sh: este arbol no es el anfitrion DoxIA'); return; }
  // Un piso sobre «tests que PASAN» es un piso sobre EL ENTORNO EN QUE SE MIDIO:
  // `node --test` no cuenta los saltados en `pass`, asi que cada test condicional
  // hace que la cifra dependa de donde se corra. Puse el piso con la cifra de mi
  // arbol y H-20260821-6ebd7317 murio en 15/16 con «un test desaparecio». No
  // desaparecio: se salto.
  //
  // ESTE TEST YA DISPARO UNA VEZ, y por eso existe: cuando el ultimo condicional
  // dejo de serlo --la comprobacion de `.env.production` paso a MEDIR la ausencia
  // en vez de saltarsela-- aviso de que el piso podia subir al total. Un piso que
  // deja holgura de mas es un piso que ya no apreta.
  //
  // No fija el NUMERO --seria el literal de hoy-- sino que lo ESCRITO junto al
  // piso coincida con lo que hay.
  const src = readFileSync(new URL('../../../scripts/gate.sh', import.meta.url), 'utf8');
  assert.ok(/^HARNESS_TESTS_MIN=\d+$/m.test(src), 'el piso del harness desaparecio');

  // RECURSIVO desde harness/, no solo `lib/`. Con `readdirSync('./')` este
  // contador solo veia harness/lib/, asi que los `t.skip` de `ports/` y de
  // `adapters/doxia/` quedaban fuera y la cifra declarada cuadraba con una
  // poblacion incompleta. Es el mismo defecto que el glob del gate: un barrido
  // que no cubre el arbol da una cifra verde sobre otra cosa.
  const raizTests = new URL('../', import.meta.url);
  const condicionales = readdirSync(raizTests, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.test.mjs'))
    .reduce((n, e) => {
      const abs = new URL(`${e.parentPath.split('/harness/')[1] ?? ''}/${e.name}`, raizTests);
      return n + (readFileSync(abs, 'utf8').match(/\bt\.skip\(/g) ?? []).length;
    }, 0);

  // La cifra DECLARADA junto al piso contra la cifra REAL. No se busca una
  // palabra en la prosa --el comentario cuenta la historia y la menciona-- sino
  // el numero, que es lo unico que se puede comparar.
  const declarado = /^# TESTS_CONDICIONALES=(\d+)\b/m.exec(src);
  assert.ok(declarado, 'el piso dejo de declarar cuantos tests condicionales hay');
  assert.equal(Number(declarado[1]), condicionales,
    `el piso declara ${declarado[1]} test(s) condicional(es) y hay ${condicionales}. `
    + 'Con condicionales, el piso va en la cifra del entorno MAS POBRE; sin ellos, en el total.');
});


// ── El consumidor que podia no existir sin decirlo ───────────────────────────
//
// La puerta tiene TRES consumidores: el hook de Kiro, el pre-commit de husky y
// CI. El segundo puede faltar en silencio: `core.hooksPath` apunta a `.husky/_`,
// que lo genera `npm install` y no se versiona, así que en un worktree recién
// creado git no encuentra el hook y NO avisa.
//
// MEDIDO el 2026-08-23 en el worktree `doxia-harness`: nueve commits del día sin
// una sola evidencia de pre-commit. El único verde era el que corría a mano — y
// el día que vi un FAIL y commiteé igual, nada me paró.

test('el pre-commit CONSUME la puerta, y no una copia de sus reglas', (t) => {
  if (!HAY_GATE) { t.skip('sin scripts/gate.sh: este arbol no es el anfitrion DoxIA'); return; }
  const hook = readFileSync(new URL('../../../.husky/pre-commit', import.meta.url), 'utf8');
  assert.match(hook, /bash scripts\/gate\.sh --fast/,
    'el pre-commit dejó de llamar a la puerta: o no comprueba nada, o comprueba una copia que diverge en silencio');
});

test('la puerta DICE si el hook no está cableado, en vez de callarlo', (t) => {
  if (!HAY_GATE) { t.skip('sin scripts/gate.sh: este arbol no es el anfitrion DoxIA'); return; }
  const gate = readFileSync(new URL('../../../scripts/gate.sh', import.meta.url), 'utf8');
  assert.match(gate, /record hook:pre-commit PASS/, 'la puerta ya no comprueba su propio consumidor');
  assert.match(gate, /record hook:pre-commit MISSING/,
    'sin la rama MISSING, un hook ausente es indistinguible de uno que pasa: el modo de fallo entero');
});
