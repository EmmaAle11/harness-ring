import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TIPOS, credencialSintetica, contenidoDeSemilla } from '../../lib/credenciales-sinteticas.mjs';

const GATE = () => readFileSync(new URL('../../../scripts/gate.sh', import.meta.url), 'utf8');

const LINEA_PUERTA = () => GATE().split('\n').find((l) => l.includes('AKIA') && /SEC_PAT=|git grep/.test(l));

const partirAlternativas = (src) => {
  const out = []; let cur = '', prof = 0, clase = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') { cur += c + (src[++i] ?? ''); continue; }
    if (clase) { clase = c !== ']'; cur += c; continue; }
    if (c === '[') { clase = true; cur += c; continue; }
    if (c === '(') prof++;
    if (c === ')') prof--;
    if (c === '|' && prof === 0) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

const valorSecPat = (l) => {
  const m = /SEC_PAT='(.*)'\s*$/.exec(l) ?? /'(.*)'/.exec(l);
  return (m?.[1] ?? '').replace(/'"'"'/g, "'");
}

const aRegExpJs = (p) => new RegExp(p
  .replace(/\[:space:\]/g, '\\s').replace(/\[:alnum:\]/g, 'A-Za-z0-9')
  .replace(/\[:alpha:\]/g, 'A-Za-z').replace(/\[:digit:\]/g, '0-9'));

const ALTERNATIVAS = () => partirAlternativas(valorSecPat(LINEA_PUERTA() ?? ''));

test('la puerta se lee, no se copia: ocho alternativas', () => {
  assert.ok(LINEA_PUERTA(), 'no encuentro la comprobación de secretos en la puerta');
  // 6 -> 8 al fusionar el tronco el 2026-09-07: entran el literal a PASSWORD/SECRET/TOKEN y la
  // credencial de un realm export. La cifra es un TRINQUETE de cobertura, no una descripción: si
  // sube, hay que añadir su generador abajo; si baja, alguien quitó un patrón de la puerta.
  assert.equal(ALTERNATIVAS().length, 8, `la puerta busca ${ALTERNATIVAS().length} formas: revisa la cobertura`);
});

test('TODO patrón de la puerta tiene generador — la dirección que importa', () => {
  // ESTE TEST ESTABA ESCRITO AL REVES, y su propio comentario nombraba el modo de
  // fallo correcto: «si alguien añade un patrón a gate.sh y no un generador aquí,
  // el criterio deja de poder probarse para ese patrón y nadie se entera».
  //
  // La aserción recorría `TIPOS` preguntando si la puerta lo busca — la dirección
  // fácil, la que no puede fallar por lo que el comentario teme. Con tres patrones
  // sin semilla (jwt, slack, clave privada) salía VERDE. Cobertura real: 3 de 6.
  // Lo cazó third. El nombre prometía cobertura y la aserción medía otra cosa.
  for (const alt of ALTERNATIVAS()) {
    const re = aRegExpJs(alt);
    const cubre = Object.keys(TIPOS).filter((t) => re.test(credencialSintetica(t, 'cobertura')));
    assert.ok(cubre.length > 0,
      `la puerta busca /${alt}/ y ningún generador lo produce: ese patrón NO se puede sembrar, o sea que su criterio no se puede probar`);
  }
});

test('y ningún generador produce algo que la puerta no cace', () => {
  // La vuelta: un generador cuya salida no case con ninguna alternativa siembra
  // algo inofensivo y la vuelta demostraría que la puerta NO muerde.
  for (const tipo of Object.keys(TIPOS)) {
    const v = credencialSintetica(tipo, 'h-007');
    assert.ok(ALTERNATIVAS().some((a) => aRegExpJs(a).test(v)),
      `'${tipo}' genera algo que la puerta no cazaría: la semilla no probaría nada`);
  }
});

test('el generador NO deja una credencial completa en lo versionado', () => {
  // La propiedad que hace que esto se pueda commitear: el módulo lleva el
  // PREFIJO y un generador, nunca una cadena que cumpla el patrón entero. Si
  // alguien pega un ejemplo real en un comentario, este test cae.
  const src = readFileSync(new URL('../../lib/credenciales-sinteticas.mjs', import.meta.url), 'utf8');
  for (const alt of ALTERNATIVAS()) {
    assert.doesNotMatch(src, aRegExpJs(alt),
      `el módulo casa con /${alt}/: el pre-commit lo bloqueará y la puerta cazará al generador en vez de a lo sembrado`);
  }
  // Y el test tampoco, que también se versiona.
  const test = readFileSync(new URL('./credenciales-sinteticas.test.mjs', import.meta.url), 'utf8');
  for (const alt of ALTERNATIVAS()) assert.doesNotMatch(test, aRegExpJs(alt));
});

test('CI sube la EVIDENCIA, no el workspace donde vive la semilla', () => {
  // La semilla no abre nada, pero tiene la forma exacta de una clave real: eso es
  // justo lo que la hace útil, y también lo que hace que cualquier escáner la
  // marque. Vive en `.harness/workspaces/` (el fichero sembrado) y en
  // `.harness/runs/` (la traza), y las dos son rutas HERMANAS de la que CI sube.
  //
  // Un `path: .harness/` —un carácter menos— publicaría las dos en un artefacto
  // que puede leer cualquiera con acceso al repo. Precondición de third, escrita
  // aquí para que deje de ser una precondición.
  const ci = readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const rutas = ci.split('\n').filter((l) => /^\s*path:/.test(l) && l.includes('.harness'));
  assert.ok(rutas.length > 0, 'CI ya no sube evidencia: la regla #0 no deja rastro fuera de la máquina');
  for (const r of rutas) {
    assert.match(r.trim(), /^path:\s*\.harness\/evidence\/?$/,
      `CI sube «${r.trim()}»: si eso incluye runs/ o workspaces/, publica el fichero sembrado con la credencial dentro`);
  }
});
