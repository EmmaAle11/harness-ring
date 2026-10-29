import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { revisar } from '../../lib/spec.mjs';
import { ROOT } from '../../lib/capabilities.mjs';

// EL MANIFIESTO REAL (del anfitrion) tiene que pasar su propio preflight. Vive en el
// adaptador DoxIA porque el .kiro/ del host no viaja con el motor.
const H001 = join(ROOT, '.kiro/specs/h-001-ring-execution/h-001.json');

test('el manifiesto H-001 versionado pasa el preflight', (t) => {
  if (!existsSync(H001)) { t.skip('sin .kiro/specs/h-001-ring-execution/h-001.json: este arbol no es el anfitrion DoxIA'); return; }
  const m = JSON.parse(readFileSync(H001, 'utf8'));
  assert.deepEqual(revisar(m.task), [], 'la tarea que ya converge no puede quedar bloqueada por el preflight');
});
