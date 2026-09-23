/**
 * El extractor de vectores y EL RESULTADO NEGATIVO que produjo.
 *
 * Los tests de abajo no prueban que la geometria funcione: prueban que el
 * extractor lee bien y que la conclusion --«estas cuatro dimensiones no
 * separan»-- sigue siendo cierta sobre el historico. Si un dia separan, estos
 * tests caen y hay que volver a mirar. Ver
 * memory/failures/la-geometria-del-cambio-no-predice-nada.md
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const RAIZ = new URL('../../', import.meta.url).pathname;
const corre = (...args) => execFileSync(
  'node', ['harness/bin/vectores-plan.mjs', ...args], { cwd: RAIZ, encoding: 'utf8', timeout: 60000 },
);

const datos = () => JSON.parse(corre('--json'));

/**
 * SIN HISTORICO NO HAY NADA QUE JUZGAR, Y ESO NO ES UN FALLO.
 *
 * Estos tests leen `.harness/runs/`, que `.gitignore:248` excluye. En el arbol
 * principal existe y hay 36 vueltas; en un WORKTREE del anillo --que se
 * construye desde HEAD-- el directorio nace VACIO, asi que `filas.length` es 0
 * y las tres aserciones de abajo caen por una razon que no tiene nada que ver
 * con lo que prueban.
 *
 * MEDIDO en H-20260921-5e4450b5: el builder llego a la etapa 11, el revisor
 * levanto un P1 «gate --fast en rojo», y el builder se autobloqueo despues de
 * diagnosticarlo correctamente -- los 3 tests rojos eran estos, y `harness/**`
 * estaba en su lista de PROHIBIDO, asi que no podia arreglarlos. La vuelta
 * murio por un rojo que ninguna vuelta puede limpiar.
 *
 * Un historico AUSENTE no es un historico que encogio. Se declara SKIP, que
 * dice «no lo he comprobado», en vez de FAIL, que afirmaria que el resultado
 * negativo dejo de ser cierto.
 */
const sinHistorico = () => datos().filas.length === 0;
const centroide = (vs) => [0, 1, 2, 3].map((i) => vs.reduce((a, v) => a + v[i], 0) / vs.length);
const dist = (a, b) => Math.hypot(...a.map((x, i) => x - b[i]));

function porCodigo() {
  const g = new Map();
  for (const f of datos().filas) {
    if (!g.has(f.reason_code)) g.set(f.reason_code, []);
    g.get(f.reason_code).push(f.vector);
  }
  return g;
}

test('el extractor lee las 4 dimensiones de todas las vueltas con plan', (t) => {
  const d = datos();
  if (!d.filas.length) return t.skip('sin .harness/runs: en un worktree el historico nace vacio');
  assert.deepEqual(d.dims, ['files', 'modulesTouched', 'domainsTouched', 'testsTouched']);
  assert.ok(d.filas.length >= 29, `solo ${d.filas.length} vueltas: el historico no deberia encoger`);
  for (const f of d.filas) {
    assert.equal(f.vector.length, 4);
    assert.ok(f.vector.every(Number.isFinite), `${f.executionId} tiene una dimension no numerica`);
  }
});

test('una vuelta sin plan NO se cuenta como vector de ceros', (t) => {
  if (sinHistorico()) return t.skip('sin .harness/runs: en un worktree el historico nace vacio');

  // Un [0,0,0,0] inventado es un punto REAL del espacio y desplazaria centroides.
  const d = datos();
  assert.ok(Array.isArray(d.sinPlan), 'las vueltas sin plan se declaran aparte');
  const ids = new Set(d.filas.map((f) => f.executionId));
  for (const x of d.sinPlan) assert.ok(!ids.has(String(x).split(' ')[0]));
});

test('MEDIDO: el mismo vector [3,1,0,1] produjo desenlaces DISTINTOS', (t) => {
  if (sinHistorico()) return t.skip('sin .harness/runs: en un worktree el historico nace vacio');

  // Es el hallazgo entero: si un punto del espacio da cinco resultados, ese
  // espacio no predice el resultado.
  const cods = new Set(
    datos().filas
      .filter((f) => f.vector.join(',') === '3,1,0,1')
      .map((f) => f.reason_code),
  );
  assert.ok(cods.size >= 3, `[3,1,0,1] solo dio ${cods.size} desenlace(s): revisar la conclusion`);
});

test('MEDIDO: dos de las cuatro dimensiones casi no varian', (t) => {
  if (sinHistorico()) return t.skip('sin .harness/runs: en un worktree el historico nace vacio');

  const vs = datos().filas.map((f) => f.vector);
  const varianza = (i) => {
    const m = vs.reduce((a, v) => a + v[i], 0) / vs.length;
    return vs.reduce((a, v) => a + (v[i] - m) ** 2, 0) / vs.length;
  };
  assert.ok(varianza(2) < 0.1, 'domainsTouched deberia ser casi constante');
  assert.ok(varianza(3) < 0.2, 'testsTouched deberia ser casi constante');
});

test('MEDIDO: TOPE_ITERACIONES tiene radio ~0 porque es la MISMA spec repetida', (t) => {
  if (sinHistorico()) return t.skip('sin .harness/runs: en un worktree el historico nace vacio');

  // Su cohesion aparente no es senal: son h-007/h-008 corridas varias veces. Un
  // grupo sin dispersion infla cualquier ratio contra el que se compare.
  const vs = porCodigo().get('TOPE_ITERACIONES') ?? [];
  if (vs.length < 5) return; // el historico cambio; el hallazgo se re-mide
  const c = centroide(vs);
  const radio = vs.reduce((a, v) => a + dist(v, c), 0) / vs.length;
  assert.ok(radio < 0.2, `radio ${radio.toFixed(3)}: ya hay dispersion, re-evaluar la geometria`);
});
