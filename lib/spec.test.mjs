// node --test harness/lib/spec.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { revisar, assertEspecificacion, bloqueadaPorEspecificacion } from './spec.mjs';
import { ROOT } from './capabilities.mjs';
import { veredictoDeSemillas } from './semillas.mjs';
import { decidirHallazgo } from './security.mjs';
import { loadSecurityPolicy } from './security-scan.mjs';

// ── Lo comprobable ANTES de gastar una invocacion ────────────────────────────

test('H-20260816-52af3889: la aceptacion pide un test y no hay donde escribirlo', () => {
  const p = revisar({
    files: ['src/lib/formatFileSize.ts', 'src/app/admin/AdminRespaldosS3.tsx'],
    acceptance: ['El .spec.ts pincha las cadenas exactas en 0, 1023 y 1024'],
  });
  assert.equal(p.length, 1);
  assert.match(p[0], /no incluye ningun fichero de spec/);
  assert.throws(() => assertEspecificacion({
    files: ['src/lib/x.ts'], acceptance: ['escribe un test que falla por asercion'],
  }), /SPECIFICATION_BLOCKED antes de empezar/);
});

test('con un fichero de spec en task.files, la misma aceptacion se sostiene', () => {
  assert.deepEqual(revisar({
    files: ['src/lib/formatFileSize.ts', 'src/lib/formatFileSize.spec.ts'],
    acceptance: ['El .spec.ts pincha las cadenas exactas en 0, 1023 y 1024'],
  }), []);
});

test('H-20260816-6b16c1a5: conservar EXACTAMENTE y corregir, sin acotar dominio', () => {
  const p = revisar({
    files: ['src/lib/x.ts'],
    acceptance: [
      'conserva EXACTAMENTE el comportamiento de fmtSize',
      'con 0 < bytes < 1 devuelve undefined y hay que corregirlo',
    ],
  });
  assert.equal(p.length, 1);
  assert.match(p[0], /incompatibles salvo que se diga dentro de que entradas/);
});

test('acotar el DOMINIO es lo que hace compatibles esos dos criterios', () => {
  // Es la forma que de verdad funciono, y es la que lleva hoy H-001.
  assert.deepEqual(revisar({
    files: ['src/lib/x.ts'],
    acceptance: [
      'DOMINIO: bytes es un entero >= 0. Dentro de ese dominio conserva EXACTAMENTE el comportamiento',
      'FUERA del dominio esta ROTO y hay que corregirlo, no heredarlo',
    ],
  }), []);
});

// El hueco es deliberado: una aceptacion puede CITAR una ruta prohibida sin
// exigir tocarla, y ninguna expresion regular distingue una cita de un
// requisito. La regla que lo intentaba bloqueaba H-001 por citar
// `memory/failures/el-fix-que-no-existe.md`. Este test fija que NO se reintroduzca.
test('citar una ruta prohibida NO es exigir modificarla', () => {
  assert.deepEqual(revisar({
    files: ['src/lib/x.ts'],
    forbiddenPaths: ['memory/**'],
    acceptance: ['ningun comentario declara una autoridad que el cambio no establece (memory/failures/el-fix-que-no-existe.md)'],
  }), []);
});

// EL MANIFIESTO REAL tiene que pasar su propio preflight. Sin este test, la
// heuristica podria bloquear la unica tarea que el harness sabe ejecutar y no
// nos enterariamos hasta lanzarla.
test('el manifiesto H-001 versionado pasa el preflight', () => {
  const m = JSON.parse(readFileSync(join(ROOT, '.kiro/specs/h-001-ring-execution/h-001.json'), 'utf8'));
  assert.deepEqual(revisar(m.task), [], 'la tarea que ya converge no puede quedar bloqueada por el preflight');
});

// ── Lo que solo se sabe DESPUES ──────────────────────────────────────────────

test('tres rondas con correcciones REALES y el mismo hallazgo vivo: es la spec', () => {
  const r = bloqueadaPorEspecificacion(['src/a.ts|fmt|indice negativo'], [5, 3, 4]);
  assert.equal(r.verdict, 'SPECIFICATION_BLOCKED');
  assert.equal(r.rounds, 3);
  assert.match(r.why, /correcciones REALES/);
});

test('sin mutaciones en alguna ronda NO se acusa a la spec: eso es otro defecto', () => {
  // El `done` contractual ya cubre al builder pasivo. Confundir los dos casos
  // haria que un builder que no toca nada quedara absuelto culpando a la tarea.
  assert.equal(bloqueadaPorEspecificacion(['x'], [5, 0, 4]), null);
});

test('dos rondas todavia no bastan: 2 reintentos es el techo, no la prueba', () => {
  assert.equal(bloqueadaPorEspecificacion(['x'], [5, 3]), null);
});

test('sin hallazgos persistentes no hay nada que achacar a la spec', () => {
  assert.equal(bloqueadaPorEspecificacion([], [5, 3, 4]), null);
  assert.equal(bloqueadaPorEspecificacion(null, [5, 3, 4]), null);
});

test('una semilla fuera de task.files es una vuelta sin salida, y se declara antes de arrancarla', () => {
  const fuera = { files: ['src/a.tsx'], acceptance: [], seed: [{ path: 'src/b.tsx' }] };
  const [aviso, ...resto] = revisar(fuera).filter((x) => x.includes('task.seed'));

  assert.ok(aviso, 'no declara la semilla fuera de la allowlist');
  assert.equal(resto.length, 0, 'un aviso por spec, no uno por regla que lo mencione');
  assert.match(aviso, /src\/b\.tsx/, 'no dice CUAL semilla');
  // Quien lee esto no sabe cual de los dos lados ampliar. El mensaje tiene que
  // nombrar los dos: es la diferencia entre un diagnostico y una orden util.
  assert.match(aviso, /task\.files/);
  assert.match(aviso, /retira la semilla/);

  // Y NO dispara cuando si puede tocarla: una regla especulativa que da un falso
  // SPECIFICATION_BLOCKED es el peor fallo de un preflight, porque bloquea antes
  // de que nada pueda desmentirla. Es la razon escrita de que no hubiera regla 3.
  const dentro = { files: ['src/a.tsx', 'src/b.tsx'], acceptance: [], seed: [{ path: 'src/b.tsx' }] };
  assert.deepEqual(revisar(dentro).filter((x) => x.includes('task.seed')), []);
  assert.deepEqual(revisar({ files: ['src/a.tsx'], acceptance: [] }), [], 'sin semilla no se inventa nada');
});

test('el bucle que la regla evita es alcanzable de verdad, no una hipotesis', () => {
  // LA REGLA 3 NO VIENE DE UNA CORRIDA QUE OCURRIO, a diferencia de las dos de
  // arriba: viene de una que h-007 vuelve ALCANZABLE. Asi que la cadena se
  // demuestra aqui componiendo las piezas reales, en vez de afirmarse en prosa.
  //
  // Sin este test, «entra en REWORK sin salida» seria una frase en un comentario
  // -- y una afirmacion sobre un estado que nadie ha construido es exactamente
  // lo que memory/failures/hable-de-una-poblacion-distinta-de-la-que-medi.md
  // llama hablar de una poblacion que no se enumero.
  const policy = loadSecurityPolicy();
  const semillaViva = [{ path: 'src/b.tsx', sigueEnElArbol: true }];
  const [hallazgo] = veredictoDeSemillas(semillaViva).hallazgos;

  // 1. la semilla viva produce un hallazgo que la politica BLOQUEA
  assert.equal(decidirHallazgo(hallazgo, policy, { hoy: '2026-08-26' }).gate, 'BLOCK');

  // 2. y el builder NO puede retirarla: el fichero no esta en su allowlist
  const permitidos = new Set(['src/a.tsx']);
  assert.equal(permitidos.has(semillaViva[0].path), false);

  // Las dos juntas son el bucle: BLOCK -> REWORK -> el builder vuelve sin poder
  // tocar el fichero -> BLOCK. Ninguna de las dos por separado es un defecto.
  assert.ok(revisar({ files: [...permitidos], acceptance: [], seed: [{ path: 'src/b.tsx' }] })
    .some((x) => x.includes('task.seed')), 'la regla no cubre el estado que se acaba de construir');
});
