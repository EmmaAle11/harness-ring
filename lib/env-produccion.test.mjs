// La comprobacion que habria evitado dejar el frontend en blanco.
//
// El build TERMINA CON EXITO sin `.env.production`. Se comprobo que el bundle
// subio, que el buildId era correcto, que index.html daba 200 y que las cadenas
// esperadas estaban dentro -- cuatro comprobaciones ciertas, ninguna medía si la
// aplicacion ARRANCA. `adminPath.ts` lanza al importarse cuando falta su
// variable, asi que el bundle muere antes de pintar nada.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { sinComentarios, consumidas, exigidas, faltantes, revisarArbol } from './env-produccion.mjs';
import { ROOT } from './capabilities.mjs';
import { ENV_LIMPIO } from './sandbox.mjs';

/** Los .ts/.tsx de src/, leidos. Con guarda: si el recorrido se rompe, no se aprueba sobre nada. */
function ficherosDeSrc() {
  const rutas = execFileSync('git', ['ls-files', 'src'], { cwd: ROOT, env: ENV_LIMPIO(), encoding: 'utf8' })
    .split('\n').filter((p) => /\.(ts|tsx)$/.test(p));
  const fs = rutas.map((p) => {
    try { return { path: p, texto: readFileSync(join(ROOT, p), 'utf8') }; } catch { return null; }
  }).filter(Boolean);
  assert.ok(fs.length > 100, `solo se leyeron ${fs.length} ficheros de src/: el recorrido se rompio`);
  return fs;
}

test('una variable citada en un COMENTARIO no se consume', () => {
  // Y el caso que lo descubrio: CRLF. En JavaScript `.` no casa `\r` --es
  // terminador de linea--, asi que `//.*$` no casa NADA en un fichero con
  // finales de Windows y el limpiador se quedaba mudo. `VITE_TURNSTILE_SITE_KEY`
  // aparece UNA vez en todo src/, dentro de un comentario, y salia como
  // obligatoria. Un falso positivo en una puerta de despliegue es la forma mas
  // rapida de que alguien la desactive.
  assert.deepEqual(exigidas([{ path: 'a.ts', texto: '// usa VITE_ALGO cuando toque\r\nexport const x = 1;\r\n' }]), []);
  assert.deepEqual(exigidas([{ path: 'a.ts', texto: '/* VITE_OTRA se documenta aqui */\nconst y = 2;' }]), []);
  assert.ok(!sinComentarios('// VITE_X\r\ncodigo').includes('VITE_X'), 'CRLF: el comentario tiene que desaparecer');
});

test('con valor por defecto NO es obligatoria: degrada sola', () => {
  assert.deepEqual(exigidas([{ path: 'a.ts', texto: "const u = import.meta.env.VITE_API_URL || 'http://localhost:3000';" }]), []);
  assert.deepEqual(exigidas([{ path: 'a.ts', texto: "const u = import.meta.env.VITE_API_URL ?? 'x';" }]), []);
});

test('sin valor por defecto SI es obligatoria, la lea como la lea', () => {
  // Las dos formas que existen en este repo. La segunda --`_ENV.VITE_X`-- es la
  // de `adminPath.ts`, y es la que se me escapo la primera vez que lo medi: conte
  // 4 variables y eran 6.
  assert.deepEqual(exigidas([{ path: 'a.ts', texto: 'const p = import.meta.env.VITE_ADMIN;' }]), ['VITE_ADMIN']);
  assert.deepEqual(exigidas([{ path: 'a.ts', texto: 'const p = (_ENV.VITE_ADMIN as string | undefined)?.trim();' }]), ['VITE_ADMIN']);
});

test('un valor VACIO cuenta como ausente: `X=` no esta configurado', () => {
  assert.deepEqual(faltantes(['VITE_A', 'VITE_B'], 'VITE_A=algo\nVITE_B='), ['VITE_B']);
  assert.deepEqual(faltantes(['VITE_A'], '# VITE_A=comentada'), ['VITE_A'], 'una linea comentada no define nada');
});

// ── Contra el repositorio de verdad ────────────────────────────────────────
test('las CINCO variables que consume el codigo tienen que estar en produccion', () => {
  // El criterio «solo las que no tienen fallback» era demasiado estrecho, y lo
  // corrigio `third` auditando. Cazaba 1 de 5.
  //
  // De los cuatro fallbacks, SOLO DOS son localhost --y esos gritan: la primera
  // llamada falla--. Los otros dos degradan a `doxia` y `doxia-frontend`, que
  // PARECEN valores de produccion. Un realm equivocado no se distingue de uno
  // correcto mirando el bundle: la sesion simplemente no autentica contra quien
  // deberia, y nadie lo ve.
  //
  // Un fallback es una comodidad de DESARROLLO. En un build de produccion
  // apoyarse en cualquiera es configuracion que falta, y los que menos ruido
  // hacen son los peores.
  const req = consumidas(ficherosDeSrc());
  assert.deepEqual(req, [
    'VITE_API_URL', 'VITE_INTERNAL_ADMIN_PATH',
    'VITE_KEYCLOAK_CLIENT_ID', 'VITE_KEYCLOAK_REALM', 'VITE_KEYCLOAK_URL',
  ], 'cambio el conjunto que el bundle necesita: cada variable nueva es una configuracion que puede faltar en silencio');
});

test('ninguna de las de produccion degrada en silencio: TODAS lanzan al cargar', () => {
  // ESTE TEST FIJABA UNA CARENCIA COMO SI FUERA UNA PROPIEDAD. Decia «UNA revienta
  // y cuatro degradan», y su propio mensaje reconocia que degradar «es peor». O sea
  // que afirmaba el estado malo, y por tanto CAIA cuando alguien lo arreglaba.
  //
  // Paso al fusionar el tronco el 2026-08-24: las seis lanzan ahora, y este test se
  // puso rojo por la mejora. Un test que fija el estado ACTUAL en vez de la
  // propiedad DESEADA convierte cada arreglo en una regresion aparente, y la
  // reaccion natural --revertir el arreglo-- es la peor de las dos.
  const todas = exigidas(ficherosDeSrc());
  assert.ok(todas.length >= 6, `solo ${todas.length} lanzan: alguna volvio a degradar en silencio`);
  assert.ok(todas.includes('VITE_INTERNAL_ADMIN_PATH'), 'la que ya lanzaba dejo de hacerlo');
  assert.ok(todas.includes('VITE_API_URL'), 'sin ella la pagina no habla con nadie, y callaba');
});

test('un arbol SIN .env.production tiene las CINCO ausentes, no se salta', () => {
  // ESTE es el caso del incidente, y la primera version de este test lo saltaba.
  // Comprobaba «el .env.production que hay esta completo» cuando lo que paso fue
  // que NO HABIA NINGUNO. Lo encontro `third` auditando.
  //
  // Es la leccion de `el-build-en-verde-y-la-pagina-en-blanco` un nivel mas
  // arriba: alli, cuatro comprobaciones ciertas que no median el ARRANQUE; aqui,
  // una comprobacion cierta que no medía la AUSENCIA. `t.skip` convierte «no
  // aplica aqui» en «pasa», y son cosas distintas.
  const r = revisarArbol({ leer: () => null, listar: ficherosDeSrc });
  assert.equal(r.existe, false);
  assert.equal(r.faltan.length, 5, 'el fichero ausente cuenta como TODAS ausentes');
  assert.deepEqual(r.faltan, r.necesarias);
});

test('el arbol de AQUI: si el fichero esta, esta completo; y se dice cual de los dos casos es', () => {
  // No se salta nunca. En CI `existe` sale false y eso NO es un fallo -- alli no
  // debe haber `.env.production`--; en el arbol desde el que se compila para
  // produccion, si lo es. La distincion la hace quien llama, no este test: por
  // eso `revisarArbol` devuelve `{existe, faltan}` y no un booleano.
  const r = revisarArbol({
    leer: (ruta) => (existsSync(join(ROOT, ruta)) ? readFileSync(join(ROOT, ruta), 'utf8') : null),
    listar: ficherosDeSrc,
  });
  if (!r.existe) {
    assert.equal(r.faltan.length, r.necesarias.length,
      'sin fichero faltan todas: si esto no se cumple, la semantica se rompio');
    return;                       // arbol de CI o worktree limpio: no aplica, y NO es un pase
  }
  assert.deepEqual(r.faltan, [],
    `faltan en .env.production: ${r.faltan.join(', ')}.\n`
    + 'Compilar asi produce un bundle que LANZA al cargar --pagina en blanco para todos-- o, peor, '
    + 'uno que autentica contra el realm equivocado sin que nada lo delate. Y el build saldra en verde.');
});

// LA PUERTA DE VERDAD NO ESTA AQUI, y conviene que quede escrito donde alguien lo
// lea: esto comprueba el arbol EN EL QUE SE CORREN LOS TESTS. El incidente fue
// compilar para produccion desde otro. La comprobacion tiene que vivir en
// `deploy.mjs`, antes de `npm run build`, y ahi `existe: false` SI es un fallo.

// ── La lista cableada contra la lista DERIVADA ─────────────────────────────
//
// Hay DOS implementaciones de la misma pregunta, y eso es el defecto dominante
// de este repositorio:
//
//   scripts/prod-env.mjs        lista CABLEADA a mano, y esta enchufada en
//                               `deploy.mjs` antes de compilar -- o sea, donde
//                               de verdad muerde
//   harness/lib/env-produccion  DERIVA la lista leyendo el codigo
//
// Hoy coinciden. Pero una lista escrita a mano no se entera de la variable que
// alguien anada manana, y la derivada si. La salida no es que una gane: la
// cableada es la PUERTA --tiene que serlo, corre donde se compila-- y la
// derivada es lo que comprueba que sigue siendo cierta. Una autoridad por hecho:
// el codigo dice cuales hacen falta, `REQUIRED_PROD_ENV` es una cache, y esto es
// lo que impide que la cache caduque en silencio.
test('toda VITE_* consumida esta clasificada: obligatoria u opcional CON motivo', async () => {
  // COBERTURA, NO IGUALDAD. Mi primera version afirmaba que las dos listas eran
  // iguales, y second lo refuto con la pregunta correcta: una variable puede
  // degradar A PROPOSITO, y entonces exigirla mata todo build legitimo que la
  // omita. El arreglo obvio de un test de igualdad --meterla en obligatorias-- es
  // peor que no tener el test.
  //
  // Lo que sostiene el argumento es que ninguna se cuele SIN DECIDIR: cada
  // variable que el codigo consume esta en `REQUIRED_PROD_ENV` o en
  // `OPCIONALES_EN_PROD`. Una variable nueva obliga a elegir, y la eleccion queda
  // escrita.
  const { REQUIRED_PROD_ENV, OPCIONALES_EN_PROD } = await import('../../scripts/prod-env.mjs');
  // `OPCIONALES_EN_PROD` es un OBJETO `{VAR: motivo}`, no una lista, y eso es
  // mejor de lo que yo habia supuesto: la razon viaja con la exencion en vez de
  // vivir en un comentario que se separa de ella al primer refactor.
  const clasificadas = new Set([...REQUIRED_PROD_ENV, ...Object.keys(OPCIONALES_EN_PROD)]);

  // Y una exencion SIN motivo escrito no cuenta como exencion: seria una lista
  // de variables que alguien decidio no exigir, sin decir por que, que es como
  // se convierte una decision en una costumbre.
  for (const [v, motivo] of Object.entries(OPCIONALES_EN_PROD)) {
    assert.ok(String(motivo ?? '').trim().length > 20,
      `'${v}' esta exenta y su motivo no explica nada: una exencion sin razon escrita es una lista, no una decision`);
  }
  const sinClasificar = consumidas(ficherosDeSrc()).filter((v) => !clasificadas.has(v));
  assert.deepEqual(sinClasificar, [],
    `${sinClasificar.join(', ')} se consume en src/ y no esta ni en REQUIRED_PROD_ENV ni en `
    + 'OPCIONALES_EN_PROD. Decide cual: si falta al compilar y rompe, es obligatoria; si degrada a '
    + 'proposito, es opcional Y el motivo va escrito al lado.');
});

test('ninguna obligatoria esta MUERTA: la lista a mano tambien puede sobrar', async () => {
  // La otra direccion, y es de second: mi hueco era que la lista se quedara
  // corta; la suya, que exija algo que ya no usa nadie. Un requisito muerto
  // bloquea despliegues por una variable que el bundle no lee.
  const { REQUIRED_PROD_ENV } = await import('../../scripts/prod-env.mjs');
  const usadas = new Set(consumidas(ficherosDeSrc()));
  const muertas = [...REQUIRED_PROD_ENV].filter((v) => !usadas.has(v));
  assert.deepEqual(muertas, [],
    `${muertas.join(', ')} se exige en produccion y ya no se consume en src/: `
    + 'un requisito muerto detiene despliegues por una variable que el bundle no lee.');
});
