// ── El quorum de auditoria: 4 votos validos, todos >= 9 ──────────────────────
//
// LOGICA PURA, sin red: recibe votos y decide. El adaptador que habla con Ollama
// vive en `harness/bin/votar.mjs`. Separarlos es lo que permite probar el
// veredicto sin cargar 13 GB de modelo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluarQuorum, parsearVoto, motivoDeOmision, presupuestoSuficiente, VEREDICTOS } from './votacion.mjs';

// La raiz del repo, deducida del propio fichero: harness/lib/ -> ../..
const RAIZ = join(fileURLToPath(new URL('.', import.meta.url)), '..');

const voto = (modelo, familia, puntaje) => ({ modelo, familia, puntaje });
const CUATRO_NUEVES = [
  voto('a:1', 'qwen', 9), voto('b:1', 'gemma', 9),
  voto('c:1', 'deepseek', 9), voto('d:1', 'gptoss', 9),
];
const ESTRICTA = { regla: 'estricta', votosMinimos: 4, puntajeMinimo: 9, minimoTolerado: 8, familiasDistintas: true };
const MIXTA = { ...ESTRICTA, regla: 'mixta' };

test('cuatro votos de familias distintas, todos 9: APROBADO', () => {
  const r = evaluarQuorum(CUATRO_NUEVES, ESTRICTA);
  assert.equal(r.veredicto, VEREDICTOS.APROBADO);
  assert.equal(r.votosValidos, 4);
  assert.equal(r.minimo, 9);
});

test('regla ESTRICTA: un voto por debajo del minimo RECHAZA, y se nombra cual', () => {
  const votos = [...CUATRO_NUEVES.slice(0, 3), voto('d:1', 'gptoss', 8)];
  const r = evaluarQuorum(votos, ESTRICTA);
  assert.equal(r.veredicto, VEREDICTOS.RECHAZADO);
  assert.match(r.razon, /d:1/, 'la razon tiene que NOMBRAR al votante que no llego');
});

test('regla MIXTA: el mismo caso APRUEBA si la media llega y nadie baja del tolerado', () => {
  // 9+9+9+8 = 35 -> media 8.75. NO llega a 9: la mixta tampoco lo aprueba.
  const casi = [...CUATRO_NUEVES.slice(0, 3), voto('d:1', 'gptoss', 8)];
  assert.equal(evaluarQuorum(casi, MIXTA).veredicto, VEREDICTOS.RECHAZADO,
    'media 8.75 no alcanza 9: la mixta NO es una rebaja, es otro criterio');

  // 10+10+9+8 = 37 -> media 9.25, minimo 8 (tolerado). Aqui SI.
  const compensado = [
    voto('a:1', 'qwen', 10), voto('b:1', 'gemma', 10),
    voto('c:1', 'deepseek', 9), voto('d:1', 'gptoss', 8),
  ];
  assert.equal(evaluarQuorum(compensado, MIXTA).veredicto, VEREDICTOS.APROBADO);
  assert.equal(evaluarQuorum(compensado, ESTRICTA).veredicto, VEREDICTOS.RECHAZADO,
    'la estricta sigue exigiendo que los CUATRO lleguen: esa es la diferencia');
});

test('regla MIXTA: por debajo del minimoTolerado rechaza aunque la media sobre', () => {
  // 10+10+10+7 = 37 -> media 9.25, pero un juez dio 7: no se compensa un suspenso.
  const votos = [
    voto('a:1', 'qwen', 10), voto('b:1', 'gemma', 10),
    voto('c:1', 'deepseek', 10), voto('d:1', 'gptoss', 7),
  ];
  const r = evaluarQuorum(votos, MIXTA);
  assert.equal(r.veredicto, VEREDICTOS.RECHAZADO);
  assert.match(r.razon, /7|tolerado/i);
});

test('UN VOTO NULO NO ES UN VOTO BAJO: falta quorum, no se rellena', () => {
  // La distincion que este repo paga caro cada vez que la olvida: «no habia con
  // que comprobar» y «comprobe y esta mal» son estados DISTINTOS. Un votante que
  // no emitio puntaje no vota 0: no vota.
  const votos = [...CUATRO_NUEVES.slice(0, 3), voto('d:1', 'gptoss', null)];
  const r = evaluarQuorum(votos, ESTRICTA);
  assert.equal(r.veredicto, VEREDICTOS.SIN_QUORUM);
  assert.equal(r.votosValidos, 3);
  assert.match(r.razon, /nulo|sin puntaje/i);
});

test('dos votantes de la MISMA familia no suman quorum independiente', () => {
  const votos = [
    voto('a:1', 'qwen', 9), voto('a:2', 'qwen', 9),
    voto('c:1', 'deepseek', 9), voto('d:1', 'gptoss', 9),
  ];
  const r = evaluarQuorum(votos, ESTRICTA);
  assert.equal(r.veredicto, VEREDICTOS.SIN_QUORUM);
  assert.match(r.razon, /familia/i);
});

test('parsearVoto acepta PUNTAJE y Puntaje: el case NO decide un voto', () => {
  // DEFECTO REAL: el regex exigia mayusculas y deepseek responde `Puntaje: 8`.
  // El voto se perdio DOS VECES por el instrumento, no por el modelo.
  for (const txt of ['PUNTAJE: 9', 'Puntaje: 9', 'puntaje : 9', '  Puntaje:9  ']) {
    assert.equal(parsearVoto(txt).puntaje, 9, `no parseo: ${JSON.stringify(txt)}`);
  }
});

test('parsearVoto NO inventa un puntaje cuando no lo hay', () => {
  for (const txt of ['El trabajo es solido y riguroso.', '', 'Nota final: excelente']) {
    assert.equal(parsearVoto(txt).puntaje, null, `invento puntaje en: ${JSON.stringify(txt)}`);
  }
});

test('parsearVoto rechaza un puntaje fuera de escala en vez de recortarlo', () => {
  assert.equal(parsearVoto('PUNTAJE: 42').puntaje, null);
  assert.equal(parsearVoto('PUNTAJE: -3').puntaje, null);
});

test('evaluarQuorum es PURA: dos llamadas con la misma entrada dan lo mismo', () => {
  const a = evaluarQuorum(CUATRO_NUEVES, ESTRICTA);
  const b = evaluarQuorum(CUATRO_NUEVES, ESTRICTA);
  assert.deepEqual(a, b, 'la C de ACID: mismo input, mismo veredicto');
});

test('el rango y la escala viajan en el resultado, no solo el veredicto', () => {
  // Sin rango no se puede decidir entre estricta y mixta: es el dato que la
  // medicion de varianza produce y el que justifica cambiar de regla.
  const r = evaluarQuorum([
    voto('a:1', 'qwen', 10), voto('b:1', 'gemma', 9),
    voto('c:1', 'deepseek', 9), voto('d:1', 'gptoss', 8),
  ], MIXTA);
  assert.equal(r.minimo, 8);
  assert.equal(r.maximo, 10);
  assert.equal(r.rango, 2, 'el rango max-min es lo que dice si un juez oscila');
  assert.equal(r.media, 9);
});

test('LA VIA DE ESCAPE EXIGE MOTIVO: no es un interruptor', () => {
  // Sin escape, un votante caido bloquea el repositorio entero: la puerta se
  // vuelve un SPOF. Con un escape SIN motivo, deja de ser puerta. El motivo
  // obligatorio es lo que hace la omision auditable en vez de oculta.
  const reglas = { motivoMinimoCaracteres: 12 };
  assert.equal(motivoDeOmision(undefined, reglas), null, 'sin variable no se omite');
  assert.equal(motivoDeOmision('', reglas), null);
  assert.equal(motivoDeOmision('1', reglas), null, 'un motivo de un caracter es un interruptor disfrazado');
  assert.equal(motivoDeOmision('   ', reglas), null);
  assert.equal(
    motivoDeOmision('ollama caido en CI, auditado a mano el 24-sep', reglas),
    'ollama caido en CI, auditado a mano el 24-sep',
  );
});

// ── El presupuesto de un razonador no es afinado, es correccion ──────────────
//
// deepseek-flash y deepseek-v4-pro gastan tokens en `reasoning_content` ANTES de
// emitir respuesta. Medido: max_tokens=30 -> content='' y finish_reason='length'
// en los DOS. El voto sale nulo por el INSTRUMENTO, no por el modelo: es el
// spinner de TTY otra vez, con otra cara.
test('un razonador con presupuesto de no-razonador vota NULO', () => {
  assert.equal(presupuestoSuficiente({ razonador: true, maxTokens: 30 }, 1000), false,
    '30 tokens a un razonador: se agotan razonando y el voto sale vacio');
  assert.equal(presupuestoSuficiente({ razonador: true, maxTokens: 2000 }, 1000), true,
    '2000 tokens bastan: medido, los dos modelos respondieron a la primera');
  assert.equal(presupuestoSuficiente({ razonador: true }, 1000), false,
    'un razonador SIN maxTokens declarado hereda el defecto: hay que declararlo');
  // Un votante que no razona no necesita el presupuesto grande.
  assert.equal(presupuestoSuficiente({ razonador: false, maxTokens: 30 }, 1000), true,
    'no-razonador: 30 tokens le sobran para tres lineas');
});

test('la politica declara presupuesto suficiente para TODOS sus razonadores', () => {
  const pol = JSON.parse(readFileSync(join(RAIZ, 'policy/votacion.json'), 'utf8'));
  const min = pol.presupuestoMinimoRazonadores;
  assert.ok(Number.isInteger(min) && min > 0, 'la politica dejo de declarar el minimo');
  for (const v of pol.votantes) {
    assert.ok(presupuestoSuficiente(v, min),
      `${v.modelo} es razonador y su maxTokens (${v.maxTokens}) lo dejaria votando nulo`);
  }
});

test('el votante de deepseek usa la API de pago, y la clave viene del entorno', () => {
  const pol = JSON.parse(readFileSync(join(RAIZ, 'policy/votacion.json'), 'utf8'));
  const ds = pol.votantes.find((v) => v.familia === 'deepseek');
  assert.ok(ds, 'desaparecio el votante de la familia deepseek: el quorum baja a 3 familias');
  assert.equal(ds.transporte, 'deepseek', 'volvio al transporte local');
  assert.equal(ds.envKey, 'DEEPSEEK_API_KEY', 'la clave dejo de leerse del entorno');
  // LA CLAVE NO PUEDE ESTAR EN LA POLITICA: el fichero esta versionado.
  assert.ok(!JSON.stringify(pol).match(/sk-[a-zA-Z0-9]{10}/),
    'hay algo con forma de clave dentro de la politica, que es un fichero versionado');
});

test('siguen siendo cuatro familias distintas tras sustituir el votante', () => {
  const pol = JSON.parse(readFileSync(join(RAIZ, 'policy/votacion.json'), 'utf8'));
  const fams = new Set(pol.votantes.map((v) => v.familia));
  assert.equal(fams.size, 4,
    'la sustitucion redujo las familias: dos modelos de la misma familia son correlacion, no confirmacion');
});

// ── El panel tiene que poder distinguir un 8 de un 9 ────────────────────────
//
// MEDIDO sobre el mismo artefacto (sha256 707468095f75), gpt-oss:20b, k=4:
//   temperature 0.1 sin seed -> votos [8,8,9,9], CUATRO hashes de respuesta
//   temperature 0 + top_k 1  -> votos [9,9,9,9], UN hash (fc1720f4)
// El ruido no era del modelo: era de la configuracion de muestreo.
test('la politica exige decodificacion GREEDY, no muestreo', () => {
  const pol = JSON.parse(readFileSync(join(RAIZ, 'policy/votacion.json'), 'utf8'));
  assert.equal(pol.muestreo.temperature, 0,
    'temperature > 0 vuelve a muestrear: el mismo artefacto daria votos distintos');
  assert.equal(pol.muestreo.topK, 1,
    'top_k > 1 deja mas de un token candidato: reintroduce el sorteo');
  assert.equal(pol.muestreo.topP, 1,
    'top_p < 1 recorta el nucleo y vuelve a hacer falta muestrear dentro de el');
  assert.ok(Number.isInteger(pol.muestreo.seed),
    'sin seed declarada la corrida no es reproducible por terceros');
});

test('gemini no puede votar: el veto es de por vida', () => {
  const pol = JSON.parse(readFileSync(new URL('../policy/votacion.json', import.meta.url), 'utf8'));
  assert.ok(!pol.votantes.some((v) => /gemini/i.test(v.modelo) || /gemini/i.test(v.familia)),
    'gemini aparece entre los votantes y esta vetado (PROVEEDORES_VETADOS en compute.mjs)');
  assert.equal(pol.votantes.length, new Set(pol.votantes.map((v) => v.familia)).size,
    'hay dos votantes de la misma familia: su acuerdo seria correlacion, no confirmacion');
});
