import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  severidadDe, deSemgrep, deNpmAudit, deSecretos, decidirHallazgo,
  aplicarPolitica, excepcionPara, excepcionesCaducadas, CAMPOS, securityKey,
} from '../../lib/security.mjs';
import { HARNESS } from '../../lib/capabilities.mjs';
import { manifiestosTocados } from '../../lib/security-scan.mjs';
import { execFileSync } from 'node:child_process';

const GATE = () => readFileSync(join(HARNESS, '..', 'scripts', 'gate.sh'), 'utf8');

const _var = (n) => {
  const m = GATE().match(new RegExp(`^\\s*${n}='(.*)'$`, 'm'));
  assert.ok(m, `no se encontro ${n} en scripts/gate.sh`);
  return m[1];
}

const detecta = (linea) => {
  const pat = _var('SEC_PAT'), excl = _var('SEC_EXCL'), fixt = _var('SEC_FIXT');
  let out;
  try {
    out = execFileSync('grep', ['-E', pat], { input: linea + '\n', encoding: 'utf8' });
  } catch { return false; }                       // grep sale 1 cuando no casa
  if (!out.trim()) return false;
  if (new RegExp(excl).test(linea)) return false;
  return !linea.includes(fixt);
}

test('el barrido de secretos NO tiene lista de rutas', () => {
  // La linea del `git grep` no debe acotar con `-- 'ruta'`: el alcance es el indice entero.
  const linea = GATE().split('\n').find((l) => l.includes('git grep -nIE "$SEC_PAT"'));
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
  assert.ok(GATE().includes('ACEPTADO por el dueno del repositorio'), 'la excepcion no dice quien la acepto');
  assert.ok(/2026-08-28/.test(GATE()), 'la excepcion no lleva fecha');
});
