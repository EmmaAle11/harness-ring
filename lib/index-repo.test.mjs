// node --test harness/lib/index-repo.test.mjs
//
// C-1 · el que lee el 100 % es el harness. Lo que estos tests fijan no es que el
// indice sea bonito: es que RESPONDE DONDE sin que ningun modelo lea nada, y que
// NO se puede citar como evidencia (ADR-006).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync, renameSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import {
  VERSION, indexar, simbolosDe, importsDe, indexarFichero, guardar, leer,
  entradasDeLsFiles,
} from './index-repo.mjs';
import { RUNTIME, ROOT } from './capabilities.mjs';
import { ENV_LIMPIO } from './sandbox.mjs';

const FUENTE = [
  "import { a } from './a.mjs';",
  "export const TOPE = 45;",
  '',
  'export function suma(x, y) {',
  '  return x + y;',
  '}',
  '',
  'export class Servicio {',
  '  private cache = new Map();',
  '',
  '  async emitir(id) {',
  '    if (!id) return null;',
  '    return this.cache.get(id);',
  '  }',
  '',
  '  cerrar() {',
  '    this.cache.clear();',
  '  }',
  '}',
].join('\n');

test('un simbolo trae su RANGO, que es lo que permite leerlo sin leer el fichero', () => {
  const s = simbolosDe(FUENTE);
  const suma = s.find((x) => x.name === 'suma');
  assert.deepEqual({ from: suma.from, to: suma.to, kind: suma.kind }, { from: 4, to: 6, kind: 'function' });

  const tope = s.find((x) => x.name === 'TOPE');
  assert.equal(tope.from, tope.to, 'una constante de una linea empieza y acaba donde esta');
});

test('los METODOS de una clase son simbolos: sin ellos el indice no sirve para un god-service', () => {
  // MEDIDO: `aafa.service.ts` son 20.523 lineas y exporta DOS simbolos, uno de
  // ellos la clase entera de la linea 195 a la 20.522. Un indice que solo mira
  // los `export` responde «esta en el fichero», que es lo que ya sabiamos.
  const s = simbolosDe(FUENTE);
  const emitir = s.find((x) => x.name === 'emitir');
  assert.equal(emitir.kind, 'method');
  assert.equal(emitir.parent, 'Servicio');
  assert.deepEqual([emitir.from, emitir.to], [11, 14]);

  // `if (` tiene la misma forma que una firma y NO es un simbolo.
  assert.equal(s.some((x) => x.name === 'if'), false);
});

test('los imports salen sin abrir nada mas', () => {
  assert.deepEqual(importsDe(FUENTE), ['./a.mjs']);
});

test('lo que no es codigo se DECLARA, no se devuelve como "sin simbolos"', () => {
  // Una lista vacia se lee como «no exporta nada», que es una afirmacion. `null`
  // mas el motivo dice lo que de verdad pasa.
  const md = indexarFichero('DEPLOY.md', '# titulo\nexport const trampa = 1;');
  assert.equal(md.symbols, null);
  assert.match(md.why, /no es codigo/);
});


test('el refresco reutiliza lo que no cambio de sha', () => {
  const uno = indexar({ previo: null });
  const dos = indexar({ previo: uno });
  assert.equal(dos.stats.reread, 0, 'nada cambio: no se relee nada');
  assert.equal(dos.stats.reused, dos.stats.files);
});

test('la VERSION del indexador invalida la cache: un sha igual no prueba una lectura igual', () => {
  // Sin esto, mejorar el extractor no invalida nada -- los ficheros no cambiaron
  // y el indice sigue sirviendo lo que entendio la version anterior.
  const uno = indexar({ previo: null });
  const viejo = { ...uno, version: VERSION - 1 };
  assert.equal(indexar({ previo: viejo }).stats.reused, 0, 'otra version, se relee todo');
});


test('el indice DICE que no es evidencia: la regla viaja con el dato (ADR-006)', () => {
  // Graphify es evidencia derivada y no autoridad; el indice es lo mismo un nivel
  // mas abajo. Una regla que solo vive en un comentario no la lee nadie.
  const i = indexar({ previo: null });
  assert.match(i.nota, /NAVEGACION, NO EVIDENCIA/);
  assert.match(i.nota, /se apoya en nada/);
});

test('se guarda y se relee igual', () => {
  const f = join(RUNTIME, 'index', 'repo.test.json');
  const i = indexar({ previo: null });
  guardar(i, f);
  assert.ok(existsSync(f));
  assert.equal(leer(f).stats.files, i.stats.files);
  assert.equal(leer(join(ROOT, 'no-existe.json')), null, 'un indice ausente es null, no una excepcion');
});

test('lo NO exportado tambien se indexa: un modulo React lo esconde todo', () => {
  // MEDIDO: `src/app/archivero/ArchiveroModule.tsx` son 3.189 lineas y el indice
  // le encontraba DOS simbolos. En un modulo React los ayudantes son `const` de
  // primer nivel SIN `export` --44 de ellos-- porque solo el componente sale del
  // fichero. Un indice que solo mira los `export` responde «esta en el fichero»
  // justo en la clase de fichero que motiva todo esto.
  const s = simbolosDe([
    'const PRIVADA = 1;',
    'export const PUBLICA = 2;',
    'const ayudante = (x) => {',
    '  return x + 1;',
    '};',
    'function dentro() {',
    '  const NO_ES_DE_PRIMER_NIVEL = 3;',
    '  return NO_ES_DE_PRIMER_NIVEL;',
    '}',
  ].join('\n'));

  assert.deepEqual(s.map((x) => x.name), ['PRIVADA', 'PUBLICA', 'ayudante', 'dentro']);
  // `exported` viaja con el simbolo: no es lo mismo mover algo que el repo puede
  // importar que algo privado del modulo.
  assert.equal(s.find((x) => x.name === 'PUBLICA').exported, true);
  assert.equal(s.find((x) => x.name === 'PRIVADA').exported, undefined);
  // Y NO entra lo de dentro de una funcion: eso convertiria el mapa en ruido.
  assert.equal(s.some((x) => x.name === 'NO_ES_DE_PRIMER_NIVEL'), false);
});


// ── Los tres desenlaces se CUENTAN, ninguno se deriva por resta ──────────────
//
// `reused` era `total - reread`, asi que un fichero que no se pudo leer no era ni
// relectura ni reutilizacion y caia en `reused` por descarte: el indice afirmaba
// haber aprovechado una entrada que en realidad no habia podido comprobar.
//
// MEDIDO en H-20260820-79575b3b: tras mover 6 ficheros, `reused` valia 6 con el
// indexador releyendo el repositorio ENTERO por cambio de version. Los seis eran
// las rutas de origen -- `renameSync` no marca el borrado en el indice de git, asi
// que `ls-files` las sigue listando y el disco ya no las tiene.
test('un fichero que git indexa y el disco no tiene NO cuenta como reutilizado', () => {
  const raiz = join(RUNTIME, 'workspaces', 'test-index-fantasma');
  rmSync(raiz, { recursive: true, force: true });
  mkdirSync(raiz, { recursive: true });
  // `ENV_LIMPIO()` NO es decorativo. Sin el, este `git` hereda el entorno del
  // proceso, y dentro de un hook de git eso incluye GIT_DIR y GIT_INDEX_FILE: el
  // `init` reusa el git dir del repo PRINCIPAL, el `add -A` escribe en su indice
  // desde este directorio de fixture, y el `commit` aterriza en la rama de quien
  // esta commiteando.
  //
  // PASO DE VERDAD el 2026-08-23: `be2951bb "base"` sobre `feat/harness`, con
  // vivo.ts y fantasma.ts dentro y 1181 ficheros borrados. Empujado a origin.
  const g = (...a) => execFileSync('git', a, { cwd: raiz, env: ENV_LIMPIO(), stdio: 'pipe' });
  g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  writeFileSync(join(raiz, 'vivo.ts'), 'export const vivo = 1;\n');
  writeFileSync(join(raiz, 'fantasma.ts'), 'export const fantasma = 2;\n');
  g('add', '-A'); g('commit', '-qm', 'base');

  try {
    // La mudanza tal como la hace `move_file`: rename en disco, sin tocar el indice.
    renameSync(join(raiz, 'fantasma.ts'), join(raiz, 'movido.ts'));

    const i = indexar({ root: raiz, previo: null });
    assert.equal(i.stats.unreadable, 1, 'el origen ya no esta en disco');
    assert.equal(i.stats.reused, 0, 'nada se reutilizo: no habia indice previo');
    assert.equal(
      i.stats.reread + i.stats.reused + i.stats.unreadable, i.stats.files,
      'los tres desenlaces tienen que sumar el total: si no, uno se deriva por resta',
    );

    // Y el MOTIVO no miente. Los dos casos venian con «ilegible como utf8», que de
    // un fichero ausente dice algo falso sobre su codificacion.
    assert.match(i.files['fantasma.ts'].why, /el disco no lo tiene/);
  } finally {
    rmSync(raiz, { recursive: true, force: true });
  }
});

test('un arbol A MEDIO FUSIONAR se declara, no se indexa', () => {
  // `git ls-files -s` en un arbol sano da etapa 0. Durante un merge conflictivo da
  // la MISMA ruta en las etapas 1 (base), 2 (nuestro) y 3 (suyo), con tres shas.
  //
  // El parseo hacia `meta.split(' ')[1]` y tiraba la etapa: tres entradas para una
  // ruta, y el sha que le llegaba al consumidor era el ultimo -- el del OTRO lado
  // del conflicto. Un indice apuntando a codigo que no esta en el disco, en silencio.
  //
  // MEDIDO el 2026-08-24 fusionando el tronco en feat/harness: 6 rutas duplicadas
  // en el inventario del orquestador, que indexa el CLON PRINCIPAL y no el workspace.
  const sano = [
    '100644 aaaaaaa 0\tsrc/a.ts',
    '100755 bbbbbbb 0\tscripts/gate.sh',
  ].join('\n');
  assert.deepEqual(entradasDeLsFiles(sano), [
    { sha: 'aaaaaaa', path: 'src/a.ts' },
    { sha: 'bbbbbbb', path: 'scripts/gate.sh' },
  ]);

  const enMedio = [
    '100644 aaaaaaa 0\tsrc/a.ts',
    '100755 1111111 1\tscripts/gate.sh',
    '100755 2222222 2\tscripts/gate.sh',
    '100755 3333333 3\tscripts/gate.sh',
  ].join('\n');
  assert.throws(() => entradasDeLsFiles(enMedio), (e) => {
    // La ruta conflictiva SE NOMBRA: un error que no dice cual obliga a buscarla.
    assert.match(e.message, /A MEDIO FUSIONAR/);
    assert.match(e.message, /scripts\/gate\.sh/);
    assert.match(e.message, /1 ruta/, 'las tres etapas son UNA ruta, no tres');
    return true;
  });

  // Y no se filtran en silencio: hacerlas desaparecer es la otra forma de mentir.
  assert.equal(entradasDeLsFiles('').length, 0);
});
