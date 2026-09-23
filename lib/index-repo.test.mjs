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
  VERSION, indexar, simbolosDe, importsDe, indexarFichero, localizar, guardar, leer,
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

test('el indice REAL cubre el repositorio entero, incluidos los 19 que no caben en una lectura', () => {
  const i = indexar({ previo: null });
  assert.ok(i.stats.files > 900, `solo ${i.stats.files} ficheros`);

  const god = i.files['backend/src/aafa/aafa.service.ts'];
  assert.ok(god, 'el god-service tiene que estar: es el que motiva todo esto');
  assert.ok(god.bytes > 1_000_000);
  const metodos = god.symbols.filter((s) => s.kind === 'method');
  assert.ok(metodos.length > 100, `solo ${metodos.length} metodos localizables`);

  // Y el rango de cada uno cabe donde el fichero no cabe.
  const mediana = metodos.map((s) => s.to - s.from).sort((a, b) => a - b)[Math.floor(metodos.length / 2)];
  assert.ok(mediana < 200, `mediana de ${mediana} lineas por metodo`);
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

test('localizar responde DONDE, con el sha para poder comprobarlo', () => {
  const i = indexar({ previo: null });
  const sitios = localizar(i, 'presupuesto', { path: 'harness/lib/surface.mjs' });
  assert.equal(sitios.length, 1);
  assert.ok(sitios[0].sha && sitios[0].from > 0 && sitios[0].to > sitios[0].from);
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

test('el fichero que motiva C-1 pasa de 2 simbolos a decenas', () => {
  // POR IDENTIDAD, NO POR DIRECCION. Esto nombraba
  // `src/app/archivero/ArchiveroModule.tsx`, y H-005 mueve ese fichero a
  // `src/app/aafa/archivero/`: el test se volvia rehen de una ruta que la propia
  // vuelta existe para retirar, y tumbaba `gate --full` dentro del workspace con
  // la mudanza ya hecha y correcta (H-20260820-79575b3b).
  //
  // El sujeto de este test es EL FICHERO -- 3000+ lineas, 200+ KB, decenas de
  // simbolos y solo dos exportados--, no su direccion. Buscarlo por lo que es
  // pasa en el arbol de antes y en el de despues, que es lo que debe hacer un
  // test durante una mudanza.
  const i = indexar({ previo: null });
  const [ruta, g] = Object.entries(i.files)
    .find(([k]) => k.endsWith('/archivero/ArchiveroModule.tsx')
      && i.files[k].bytes > 200_000) ?? [];
  assert.ok(g, `el modulo del archivero tiene que estar indexado; rutas vistas: ${
    Object.keys(i.files).filter((k) => k.includes('archivero')).join(', ')}`);
  assert.ok(ruta.startsWith('src/app/'), `ruta inesperada: ${ruta}`);
  assert.ok(g.lines > 3000 && g.bytes > 200_000, 'es el fichero grande, no otro');
  assert.ok(g.symbols.length > 30, `solo ${g.symbols.length} simbolos navegables`);

  // LA DESPROPORCION, NO EL NUMERO.
  //
  // Esto fijaba el literal: `equal(exportados, 2)`. Y el 2 es incidental al
  // proposito -- el sujeto, que lo dice el comentario de arriba, es «decenas de
  // simbolos y un punado exportados», o sea la desproporcion que motiva C-1. Un
  // fichero de 3000 lineas que exporta 3 es EXACTAMENTE el mismo caso.
  //
  // MEDIDO el 2026-08-21: la sesion de AAFA exporto `ModalCambioPatente` para
  // poder testearlo, y este test se puso rojo. Es decir, **castigo una mejora**:
  // sacar un simbolo a la superficie para cubrirlo con un test es justo lo que
  // este repositorio pide, y la puerta lo bloqueaba. Un test que se pone rojo
  // cuando alguien hace lo correcto no protege una regla: protege un numero.
  //
  // La forma nueva sobrevive a que se exporte lo que haga falta para probar, y
  // sigue cayendo si el fichero deja de ser lo que este caso describe -- si su
  // superficie publica crece hasta parecerse a un barril de exports, la
  // desproporcion desaparece y con ella el motivo de C-1.
  const exportados = g.symbols.filter((s) => s.exported).length;
  assert.ok(
    exportados <= 5 && exportados * 6 <= g.symbols.length,
    `la desproporcion que motiva C-1 desaparecio: ${exportados} exportados de `
    + `${g.symbols.length} simbolos. El indice existe porque este fichero esconde `
    + `decenas de simbolos detras de una superficie minima`,
  );
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
