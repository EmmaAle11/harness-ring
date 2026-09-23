// node --test harness/lib/alias-vite.test.mjs
//
// DOS AUTORIDADES SOBRE «QUE RESUELVE UN IMPORT», y la puerta solo comprobaba una.
//
// `tsconfig.json` declara `"@/*": ["src/*"]`. `vite.config.ts` no lo resuelve --ni
// por `resolve.alias` ni por plugin-- y `vite-tsconfig-paths` no esta instalado.
//
// REPRODUCIDO el 2026-08-24 con una sonda cableada al grafo:
//
//   npx tsc -p tsconfig.json --noEmit          exit 0   PASA
//   npx vite build                             exit 1   FALLA
//     [vite]: Rollup failed to resolve import "@/lib/apiClient"
//
// Y la tercera pieza: `--fast` NO corre build --lo imprime: «-- build modo --fast»--
// asi que un import por alias ATRAVIESA el pre-commit y el hook de Kiro, entra al
// repo, y muere en CI o en el deploy, donde cuesta mas y el contexto es peor.
// Es `el-build-en-verde-y-la-pagina-en-blanco` con el conducto ya montado.
//
// SE PREGUNTA POR EL HECHO, NO POR EL MECANISMO. Hay dos formas de resolverlo
// --`resolve.alias` o `vite-tsconfig-paths`, que trabaja por un hook `resolveId` y
// NO deja rastro en `resolve.alias`-- asi que exigir una concreta convertiria el
// guarda en una preferencia. Se le pide a vite que RESUELVA. (aviso de third)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './capabilities.mjs';

/** Un fichero real bajo `dir`, para no preguntar por una ruta inventada. */
const unFicheroDe = (dir) => {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return null;
  const f = readdirSync(abs).find((x) => /\.(ts|tsx|mjs|js)$/.test(x));
  return f ? `${dir}/${f}`.replace(/^\.\//, '') : null;
};

test('todo alias que tsconfig declara, vite lo resuelve', async () => {
  const tsc = join(ROOT, 'tsconfig.json');
  if (!existsSync(tsc)) return;                       // rama sin tsconfig: nada que afirmar
  // El tsconfig del repo lleva comentarios; se limpian antes de parsear.
  const paths = JSON.parse(readFileSync(tsc, 'utf8').replace(/\/\/[^\n]*/g, ''))
    ?.compilerOptions?.paths ?? {};
  const alias = Object.entries(paths);
  if (!alias.length) return;                          // sin alias declarados: nada que comprobar

  const { createServer } = await import('vite');
  const s = await createServer({
    configFile: join(ROOT, 'vite.config.ts'), server: { middlewareMode: true }, logLevel: 'silent',
  });
  const desde = join(ROOT, 'src', 'main.tsx');
  const resuelve = async (id) => !!(await s.pluginContainer.resolveId(id, desde));

  try {
    // CONTROL. Sin esto, un `resolveId` roto devolveria null para todo y este test
    // aprobaria «no resuelve nada» como si fuera «no hay alias que comprobar».
    assert.ok(await resuelve('./lib/apiClient'),
      'ni siquiera un import relativo real resuelve: el comprobador esta roto, no la config');

    const rotos = [];
    for (const [patron, destinos] of alias) {
      const dir = String(destinos?.[0] ?? '').replace(/\/?\*$/, '');
      const fichero = unFicheroDe(dir);
      if (!fichero) continue;                         // el destino no existe: otro problema
      const id = patron.replace('*', fichero.slice(dir.length + 1)).replace(/\.(tsx?|mjs|js)$/, '');
      if (!(await resuelve(id))) rotos.push(`${patron} -> ${id}`);
    }

    assert.deepEqual(rotos, [],
      `tsconfig declara ${rotos.join(', ')} y vite NO lo resuelve.\n`
      + 'Un import asi PASA `typecheck:fe` y ROMPE el build -- y `--fast` no corre build, '
      + 'asi que atraviesa el pre-commit y muere en CI. Cablealo en vite.config.ts '
      + '(`resolve.alias`) o instala vite-tsconfig-paths, o quita el alias de tsconfig.');
  } finally {
    await s.close();
  }
});
