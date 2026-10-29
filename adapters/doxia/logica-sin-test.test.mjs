import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { revisar } from '../../lib/logica-sin-test.mjs';
import { ROOT } from '../../lib/capabilities.mjs';
import { ENV_LIMPIO } from '../../lib/sandbox.mjs';

// El trinquete contra el arbol REAL del anfitrion: cuenta la logica pura sin spec
// del host, que un motor portable no trae. Vive en el adaptador DoxIA con guarda.

// El techo MEDIDO el 2026-08-21 EN `feat/harness`. Baja cuando alguien escribe un
// spec; NO sube.
//
// AL TRAER ESTE FICHERO A OTRA RAMA HAY QUE VOLVER A MEDIRLO. Es una cuenta sobre
// el arbol, igual que los pisos de tests de `gate.sh`, y un arbol con mas codigo
// tiene mas ficheros de logica pura: el tronco lleva F4b y el editor de cartas,
// que aqui no estan. Copiar el 61 pondria esa puerta roja de nacimiento -- que es
// exactamente el defecto que costo tres pisos rotos hoy, y lo escribo aqui
// ANTES de que pase.
//
//   node -e "…revisar(ficheros).sinSpec.length"   -> y ese numero va aqui
//
// La cifra la firma quien la corre, tambien cuando el fichero es de otro.
// 62 desde el 2026-08-24: `backend/src/aafa/carta-modelos/carta-campos.builder.ts`
// entra CON LA FUSION del tronco, no porque nadie anadiera logica sin test aqui.
// Es AAFA, dominio de `second`, y queda como deuda suya: el trinquete solo baja.
// 62 -> 68 el 2026-09-07 AL FUNDIR `feat/staging-aafa`. Los seis nuevos no los escribio nadie en
// esta rama: llegan con el bloque del Archivero y el hotfix del representante, donde ya estaban sin
// spec. Un trinquete es una cuenta DE SU ARBOL y la union de dos arboles es la union de sus cuentas
// --el mismo razonamiento que el techo de lint (3715 -> 3893)--. NO es permiso: de aqui solo baja,
// y los seis son deuda con dueno `second`. MEDIDO por el propio test al bloquear la fusion:
// «68 ficheros de logica pura sin spec al lado, y el techo es 62».
const TECHO = 68;

// ── El trinquete, contra el repositorio de verdad ───────────────────────────
test('la logica pura sin test NO crece', (t) => {
  if (!existsSync(join(ROOT, 'scripts', 'gate.sh'))) { t.skip('sin scripts/gate.sh: este arbol no es el anfitrion DoxIA'); return; }
  const rutas = execFileSync('git', ['ls-files'], { cwd: ROOT, env: ENV_LIMPIO(), encoding: 'utf8' }).split('\n');
  const ficheros = rutas.filter((p) => p.endsWith('.ts')).map((p) => {
    try { return { path: p, texto: readFileSync(join(ROOT, p), 'utf8') }; } catch { return null; }
  }).filter(Boolean);

  const r = revisar(ficheros, (p) => existsSync(join(ROOT, p)));

  // EL DENOMINADOR. Si el recorrido deja de encontrar ficheros, `sinSpec` cae a
  // cero y el test aprueba sobre nada -- la forma en que estos controles se
  // mueren en silencio.
  assert.ok(r.pura > 100, `solo se examinaron ${r.pura} ficheros de logica pura: el recorrido se rompio`);

  assert.ok(r.sinSpec.length <= TECHO,
    `${r.sinSpec.length} ficheros de logica pura sin spec al lado, y el techo es ${TECHO}.\n`
    + 'Un predicado de decision sin test es una autoridad que cualquiera puede cambiar en silencio: '
    + 'hoy costo la emision de una carta en produccion.\n'
    + r.sinSpec.slice(0, 10).map((p) => `  ${p}`).join('\n'));

  // Y si BAJA, el techo baja con el: la deuda declarada no puede quedarse
  // declarada de mas. Sin esto, arreglar diez ficheros no protege de que vuelvan.
  assert.ok(r.sinSpec.length >= TECHO - 5,
    `bajo a ${r.sinSpec.length}: baja TECHO a esa cifra en este fichero para que el trinquete siga apretando`);
});

