// Adaptador de ENTRADA — agentes canonicos -> .kiro/agents/*.json
//
// Kiro es el unico runtime de los dos que APLICA permisos: su schema tiene
// `permissions.rules[].effect: allow|deny|ask`. Por eso aqui `denied` deja de
// ser una frase en un prompt y pasa a ser una regla que el runtime hace cumplir.
//
// Lo generado es ARTEFACTO, no fuente. Se regenera con `doxia sync`.
import { writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, loadCapabilities } from '../lib/capabilities.mjs';

const AVISO =
  'GENERADO por `doxia sync` desde harness/capabilities/. NO editar a mano: se sobrescribe. ' +
  'La fuente es el .md, que es a la vez definicion y prompt (ADR-001).';

function toKiro(a) {
  const rules = [];

  // El DENY va PRIMERO, y el orden no es estetico: si el motor resuelve por
  // primera coincidencia, una regla de denegacion escrita despues del allow no
  // se aplica nunca. Una frontera que depende del orden de la lista es una
  // frontera que se rompe la proxima vez que alguien reordene.
  const escribe = a.permissions?.write ?? [];
  for (const d of a.denyPaths ?? []) rules.push({ capability: 'fsWrite', match: [`${d}/**`], effect: 'deny' });

  // Lo que puede escribir. Sin `permissions.write` -> solo lectura.
  if (escribe.length) {
    rules.push({ capability: 'fsWrite', match: escribe.map((w) => `${w}/**`), effect: 'allow' });
  }
  rules.push({ capability: 'fsWrite', effect: escribe.length ? 'ask' : 'deny' });

  // Lo que NO puede hacer nunca. Regla #16: commit, push y deploy son humanos.
  for (const cmd of a.forbidden ?? []) {
    rules.push({ capability: 'executeBash', match: [cmd], effect: 'deny' });
  }

  return {
    $generated: AVISO,
    name: a.id,
    description: a.title,
    prompt: a.prompt,
    tools: a.tools?.length ? a.tools : '*',
    excludedTools: escribe.length ? [] : ['fsWrite', 'fsReplace'],
    dispatchKind: 'custom-agent',
    permissions: { rules },
    $doxia: { role: a.role, model_class: a.model_class, gate: a.gate, source: a.source },
  };
}

export function syncKiro() {
  const dir = join(ROOT, '.kiro', 'agents');
  mkdirSync(dir, { recursive: true });

  // Se borra lo generado antes: un agente retirado debe DESAPARECER, no quedar
  // huerfano decidiendo cosas.
  if (existsSync(dir)) {
    for (const f of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
      rmSync(join(dir, f));
    }
  }

  const out = [];
  for (const a of loadCapabilities()) {
    const path = join(dir, `${a.id}.json`);
    // sin-redactar: es CONFIGURACION de un IDE (.kiro/agents/*.json), no un
    // artefacto de vuelta. CI no sube .kiro/ como evidencia, y redactarlo
    // romperia el fichero que Kiro lee.
    writeFileSync(path, JSON.stringify(toKiro(a), null, 2) + '\n');
    out.push(`.kiro/agents/${a.id}.json`);
  }
  return out;
}
