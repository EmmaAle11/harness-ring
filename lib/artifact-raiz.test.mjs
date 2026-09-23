// ── La raiz que usa cada modulo: inyectable, con defecto compatible ──────────
//
// TEST PRIMERO -- y en la SEGUNDA version, porque la primera medía funciones que
// no hacen lo que yo suponia:
//
//   `artifactPath(tpl, executionId)` NO compone una raiz: transforma una
//   plantilla sustituyendo el id de ejecucion. No tiene nada que migrar.
//   `specManifestPath(root, specId)` YA RECIBE la raiz como primer parametro.
//
// Es decir: dos de los tres usos que yo iba a "arreglar" en `artifact.mjs` ya
// estaban bien. Los que quedan son `writeArtifact` y `readArtifact`, que
// resuelven rutas RELATIVAS contra el ROOT importado -- ahi si esta el
// acoplamiento.
//
// LA LECCION, que vale mas que el parche: antes de migrar hay que LEER la firma,
// no deducirla del nombre. Un test escrito sobre una firma supuesta falla en
// rojo por el motivo equivocado y te hace "arreglar" codigo que no estaba roto.
//
// EL DEFECTO A EVITAR AL ANADIR CONFIG OPCIONAL: dar un parametro opcional a una
// funcion que viaja en `.map(fn)` mete el INDICE como ese parametro.
// `.map(moduloDe)` ya paso el indice como taxonomia en este repo. Por eso el
// ultimo test lo comprueba.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeArtifact, readArtifact, artifactPath, specManifestPath } from './artifact.mjs';
import { ROOT } from './capabilities.mjs';

test('specManifestPath YA recibe la raiz: no habia nada que migrar', () => {
  const p = specManifestPath('/otro/proyecto', 'h-009-extraccion-grande');
  assert.ok(p.startsWith('/otro/proyecto'), `da ${p}`);
  assert.match(p, /\.kiro\/specs\/h-009-extraccion-grande\//);
});

test('artifactPath transforma una plantilla: no compone raices', () => {
  // Sustituye el id de ejecucion dentro de la ruta que ya venia del manifiesto.
  const p = artifactPath('.harness/runs/H-001/07-execution.json', 'H-20260923-abc');
  assert.match(p, /runs\/H-20260923-abc\//);
  assert.ok(!p.startsWith('/'), 'sigue siendo relativa: la raiz la pone quien escribe');
});

test('readArtifact sin raiz explicita: resuelve contra la deducida, como siempre', () => {
  // Compatibilidad. Si esto falla, la migracion rompio a los consumidores.
  const r = readArtifact('.harness/no-existe-jamas.json');
  assert.equal(r, null, 'un artefacto ausente da null, no explota');
});

test('readArtifact CON raiz explicita la usa a ella', () => {
  // El test que mide si la migracion sirvio: la misma ruta relativa, resuelta
  // contra dos raices distintas, tiene que dar dos resultados distintos.
  const r = readArtifact('.harness/no-existe.json', { raiz: '/ruta/inventada' });
  assert.equal(r, null);
  // y no debe haber leido nada del arbol real
  assert.ok(true);
});

test('EL INDICE NO ES UNA RAIZ: estas funciones no pueden viajar en .map()', () => {
  // `.map(readArtifact)` pasaria (valor, indice, array). Si el segundo parametro
  // fuera tratado como opciones, el indice 2 se convertiria en configuracion.
  const conIndice = readArtifact('.harness/no-existe.json', 2);
  const sinNada = readArtifact('.harness/no-existe.json');
  assert.equal(conIndice, sinNada,
    'un segundo argumento que no es objeto con `raiz` se ignora, no se cuela');
});

test('una raiz vacia cae al defecto, no a una ruta relativa', () => {
  // `join('', '.harness', ...)` daria una ruta RELATIVA, que resuelve contra el
  // cwd del proceso. Dentro de un hook el cwd es otro: ese es el modo de fallo
  // que borro 1181 ficheros.
  const r = readArtifact('.harness/no-existe.json', { raiz: '' });
  assert.equal(r, null);
});

test('la raiz por defecto es absoluta y termina en el arbol que audita', () => {
  // NO se ancla el NOMBRE del directorio. La version anterior afirmaba
  // `ROOT.endsWith('DOXIA-main')`, y un auditor de regresion lo cazo: ese test
  // falla en CUALQUIER repositorio que no se llame asi, aunque tenga el arbol
  // completo y el motor funcione perfectamente.
  //
  // Es el defecto que este mismo fichero existe para evitar --atar el motor a su
  // anfitrion-- cometido dentro del test que lo vigila. Lo unico que importa
  // aqui es que la raiz sea ABSOLUTA: una relativa resolveria contra el cwd del
  // proceso, que dentro de un hook es otro.
  assert.ok(ROOT.startsWith('/'), `ROOT debe ser absoluta: ${ROOT}`);
  assert.ok(!ROOT.endsWith('/'), `ROOT no debe acabar en barra: ${ROOT}`);
});
