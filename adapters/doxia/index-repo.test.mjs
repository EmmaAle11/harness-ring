import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { indexar, localizar } from '../../lib/index-repo.mjs';
import { ROOT } from '../../lib/capabilities.mjs';

// El indice REAL se mide contra el arbol del anfitrion (miles de ficheros, el god-service
// de backend, el ArchiveroModule). Un motor portable no trae ese arbol, asi que estos
// casos viven en el adaptador DoxIA.

test('el indice REAL cubre el repositorio entero, incluidos los 19 que no caben en una lectura', (t) => {
  if (!existsSync(join(ROOT, 'scripts', 'gate.sh'))) { t.skip('sin scripts/gate.sh: este arbol no es el anfitrion DoxIA'); return; }
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
test('localizar responde DONDE, con el sha para poder comprobarlo', (t) => {
  if (!existsSync(join(ROOT, 'scripts', 'gate.sh'))) { t.skip('sin scripts/gate.sh: este arbol no es el anfitrion DoxIA'); return; }
  const i = indexar({ previo: null });
  const sitios = localizar(i, 'presupuesto', { path: 'harness/lib/surface.mjs' });
  assert.equal(sitios.length, 1);
  assert.ok(sitios[0].sha && sitios[0].from > 0 && sitios[0].to > sitios[0].from);
});
test('el fichero que motiva C-1 pasa de 2 simbolos a decenas', (t) => {
  if (!existsSync(join(ROOT, 'scripts', 'gate.sh'))) { t.skip('sin scripts/gate.sh: este arbol no es el anfitrion DoxIA'); return; }
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
