import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { llamadas, hallazgos } from '../../lib/etapas-emisibles.mjs';

// La comprobacion contra el `gate.sh` REAL del anfitrion: impide que la regla se cumpla
// porque el fichero cambio de forma y el regex dejo de casar con nada. Vive en el adaptador
// DoxIA porque un motor portable no puede afirmar cosas sobre la puerta de un host.
const GATE = new URL('../../../scripts/gate.sh', import.meta.url);

test('el regex SIGUE CASANDO con el gate real', (t) => {
  if (!existsSync(GATE)) { t.skip('sin scripts/gate.sh: este arbol no es el anfitrion DoxIA'); return; }
  // Sin esto, un cambio de formato en gate.sh dejaria 0 llamadas, 0 hallazgos y un verde
  // que no mira nada. El numero exacto no importa; que haya muchas, si.
  const n = llamadas(readFileSync(GATE, 'utf8')).length;
  assert.ok(n > 20, `solo ${n} llamadas a record reconocidas en gate.sh: el patron dejo de casar`);
});

test('el gate.sh de HOY no tiene ninguna etapa que no pueda fallar', (t) => {
  if (!existsSync(GATE)) { t.skip('sin scripts/gate.sh: este arbol no es el anfitrion DoxIA'); return; }
  const h = hallazgos(readFileSync(GATE, 'utf8'));
  assert.deepEqual(h, [], `etapas que no pueden fallar: ${h.map((x) => x.etapa).join(', ')}`);
});
