// ── La negociacion de puertos, y la regla que mantiene limpio el nucleo ──────
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertRing, crearAnfitrion, puertaNula } from './index.mjs';
import { puertaDoxia } from '../adapters/doxia/quality-gate.mjs';

const AQUI = dirname(fileURLToPath(import.meta.url));

test('falta un puerto -> la vuelta NO empieza', () => {
  const r = assertRing({ anfitrion: crearAnfitrion({ raiz: '/x' }) });
  assert.equal(r.ok, false);
  assert.match(r.fallos.join(' '), /puertaDeCalidad/);
});

test('un adaptador que no cumple el contrato se caza al negociar', () => {
  const r = assertRing({
    anfitrion: crearAnfitrion({ raiz: '/x' }),
    puertaDeCalidad: { id: () => 'incompleto' },
  });
  assert.equal(r.ok, false);
  assert.match(r.fallos.join(' '), /falta '/);
});

test('con los dos puertos completos, negocia y describe quien es cada uno', () => {
  const r = assertRing({
    anfitrion: crearAnfitrion({ raiz: '/x' }),
    puertaDeCalidad: puertaNula('sin gate'),
  });
  assert.equal(r.ok, true, r.fallos.join(' '));
  assert.ok(r.informe.anfitrion.raiz);
  assert.ok(r.informe.puertaDeCalidad);
});

test('EL FALLO DE h-009: la puerta ausente se detecta al ARRANCAR, no en la etapa 15', () => {
  // Tres vueltas del 22-sep llegaron a la etapa 15 --una con rework completo--
  // para morir por algo comprobable en el segundo cero. Con `workspace`, la
  // negociacion pregunta disponibilidad REAL, no solo forma.
  const r = assertRing(
    { anfitrion: crearAnfitrion({ raiz: '/x' }), puertaDeCalidad: puertaDoxia() },
    { workspace: '/ruta/que/no/existe' },
  );
  assert.equal(r.ok, false);
  assert.match(r.fallos.join(' '), /no disponible|falta scripts\/gate\.sh/);
});

test('el adaptador REAL de DoxIA cumple el puerto — solo donde DoxIA existe', (t) => {
  // GUARDA DE ENTORNO, no un skip por comodidad. Este caso comprueba el
  // ADAPTADOR, y un adaptador solo se puede comprobar donde vive su anfitrion.
  // Un auditor de regresion lo cazo fallando en un repositorio limpio: el test
  // del PUERTO exigia `scripts/gate.sh`, que es precisamente lo que el puerto
  // existe para no exigir.
  //
  // Se distingue «no habia con que comprobar» de «comprobe y falla», que es la
  // misma distincion que el motor hace con las rutas de memory/. Sin la guarda,
  // el rojo diria «el adaptador no cumple» cuando la verdad es «aqui no hay
  // adaptador que comprobar».
  const raiz = join(AQUI, '..', '..');
  if (!existsSync(join(raiz, 'scripts', 'gate.sh'))) {
    t.skip('sin scripts/gate.sh: este arbol no es el anfitrion DoxIA');
    return;
  }
  const r = assertRing(
    { anfitrion: crearAnfitrion({ raiz }), puertaDeCalidad: puertaDoxia() },
    { workspace: raiz },
  );
  assert.equal(r.ok, true, `este repo SI tiene scripts/gate.sh: ${r.fallos.join(' ')}`);
});

test('REGLA DEL NUCLEO: ningun puerto importa un adaptador', () => {
  // Mecanizable, como el guarda «nada del harness llama a git sin ENV_LIMPIO».
  // Si un puerto importara su implementacion, la inversion de dependencias
  // estaria invertida al reves y el hexagono seria decorativo.
  for (const f of readdirSync(AQUI).filter((x) => x.endsWith('.mjs') && !x.includes('.test.'))) {
    const src = readFileSync(join(AQUI, f), 'utf8');
    const imports = [...src.matchAll(/^\s*import\s[^;]*from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    for (const i of imports) {
      assert.ok(!i.includes('adapters/'), `ports/${f} importa un adaptador: ${i}`);
    }
  }
});
