// Telemetria de invocacion — que costo cada llamada, MEDIDO.
//
// LA REGLA, y es la misma que gobierna `MISSING` en Security: lo que no se
// puede medir se DECLARA, nunca se estima. Un coste inventado no es una
// aproximacion util: es una cifra que se lee como una medida.
//
//   duracion      la mide el harness  -> SIEMPRE existe
//   tokens        los publica el proveedor -> deepseek y ollama si, los CLI no
//   coste         nadie lo publica aqui -> MISSING, con su motivo
//
// `catalog.json` declara el coste como TIER cualitativo a proposito ("el precio
// exacto cambia sin avisar y un numero desactualizado decide peor que una
// categoria honesta"). Multiplicar tokens por un precio que este repo no tiene
// seria fabricar el dato que esa decision evito.
//
// EL SUMIDERO ES DE MODULO porque `invoke()` es el unico punto de entrada a un
// proveedor y no recibe el contexto de la vuelta. Quien la vacia es el
// orquestador al cerrar, y de ahi va al ExecutionTrace.

const eventos = [];

/** Registra UNA invocacion. Se llama desde `adapters/models/index.mjs`. */
export function registrar(e) {
  eventos.push({
    provider: e.provider ?? null,
    model: e.model ?? null,
    ms: e.ms ?? null,
    ok: e.ok !== false,
    ...(e.code ? { code: e.code } : {}),
    usage: e.usage ?? null,
  });
  return e;
}

/** Vacia el registro y devuelve lo acumulado. Lo llama quien cierra la vuelta. */
export const drenar = () => eventos.splice(0);
export const leer = () => [...eventos];

const suma = (xs) => xs.reduce((a, x) => a + (x ?? 0), 0);
const sumaONull = (xs) => (xs.every((x) => x == null) ? null : suma(xs));

/**
 * Los eventos, agregados por (proveedor, modelo).
 *
 * `tokens*` en `null` significa NO LO PUBLICA, que es distinto de cero. Un cero
 * ahi diria «esta llamada no gasto tokens», que es falso en todas.
 */
export function resumir(evs = []) {
  const porClave = new Map();
  for (const e of evs) {
    const k = `${e.provider}:${e.model}`;
    if (!porClave.has(k)) porClave.set(k, []);
    porClave.get(k).push(e);
  }
  return [...porClave.entries()].map(([id, xs]) => {
    const u = xs.map((x) => x.usage).filter(Boolean);
    const tokensInput = sumaONull(u.map((x) => x.tokensInput));
    const tokensOutput = sumaONull(u.map((x) => x.tokensOutput));
    const totalTokens = sumaONull(u.map((x) => x.totalTokens));
    return {
      id,
      provider: xs[0].provider,
      model: xs[0].model,
      calls: xs.length,
      failed: xs.filter((x) => !x.ok).length,
      durationMs: suma(xs.map((x) => x.ms)),
      // La duracion es lo unico comparable entre proveedores hoy, y por eso se
      // publica tambien por llamada: un total sin el numero de llamadas no
      // distingue «lento» de «invocado muchas veces».
      msPerCall: xs.length ? Math.round(suma(xs.map((x) => x.ms)) / xs.length) : null,
      tokensInput,
      tokensOutput,
      totalTokens,
      tokensStatus: totalTokens === null ? 'MISSING' : 'REPORTED',
      estimatedCost: null,
      costStatus: 'MISSING',
      costNote: totalTokens === null
        ? 'el proveedor no publica uso: sin tokens no hay coste que calcular'
        : 'hay tokens, pero el catalogo declara el coste como tier cualitativo y no como precio: no se estima',
    };
  }).sort((a, b) => b.durationMs - a.durationMs);
}
