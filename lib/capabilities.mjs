// Carga de agentes — el unico sitio que sabe que un agente es un .md con
// frontmatter. Si manana el formato cambia, cambia aqui.
//
// El fichero ES la definicion Y el prompt (ADR-001): un JSON de config mas un
// .md de prompt serian dos autoridades que derivan.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter } from './frontmatter.mjs';
import { anfitrionPorDefecto } from '../ports/host.mjs';

// ── La raiz ya NO se deduce aqui: la resuelve el PuertoAnfitrion ────────────
//
// Antes estas tres lineas derivaban el arbol auditado de la posicion de ESTE
// fichero en disco. Eso ataba el motor a vivir dentro del repo que audita:
// instalado en `node_modules/@harness/ring`, ROOT habria apuntado a
// `node_modules`. Era el bloqueante anterior a todos los demas -- 67
// referencias a ROOT en 16 ficheros, todas componiendose contra una raiz
// adivinada.
//
// AHORA la raiz entra por `ports/host.mjs`, que puede recibirla inyectada. Los
// tres exports se conservan con el MISMO valor para que los 16 ficheros sigan
// funcionando mientras se migran de uno en uno: un refactor que rompe todo a la
// vez no se puede verificar por partes.
//
// `anfitrionPorDefecto()` DECLARA en su `describe().origen` que dedujo la raiz,
// asi que la traza distingue un anfitrion deducido de uno configurado. Esa
// distincion es la que permitira, mas adelante, exigir que sea explicita.
export const ANFITRION = anfitrionPorDefecto();
export const HARNESS = ANFITRION.harnessDir();
export const ROOT = ANFITRION.raiz();
export const RUNTIME = ANFITRION.runtimeDir();

export function loadCapabilities() {
  const dir = join(HARNESS, 'capabilities');
  if (!existsSync(dir)) return [];

  return readdirSync(dir)
    .filter((f) => f.endsWith('.md') && f !== 'README.md')
    .map((f) => {
      const { data, body } = parseFrontmatter(readFileSync(join(dir, f), 'utf8'));
      return {
        ...data,
        id: data.id || f.replace(/\.md$/, ''),
        prompt: body,
        source: `harness/capabilities/${f}`,
      };
    })
    .filter((a) => a.status !== 'retired')
    .sort((a, b) => a.id.localeCompare(b.id));
}

export const loadRouter = () =>
  JSON.parse(readFileSync(join(HARNESS, 'policy', 'router.json'), 'utf8'));

/** Politica de promocion: quien decide que un aprendizaje entra en memory/. */
export const loadLearningPolicy = () =>
  JSON.parse(readFileSync(join(HARNESS, 'policy', 'learning.json'), 'utf8'));

/** Provider y Model como entidades separadas. Lo que permite a Compute razonar
 *  sobre capacidades sin saber como se invoca nada. */
export const loadCatalog = () =>
  JSON.parse(readFileSync(join(HARNESS, 'policy', 'catalog.json'), 'utf8'));

/** Change Surface Budget: cuanto puede cambiar una vuelta. Sus numeros estan medidos. */
export const loadSurfacePolicy = () =>
  JSON.parse(readFileSync(join(HARNESS, 'policy', 'surface.json'), 'utf8'));
