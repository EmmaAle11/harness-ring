// ── Adaptador DoxIA · PuertaDeCalidad ────────────────────────────────────────
//
// TODO lo que sabe que en este proyecto la puerta se llama `scripts/gate.sh`,
// se invoca con bash y escribe en `.harness/evidence/`. Un proyecto nuevo borra
// este fichero y escribe el suyo; el nucleo no cambia.
//
// EL DETALLE QUE COSTO UNA VUELTA: la evidencia se lee de la raiz DEL WORKSPACE,
// no del arbol principal. Leerla del principal fue un defecto real documentado
// en `stages.mjs:22-31`: el gate corria dentro del workspace y el motor iba a
// buscar su resultado a otro sitio.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const GATE = ['scripts', 'gate.sh'];

export function puertaDoxia({ timeoutMs = 1_800_000 } = {}) {
  const rutaGate = (ws) => join(ws, ...GATE);

  return {
    id: () => 'doxia:gate.sh',

    // Se puede preguntar AL ARRANCAR. Hoy esto explota en la etapa 15.
    disponible(ws) {
      const p = rutaGate(ws);
      return existsSync(p)
        ? { ok: true, porque: `${GATE.join('/')} presente` }
        : { ok: false, porque: `falta ${GATE.join('/')} en ${ws}` };
    },

    capabilities: () => ({
      modos: ['fast', 'full'],
      escribeEvidencia: true,
      correlacionaEjecucion: true,   // acepta DOXIA_EXECUTION_ID
    }),

    ejecutar({ workspace, modo = 'full', executionId, env = {}, timeout = timeoutMs }) {
      const t0 = Date.now();
      const d = this.disponible(workspace);
      if (!d.ok) {
        return { veredicto: 'NOT_CONFIGURED', codigoSalida: null, stdout: '', stderr: d.porque, ms: 0 };
      }
      // ENV_LIMPIO no se replica aqui: quien invoque este adaptador pasa el env
      // ya saneado. Duplicar el saneo crearia una segunda autoridad sobre GIT_*,
      // y ese guarda existe porque su ausencia borro 1181 ficheros.
      let stdout = '', stderr = '', codigoSalida = 0;
      try {
        stdout = execFileSync('bash', [rutaGate(workspace), `--${modo}`], {
          cwd: workspace, encoding: 'utf8', timeout,
          env: { ...env, ...(executionId ? { DOXIA_EXECUTION_ID: executionId } : {}) },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (e) {
        codigoSalida = e.status ?? 1;
        stdout = e.stdout?.toString() ?? '';
        stderr = e.stderr?.toString() ?? String(e.message ?? e);
      }
      return {
        veredicto: codigoSalida === 0 ? 'PASS' : 'FAIL',
        codigoSalida, stdout, stderr, ms: Date.now() - t0,
      };
    },

    // EL PUNTERO, no solo el veredicto: sin el no se puede auditar que fallo.
    rutaDeEvidencia({ workspace, sha }) {
      const dir = join(workspace, '.harness', 'evidence');
      if (!existsSync(dir) || !sha) return null;
      const p = join(dir, `${sha}.json`);
      return existsSync(p) ? p : null;
    },

    leerChecks(ruta) {
      if (!ruta || !existsSync(ruta)) return [];
      try {
        const j = JSON.parse(readFileSync(ruta, 'utf8'));
        return (j.checks ?? []).map((c) => ({
          check: c.check ?? c.name, status: c.status, detalle: c.detail ?? c.detalle ?? '',
        }));
      } catch { return []; }
    },

    describe: () => ({
      id: 'doxia:gate.sh',
      comando: `bash ${GATE.join('/')} --<modo>`,
      evidencia: '.harness/evidence/<sha>.json en la raiz DEL WORKSPACE',
    }),
  };
}
