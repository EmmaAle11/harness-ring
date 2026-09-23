import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// La aceptacion de un riesgo NO puede convertirse en un silencio. Estos casos son los que impiden
// que este filtro apague la SIGUIENTE vulnerabilidad, que es justo lo que la puerta existe para ver.
const SCRIPT = new URL('./altas-sin-aceptar.mjs', import.meta.url).pathname;

const correr = (audit, aceptados, hoy = '2026-08-23') => {
  const dir = mkdtempSync(join(tmpdir(), 'riesgos-'));
  const ruta = join(dir, 'aceptados.json');
  writeFileSync(ruta, JSON.stringify(aceptados));
  return execFileSync('node', [SCRIPT, 'backend', ruta, hoy], {
    input: JSON.stringify(audit), encoding: 'utf8',
  }).trim();
};

const alta = (paquete, titulo) => ({
  vulnerabilities: { [paquete]: { severity: 'high', via: [{ title: titulo, cve: 'CVE-X', url: 'u' }] } },
});
const ACEPTA_PDFJS = {
  backend: [{ paquete: 'pdfjs-dist', cve: 'CVE-2024-4367', aviso: 'arbitrary JavaScript execution', revisar_antes_de: '2026-09-30' }],
};

test('la alta aceptada no se cuenta', () => {
  assert.equal(correr(alta('pdfjs-dist', 'PDF.js vulnerable to arbitrary JavaScript execution'), ACEPTA_PDFJS), '');
});

test('OTRA vulnerabilidad del MISMO paquete SI se cuenta', () => {
  // Lo aceptado es un riesgo concreto, no un proveedor. Sin esto, aceptar una vez apagaria pdfjs
  // para siempre — y la proxima podria no tener mitigacion.
  const r = correr(alta('pdfjs-dist', 'Otro fallo distinto del aceptado'), ACEPTA_PDFJS);
  assert.match(r, /pdfjs-dist/);
});

test('una alta de OTRO paquete SI se cuenta', () => {
  assert.match(correr(alta('otro-paquete', 'lo que sea'), ACEPTA_PDFJS), /otro-paquete/);
});

test('la aceptacion CADUCA: pasada la fecha, vuelve a contar', () => {
  // Una aceptacion eterna es indistinguible de un descuido.
  const r = correr(alta('pdfjs-dist', 'PDF.js vulnerable to arbitrary JavaScript execution'), ACEPTA_PDFJS, '2026-10-01');
  assert.match(r, /pdfjs-dist/);
});

test('sin registro de aceptados, TODO cuenta (lado seguro)', () => {
  assert.match(correr(alta('pdfjs-dist', 'PDF.js vulnerable to arbitrary JavaScript execution'), {}), /pdfjs-dist/);
});

test('una CRITICAL nunca se cuela por ser del paquete aceptado', () => {
  const audit = { vulnerabilities: { 'pdfjs-dist': { severity: 'critical', via: [{ title: 'algo nuevo y critico' }] } } };
  assert.match(correr(audit, ACEPTA_PDFJS), /pdfjs-dist/);
});

test('sin ninguna alta, no dice nada', () => {
  assert.equal(correr({ vulnerabilities: { x: { severity: 'moderate', via: [] } } }, ACEPTA_PDFJS), '');
});
