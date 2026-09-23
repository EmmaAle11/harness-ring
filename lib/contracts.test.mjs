import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadCapabilities } from './capabilities.mjs';

const C = JSON.parse(readFileSync(new URL('../contracts/contracts.json', import.meta.url), 'utf8'));

const caps = loadCapabilities();

const byId = Object.fromEntries(caps.map((c) => [c.id, c]));

test('el anillo empieza y termina en Knowledge', () => {
  assert.equal(C.model.length, 17, '16 etapas + el Knowledge de cierre');
  assert.equal(C.model[0], 'Knowledge');
  assert.equal(C.model.at(-1), 'Knowledge', 'cierra donde empezo: es un anillo, no una tuberia');
  assert.equal(
    C.model.filter((s) => s.startsWith('Evidence')).length, 2,
    'se produce evidencia dos veces: antes de decidir y al cerrar',
  );
});

test('Compute y Sandbox van ANTES de Execution', () => {
  const i = (s) => C.model.indexOf(s);
  assert.ok(i('Compute') < i('Execution'), 'se decide QUIEN antes de ejecutar');
  assert.ok(i('Sandbox') < i('Execution'), 'se decide DONDE antes de ejecutar');
  assert.ok(i('Plan') < i('Compute'), 'no se asigna ejecutor sin plan');
});

test('Security va ANTES de Validation y de Convergence', () => {
  const i = (s) => C.model.indexOf(s);
  assert.ok(i('Execution') < i('Security'), 'no hay nada que escanear antes de ejecutar');
  assert.ok(
    i('Security') < i('Validation'),
    'lo que decide una funcion determinista se decide ANTES de gastar cuatro invocaciones de modelo',
  );
  assert.ok(
    i('Security') < i('Convergence'),
    'detras de Convergence, el revisor le gana la mano y Security nunca llega a bloquear',
  );
});

test('Security no consume Verdict: lo produce Convergence, que ahora va detras', () => {
  // La spec lo declaraba y el handler nunca lo uso -- escaneaba el ChangeSet. Un
  // contrato que pide una entrada inexistente es una segunda autoridad sobre lo
  // que la etapa necesita, y al reordenar habria quedado apuntando hacia delante.
  const sec = C.stages.find((s) => s.stage === 'Security');
  assert.deepEqual(sec.consume, ['ChangeSet']);
});

test('Compute y Sandbox son deterministas: no los decide un modelo', () => {
  for (const s of ['Compute', 'Sandbox']) {
    assert.equal(C.stages.find((x) => x.stage === s).capability, null);
  }
});

test('toda etapa nombra una capacidad que existe (o ninguna, a proposito)', () => {
  for (const s of C.stages) {
    if (s.capability === null) {
      assert.ok(
        ['Compute', 'Sandbox', 'Convergence', 'Observability', 'CapabilityLayer', 'AdapterLayer'].includes(s.stage),
        `etapa '${s.stage}' sin capacidad: ¿es realmente determinista?`,
      );
      continue;
    }
    assert.ok(byId[s.capability], `etapa '${s.stage}' nombra capacidad inexistente '${s.capability}'`);
  }
});

test('toda etapa consume y produce contratos declarados', () => {
  const conocidos = new Set(Object.keys(C.contracts));
  for (const s of C.stages) {
    for (const c of s.consume) {
      assert.ok(conocidos.has(c), `etapa '${s.stage}' consume contrato desconocido '${c}'`);
    }
    assert.ok(conocidos.has(s.produce), `etapa '${s.stage}' produce contrato desconocido '${s.produce}'`);
  }
});

test('cada capacidad declara sus contratos: sin eso no se puede colocar en el ciclo', () => {
  const conocidos = new Set(Object.keys(C.contracts));
  for (const c of caps) {
    assert.ok(c.allowedStages?.length, `'${c.id}': sin 'allowedStages'`);
    assert.ok(c.inputs?.length, `'${c.id}': sin 'inputs'`);
    assert.ok(c.outputs?.length, `'${c.id}': sin 'outputs'`);
    for (const x of [...c.inputs, ...c.outputs]) {
      assert.ok(conocidos.has(x), `'${c.id}': contrato desconocido '${x}'`);
    }
  }
});

test('la capacidad de una etapa produce lo que la etapa dice producir', () => {
  for (const s of C.stages.filter((s) => s.capability)) {
    const cap = byId[s.capability];
    assert.ok(
      cap.outputs.includes(s.produce),
      `etapa '${s.stage}' produce '${s.produce}' pero la capacidad '${cap.id}' no lo declara`,
    );
  }
});

test('la cadena encaja: lo que produce una etapa lo consume la siguiente', () => {
  const producidos = new Set(['RepoRef', 'PlanRef']); // entradas externas del ciclo
  for (const s of C.stages) {
    for (const c of s.consume) {
      assert.ok(
        producidos.has(c),
        `etapa '${s.stage}' consume '${c}', que ninguna etapa anterior produce`,
      );
    }
    producidos.add(s.produce);
  }
  assert.ok(producidos.has('EvidencePackage'), 'el ciclo debe producir evidencia');
  assert.ok(producidos.has('LearningRecord'), 'y terminar en Learning, que es lo que cierra el anillo');
});

test('EvidencePackage es el contrato obligatorio (regla #0)', () => {
  const ev = C.contracts.EvidencePackage;
  for (const campo of ['sha', 'checks', 'verdict']) {
    assert.ok(ev.required.includes(campo), `EvidencePackage debe exigir '${campo}'`);
  }
});

test('Finding se identifica por (file, symbol, claim) y NUNCA por linea', () => {
  const f = C.contracts.Finding;
  for (const campo of ['file', 'symbol', 'claim', 'evidence']) {
    assert.ok(f.required.includes(campo), `Finding debe exigir '${campo}'`);
  }
  assert.ok(!f.required.includes('line'), 'la linea se mueve: no puede ser parte de la identidad');
});

test('un campo NUEVO del ChangeSet no llega al revisor por su cuenta', async () => {
  const { paraRevisar } = await import('./stages-model.mjs');
  const art = {
    stage: 'Execution',
    payload: {
      files: ['src/a.ts'], diff: '+una', summary: 'ok',
      changeSurface: { checks: [1, 2, 3], budget: { maxLines: 180 } },
      usage: { totalTokens: 999 },
      iterations: 19,
      inventadoManana: 'lo que se anada el mes que viene',
      toolCalls: [{ tool: 'read_file' }],
      mutations: [{ op: 'create_file', path: 'src/a.ts', before: null, after: 'ab', changed: true, ruido: 'x' }],
    },
  };
  const visto = paraRevisar(art).payload;

  assert.deepEqual(Object.keys(visto).sort(), ['diff', 'files', 'mutations', 'summary', 'toolCallCount']);
  assert.equal(visto.changeSurface, undefined, 'el analisis de presupuesto no es material de revision');
  assert.equal(visto.inventadoManana, undefined, 'lo que se anada manana tampoco entra solo');
  assert.equal(visto.toolCallCount, 1, 'la bitacora se cuenta, no se manda');
  assert.equal(visto.mutations[0].ruido, undefined, 'de cada mutacion, solo lo revisable');
});

test('el careo entre la bitacora y git SI llega al revisor', async () => {
  const { paraRevisar } = await import('./stages-model.mjs');
  const visto = paraRevisar({
    stage: 'Execution',
    payload: {
      files: ['src/a.spec.ts'], diff: '+una', summary: 'ok',
      mutations: [{ op: 'apply_patch', path: 'src/a.ts', before: 'aa', after: 'bb', changed: true }],
      careo: { coinciden: false, soloBitacora: [{ path: 'src/a.ts', after: 'bb' }], soloGit: [] },
    },
  }).payload;

  assert.equal(visto.careo.coinciden, false);
  assert.deepEqual(visto.careo.soloBitacora, [{ path: 'src/a.ts', after: 'bb' }],
    'el revisor tiene que poder ver CUAL discrepa, no solo que algo discrepa');
});

test('la INTENCION que ve el revisor es objetivo y aceptacion, no el WorkPackage entero', async () => {
  const { paraIntencion } = await import('./stages-model.mjs');
  const visto = paraIntencion({
    payload: { id: 'WP-1', goal: 'g', acceptance: ['a'], files: ['x.ts'], changeSurface: { budget: {} } },
  }).payload;
  assert.deepEqual(Object.keys(visto).sort(), ['acceptance', 'files', 'goal']);
});

test('el reintento por truncado lleva un NUMERO, no un ruego', async () => {
  const { avisoDeReintento } = await import('./invoke.mjs');

  const conNumero = avisoDeReintento({
    ultimo: 'respuesta truncada por max_tokens', truncado: true,
    reduccion: 'Responde con MAXIMO 3 hallazgos, los mas graves primero.',
  });
  assert.match(conNumero, /MAXIMO 3 hallazgos/, 'el reintento pide una cantidad concreta');
  assert.ok(!/MUCHO mas corto/.test(conNumero), 'y deja de limitarse a rogar');
  assert.match(conNumero, /sin espacio de salida/);

  // Sin `reduccion` no se INVENTA una: el aviso generico es lo unico honesto que
  // se puede decir sin conocer el contrato del llamante.
  assert.match(avisoDeReintento({ ultimo: 'x', truncado: true }), /MUCHO mas corto/);

  // Y un fallo que NO es de truncado no arrastra el discurso del techo de salida.
  const otro = avisoDeReintento({ ultimo: 'no devolvio JSON reconocible' });
  assert.ok(!/espacio de salida/.test(otro));
  assert.match(otro, /Devuelve SOLO el JSON/);
});

function entradasDeclaradas() {
  const src = readFileSync(new URL('./stages-model.mjs', import.meta.url), 'utf8');
  const claves = new Set();
  for (const m of src.matchAll(/inputs:\s*\{/g)) {
    // Escaneo con balance de llaves: un regex no cierra un objeto anidado.
    let i = m.index + m[0].length - 1, prof = 0, fin = i;
    for (; i < src.length; i++) {
      if (src[i] === '{') prof++;
      else if (src[i] === '}' && --prof === 0) { fin = i; break; }
    }
    const cuerpo = src.slice(m.index + m[0].length, fin);
    // Solo las claves de PRIMER nivel: las de dentro son datos, no entradas.
    let p = 0;
    for (const linea of cuerpo.split('\n')) {
      const k = p === 0 ? /^\s*(\w+):/.exec(linea) : null;
      if (k) claves.add(k[1]);
      for (const ch of linea) { if (ch === '{' || ch === '[') p++; else if (ch === '}' || ch === ']') p--; }
    }
  }
  return claves;
}

test('NINGUNA entrada llega a un modelo sin proyeccion declarada', async () => {
  const { PROYECCIONES, contextoDeRevision } = await import('./stages-model.mjs');

  // Las literales del fuente...
  const claves = entradasDeclaradas();
  assert.ok(claves.size >= 8, `se esperaban las entradas de las nueve llamadas, hay ${claves.size}`);

  // ...mas las que entran por spread, que el fuente no puede ver.
  for (const k of Object.keys(contextoDeRevision({
    artifacts: { Security: { payload: { blocked: [{ severity: 'P1', rule: 'r', path: 'p' }] } } },
    lifecycle: [{ status: 'CARRIED', file: 'a.ts', claim: 'x' }],
  }))) claves.add(k);

  const sin = [...claves].filter((k) => !PROYECCIONES[k]);
  assert.deepEqual(sin, [], `entradas sin proyeccion declarada: ${sin.join(', ')}`);
});

test('una entrada NO declarada lanza, no viaja entera', async () => {
  const { proyectar } = await import('./stages-model.mjs');
  // Falla en CERRADO. Con una lista negra, el campo nuevo habria viajado gratis:
  // eso es exactamente lo que paso con `changeSurface`.
  assert.throws(() => proyectar('ArtefactoNuevo', { payload: { secreto: 1 } }), /sin proyeccion declarada/);
});

test('un campo nuevo en un artefacto YA declarado tampoco se cuela', async () => {
  const { PROYECCIONES, proyectar } = await import('./stages-model.mjs');
  const listas = Object.entries(PROYECCIONES).filter(([, v]) => Array.isArray(v));
  assert.ok(listas.length >= 6);

  for (const [nombre, campos] of listas) {
    const payload = Object.fromEntries([...campos.map((c) => [c, 'ok']), ['campoNuevoDeLaFase12', 'NO DEBE VIAJAR']]);
    const visto = proyectar(nombre, { stage: 'X', payload }).payload;
    assert.ok(!('campoNuevoDeLaFase12' in visto), `${nombre} deja pasar un campo no declarado`);
    assert.deepEqual(Object.keys(visto).sort(), [...campos].sort(), `${nombre} no proyecta lo que declara`);
  }
});

test('el baseline llega al modelo SIN el grafo: ADR-006 no es una nota al pie', async () => {
  const { proyectar } = await import('./stages-model.mjs');
  const visto = proyectar('ArchitectureBaseline', {
    payload: { scope: 's', facts: [], unknowns: [], graph: { nodes: 1e6 }, hotspots: ['x'] },
  }).payload;
  // Graphify es evidencia DERIVADA y no autoridad. Un hallazgo que se apoya en
  // el grafo se apoya en nada, asi que el grafo no viaja hacia quien razona.
  assert.ok(!('graph' in visto) && !('hotspots' in visto));
});

test('ninguna etapa proyecta a mano: la puerta es `pedir`', () => {
  const src = readFileSync(new URL('./stages-model.mjs', import.meta.url), 'utf8');
  // Una segunda proyeccion en el sitio de llamada seria la segunda autoridad de
  // siempre, y la que se olvida al anadir la entrada trece.
  assert.doesNotMatch(src, /inputs:[\s\S]{0,400}?para(Revisar|Intencion)\(/);
  assert.match(src, /inputs: proyectados/, '`pedir` debe mandar lo proyectado, no lo recibido');
});

test('la etapa que NO pasa por `pedir` tampoco escapa a la proyeccion', async () => {
  // Adversarial llama a `invokeCapability` directamente -- necesita N pasadas en
  // paralelo con su propio conteo-- y se saltaba la unica puerta que aplicaba las
  // listas blancas. Una frontera con dos puertas y una sola cerradura no es una
  // frontera; el test que solo miraba `pedir` la daba por cerrada.
  const { entradaAdversarial } = await import('./stages-model.mjs');
  const { inputs } = entradaAdversarial({
    artifacts: {
      Validation: { payload: { findings: [{ file: 'a.ts', claim: 'x' }], counts: { confirmed: 3 }, unreviewed: 2, passes: 3 } },
      Execution: { payload: { files: ['a.ts'], diff: 'd', contents: { 'a.ts': 'TODO EL FICHERO' }, toolCalls: [1, 2, 3] } },
    },
  });

  // El MARCADOR de la ronda no viaja: una pasada que sabe cuantos ya cayeron no
  // es independiente.
  assert.deepEqual(Object.keys(inputs.FindingSet.payload), ['findings']);
  // Ni el fichero entero ni la bitacora.
  assert.ok(!('contents' in inputs.ChangeSet.payload));
  assert.equal(inputs.ChangeSet.payload.toolCallCount, 3);
});

test('SOLO hay dos puertas hacia un modelo, y las dos proyectan', () => {
  // Si aparece una tercera llamada a `invokeCapability`, este test cae: es la
  // unica forma de que anadir una etapa no reabra el agujero en silencio.
  const src = readFileSync(new URL('./stages-model.mjs', import.meta.url), 'utf8');
  const puertas = [...src.matchAll(/invokeCapability\(/g)].length;
  assert.equal(puertas, 2, `${puertas} llamadas a invokeCapability: cada una debe proyectar sus inputs`);
  assert.match(src, /inputs: proyectados/);
});

test('la entrada de Adversarial esta PROYECTADA: el marcador de la ronda no viaja', async () => {
  // Antes esto era un regex sobre el fuente --`/FindingSet: proyectar\('FindingSet'/`--
  // y cayo en rojo cuando la etapa paso a inyectar el `id` del voto, sin que la
  // propiedad se hubiera roto: el codigo seguia proyectando, solo que en dos
  // lineas en vez de una. Un test que fija la FORMA del fuente se pone rojo
  // cuando alguien hace lo correcto; este fija lo que la lista blanca existe
  // para conseguir, que es lo unico que importa.
  const { entradaAdversarial } = await import('./stages-model.mjs');
  const { inputs } = entradaAdversarial({
    artifacts: {
      Validation: { payload: {
        findings: [{ file: 'a.ts', symbol: 'g', claim: 'el reloj se construye dentro', severity: 'P3', evidence: 'e' }],
        // El marcador de la ronda. El refutador NO debe verlo: saber cuantas
        // pasadas van o que salio la vez anterior es justo lo que ancla un voto
        // que tiene que ser independiente.
        counts: { confirmed: 9 }, passes: 3, passesOk: 3, unreviewed: 7,
      } },
      Execution: { payload: { files: ['a.ts'], diff: 'd', summary: 's', contents: { 'a.ts': 'SECRETO' } } },
    },
  });

  const fs = inputs.FindingSet.payload ?? inputs.FindingSet;
  assert.ok(Array.isArray(fs.findings), 'los hallazgos viajan');
  assert.equal(fs.findings[0].id, '1',
    'y con el id que el harness calcula: un ORDINAL, no la huella. Medido contra el modelo real, '
    + 'una huella de cien caracteres no se copia -- se inventa-- y los votos salen huerfanos');
  for (const fuera of ['counts', 'passes', 'passesOk', 'unreviewed']) {
    assert.ok(!(fuera in fs), `'${fuera}' llego al refutador: la lista blanca fallo en abierto`);
  }

  const cs = inputs.ChangeSet.payload ?? inputs.ChangeSet;
  assert.ok(!('contents' in cs), 'el contenido de los ficheros NO viaja: eso es el repositorio entero');
});

test('un fallo de parseo dice QUE devolvio el modelo, no solo que no valia', async () => {
  // El motivo era 'no devolvio JSON reconocible' y `raw` se perdia en esa misma
  // linea. Ese es el unico dato que separa tres causas distintas -- el modelo se
  // fue por las ramas, la respuesta vino vacia, o el prompt esta roto-- y sin el
  // la etapa falla con un motivo INFALSIFICABLE. Regla #0: sin evidencia no hay
  // avance, y eso vale tambien para la evidencia de un fallo.
  //
  // MEDIDO en H-20260820-e6415189: etapa 1 muerta, 2 llamadas, `failed: 0`,
  // 240 s. El proveedor contesto las dos veces y no sobrevivio un solo caracter.
  const { muestraDe } = await import('./invoke.mjs');

  assert.match(muestraDe(''), /VACIA/, 'una respuesta vacia se distingue de una ilegible');
  assert.match(muestraDe('   \n  '), /VACIA/, 'solo espacios es vacia, no una muestra en blanco');
  assert.match(muestraDe('Claro, aqui tienes:'), /devolvio: "Claro, aqui tienes:"/);

  // La muestra es una MUESTRA: un `raw` de 30 KB dentro del motivo llenaria la
  // traza con lo que ya se descarto.
  const largo = muestraDe('y'.repeat(9000));
  assert.match(largo, /devolvio 9000 chars/, 'dice cuanto vino, no solo un trozo');
  assert.ok(largo.length < 500, `la muestra no se recorto: ${largo.length} chars`);

  // Y esta CABLEADA en el fallo de parseo, no solo exportada: una funcion que
  // nadie llama es el defecto de `el-fix-que-no-existe`.
  const src = readFileSync(new URL('./invoke.mjs', import.meta.url), 'utf8');
  assert.match(src, /no devolvio JSON reconocible; \$\{muestraDe\(raw\)\}/);
});
