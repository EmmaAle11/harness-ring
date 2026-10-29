import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { loadCapabilities } from '../../lib/capabilities.mjs';

// EVIDENCE contra el anillo REAL del anfitrion: las etapas que declara cada capacidad
// tienen que existir en el manifiesto H-001 del host. Vive en el adaptador DoxIA porque
// el manifiesto no viaja con el motor.
const caps = loadCapabilities();
const H001 = new URL('../../../.kiro/specs/h-001-ring-execution/h-001.json', import.meta.url);

test('EVIDENCE: toda etapa declarada existe en el anillo real', (t) => {
  if (!existsSync(H001)) { t.skip('sin .kiro/specs/h-001-ring-execution/h-001.json: este arbol no es el anfitrion DoxIA'); return; }
  const M = JSON.parse(readFileSync(H001, 'utf8'));
  const delAnillo = new Set(M.stages.map((s) => s.stage));
  // `Orchestration` es del trigger y vive FUERA del anillo: se declara aparte.
  const fuera = new Set(['Orchestration', 'Evidence2']);
  for (const c of caps) {
    for (const s of c.allowedStages ?? []) {
      assert.ok(delAnillo.has(s) || fuera.has(s),
        `'${c.id}' declara la etapa '${s}', que no existe en el anillo`);
    }
  }
});
