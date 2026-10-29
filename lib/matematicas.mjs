// LAS MATEMATICAS DEL ANILLO — las cinco familias que usa para medirse.
//
// POR QUE ESTA AQUI Y NO EN /tmp: estas formulas vivieron en scripts `/tmp/*.py`
// hasta que se borraron. Se perdieron las formulas y, peor, las LECCIONES que
// dieron: que la regresion logistica publicada no superaba a la linea base
// trivial se tuvo que descubrir dos veces.
//
// PURO: sin E/S, sin dependencias. Quien lee datos es el llamante.
//
// LA DECISION DE DISENO QUE IMPORTA: `evaluarClasificador` devuelve el acierto,
// su linea base trivial y la ganancia en puntos porcentuales EN EL MISMO OBJETO.
// No se puede leer el acierto sin ver contra que compite. Se publico un 87.5%
// que empataba exactamente con «responder si siempre» (+0.0 pp) y ese numero
// paso por resultado durante dias. El tipo de dato ahora lo impide.
//
// Convencion: lo que no se puede calcular devuelve `null`, no 0 ni NaN. Un 0 es
// un dato falso y un NaN se propaga en silencio hasta que alguien publica una
// probabilidad que no existe.

// ── Descriptiva ─────────────────────────────────────────────────────────────

/** Media aritmetica. `null` si no hay datos: 0 seria un dato inventado. */
export function media(xs) {
  if (!Array.isArray(xs) || xs.length === 0) return null;
  return xs.reduce((a, x) => a + x, 0) / xs.length;
}

/**
 * Varianza MUESTRAL (n-1), no poblacional.
 *
 * Los votos de k corridas son una MUESTRA del comportamiento del juez, no la
 * poblacion entera: con n-1 la estimacion no queda sesgada a la baja. Con k=5 y
 * votos 8,9,8,9,9 la muestral da 0.30 y la poblacional 0.24 — la diferencia
 * decide si un juez parece mas consistente de lo que es.
 */
export function varianza(xs) {
  if (!Array.isArray(xs) || xs.length < 2) return null;
  const m = media(xs);
  return xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1);
}

export function desviacion(xs) {
  const v = varianza(xs);
  return v === null ? null : Math.sqrt(v);
}

/** Rango = max - min. Es la medida con la que se decidio la regla del quorum. */
export function rango(xs) {
  if (!Array.isArray(xs) || xs.length === 0) return null;
  return Math.max(...xs) - Math.min(...xs);
}

// ── Geometria euclidiana ────────────────────────────────────────────────────

/** Distancia euclidiana. `Math.hypot` evita el desborde de sumar cuadrados grandes. */
export function distancia(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
    throw new Error(`distancia: vectores de dimension distinta (${a?.length} vs ${b?.length})`);
  }
  return Math.hypot(...a.map((x, i) => x - b[i]));
}

/** Centro de masa de un conjunto de vectores. */
export function centroide(vs) {
  if (!Array.isArray(vs) || vs.length === 0) return null;
  const d = vs[0].length;
  if (vs.some((v) => v.length !== d)) throw new Error('centroide: vectores de dimension distinta');
  return Array.from({ length: d }, (_, i) => vs.reduce((a, v) => a + v[i], 0) / vs.length);
}

// ── Sigmoide ────────────────────────────────────────────────────────────────

/**
 * Sigmoide numericamente estable.
 *
 * MEDIDO: la forma naive `1/(1+e^-z)` NO da NaN en los extremos — ahi coincide
 * con esta (1/(1+Infinity) = 0). Donde difieren de verdad es en z ∈ (-745,-710),
 * donde `Math.exp(-z)` desborda a Infinity y la division colapsa a 0 EXACTO:
 *
 *   z = -710   naive 0   ·   estable 4.476e-309
 *   z = -745   naive 0   ·   estable 5e-324
 *
 * Una probabilidad diminuta pero no nula se convierte en imposible, y eso cambia
 * una verosimilitud. Las dos ramas evitan evaluar exp() de un positivo grande.
 */
export function sigmoide(z) {
  if (z >= 0) {
    const e = Math.exp(-z);
    return 1 / (1 + e);
  }
  const e = Math.exp(z);
  return e / (1 + e);
}

// ── Regresion lineal ────────────────────────────────────────────────────────

/**
 * Minimos cuadrados sobre pares [x, y]. Devuelve pendiente, intercepto y r2.
 *
 * `r2` es 0 — no NaN — cuando `y` no tiene varianza: la x no explica nada, que
 * es una respuesta, no un error.
 */
export function regresionLineal(puntos) {
  if (!Array.isArray(puntos) || puntos.length < 2) {
    throw new Error('regresionLineal: hacen falta al menos 2 puntos');
  }
  const xs = puntos.map(([x]) => x);
  const ys = puntos.map(([, y]) => y);
  const mx = media(xs);
  const my = media(ys);

  const sxx = xs.reduce((a, x) => a + (x - mx) ** 2, 0);
  if (sxx === 0) throw new Error('regresionLineal: la x no tiene varianza, la pendiente no existe');

  const sxy = puntos.reduce((a, [x, y]) => a + (x - mx) * (y - my), 0);
  const pendiente = sxy / sxx;
  const intercepto = my - pendiente * mx;

  const syy = ys.reduce((a, y) => a + (y - my) ** 2, 0);
  const residual = puntos.reduce((a, [x, y]) => a + (y - (pendiente * x + intercepto)) ** 2, 0);
  const r2 = syy === 0 ? 0 : Math.max(0, 1 - residual / syy);

  return { pendiente, intercepto, r2, n: puntos.length };
}

/** Pearson. El SIGNO es lo que suele importar; el valor sin n no dice gran cosa. */
export function correlacion(puntos) {
  const xs = puntos.map(([x]) => x);
  const ys = puntos.map(([, y]) => y);
  const mx = media(xs);
  const my = media(ys);
  const num = puntos.reduce((a, [x, y]) => a + (x - mx) * (y - my), 0);
  const den = Math.sqrt(
    xs.reduce((a, x) => a + (x - mx) ** 2, 0) * ys.reduce((a, y) => a + (y - my) ** 2, 0),
  );
  return den === 0 ? null : num / den;
}

// ── Regresion logistica ─────────────────────────────────────────────────────

/**
 * Descenso de gradiente sobre datos [[x1..xn], y] con y en {0,1}.
 *
 * Sin regularizacion y con pocas iteraciones a proposito: el uso real son
 * muestras de n<20 donde lo que hace falta es una referencia honesta, no el
 * mejor ajuste posible. Un modelo mas potente sobre 16 puntos solo memoriza
 * mejor, que es como se llego a un 100% in-sample que no valia nada.
 */
export function regresionLogistica(datos, { iteraciones = 2000, tasa = 0.1 } = {}) {
  if (!Array.isArray(datos) || datos.length === 0) throw new Error('regresionLogistica: sin datos');
  for (const [, y] of datos) {
    if (y !== 0 && y !== 1) throw new Error(`regresionLogistica: etiqueta no binaria (${y})`);
  }
  const d = datos[0][0].length;
  let w = new Array(d).fill(0);
  let b = 0;

  for (let it = 0; it < iteraciones; it++) {
    const gw = new Array(d).fill(0);
    let gb = 0;
    for (const [x, y] of datos) {
      const p = sigmoide(x.reduce((a, xi, i) => a + xi * w[i], 0) + b);
      const e = p - y;
      for (let i = 0; i < d; i++) gw[i] += e * x[i];
      gb += e;
    }
    for (let i = 0; i < d; i++) w[i] -= (tasa * gw[i]) / datos.length;
    b -= (tasa * gb) / datos.length;
  }
  return { w, b, n: datos.length, iteraciones, tasa };
}

export function predecirLogistica(modelo, x) {
  return sigmoide(x.reduce((a, xi, i) => a + xi * modelo.w[i], 0) + modelo.b);
}

// ── Linea base y validacion: el mecanismo contra el autoengaño ──────────────

/**
 * La linea base TRIVIAL: responder siempre la clase mayoritaria.
 *
 * Es el rival que todo clasificador tiene que batir y el que se olvida. Con 14
 * de 16 positivos acierta el 87.5% sin mirar ni una variable.
 */
export function lineaBaseMayoritaria(ys) {
  if (!Array.isArray(ys) || ys.length === 0) return null;
  const unos = ys.filter((y) => y === 1).length;
  const clase = unos >= ys.length - unos ? 1 : 0;
  const acierto = (clase === 1 ? unos : ys.length - unos) / ys.length;
  return { clase, acierto, n: ys.length };
}

/**
 * Acierto JUNTO A su linea base y la ganancia en puntos porcentuales.
 *
 * El acierto y su rival viajan en el mismo objeto a proposito: un acierto que se
 * puede leer sin ver contra que compite es como se publica un 87.5% que empata
 * con «responder si siempre». `superaLineaBase` es estrictamente mayor —
 * empatar no es superar.
 */
export function evaluarClasificador(ys, predicciones) {
  if (ys.length !== predicciones.length) {
    throw new Error(`evaluarClasificador: ${ys.length} etiquetas vs ${predicciones.length} predicciones`);
  }
  const aciertos = ys.filter((y, i) => y === predicciones[i]).length;
  const acierto = aciertos / ys.length;
  const lineaBase = lineaBaseMayoritaria(ys);
  const gananciaPp = (acierto - lineaBase.acierto) * 100;
  return {
    acierto,
    aciertos,
    n: ys.length,
    lineaBase,
    gananciaPp,
    superaLineaBase: acierto > lineaBase.acierto,
  };
}

/**
 * Leave-One-Out: n modelos, cada uno entrenado SIN el punto que predice.
 *
 * Con n<20 no hay sitio para un conjunto de prueba aparte, y el acierto
 * in-sample de una logistica sobre 16 puntos es casi siempre 100% — un numero
 * que no mide nada. El LOOCV es lo minimo que distingue aprender de memorizar.
 */
export function loocvLogistica(datos, opciones = {}) {
  if (!Array.isArray(datos) || datos.length < 3) {
    throw new Error('loocvLogistica: hacen falta al menos 3 puntos');
  }
  const ys = datos.map(([, y]) => y);
  const predicciones = datos.map(([x], i) => {
    const resto = datos.filter((_, j) => j !== i);
    // Un pliegue con una sola clase no puede predecir la otra: se responde la
    // que vio, que es lo que haria la linea base. Fingir otra cosa seria fuga.
    const clases = new Set(resto.map(([, y]) => y));
    if (clases.size < 2) return [...clases][0];
    const m = regresionLogistica(resto, opciones);
    return predecirLogistica(m, x) >= 0.5 ? 1 : 0;
  });
  return { ...evaluarClasificador(ys, predicciones), predicciones, metodo: 'LOOCV' };
}
