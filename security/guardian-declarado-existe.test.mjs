import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Una aceptacion de riesgo NOMBRA su mitigacion y su guardian (regla 3 de riesgos-aceptados.json).
// Nada comprobaba que esos ficheros EXISTAN, asi que la aceptacion podia apoyarse en un guardian
// renombrado, movido o borrado y la puerta seguiria imprimiendo «aceptadas y mitigadas».
// El 2026-09-01 `third` midio la version cara de esto en otra rama: el guardian existia pero
// vigilaba UN fichero mientras el riesgo alcanzaba a todo el arbol, y un segundo llamante sin
// mitigar se desplego en verde. Esto cubre el caso barato --que no este--; el alcance NO se puede
// comprobar aqui y por eso va declarado en `alcance_del_guardian`, no aprobado en silencio.
const RAIZ = new URL('../../', import.meta.url).pathname;
const RIESGOS = JSON.parse(readFileSync(new URL('./riesgos-aceptados.json', import.meta.url), 'utf8'));
const ARBOL = { backend: 'backend', frontend: '.' };

const aceptados = Object.entries(RIESGOS)
  .filter(([k]) => !k.startsWith('_'))
  .flatMap(([arbol, lista]) => lista.map((r) => ({ ...r, arbol })));

test('hay al menos un riesgo aceptado que comprobar', () => {
  assert.ok(aceptados.length > 0, 'sin riesgos aceptados este fichero no mide nada: seria un test vacio en verde');
});

for (const r of aceptados) {
  const base = join(RAIZ, ARBOL[r.arbol] ?? r.arbol, 'src');

  test(`${r.paquete}/${r.cve}: el guardian declarado EXISTE`, () => {
    assert.ok(r.test, 'la regla 3 exige `test`: sin guardian no se acepta');
    assert.ok(existsSync(join(base, r.test.replace(/^src\//, ''))),
      `el guardian declarado no esta en el arbol: ${r.arbol}/${r.test}. La aceptacion se apoya en un fichero que no existe`);
  });

  test(`${r.paquete}/${r.cve}: los ficheros citados en la mitigacion EXISTEN`, () => {
    const citados = (r.mitigacion ?? '').match(/[\w./-]+\.(ts|tsx|mjs|js)/g) ?? [];
    assert.ok(citados.length > 0, 'la mitigacion tiene que nombrar el fichero donde vive, no solo describirse');
    for (const c of citados) {
      assert.ok(existsSync(join(base, c.replace(/^src\//, ''))),
        `la mitigacion cita ${c} y no esta en ${r.arbol}/src`);
    }
  });

  test(`${r.paquete}/${r.cve}: declara el ALCANCE de su guardian`, () => {
    // Que el guardian exista no dice a cuanto llega. Lo que no se puede comprobar se declara.
    assert.ok(r.alcance_del_guardian, 'falta `alcance_del_guardian`: sin el, un guardian de un fichero aparenta cubrir el arbol');
  });

  test(`${r.paquete}/${r.cve}: la premisa del alcance se MIDE en este arbol`, () => {
    // Una aceptacion es una afirmacion sobre UN arbol y hay mas de uno: la misma frase era cierta
    // en `feat/harness-doxia` y falsa en `feat/staging-aafa` el 2026-09-02. Una premisa que se
    // puede contar no se declara: se cuenta, aqui, cada vez que corre la puerta.
    assert.ok(r.invariante, 'falta `invariante`: si la premisa del alcance se puede medir, se mide');
    const { arbol, patron, excluye, esperado } = r.invariante;
    const raiz = join(RAIZ, arbol);   // `arbol` del invariante es relativo a la RAIZ del repo
    const hallados = [];
    const barrer = (dir) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const ruta = join(dir, e.name);
        if (e.isDirectory()) { barrer(ruta); continue; }
        if (!/\.(ts|tsx|mjs|js)$/.test(e.name)) continue;
        if (excluye && e.name.includes(excluye)) continue;
        if (readFileSync(ruta, 'utf8').includes(patron)) hallados.push(ruta.slice(RAIZ.length));
      }
    };
    barrer(raiz);
    assert.equal(hallados.length, esperado,
      `la premisa de la aceptacion dice ${esperado} fichero(s) con \`${patron}\` y hay ${hallados.length}:\n  ${hallados.join('\n  ')}\nSi el nuevo no lleva la mitigacion, la aceptacion de ${r.cve} ya no es cierta en este arbol.`);
  });
}
