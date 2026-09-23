// Una ruta que DEPLOY.md declara obligatoria no puede ser invisible para git.
//
// Lo midió el agente de S3: `DEPLOY.md:261` nombra
// `ai/aws/migrations/2026-05-28-…sql` como MIGRACIÓN OBLIGATORIA PRE-DEPLOY, y el
// `.gitignore` del tronco ignora `ai/` entero. Los tres ficheros que ya viven
// ahí siguen rastreados --ignorar no desrastrea-- así que hoy no rompe nada, y
// por eso nadie lo va a ver: el fallo aparece cuando alguien escriba el
// SIGUIENTE .sql, no entre en el commit, y se descubra desplegando.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { rutasDeclaradas, directoriosDe, invisibles } from './deploy-rutas.mjs';
import { ENV_LIMPIO } from './sandbox.mjs';
import { ROOT } from './capabilities.mjs';

test('extrae las rutas del repositorio que el documento nombra', () => {
  const t = 'Correr `migration/x.sql` y luego ai/aws/migrations/y.sql; ver https://x.com/z.sql';
  assert.deepEqual(rutasDeclaradas(t), ['ai/aws/migrations/y.sql', 'migration/x.sql']);
});

test('la pregunta es por el DIRECTORIO, porque el peligro es el fichero NUEVO', () => {
  // `git check-ignore` sin `--no-index` no marca lo ya rastreado, así que
  // preguntar por los ficheros existentes responde «visible» por la razón
  // equivocada. Los tres de `ai/aws/` están rastreados y el directorio ignorado.
  assert.deepEqual(directoriosDe(['ai/aws/migrations/y.sql', 'migration/x.sql']),
    ['ai/aws/migrations', 'migration']);
});

test('DETECTA el caso real: `ai/` ignorado con una migración obligatoria dentro', () => {
  // Sintético a propósito: en `feat/harness` el `.gitignore` NO tiene la línea
  // `ai/` --la tiene el tronco, en :304-- así que sin este caso el test de abajo
  // aprobaría sobre cero y el mecanismo nunca se ejercitaría. Es la guarda de
  // denominador, que es como se mueren estos controles.
  const doc = 'MIGRATION OBLIGATORIA PRE-DEPLOY: `ai/aws/migrations/2026-05-28-x.sql`';
  const comoElTronco = (d) => d.startsWith('ai/');
  assert.deepEqual(invisibles(doc, comoElTronco), ['ai/aws/migrations'],
    'el mecanismo no detecta el caso que lo motiva');
  assert.deepEqual(invisibles(doc, () => false), []);
});

test('en ESTE árbol, ninguna ruta que DEPLOY.md declara es invisible', () => {
  const p = join(ROOT, 'DEPLOY.md');
  if (!existsSync(p)) return;                     // rama sin DEPLOY.md: nada que afirmar
  const texto = readFileSync(p, 'utf8');

  const rutas = rutasDeclaradas(texto);
  assert.ok(rutas.length > 10,
    `sólo se extrajeron ${rutas.length} rutas de DEPLOY.md: el patrón dejó de casar y esto aprobaría sobre nada`);

  const ignoraNuevo = (d) => {
    try {
      execFileSync('git', ['check-ignore', '--no-index', '-q', `${d}/NUEVO-PRUEBA.sql`],
        { cwd: ROOT, env: ENV_LIMPIO(), stdio: 'ignore' });
      return true;
    } catch { return false; }
  };
  // INVISIBLE POR DESCUIDO vs INVISIBLE POR DECISION ESCRITA. No son lo mismo, y
  // el mismo `check-ignore` distingue las dos: `-v` devuelve el FICHERO y la LINEA
  // de la regla que ignora, asi que se puede ir a mirar si esa regla lleva su
  // motivo al lado.
  //
  // MEDIDO el 2026-08-24 al fusionar el tronco: `second` decidio que los documentos
  // de `ai/` viven en el bucket y no se versionan --con `ai/*` + `!ai/aws/` y ocho
  // lineas de comentario explicando por que--. DEPLOY.md los sigue nombrando. Este
  // test caia, y estaba pidiendo que se revirtiera una decision deliberada.
  //
  // Un guarda que no distingue el descuido de la decision obliga a elegir entre
  // desactivarlo o deshacer la decision, y las dos son peores que el problema.
  const reglaQueIgnora = (d) => {
    try {
      const out = execFileSync('git', ['check-ignore', '--no-index', '-v', `${d}/NUEVO-PRUEBA.sql`],
        { cwd: ROOT, env: ENV_LIMPIO(), encoding: 'utf8' });
      const [fichero, linea] = String(out).split(':');
      return { fichero, linea: Number(linea) };
    } catch { return null; }
  };
  // ¿La regla lleva su motivo? Se miran las lineas de comentario INMEDIATAMENTE
  // encima. Un `# ...` pegado a la regla es una decision; una regla suelta, no.
  const tieneMotivo = (r) => {
    if (!r?.fichero || !r.linea) return false;
    const abs = join(ROOT, r.fichero);
    if (!existsSync(abs)) return false;
    const ls = readFileSync(abs, 'utf8').split('\n');
    for (let i = r.linea - 2; i >= 0; i--) {
      const l = ls[i].trim();
      if (l.startsWith('#')) return true;   // hay comentario pegado
      if (l === '') continue;               // una linea en blanco no rompe el bloque
      return false;                         // codigo/regla: no hay motivo escrito
    }
    return false;
  };

  const fuera = invisibles(texto, ignoraNuevo);
  const porDescuido = fuera.filter((d) => !tieneMotivo(reglaQueIgnora(d)));
  const porDecision = fuera.filter((d) => tieneMotivo(reglaQueIgnora(d)));

  assert.deepEqual(porDescuido, [],
    `DEPLOY.md nombra ficheros en ${porDescuido.join(', ')} y git ignoraría uno nuevo ahí, `
    + 'SIN NINGUN MOTIVO ESCRITO junto a la regla.\n'
    + 'El siguiente que alguien escriba no entrará en el commit y el fallo saldrá desplegando. '
    + 'Si es deliberado, escribe el porqué encima de la regla en .gitignore.');

  // Lo deliberado NO se aprueba en silencio: se declara, que es la misma regla que
  // la puerta aplica a lo que no puede comprobar. Y queda dicho que DEPLOY.md sigue
  // nombrando algo que ya no vive en el repo -- una referencia rota con buena letra.
  if (porDecision.length) {
    console.error(`    (declarado) DEPLOY.md nombra ${porDecision.join(', ')}, ignorados POR DECISION `
      + 'escrita en .gitignore. Esos documentos ya no viven en el repo: DEPLOY.md debería apuntar a donde sí.');
  }
});
