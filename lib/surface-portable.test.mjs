/**
 * EL HARNESS NO PUEDE SABER QUE ES «AAFA».
 *
 * `surface.mjs` llevaba la taxonomia del producto incrustada en la logica:
 *
 *   export const SISTEMAS = ['aafa', 'sipca', 'sisdir', 'sicath', 'sgci', 'admin'];
 *   export const ALIAS_DE_SISTEMA = { archivero: 'aafa' };
 *   /^(?:src\/app|backend\/src)\/([^/]+)\//
 *
 * Las tres cosas son ciertas PARA ESTE REPO y falsas para cualquier otro. Un
 * harness que aspira a ser el cuerpo donde cualquier sistema se automatice no
 * puede traer los organos de uno solo: `maxDomains` --el guard que impide que una
 * vuelta toque dos sistemas a la vez-- deja de funcionar en cuanto el proyecto
 * llama a sus carpetas de otra forma, y lo hace EN SILENCIO, contando
 * `plataforma` para todo.
 *
 * La taxonomia pasa a `harness/policy/dominios.json`, que ES configuracion. El
 * motor lee; no sabe.
 *
 * ESTOS TESTS NO PRUEBAN QUE DOXIA FUNCIONE --eso lo hace surface.test.mjs-- sino
 * que el motor funcione con una taxonomia que NO es la de DoxIA.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dominioDe, esSistema, cargarDominios, superficie } from './surface.mjs';

const SRC = readFileSync(new URL('./surface.mjs', import.meta.url), 'utf8');
const SIN_COMENTARIOS = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

test('el MOTOR no nombra ningun sistema de DoxIA', () => {
  for (const nombre of ['aafa', 'sipca', 'sisdir', 'sicath', 'sgci', 'archivero']) {
    assert.doesNotMatch(
      SIN_COMENTARIOS, new RegExp(`['"]${nombre}['"]`),
      `'${nombre}' sigue incrustado en la logica de surface.mjs`,
    );
  }
});

test('las rutas base tampoco estan incrustadas', () => {
  // `src/app` y `backend/src` son la convencion de ESTE repo. Un proyecto con
  // `packages/*/src` o `apps/*` no tiene por que reorganizarse para usar el anillo.
  assert.doesNotMatch(
    SIN_COMENTARIOS, /src\\?\/app\|backend/,
    'el regex de dominio trae la disposicion de carpetas de DoxIA',
  );
});

test('una taxonomia AJENA funciona igual de bien', () => {
  // Un monorepo cualquiera: nada que ver con DoxIA.
  const otro = cargarDominios({
    sistemas: ['facturacion', 'inventario', 'rrhh'],
    alias: { nominas: 'rrhh' },
    basePaths: ['apps', 'services'],
  });
  assert.equal(dominioDe('apps/facturacion/Factura.tsx', otro), 'facturacion');
  assert.equal(dominioDe('services/inventario/stock.ts', otro), 'inventario');
  assert.equal(dominioDe('apps/nominas/Recibo.tsx', otro), 'rrhh', 'el alias ajeno no resolvio');
  assert.equal(dominioDe('libs/compartido/util.ts', otro), 'plataforma');
  assert.ok(esSistema('facturacion', otro));
  assert.ok(!esSistema('aafa', otro), 'un sistema de DoxIA no existe en otra taxonomia');
});

test('sin configuracion NO adivina: cae a plataforma, no a un dominio inventado', () => {
  // El fallo tiene que ser visible y conservador. Inventar un dominio a partir
  // del nombre de la carpeta haria que maxDomains contara sistemas que nadie
  // declaro, que es peor que no contar ninguno.
  const vacia = cargarDominios({ sistemas: [], alias: {}, basePaths: ['src/app'] });
  assert.equal(dominioDe('src/app/loquesea/X.tsx', vacia), 'plataforma');
  assert.ok(!esSistema('loquesea', vacia));
});

test('la taxonomia de DoxIA sigue funcionando: es config, no codigo', () => {
  // El default carga harness/policy/dominios.json, que HOY tiene la de DoxIA.
  // Generalizar no puede significar romper al unico usuario que existe.
  assert.equal(dominioDe('src/app/aafa/Foo.tsx'), 'aafa');
  assert.equal(dominioDe('src/app/archivero/Bar.tsx'), 'aafa', 'se perdio el alias medido');
  assert.equal(dominioDe('backend/src/sgci/svc.ts'), 'sgci');
  assert.equal(dominioDe('src/lib/util.ts'), 'plataforma');
  assert.ok(esSistema('admin'));
});

test('las funciones con config opcional NO viajan sueltas dentro de un .map', () => {
  // `.map(moduloDe)` le pasa el INDICE como segundo argumento. Desde que estas
  // funciones aceptan una taxonomia ahi, el indice entraba como config y
  // reventaba con «Cannot read properties of undefined (reading 'includes')».
  // Lo caza el test de superficie, pero tarde: el error aparece en la etapa Plan
  // de una vuelta, no al refactorizar.
  for (const patron of [/\.map\(moduloDe\)/, /\.map\(dominioDe\)/, /\.filter\(esSistema\)/]) {
    assert.doesNotMatch(SIN_COMENTARIOS, patron, `${patron} pasa el indice como config`);
  }
});

test('superficie() acepta una taxonomia y la usa de verdad', () => {
  const otro = cargarDominios({
    sistemas: ['facturacion', 'inventario'],
    alias: {},
    basePaths: ['apps'],
  });
  const s = superficie(['apps/facturacion/A.tsx', 'apps/inventario/B.ts', 'libs/x/c.ts'], null, { cfg: otro });
  assert.equal(s.domainsTouched, 2, 'no conto los dominios de la taxonomia ajena');
  assert.deepEqual(s.domains, ['facturacion', 'inventario', 'plataforma']);
  assert.deepEqual(s.modules.sort(), ['apps/facturacion', 'apps/inventario', 'libs/x']);
});
