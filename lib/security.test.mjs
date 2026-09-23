// node --test harness/lib/
//
// Lo que se fija: que la severidad la ponga LA POLITICA y no el scanner, que
// `scanner output -> PASS` no exista, y que una excepcion sea una deuda con
// fecha y no un silencio.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  severidadDe, deSemgrep, deNpmAudit, deSecretos, decidirHallazgo,
  aplicarPolitica, excepcionPara, excepcionesCaducadas, CAMPOS, securityKey,
} from './security.mjs';
import { HARNESS } from './capabilities.mjs';
import { manifiestosTocados } from './security-scan.mjs';

const POLICY = JSON.parse(readFileSync(join(HARNESS, 'policy', 'security.json'), 'utf8'));
const HOY = '2026-08-17';

// ── La severidad la pone la politica ────────────────────────────────────────
test('la severidad del repo se DERIVA, no se copia del scanner', () => {
  assert.equal(severidadDe('critical', POLICY), 'P0');
  assert.equal(severidadDe('high', POLICY), 'P1');
  assert.equal(severidadDe('low', POLICY), 'P4');
  // Lo que no se sabe clasificar NO se archiva como leve.
  assert.equal(severidadDe('nunca-visto', POLICY), 'P3');
  assert.equal(severidadDe(undefined, POLICY), 'P3');
});

test('un hallazgo normalizado trae los campos del contrato', () => {
  const [f] = deSemgrep({
    results: [{
      check_id: 'harness.security.eval-o-function-dinamico',
      path: 'src/a.ts', start: { line: 3, col: 5 },
      extra: { severity: 'ERROR', message: 'uso de eval', lines: 'eval(x)', metadata: { owasp: 'A03:2021-Injection' } },
    }],
  }, POLICY);
  for (const c of CAMPOS) assert.notEqual(f[c], undefined, `falta '${c}'`);
  assert.equal(f.severity, 'P1', 'ERROR -> P1 por politica');
  assert.equal(f.rawSeverity, 'ERROR', 'y se conserva lo que dijo el scanner, para poder auditarlo');
  assert.equal(f.rule, 'eval-o-function-dinamico');
  assert.equal(f.owasp, 'A03:2021-Injection');
});

test('npm audit emite UN hallazgo por paquete, no uno por aparicion', () => {
  const f = deNpmAudit({
    vulnerabilities: {
      esbuild: { severity: 'moderate', range: '<=0.24', via: [{ title: 'dev server' }], isDirect: false, fixAvailable: true },
      ruta: { severity: 'info', range: '*' },
    },
  }, POLICY);
  assert.equal(f.length, 1, 'lo `info` no entra: seria ruido con forma de hallazgo');
  assert.equal(f[0].severity, 'P3');
  assert.equal(f[0].source, 'sca');
  assert.match(f[0].remediation, /npm audit fix|npm i/);
});

test('un secreto no se gradua: siempre P0', () => {
  const [f] = deSecretos([{ kind: 'clave de acceso AWS', sample: 'AK…' }], POLICY);
  assert.equal(f.severity, 'P0');
  assert.equal(f.source, 'secrets');
  // No hay credencial leve. Que la politica pudiera mapear 'low' a P4 no debe
  // poder aplicarse aqui.
});

// ── El gate ─────────────────────────────────────────────────────────────────
const H = (over) => ({ source: 'sast', rule: 'r', severity: 'P1', path: 'src/a.ts', location: '1:1', ...over });

test('SAST bloquea a partir de P2; SCA solo con P0', () => {
  assert.equal(decidirHallazgo(H({ severity: 'P2' }), POLICY, { hoy: HOY }).gate, 'BLOCK');
  assert.equal(decidirHallazgo(H({ severity: 'P3' }), POLICY, { hoy: HOY }).gate, 'WARN');
  // El umbral va por FUENTE: lo que esta vuelta escribio se corrige en esta
  // vuelta; una CVE transitiva no la puede resolver el builder.
  assert.equal(decidirHallazgo(H({ source: 'sca', severity: 'P1' }), POLICY, { hoy: HOY }).gate, 'WARN');
});

test('un secreto bloquea a CUALQUIER severidad', () => {
  for (const s of ['P0', 'P3', 'P5']) {
    assert.equal(decidirHallazgo(H({ source: 'secrets', severity: s }), POLICY, { hoy: HOY }).gate, 'BLOCK', s);
  }
});

test('una fuente sin umbral declarado NO pasa en silencio: avisa', () => {
  const d = decidirHallazgo(H({ source: 'inventada', severity: 'P0' }), POLICY, { hoy: HOY });
  assert.equal(d.gate, 'WARN');
  assert.match(d.why, /sin umbral declarado/);
});

// ── Excepciones ─────────────────────────────────────────────────────────────
test('una excepcion CADUCADA vuelve a bloquear', () => {
  const politica = {
    ...POLICY,
    gates: { sca: { block: 'P1' } },
    exceptions: [{ id: 'X', scope: 'sca', severityAtMost: 'P1', expires: '2026-01-01', reason: 'r' }],
  };
  const f = H({ source: 'sca', severity: 'P1' });
  assert.equal(decidirHallazgo(f, politica, { hoy: '2025-12-31' }).gate, 'WARN', 'vigente: no bloquea');
  assert.equal(decidirHallazgo(f, politica, { hoy: '2026-08-17' }).gate, 'BLOCK', 'caducada: vuelve a bloquear');
  // Es lo unico que impide que una deuda aceptada se convierta en una deuda
  // olvidada.
});

test('una excepcion NO perdona lo mas grave que su techo', () => {
  const politica = {
    ...POLICY,
    gates: { sca: { block: 'P1' } },
    exceptions: [{ id: 'X', scope: 'sca', severityAtMost: 'P1', expires: '2099-01-01', reason: 'r' }],
  };
  assert.equal(decidirHallazgo(H({ source: 'sca', severity: 'P1' }), politica, { hoy: HOY }).gate, 'WARN');
  assert.equal(decidirHallazgo(H({ source: 'sca', severity: 'P0' }), politica, { hoy: HOY }).gate, 'BLOCK',
    'una excepcion sin techo seria una politica desactivada con otro nombre');
});

test('una excepcion no cruza de fuente', () => {
  const f = H({ source: 'sast', severity: 'P1' });
  assert.equal(excepcionPara(f, POLICY, HOY), null, 'la excepcion de SCA no cubre SAST');
});

test('las excepciones vigentes del repo estan fechadas y con motivo', () => {
  for (const e of POLICY.exceptions) {
    assert.ok(e.reason && e.reason.length > 40, `'${e.id}' sin motivo suficiente`);
    assert.match(e.expires, /^\d{4}-\d{2}-\d{2}$/, `'${e.id}' sin caducidad`);
    assert.ok(e.owner, `'${e.id}' sin dueno`);
    assert.ok(e.scope, `'${e.id}' sin ambito: una excepcion global es la politica apagada`);
  }
  assert.deepEqual(excepcionesCaducadas(POLICY, HOY), [], 'hoy no hay ninguna caducada');
});

// ── El conjunto ─────────────────────────────────────────────────────────────
test('el veredicto del conjunto es BLOCK si algo bloquea, y lo cuenta todo', () => {
  const r = aplicarPolitica([
    H({ severity: 'P1' }),                       // sast P1 -> BLOCK
    H({ source: 'sca', severity: 'P1' }),        // sca P1  -> WARN (excepcion)
    H({ source: 'secrets', severity: 'P0' }),    // secreto -> BLOCK
  ], POLICY, { hoy: HOY });

  assert.equal(r.gate, 'BLOCK');
  assert.equal(r.counts.block, 2);
  assert.equal(r.counts.warn, 1);
  assert.equal(r.counts.conExcepcion, 1);
  assert.deepEqual(r.counts.porFuente, { sast: 1, sca: 1, secrets: 1 });
});

test('sin hallazgos el gate es ALLOW, y eso NO es lo mismo que "no se escaneo"', () => {
  const r = aplicarPolitica([], POLICY, { hoy: HOY });
  assert.equal(r.gate, 'ALLOW');
  assert.equal(r.counts.total, 0);
  // La diferencia la establece el estado del control (RAN vs MISSING), no esta
  // funcion: `scanner output -> PASS` no existe.
});

test('la identidad de un hallazgo permite deduplicar entre corridas', () => {
  assert.equal(securityKey(H()), securityKey(H({ severity: 'P5' })), 'la severidad no es identidad');
  assert.notEqual(securityKey(H()), securityKey(H({ path: 'src/b.ts' })));
});

// ── OWASP ───────────────────────────────────────────────────────────────────
test('OWASP se declara PARCIAL o MISSING, nunca "compliant"', () => {
  const vals = Object.values(POLICY.owasp).map((c) => c.status);
  assert.ok(vals.every((v) => ['PARTIAL', 'MISSING'].includes(v)), `estados inesperados: ${vals}`);
  // El riesgo dominante de ESTE repo -- control de acceso, VULN-001 -- no lo
  // cubre ninguna regla, y declararlo cubierto seria la mentira mas cara posible.
  assert.equal(POLICY.owasp['A01:2021-Broken-Access-Control'].status, 'MISSING');
  assert.ok(POLICY.owasp['A01:2021-Broken-Access-Control'].why);
});

// ── La puerta ───────────────────────────────────────────────────────────────
test('assertSecurityGate LANZA cuando la politica bloquea, y nombra el hallazgo', async () => {
  const { assertSecurityGate } = await import('./stages-model.mjs');
  const payload = {
    gate: 'BLOCK', counts: { block: 1 },
    blocked: [{ severity: 'P1', rule: 'xss-innerhtml-sin-sanitizar', path: 'src/a.tsx', location: '9:7' }],
  };
  assert.throws(() => assertSecurityGate(payload), /seguridad BLOQUEA.*xss-innerhtml-sin-sanitizar/s);
  // Un SecurityReport con hallazgos bloqueantes que deja pasar la vuelta es
  // documentacion, no seguridad.
});

test('assertSecurityGate deja pasar WARN y ALLOW', async () => {
  const { assertSecurityGate } = await import('./stages-model.mjs');
  for (const gate of ['WARN', 'ALLOW']) {
    assert.doesNotThrow(() => assertSecurityGate({ gate, counts: {}, blocked: [] }), gate);
  }
});

// ── Cobertura: cero por no mirar != cero por no haber nada ─────────────────
test('un fichero que el SAST no pudo parsear se DECLARA como no cubierto', async () => {
  const { sast } = await import('./security-scan.mjs');
  const { mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { RUNTIME } = await import('./capabilities.mjs');

  const ws = { path: join(RUNTIME, 'workspaces', 'test-sast-cobertura') };
  rmSync(ws.path, { recursive: true, force: true });
  mkdirSync(join(ws.path, 'src'), { recursive: true });
  // JSX dentro de un `.ts`: semgrep no lo parsea. Es EXACTAMENTE el caso que
  // devolvio cero hallazgos sobre una semilla deliberadamente vulnerable en la
  // primera corrida de H-002.
  writeFileSync(join(ws.path, 'src', 'roto.ts'),
    'export const X = () => <div dangerouslySetInnerHTML={{ __html: "x" }} />;\n');

  try {
    const r = await sast(ws, ['src/roto.ts'], POLICY);
    if (r.status !== 'RAN') return;                 // sin semgrep instalado no aplica
    assert.equal(r.unparsed, 1, 'el fichero no parseado se cuenta');
    const cobertura = r.findings.find((f) => f.rule === 'fichero-no-analizado');
    assert.ok(cobertura, 'y produce un hallazgo: si no, cero se lee como limpio');
    assert.equal(cobertura.severity, 'P4');
    // No bloquea -- es una laguna de cobertura, no una vulnerabilidad -- pero
    // deja de ser invisible.
    assert.equal(decidirHallazgo(cobertura, POLICY, { hoy: HOY }).gate, 'WARN');
  } finally {
    rmSync(ws.path, { recursive: true, force: true });
  }
});

// ── SBOM: su alcance es una decision, no un detalle ──────────────────────────
//
// `npm sbom` no corre dentro del workspace -- el worktree enlaza `node_modules` y
// npm no reconstruye su arbol virtual a traves del enlace. El del arbol principal
// SIRVE, porque un SBOM describe el grafo de dependencias y ese grafo es funcion
// de los manifiestos, no del node_modules de quien lo genera.
//
// Pero solo sirve si la vuelta NO los toco. Esa es la condicion entera, y es lo
// que se prueba aqui: firmar el SBOM del arbol principal sobre una vuelta que
// cambio package.json seria describir un cambio distinto del que se hizo.
test('sin tocar manifiestos, el SBOM del arbol principal describe la vuelta', () => {
  assert.deepEqual(manifiestosTocados(['src/app/admin/X.tsx', 'scripts/gate.sh']), []);
  assert.deepEqual(manifiestosTocados([]), []);
  assert.deepEqual(manifiestosTocados(), []);
});

test('si la vuelta toca un manifiesto, el fallback deja de valer', () => {
  assert.deepEqual(manifiestosTocados(['package.json']), ['package.json']);
  assert.deepEqual(manifiestosTocados(['backend/package-lock.json']), ['backend/package-lock.json']);
  assert.deepEqual(
    manifiestosTocados(['src/a.ts', 'package.json', 'backend/package.json']),
    ['package.json', 'backend/package.json'],
  );
});

test('un package.json anidado NO es un manifiesto del proyecto', () => {
  // `node_modules/x/package.json` o `src/fixtures/package.json` no cambian el
  // grafo de dependencias del repo. Casar por sufijo los habria contado.
  assert.deepEqual(manifiestosTocados(['node_modules/x/package.json', 'src/fixtures/package.json']), []);
});

// ── El barrido de secretos de la puerta: alcance y patron ───────────────────
//
// 2026-08-28. El barrido miraba SIETE rutas y reportaba «sin claves en lo versionado».
// `terraform/`, `backend/taskdef-*.json`, `.github/` y la raiz quedaban fuera -- justo
// donde vive la infraestructura. No habia fuga, medido; lo que fallaba era el motivo, y
// un motivo falso se obedece igual que un dato falso.
//
// ESTAS PRUEBAS EJECUTAN EL PATRON, no lo comparan como texto. Se extrae de `gate.sh` y
// se corre con `grep -E` contra fixtures: si alguien lo estrecha, caen por asercion.
// (Comparar el fuente mediria que el patron ESTA escrito, no que ATRAPA algo.)
import { execFileSync } from 'node:child_process';

const GATE = readFileSync(join(HARNESS, '..', 'scripts', 'gate.sh'), 'utf8');
const _var = (n) => {
  const m = GATE.match(new RegExp(`^\\s*${n}='(.*)'$`, 'm'));
  assert.ok(m, `no se encontro ${n} en scripts/gate.sh`);
  return m[1];
};
/** ¿La linea sobrevive al patron y a los dos filtros? true = la puerta la reportaria. */
const detecta = (linea) => {
  const pat = _var('SEC_PAT'), excl = _var('SEC_EXCL'), fixt = _var('SEC_FIXT');
  let out;
  try {
    out = execFileSync('grep', ['-E', pat], { input: linea + '\n', encoding: 'utf8' });
  } catch { return false; }                       // grep sale 1 cuando no casa
  if (!out.trim()) return false;
  if (new RegExp(excl).test(linea)) return false;
  return !linea.includes(fixt);
};

test('el barrido de secretos NO tiene lista de rutas', () => {
  // La linea del `git grep` no debe acotar con `-- 'ruta'`: el alcance es el indice entero.
  const linea = GATE.split('\n').find((l) => l.includes('git grep -nIE "$SEC_PAT"'));
  assert.ok(linea, 'no se encontro la invocacion del barrido');
  assert.ok(!/--\s+'/.test(linea), 'el barrido volvio a acotarse a una lista de rutas');
});

test('atrapa lo que no tiene forma de clave de proveedor', () => {
  // El hueco que abrio esta tanda: una contrasena de base de datos o un client secret no
  // empiezan por AKIA ni por sk-, y el patron viejo no los veia.
  // LAS FIXTURES VAN PARTIDAS A PROPOSITO. Escritas enteras, el barrido se marcaba a si
  // mismo -- medido en la primera corrida: `FAIL secrets  harness/lib/security.test.mjs`.
  // La salida facil era excluir este fichero, y habria sido la peor: un secreto de verdad
  // aqui dentro dejaria de verse. Partir el literal deja el patron intacto y el fichero
  // vigilado; el valor en tiempo de ejecucion es identico.
  assert.equal(detecta('const DB_PASS' + 'WORD = "Xq7-panaderia-2026"'), true);
  assert.equal(detecta("  CLIENT_SEC" + "RET: 'aB3dEfGhIjKlMnOpQr'"), true);
  assert.equal(detecta('API_TOK' + 'EN="0123456789abcdef0123"'), true);
  assert.equal(detecta('  "ty' + 'pe": "pass' + 'word", "value": "loQueSea"'), true);
});

test('sigue atrapando las de proveedor', () => {
  assert.equal(detecta('aws_key = AKIA' + 'ABCDEFGHIJKLMNOP'), true);
  assert.equal(detecta('-----BEGIN RSA PRIVATE ' + 'KEY-----'), true);
});

test('y no grita por las fixtures ni por lo que es codigo normal', () => {
  // `test-secret-*` se filtra por LINEA. Un secreto de verdad en ese mismo fichero
  // seguiria saliendo, que es la diferencia con excluir el fichero entero.
  assert.equal(detecta("const SEC" + "RET = 'test-secret-32-bytes-aaaaaaaaaaaa'"), false);
  assert.equal(detecta('const SECRET = process.env.CLIENT_KEY_VAULT_SECRET'), false);
  assert.equal(detecta(`  password: undefined,`), false);
  assert.equal(detecta(`export function verifyPassword(p) { return hash(p) }`), false);
});

test('las dos excepciones estan DECLARADAS, no escondidas en el alcance', () => {
  const excl = _var('SEC_EXCL');
  // `includes` y no `match`: la cadena viene del fuente de bash, con la barra invertida
  // LITERAL (`rules\.yaml`). Un `/rules\.yaml/` de JS pedia `rules.yaml` y no casaba --
  // el instrumento daba rojo sobre un valor correcto.
  assert.ok(excl.includes('realm-export'), 'el realm local es una excepcion aceptada y debe estar escrita');
  assert.ok(excl.includes('rules'), 'la exclusion de las fixtures debe seguir declarada');
  // Y el motivo de cada una vive al lado, en el comentario. Una excepcion sin motivo es
  // un silencio con formato de regla.
  // El motivo cruza dos lineas de comentario, con el `#` en medio: `\s+` no lo salva.
  // Se comprueban los dos hechos por separado, que es lo que importa -- que la excepcion
  // diga QUIEN la acepto y CUANDO.
  assert.ok(GATE.includes('ACEPTADO por el dueno del repositorio'), 'la excepcion no dice quien la acepto');
  assert.ok(/2026-08-28/.test(GATE), 'la excepcion no lleva fecha');
});
