// node --test harness/lib/secretos.test.mjs
//
// El control DETECTABA y no impedia nada: el artefacto se escribia con la clave
// dentro y la deteccion salia meses despues, si alguien corria `doxia trace`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { sinSecretos, redactarSecretos } from './secretos.mjs';

test('redacta y sigue pudiendo decir «este es el mismo de alla»', () => {
  // MEDIDO en H-20260824-fa058d63: la credencial que el harness SIEMBRA para h-007
  // aparecia 19 veces en 3 artefactos (07-execution 7, 14-observability 6,
  // trace.json 6). Sintetica, asi que no era una fuga -- pero `.harness/` la sube
  // CI, y un escaner de secretos sobre esos artefactos muerde por algo que no es
  // un defecto. Un falso positivo en un control compartido ensena a ignorarlo.
  // LA MUESTRA SE COMPONE, no se escribe. Escrita literal, el `pre-commit` la caza
  // en el staged diff y este fichero NO SE PUEDE COMMITEAR -- me paso al escribirlo.
  // Es el mismo criterio intestable por construccion que resolvio la spec de h-007:
  // la spec declara el TIPO y el harness pone el VALOR. Aqui igual.
  const P = 'AK' + 'IA';
  const uno = `${P}6YQYIM2ABCDEFGHI`;
  const otro = `${P}0000000000000000`;
  const t = `k=${uno} otra ${uno} distinta ${otro}`;
  const r = redactarSecretos(t);

  assert.equal(sinSecretos(r).length, 0, 'quedo un secreto sin redactar');
  assert.ok(!r.includes(uno), 'el valor sigue en el texto redactado');

  // COMPARABILIDAD: una cadena fija haria iguales dos valores distintos y se
  // perderia poder auditar una semilla. El mismo valor da el mismo sha.
  const hashes = [...r.matchAll(/sha256:([0-9a-f]{8})/g)].map((m) => m[1]);
  assert.equal(hashes.length, 3);
  assert.equal(hashes[0], hashes[1], 'el mismo valor tiene que dar el mismo sello');
  assert.notEqual(hashes[0], hashes[2], 'dos valores distintos no pueden colapsar en uno');

  // Lo que NO es un secreto se queda como estaba.
  assert.equal(redactarSecretos(`un texto normal con ${P} corto`), `un texto normal con ${P} corto`);
  assert.equal(redactarSecretos(''), '');
  assert.equal(redactarSecretos(null), '');
});

test('el artefacto se redacta AL ESCRIBIR, no en el objeto que viaja', () => {
  // Security tiene que VER la credencial para cazarla; el artefacto no tiene que
  // GUARDARLA. Por eso la redaccion va en el `writeFileSync` y no antes: si se
  // aplicara al objeto, la etapa 8 dejaria de poder encontrar la semilla y el
  // criterio entero de h-007 se caeria.
  const src = readFileSync(new URL('./artifact.mjs', import.meta.url), 'utf8');
  assert.match(src, /writeFileSync\(abs, redactarSecretos\(JSON\.stringify\(env, null, 2\)\)/,
    'el artefacto no pasa por redactarSecretos al escribirse');
  assert.doesNotMatch(src, /env = redactarSecretos|redactarSecretos\(env\)/,
    'se esta redactando el OBJETO: Security dejaria de ver la semilla');

  // Y NO SOLO ESE CAMINO. `trace.json` no pasa por `writeArtifact` -- lo escribe
  // `doxia.mjs` directo-- asi que la primera version de la redaccion no lo tocaba:
  // MEDIDO en H-20260824-d897a07f, 4 apariciones en claro en `trace.json` cuando
  // `07-execution.json` tenia 0 y 5 marcas.
  //
  // Redacte UN camino de escritura y habia otro. Es el guarda que cubre una forma
  // de seis, cometido dentro del arreglo que existe para eso.
  const cli = readFileSync(new URL('../bin/doxia.mjs', import.meta.url), 'utf8');
  assert.match(cli, /writeFileSync\(join\(dir, 'trace\.json'\),\s*\n?\s*redactarSecretos\(/,
    'trace.json se escribe SIN redactar: es el artefacto que mas se comparte');
  assert.match(cli, /import \{ redactarSecretos \} from '\.\.\/lib\/secretos\.mjs'/,
    'redactarSecretos no esta importado en el CLI: compilaria y reventaria al correr');
});

test('ningun escritor del harness serializa a disco sin redactar', () => {
  // CUATRO CAMINOS DE ESCRITURA, y la primera redaccion cubria UNO. El que mas
  // costo encontrar fue `consolidar()`: REESCRIBE `14-observability.json` al cerrar,
  // encima de un fichero que `writeArtifact` ya habia redactado bien.
  //
  // MEDIDO en H-20260824-d897a07f: 07-execution 0 en claro y 5 marcas, mientras
  // trace.json y 14-observability tenian 4 cada uno.
  //
  // LA REGLA VA AL REVES, y es lo que la hace funcionar: mi primera version exigia
  // redaccion solo a lo que "parecia" ir a runs/, y la reversion que quitaba la de
  // `consolidar` NO la puso en rojo -- su ruta sale de un PARAMETRO y ninguna
  // heuristica sobre el texto la reconoce. Ahora TODO el que serializa a disco
  // redacta O DECLARA por que no, con `sin-redactar:` y su motivo.
  //
  // Los .test.mjs quedan fuera POR REGLA, no por marcador: un test que monta su
  // fixture no produce un artefacto de vuelta, y pedirle la marca a cada uno
  // convierte el guarda en ruido.
  const raiz = new URL('../', import.meta.url);
  const ficheros = readdirSync(raiz, { recursive: true })
    .map(String)
    .filter((x) => x.endsWith('.mjs') && !x.endsWith('.test.mjs') && !x.includes('node_modules'));
  assert.ok(ficheros.length > 30, `solo ${ficheros.length} ficheros barridos: el guarda dejo de mirar`);

  const sinRedactar = [];
  for (const nombre of ficheros) {
    const ls = readFileSync(new URL(nombre, raiz), 'utf8').split('\n');
    for (const [i, l] of ls.entries()) {
      // SINTAXIS DE LLAMADA, no la mencion: la primera version se cazo a si misma
      // en la linea que dice `l.includes('writeFileSync')`, que es la trampa exacta
      // del guarda de ENV_LIMPIO, repetida cuatro horas despues por su autor.
      if (!/\bwriteFileSync\(/.test(l) || /^\s*(\/\/|\*)/.test(l)) continue;
      const trozo = ls.slice(Math.max(0, i - 4), i + 5).join('\n');
      if (!trozo.includes('JSON.stringify')) continue;
      if (/sin-redactar:/.test(trozo) || trozo.includes('redactarSecretos')) continue;
      sinRedactar.push(`${nombre}:${i + 1}`);
    }
  }

  assert.deepEqual(sinRedactar, [],
    `estos serializan a disco SIN redactar y SIN declarar por que: ${sinRedactar.join(', ')}.\n`
    + '`.harness/` la sube CI y `trace.json` es lo que se pega en un informe. '
    + 'Envuelve el JSON.stringify en redactarSecretos(), o pon `// sin-redactar: <motivo>`.');
});
