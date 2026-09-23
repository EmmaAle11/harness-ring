// Adaptador de ENTRADA — agentes canonicos -> .claude/agents/*.md
//
// ASIMETRIA HONESTA: Claude Code NO tiene mecanismo de permisos por agente.
// Kiro aplica `denied` como `permissions.rules[].effect: deny`; aqui solo puede
// escribirse en el prompt. Quien lo hace cumplir de verdad es el gate en
// .husky/pre-commit. Se DOCUMENTA en el fichero generado en vez de fingir
// paridad -- fingirla seria el defecto de memory/failures/el-fix-que-no-existe.md.
import { writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, loadCapabilities } from '../lib/capabilities.mjs';

function toClaudeCode(a) {
  const fm = [
    '---',
    `name: ${a.id}`,
    `description: ${a.title}`,
    a.tools?.length ? `tools: ${a.tools.join(', ')}` : null,
    '---',
  ].filter(Boolean);

  const limites = [];
  const escribe = a.permissions?.write ?? [];
  if (escribe.length) limites.push(`**Escribes solo en:** ${escribe.join(' · ')}`);
  else limites.push('**No escribes en el arbol.** Tu producto es analisis, no cambios.');

  const veta = [...(a.forbidden ?? []), ...(a.denyPaths ?? [])];
  if (veta.length) {
    limites.push(
      `**Nunca ejecutas ni tocas:** ${veta.join(' · ')}. ` +
        'Claude Code no lo impide por si mismo: lo impide el gate en pre-commit. ' +
        'Que no haya barrera tecnica no lo convierte en permitido.',
    );
  }

  return [
    ...fm,
    '',
    `<!-- GENERADO por \`doxia sync\` desde ${a.source}. NO editar: se sobrescribe. -->`,
    '',
    a.prompt,
    '',
    '---',
    '',
    '## Limites',
    '',
    ...limites.map((l) => `- ${l}`),
    '',
  ].join('\n');
}

export function syncClaudeCode() {
  const dir = join(ROOT, '.claude', 'agents');
  mkdirSync(dir, { recursive: true });

  if (existsSync(dir)) {
    for (const f of readdirSync(dir).filter((f) => f.endsWith('.md'))) rmSync(join(dir, f));
  }

  const out = [];
  for (const a of loadCapabilities()) {
    writeFileSync(join(dir, `${a.id}.md`), toClaudeCode(a));
    out.push(`.claude/agents/${a.id}.md`);
  }
  return out;
}
