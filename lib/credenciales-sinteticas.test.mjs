import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TIPOS, credencialSintetica, contenidoDeSemilla } from './credenciales-sinteticas.mjs';

const AWS = /AKIA[0-9A-Z]{16}/;

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
