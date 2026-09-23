// El criterio «secret scanning bloquea una credencial sembrada» era INTESTABLE por
// construcción, y por eso lleva desde siempre en ✘:
//
//   scripts/gate.sh   busca los patrones con `git grep` sobre LO VERSIONADO
//   .husky/pre-commit los bloquea en el staged diff
//
// Una spec con la credencial dentro ni se puede commitear; y si se commiteara, la
// puerta cazaría su propio material de pruebas — un hallazgo sobre la spec, no
// sobre el fichero sembrado. La spec declara el TIPO; el harness pone el valor.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TIPOS, credencialSintetica, contenidoDeSemilla } from './credenciales-sinteticas.mjs';

// Las alternativas de la puerta, LEIDAS de `gate.sh`. Copiarlas aquí era la mitad
// del defecto: una copia no diverge con un error, diverge en silencio.
// EL LOCALIZADOR TAMBIEN ENVEJECE. Esto buscaba la linea con `AKIA` Y `git grep`, porque en esta
// rama los patrones vivian dentro de la propia llamada. Al fusionar el tronco (2026-09-07) pasaron a
// una variable `SEC_PAT=`, y el lector dejo de encontrar NADA: `ALTERNATIVAS` salio vacio y el test
// dijo «la puerta busca 0 formas». No es un falso positivo -- es el test funcionando: se nego a
// afirmar sobre una lista que no habia podido leer. Lo que NO puede pasar es que un lector que no
// encuentra su linea devuelva una lista vacia y alguien la lea como «no hay patrones».
const GATE = readFileSync(new URL('../../scripts/gate.sh', import.meta.url), 'utf8');
const LINEA_PUERTA = GATE.split('\n').find((l) => l.includes('AKIA') && /SEC_PAT=|git grep/.test(l));
// PARTIR POR `|` A SECAS ROMPE LA ALTERNANCIA QUE VA DENTRO DE UN GRUPO. El patrón del tronco trae
// `(PASSWORD|PASSWD|SECRET|TOKEN)[A-Z_]*…`: con un `split('|')` pelado salían DIEZ trozos y cuatro de
// ellos no eran regex válidas (`/(PASSWORD/` → «Unterminated group»). Se parte sólo en profundidad 0,
// fuera de `(...)` y de `[...]`, que es lo que significa «una alternativa» aquí.
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
};
// DOS TRADUCCIONES, y las dos son el mismo hecho: la puerta es BASH+ERE y este test es JS.
//   1. El valor va en comillas simples de shell, y una comilla dentro se escribe `'"'"'`. Un
//      `/'([^']+)'/` se para en la primera y devolvía SIETE alternativas de ocho: la lista
//      truncada no se distingue de una lista corta.
//   2. `[[:space:]]` es una clase POSIX que `grep -E` entiende y `new RegExp` NO: compilarla tal
//      cual lanza «Unterminated character class». Traducirla no es cosmética -- sin esto el test
//      no puede EJECUTAR el patrón de la puerta, que es lo único que prueba algo.
const valorSecPat = (l) => {
  const m = /SEC_PAT='(.*)'\s*$/.exec(l) ?? /'(.*)'/.exec(l);
  return (m?.[1] ?? '').replace(/'"'"'/g, "'");
};
const aRegExpJs = (p) => new RegExp(p
  .replace(/\[:space:\]/g, '\\s').replace(/\[:alnum:\]/g, 'A-Za-z0-9')
  .replace(/\[:alpha:\]/g, 'A-Za-z').replace(/\[:digit:\]/g, '0-9'));
const ALTERNATIVAS = partirAlternativas(valorSecPat(LINEA_PUERTA ?? ''));
const AWS = /AKIA[0-9A-Z]{16}/;

test('la puerta se lee, no se copia: ocho alternativas', () => {
  assert.ok(LINEA_PUERTA, 'no encuentro la comprobación de secretos en la puerta');
  // 6 -> 8 al fusionar el tronco el 2026-09-07: entran el literal a PASSWORD/SECRET/TOKEN y la
  // credencial de un realm export. La cifra es un TRINQUETE de cobertura, no una descripción: si
  // sube, hay que añadir su generador abajo; si baja, alguien quitó un patrón de la puerta.
  assert.equal(ALTERNATIVAS.length, 8, `la puerta busca ${ALTERNATIVAS.length} formas: revisa la cobertura`);
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
  for (const alt of ALTERNATIVAS) {
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
    assert.ok(ALTERNATIVAS.some((a) => aRegExpJs(a).test(v)),
      `'${tipo}' genera algo que la puerta no cazaría: la semilla no probaría nada`);
  }
});

test('determinista: dos corridas de la misma vuelta dan la misma cadena', () => {
  // Sin esto, una diferencia entre dos trazas podría explicarse por azar, y una
  // vuelta deja de ser comparable consigo misma.
  assert.equal(credencialSintetica('aws', 'x'), credencialSintetica('aws', 'x'));
  assert.notEqual(credencialSintetica('aws', 'x'), credencialSintetica('aws', 'y'));
});

test('un tipo desconocido se DICE, no se inventa', () => {
  assert.equal(credencialSintetica('no-existe'), null);
  assert.throws(() => contenidoDeSemilla({ path: 'a.ts', generate: 'no-existe' }), /desconocido/);
});

test('`content` y `generate` a la vez es un ERROR, no una precedencia silenciosa', () => {
  // Quien escribió la spec no sabía cuál quería. Elegir por él escondería la duda.
  assert.throws(() => contenidoDeSemilla({ path: 'a.ts', content: 'x', generate: 'aws' }),
    /declara 'content' Y 'generate'/);
  assert.throws(() => contenidoDeSemilla({ path: 'a.ts' }), /sin 'content' ni 'generate'/);
});

test('`content` literal sigue funcionando: la semilla de XSS no se toca', () => {
  assert.equal(contenidoDeSemilla({ path: 'a.tsx', content: '<div dangerouslySetInnerHTML={{__html: x}} />' }),
    '<div dangerouslySetInnerHTML={{__html: x}} />');
});

test('el generador NO deja una credencial completa en lo versionado', () => {
  // La propiedad que hace que esto se pueda commitear: el módulo lleva el
  // PREFIJO y un generador, nunca una cadena que cumpla el patrón entero. Si
  // alguien pega un ejemplo real en un comentario, este test cae.
  const src = readFileSync(new URL('./credenciales-sinteticas.mjs', import.meta.url), 'utf8');
  for (const alt of ALTERNATIVAS) {
    assert.doesNotMatch(src, aRegExpJs(alt),
      `el módulo casa con /${alt}/: el pre-commit lo bloqueará y la puerta cazará al generador en vez de a lo sembrado`);
  }
  // Y el test tampoco, que también se versiona.
  const test = readFileSync(new URL('./credenciales-sinteticas.test.mjs', import.meta.url), 'utf8');
  for (const alt of ALTERNATIVAS) assert.doesNotMatch(test, aRegExpJs(alt));
});


// ── `plantilla`: lo que hace que la semilla sea CODIGO VIVO ──────────────────
//
// Sin plantilla, la semilla generada es un fichero con una sola línea suelta —
// y eso ya tumbó las tres primeras versiones de H-002: una extracción que es
// primer paso es código muerto, y el revisor bloquea, con razón. La plantilla
// es lo que permite sembrar la credencial DENTRO de un fichero que la app usa.

test('la plantilla pone la credencial dentro del código, y el código sobrevive', () => {
  const out = contenidoDeSemilla(
    { path: 'x.ts', generate: 'aws', plantilla: 'export const S3 = { key: "{{CREDENCIAL}}" };\n' },
    { sal: 'h-007' },
  );
  assert.match(out, AWS, 'la credencial no entró: la puerta no tendría qué cazar');
  assert.ok(out.startsWith('export const S3 = {'), 'la plantilla se perdió: quedaría un fichero suelto, o sea código muerto');
});

test('una plantilla SIN hueco falla, en vez de sembrar un fichero limpio', () => {
  // El fallo silencioso: `replace` sobre una plantilla sin `{}` devuelve la
  // plantilla tal cual. La vuelta correría entera, la puerta no mordería y el
  // artefacto diría `detectada: false` — que es lo que diría una puerta ROTA.
  assert.throws(
    () => contenidoDeSemilla({ path: 'x.ts', generate: 'aws', plantilla: 'const A = 1;\n' }),
    /no tiene \{\{CREDENCIAL\}\}/,
  );
});

test('con dos huecos no queda un `{}` literal dentro del fichero sembrado', () => {
  const out = contenidoDeSemilla(
    { path: 'x.ts', generate: 'aws', plantilla: 'const A = "{{CREDENCIAL}}";\nconst B = "{{CREDENCIAL}}";\n' },
    { sal: 'h-007' },
  );
  assert.doesNotMatch(out, /\{\}/, 'quedó un hueco sin rellenar: el fichero sembrado no compila');
});

test('el código real con `{}` sobrevive intacto: por eso el hueco no es `{}`', () => {
  // MEDIDO: 110 ficheros del FE contienen `{}` — `catch {}`, `=> {}`, tipos
  // vacíos. Con `{}` de marcador, sembrar cualquiera de ellos metía la
  // credencial en cada llave vacía del fichero. Y `replaceAll` lo empeoraba.
  const vivo = 'try { f(); } catch {}\nconst noop = () => {};\nconst K = "{{CREDENCIAL}}";\n';
  const out = contenidoDeSemilla({ path: 'x.ts', generate: 'aws', plantilla: vivo }, { sal: 'h-007' });
  assert.ok(out.includes('catch {}'), 'la credencial entró en un `catch {}`: el fichero sembrado no compila');
  assert.ok(out.includes('=> {}'), 'la credencial entró en un `=> {}`');
  assert.match(out, AWS);
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
  const ci = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const rutas = ci.split('\n').filter((l) => /^\s*path:/.test(l) && l.includes('.harness'));
  assert.ok(rutas.length > 0, 'CI ya no sube evidencia: la regla #0 no deja rastro fuera de la máquina');
  for (const r of rutas) {
    assert.match(r.trim(), /^path:\s*\.harness\/evidence\/?$/,
      `CI sube «${r.trim()}»: si eso incluye runs/ o workspaces/, publica el fichero sembrado con la credencial dentro`);
  }
});
