// ¿QUE VEREDICTOS PUEDE EMITIR CADA ETAPA DE LA PUERTA?
//
// «Un control que no puede cambiar su salida no es un control»: ocupa la casilla para que
// nadie mire. Y el camino obvio para detectarlo es el falso — medir la VARIANZA de las
// corridas. Medido sobre 18 evidencias, de 24 etapas sólo una había variado alguna vez; en
// una rama sana lo normal es que `typecheck` y `lint` salgan PASS siempre. Varianza cero es
// un cribado, no un veredicto.
//
// Lo que sí prueba es ESTÁTICO y sale del código: si TODAS las llamadas a `record` de una
// etapa llevan un estado LITERAL y ninguno es `FAIL`, esa etapa no puede fallar. No hace
// falta correrla para saberlo.
//
// Se ignoran las que registran con VARIABLE (`record lock:full "$TURNO_ESTADO"`): la variable
// sí puede valer FAIL, y marcarlas era el falso positivo del primer barrido.
//
// Hallazgo de `third` (2026-08-30); el disparador, entre los dos. Ver
// `memory/failures/un-control-que-no-puede-fallar-no-es-un-control.md`.
import { readFileSync } from 'node:fs';

/** Estados que DECLARAN una carencia en vez de aprobarla. Una etapa que sólo emite esto no
 *  está fingiendo que comprueba: está diciendo que no puede. */
export const DECLARATIVOS = new Set(['NOT_CONFIGURED', 'MISSING', 'SKIP']);

/**
 * Etapas cuya naturaleza está DECLARADA y aceptada, con el motivo. No es una lista de
 * perdón: es la diferencia entre una etapa que dice lo que es y otra que aparenta.
 */
export const DECLARADAS = new Map([
  ['architecture_validation', 'informativa por diseño: el grafo no se versiona, así que sin él no hay nada que validar'],
]);

/** Las llamadas a `record` con etapa y estado LITERALES (las de variable no se pueden juzgar). */
export function llamadas(fuente) {
  const out = [];
  for (const m of fuente.matchAll(/(?:^|\n)\s*record\s+("?)([A-Za-z_][\w:]*)\1\s+(\S+)/g)) {
    const estado = m[3];
    // `"$VAR"` o `$VAR`: el estado se decide en tiempo de corrida y puede ser FAIL.
    out.push({ etapa: m[2], estado: estado.replace(/^"|"$/g, ''), literal: !estado.includes('$') });
  }
  return out;
}

/**
 * Las etapas que NO PUEDEN FALLAR: todas sus llamadas son literales, ninguna es FAIL, y
 * alguna aprueba (`PASS`/`WARN`). Una que sólo emite declarativos no entra: declarar no es
 * mentir.
 */
export function etapasQueNoPuedenFallar(fuente) {
  const porEtapa = new Map();
  for (const l of llamadas(fuente)) {
    if (!porEtapa.has(l.etapa)) porEtapa.set(l.etapa, []);
    porEtapa.get(l.etapa).push(l);
  }
  const out = [];
  for (const [etapa, ls] of porEtapa) {
    if (ls.some((l) => !l.literal)) continue;              // la variable puede valer FAIL
    if (ls.some((l) => l.estado === 'FAIL')) continue;     // puede fallar: es un control
    if (ls.every((l) => DECLARATIVOS.has(l.estado))) continue; // declara, no aprueba
    out.push({ etapa, estados: [...new Set(ls.map((l) => l.estado))].sort() });
  }
  return out.sort((a, b) => a.etapa.localeCompare(b.etapa));
}

/** Las que además NO están declaradas: éstas son el hallazgo. */
export function hallazgos(fuente) {
  return etapasQueNoPuedenFallar(fuente).filter((e) => !DECLARADAS.has(e.etapa));
}

/**
 * Las etapas que se registran con el NOMBRE en una variable (`record "$label" ...`).
 *
 * Están FUERA DE ALCANCE: no se puede atribuir el veredicto a una etapa concreta leyendo el
 * fichero. Y eso importa decirlo, porque una etapa fuera de alcance contaba como sana POR
 * SILENCIO — que es la forma exacta del defecto que este comprobador persigue. Ahí vivía `sca`,
 * cuyo peor caso era `WARN` y por tanto no podía poner la puerta en rojo: un CVE nuevo y sin
 * aceptar salía con su aviso y el gate seguía diciendo PASS.
 */
export function fueraDeAlcance(fuente) {
  const out = new Set();
  for (const m of fuente.matchAll(/(?:^|\n)\s*record\s+"?\$\{?(\w+)/g)) out.add(`$${m[1]}`);
  return [...out].sort();
}

/** Cuántas etapas se examinaron de verdad. La nota del gate NO puede decir «todas». */
export function alcance(fuente) {
  const vistas = new Set(llamadas(fuente).map((l) => l.etapa));
  return { examinadas: vistas.size, fuera: fueraDeAlcance(fuente) };
}

if (process.argv[2]) {
  const fuente = readFileSync(process.argv[2], 'utf8');
  const h = hallazgos(fuente);
  const a = alcance(fuente);
  for (const e of h) console.log(`${e.etapa} — sólo emite ${e.estados.join(' ')}, nunca FAIL`);
  // El alcance SIEMPRE, haya hallazgo o no: es lo que impide que el verde signifique «todas».
  console.log(`${a.examinadas} etapas examinadas${a.fuera.length ? ` · fuera de alcance: ${a.fuera.join(', ')}` : ''}`);
  process.exit(h.length ? 1 : 0);
}
