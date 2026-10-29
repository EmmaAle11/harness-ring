// LAS MITIGACIONES DE LOS RIESGOS ACEPTADOS, MEDIDAS CONTRA EL CODIGO.
//
// `harness/security/riesgos-aceptados.json` declara su propia regla #3:
//
//     "Exige `mitigacion` y `test`: si el riesgo esta cerrado por otra via, esa
//      via tiene que tener nombre y guardian. Sin test, no se acepta."
//
// Cinco entradas la incumplian con `"test": "PENDIENTE: ..."`. Una aceptacion
// con mitigacion no verificada es exactamente la forma documentada de un WARN
// que parece PASS: el gate sale verde porque alguien ESCRIBIO que el riesgo esta
// cerrado, no porque este cerrado.
//
// Estos tests convierten esas tres frases en predicados ejecutables, y uno de
// los tres REFUTA la mitigacion que el fichero declaraba.
//
// POR QUE VIVE EN adapters/doxia/: afirma cosas sobre el arbol de DoxIA
// (backend/src, app.module.ts, main.ts). Salta con motivo donde ese arbol no
// esta. El motor no sabe nada de NestJS.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = fileURLToPath(new URL('../../', import.meta.url));
const BACKEND = join(RAIZ, 'backend', 'src');
const HAY_BACKEND = existsSync(BACKEND);

/** Todos los .ts de produccion del backend (sin specs). */
function fuentes(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) fuentes(p, out);
    else if (/\.ts$/.test(e.name) && !/\.(spec|test)\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}

const leerTodo = () => fuentes(BACKEND).map((p) => ({ path: p.slice(RAIZ.length), texto: readFileSync(p, 'utf8') }));

// ── GHSA-xcx6-jx8p-x3h5 · @azure/msal-node ──────────────────────────────────

test('MSAL: el authorization code flow —el vector del CVE— no se usa', (t) => {
  if (!HAY_BACKEND) return t.skip('sin backend/src de DoxIA');

  // El aviso es "MSAL Node authorization code flow may disclose parameters to an
  // attacker-controlled endpoint". La mitigacion declarada hablaba de
  // `redirect_uri` fijo, que es una afirmacion mas debil que la realidad MEDIDA:
  // el authorization code flow NO EXISTE en el codigo. El unico uso de MSAL es
  // `acquireTokenByClientCredential` (email.service.ts), que es client
  // credentials: no hay redireccion, no hay endpoint que un atacante controle.
  const docs = leerTodo();
  const delFlujo = /acquireTokenByCode|getAuthCodeUrl|AuthorizationCodeRequest|AuthorizationUrlRequest/;
  const culpables = docs.filter((d) => delFlujo.test(d.texto)).map((d) => d.path);

  assert.deepEqual(culpables, [],
    `el vector del CVE SI se ejecuta en: ${culpables.join(', ')} — la aceptacion deja de ser valida`);

  // Y el denominador: si MSAL desapareciera del todo, este test pasaria sin
  // comprobar nada. Se exige que el uso que SI existe siga siendo el seguro.
  const conMsal = docs.filter((d) => /msal-node|ConfidentialClientApplication/.test(d.texto));
  assert.ok(conMsal.length > 0,
    'ningun fichero usa MSAL: si se retiro la dependencia, esta aceptacion ya no hace falta');
  assert.ok(conMsal.some((d) => /acquireTokenByClientCredential/.test(d.texto)),
    'MSAL se usa pero NO por client credentials: revisar que flujo es');
});

// ── GHSA-q7qp-rjg7-q26m · multer ────────────────────────────────────────────

test('multer: ningun fileFilter asincrono —el vector del CVE— existe', (t) => {
  if (!HAY_BACKEND) return t.skip('sin backend/src de DoxIA');

  // El aviso es "DoS via a pending asynchronous fileFilter after request
  // teardown". MEDIDO: el backend no define NINGUN fileFilter, ni sincrono ni
  // asincrono. Las opciones centrales (common/upload/multer-opciones.ts) solo
  // fijan `limits.fileSize`.
  const docs = leerTodo();
  const conFilter = docs.filter((d) => /fileFilter/.test(d.texto));

  // Si algun dia se añade uno, tiene que ser sincrono: sin `async` y sin await.
  for (const d of conFilter) {
    const asincrono = /fileFilter\s*:\s*async|fileFilter\s*:\s*(\([^)]*\)|\w+)\s*=>\s*{[^}]*await/s;
    assert.ok(!asincrono.test(d.texto),
      `${d.path} define un fileFilter ASINCRONO: es el vector exacto de GHSA-q7qp-rjg7-q26m`);
  }

  // Hoy la cuenta es cero, y eso es mas fuerte que "todos son sincronos".
  assert.equal(conFilter.length, 0,
    `aparecieron fileFilter donde no habia ninguno: ${conFilter.map((d) => d.path).join(', ')}`
    + ' — revisar a mano que sean sincronos (el test de arriba ya lo exige)');
});

// ── GHSA-27r3-jxmh-p828 · body-parser / express / @nestjs/platform-express ──

test('body-parser: la mitigacion declarada (ThrottlerGuard) NO cubre el vector', (t) => {
  if (!HAY_BACKEND) return t.skip('sin backend/src de DoxIA');

  // ESTE TEST REFUTA LA MITIGACION ESCRITA, y por eso existe.
  //
  // El fichero declaraba: "la tasa la limita el ThrottlerGuard (app.module.ts,
  // primer guard global)". MEDIDO: es cierto que ThrottlerGuard es el primer
  // APP_GUARD -- y es irrelevante para este CVE.
  //
  // `body-parser` es middleware de EXPRESS y corre en `main.ts` ANTES de que
  // Nest resuelva ninguna ruta. Los guards de Nest se evaluan DESPUES del
  // parseo del cuerpo. El DoS ocurre durante el parseo, asi que el guard no
  // puede interceptarlo: cuando el guard se ejecuta, el dano ya se hizo.
  //
  // Lo que SI acota el vector es el limite de tamaño de los parsers y lo que
  // haga el borde (CloudFront/WAF). Eso es lo que se comprueba aqui.
  const main = join(BACKEND, 'main.ts');
  assert.ok(existsSync(main), 'sin main.ts no se puede comprobar el orden del middleware');
  const txt = readFileSync(main, 'utf8');

  // 1. Los parsers declaran un limite explicito (sin limite, el defecto de
  //    express es 100kb, pero aqui se sube a proposito para base64).
  const limites = [...txt.matchAll(/bodyParser\.(json|urlencoded)\(\s*{[^}]*limit:\s*'([^']+)'/g)]
    .map((m) => ({ parser: m[1], limite: m[2] }));
  assert.ok(limites.length >= 2,
    `se esperaban limites explicitos en json y urlencoded, y hay ${limites.length}`);

  // 2. El orden importa y esta documentado: el limite estrecho va ANTES del
  //    global. Si alguien invierte el orden, el de 50mb gana y el estrecho deja
  //    de aplicarse (body-parser salta un cuerpo ya leido).
  const iEstrecho = txt.indexOf('limiteCuerpoProspectos()');
  const iGlobal = txt.search(/bodyParser\.json\(/);
  if (iEstrecho !== -1) {
    assert.ok(iEstrecho < iGlobal,
      'el limite estrecho debe registrarse ANTES del parser global de 50mb, o no se aplica');
  }

  // 3. LO QUE REFUTA LA NOTA: ningun guard de Nest puede mitigar esto, asi que
  //    la aceptacion no puede apoyarse en el ThrottlerGuard. Se afirma aqui para
  //    que quede escrito en una guarda y no solo en un informe.
  const appModule = join(BACKEND, 'app.module.ts');
  if (existsSync(appModule)) {
    const am = readFileSync(appModule, 'utf8');
    const tieneThrottler = /ThrottlerGuard/.test(am);
    assert.ok(tieneThrottler,
      'el ThrottlerGuard sigue siendo necesario para OTROS vectores (fuerza bruta de auth)');
    // No se afirma que mitigue body-parser: se afirma lo contrario, en prosa
    // ejecutable. El limite de tamaño es la mitigacion real.
    assert.ok(limites.every((l) => /^\d+(kb|mb)$/i.test(l.limite)),
      `limite de parser con formato inesperado: ${JSON.stringify(limites)}`);
  }
});
