// LAS MATEMATICAS DEL ANILLO — test primero.
//
// Por que este fichero existe: las cinco familias que el anillo usa para medirse
// (euclidiana, sigmoide, regresion lineal, regresion logistica, varianza) vivian
// en scripts `/tmp/*.py` que se borraron. Se perdieron las formulas Y las
// lecciones que dieron: que la logistica publicada no superaba a la linea base
// trivial se descubrio DOS veces porque la primera no quedo versionada.
//
// LA REGLA QUE GOBIERNA ESTE MODULO: toda metrica de clasificacion se publica
// junto a su LINEA BASE TRIVIAL y con validacion fuera de muestra. Un 87.5% que
// empata con «responder si siempre» no es un resultado, y el codigo debe hacer
// incomodo publicarlo sin la comparacion. De ahi que `evaluarClasificador`
// DEVUELVA la linea base en el mismo objeto: no se puede leer el acierto sin
// verla al lado.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  media, varianza, desviacion, rango,
  distancia, centroide,
  sigmoide,
  regresionLineal, correlacion,
  regresionLogistica, predecirLogistica,
  lineaBaseMayoritaria, evaluarClasificador, loocvLogistica,
} from './matematicas.mjs';

const cerca = (a, b, eps = 1e-9, msg) => assert.ok(Math.abs(a - b) < eps, msg ?? `${a} != ${b}`);

// ── Descriptiva ─────────────────────────────────────────────────────────────

test('media', () => {
  cerca(media([8, 9, 8, 9, 9]), 8.6);
  cerca(media([5]), 5);
});

test('la media de una lista vacia es null, no 0 ni NaN', () => {
  assert.equal(media([]), null,
    '0 seria un dato falso y NaN se propaga en silencio: null obliga a decidir');
});

test('VARIANZA MUESTRAL (n-1), no poblacional: son medidas de k corridas', () => {
  // qwen con k=5: 8,9,8,9,9 -> media 8.6
  // desviaciones: -0.6, 0.4, -0.6, 0.4, 0.4 -> cuadrados 0.36,0.16,0.36,0.16,0.16 = 1.2
  // muestral: 1.2/4 = 0.30   (poblacional seria 1.2/5 = 0.24)
  cerca(varianza([8, 9, 8, 9, 9]), 0.30, 1e-9,
    'con n-1 da 0.30; si da 0.24 se esta usando la poblacional');
});

test('varianza 0 cuando todos los votos coinciden', () => {
  cerca(varianza([9, 9, 9, 9, 9]), 0);
});

test('la varianza de UN solo dato es null: no hay dispersion que medir', () => {
  assert.equal(varianza([7]), null, 'n-1 = 0 seria una division por cero disfrazada');
});

test('desviacion es la raiz de la varianza', () => {
  cerca(desviacion([8, 9, 8, 9, 9]), Math.sqrt(0.30));
});

test('rango: la medida que decidio la regla del quorum', () => {
  assert.equal(rango([8, 9, 8, 9, 9]), 1);
  assert.equal(rango([9, 9, 9]), 0);
  assert.equal(rango([]), null);
});

// ── Geometria euclidiana ────────────────────────────────────────────────────

test('distancia euclidiana', () => {
  cerca(distancia([0, 0], [3, 4]), 5);
  cerca(distancia([1, 2, 3], [1, 2, 3]), 0);
});

test('la distancia exige vectores de la misma dimension', () => {
  assert.throws(() => distancia([1, 2], [1, 2, 3]), /dimension/);
});

test('centroide', () => {
  assert.deepEqual(centroide([[0, 0], [2, 0], [1, 3]]), [1, 1]);
});

test('el centroide de un conjunto vacio es null', () => {
  assert.equal(centroide([]), null);
});

// ── Sigmoide ────────────────────────────────────────────────────────────────

test('sigmoide: 0 -> 0.5, y es monotona', () => {
  cerca(sigmoide(0), 0.5);
  assert.ok(sigmoide(-2) < sigmoide(-1) && sigmoide(-1) < sigmoide(1));
});

test('sigmoide NO desborda con entradas extremas', () => {
  cerca(sigmoide(1000), 1, 1e-12);
  cerca(sigmoide(-1000), 0, 1e-12);
  assert.ok(Number.isFinite(sigmoide(1e9)));
  assert.ok(Number.isFinite(sigmoide(-1e9)));
});

test('sigmoide ESTABLE: la forma naive pierde los subnormales bajo z≈-710', () => {
  // MEDIDO, no supuesto. Mi primer comentario decia que la forma naive da NaN en
  // los extremos: es FALSO, ahi ambas coinciden (1/(1+Infinity) = 0). El mutante
  // "usa la forma naive" sobrevivio a ese test porque medía la variable
  // equivocada. La diferencia real esta en z ∈ (-745, -710):
  //
  //   z=-710  naive 0                  estable 4.476e-309
  //   z=-745  naive 0                  estable 5e-324
  //
  // `Math.exp(-z)` con z muy negativo desborda a Infinity y la division colapsa
  // a 0 exacto, perdiendo una probabilidad pequeña pero NO nula.
  assert.ok(sigmoide(-710) > 0,
    'la forma naive da 0 exacto aqui: una probabilidad no nula se vuelve imposible');
  assert.ok(sigmoide(-745) > 0);
  assert.ok(sigmoide(-710) < 1e-300, 'y sigue siendo diminuta, no un valor inventado');

  // Simetria: el lado positivo nunca evalua exp() de un positivo grande.
  assert.equal(sigmoide(710), 1);
});

// ── Regresion lineal ────────────────────────────────────────────────────────

test('regresion lineal sobre una recta exacta', () => {
  const r = regresionLineal([[1, 3], [2, 5], [3, 7]]); // y = 2x + 1
  cerca(r.pendiente, 2);
  cerca(r.intercepto, 1);
  cerca(r.r2, 1);
});

test('r2 = 0 cuando la x no explica nada', () => {
  const r = regresionLineal([[1, 5], [2, 5], [3, 5]]);
  cerca(r.pendiente, 0);
  assert.equal(r.r2, 0, 'sin varianza en y, r2 debe ser 0 y no NaN');
});

test('correlacion: el signo importa mas que el valor', () => {
  cerca(correlacion([[1, 1], [2, 2], [3, 3]]), 1);
  cerca(correlacion([[1, 3], [2, 2], [3, 1]]), -1);
});

test('la regresion exige al menos dos puntos distintos', () => {
  assert.throws(() => regresionLineal([[1, 1]]), /al menos/);
  assert.throws(() => regresionLineal([[1, 1], [1, 2]]), /varianza/);
});

// ── Regresion logistica y SU LINEA BASE ─────────────────────────────────────

const SEPARABLE = [
  [[1], 0], [[2], 0], [[3], 0], [[4], 0],
  [[7], 1], [[8], 1], [[9], 1], [[10], 1],
];

test('la logistica aprende un problema separable', () => {
  const m = regresionLogistica(SEPARABLE, { iteraciones: 3000, tasa: 0.3 });
  assert.ok(predecirLogistica(m, [1]) < 0.5);
  assert.ok(predecirLogistica(m, [10]) > 0.5);
});

test('LINEA BASE MAYORITARIA: lo que hay que superar', () => {
  // 14 de 16 son 1 -> «responder 1 siempre» acierta 14/16 = 0.875
  const y = Array(14).fill(1).concat([0, 0]);
  const b = lineaBaseMayoritaria(y);
  assert.equal(b.clase, 1);
  cerca(b.acierto, 14 / 16);
});

test('evaluarClasificador DEVUELVE la linea base y la GANANCIA en el mismo objeto', () => {
  // Esto es el mecanismo, no un adorno: el 87.5% se publico sin su linea base y
  // resulto que empataba con ella. Si el acierto se pudiera leer sin la ganancia
  // al lado, el mismo error vuelve.
  const y    = [1, 1, 1, 1, 1, 1, 1, 0];
  const pred = [1, 1, 1, 1, 1, 1, 1, 1];
  const e = evaluarClasificador(y, pred);

  cerca(e.acierto, 7 / 8);
  cerca(e.lineaBase.acierto, 7 / 8);
  cerca(e.gananciaPp, 0, 1e-9);
  assert.equal(e.superaLineaBase, false,
    'empatar con la linea base trivial NO es superarla');
});

test('un clasificador que de verdad aprende da ganancia POSITIVA', () => {
  const e = evaluarClasificador([1, 1, 0, 0], [1, 1, 0, 0]);
  cerca(e.acierto, 1);
  cerca(e.lineaBase.acierto, 0.5);
  cerca(e.gananciaPp, 50);
  assert.equal(e.superaLineaBase, true);
});

test('LOOCV: n modelos, cada uno ciego a su propio punto', () => {
  const r = loocvLogistica(SEPARABLE, { iteraciones: 2000, tasa: 0.3 });
  assert.equal(r.n, 8);
  assert.equal(r.predicciones.length, 8);
  assert.ok(r.acierto > 0.5, 'un problema separable debe sobrevivir al LOOCV');
  assert.ok('lineaBase' in r && 'gananciaPp' in r,
    'el LOOCV tambien se publica contra su linea base');
});

test('LOOCV no puede ser mejor que in-sample por construccion accidental', () => {
  const datos = SEPARABLE;
  const m = regresionLogistica(datos, { iteraciones: 2000, tasa: 0.3 });
  const inSample = evaluarClasificador(
    datos.map(([, y]) => y),
    datos.map(([x]) => (predecirLogistica(m, x) >= 0.5 ? 1 : 0)),
  );
  const fuera = loocvLogistica(datos, { iteraciones: 2000, tasa: 0.3 });
  assert.ok(fuera.acierto <= inSample.acierto + 1e-9,
    'si el LOOCV supera al in-sample, hay fuga de datos en el pliegue');
});

test('EL PLIEGUE NO PUEDE VER SU PROPIO PUNTO (la fuga que un dato separable esconde)', () => {
  // MEDIDO: con datos SEPARABLES el mutante «entrena con todos los puntos»
  // sobrevive, porque honesto y tramposo aciertan 1.0 igual. La fuga solo se ve
  // con datos donde la x NO predice la y:
  //
  //   x: 1 2 3 4 5 6 7 8
  //   y: 0 1 0 1 0 1 0 1     <- alterna: ninguna frontera lineal sirve
  //
  //   LOOCV honesto  0.0    cada pliegue aprende la mayoria del resto, que es
  //                         siempre la clase OPUESTA a la del punto excluido
  //   con fuga       0.5    el modelo ya vio el punto que predice
  //
  // El 0.0 no es un fallo del metodo: es la respuesta correcta. En n=8 alternante
  // dejar uno fuera invierte la mayoria, y eso es precisamente lo que un
  // clasificador que no aprende nada merece.
  const ALTERNANTE = [
    [[1], 0], [[2], 1], [[3], 0], [[4], 1],
    [[5], 0], [[6], 1], [[7], 0], [[8], 1],
  ];
  const r = loocvLogistica(ALTERNANTE, { iteraciones: 2000, tasa: 0.3 });

  assert.equal(r.acierto, 0,
    'con fuga de datos esto sube a 0.5: el pliegue habria visto su propio punto');
  assert.equal(r.lineaBase.acierto, 0.5);
  assert.equal(r.superaLineaBase, false,
    'y queda por DEBAJO de la linea base, que es la conclusion honesta');
});

test('la logistica exige datos y etiquetas binarias', () => {
  assert.throws(() => regresionLogistica([], {}), /sin datos/);
  assert.throws(() => regresionLogistica([[[1], 2]], {}), /binaria/);
});
