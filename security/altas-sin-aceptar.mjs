#!/usr/bin/env node
// Lee `npm audit --json` por stdin y dice que ALTAS quedan SIN aceptar.
//
// Existe para que la aceptacion de un riesgo NO sea un silencio. El gate reportaba `sca:be WARN 1
// high` y el usuario pidio cerrarlo; cerrarlo con un `|| true` habria apagado tambien la SIGUIENTE
// vulnerabilidad, que es justo lo que la puerta existe para ver.
//
// Reglas (las mismas que declara riesgos-aceptados.json):
//   - se casa por PAQUETE + AVISO (titulo o CVE). Otra vulnerabilidad del mismo paquete NO esta
//     aceptada: lo aceptado es un riesgo concreto, no un proveedor.
//   - la aceptacion CADUCA. Pasada su fecha vuelve a contar, y se dice por que.
//
// Salida: una linea por alta sin aceptar (vacio = ninguna), y en stderr el resumen para el log.
import { readFileSync } from 'node:fs';

const [, , proyecto, rutaAceptados, hoyISO] = process.argv;
const hoy = hoyISO || new Date().toISOString().slice(0, 10);

let auditJson = '';
process.stdin.on('data', (c) => (auditJson += c));
process.stdin.on('end', () => {
  let audit;
  try { audit = JSON.parse(auditJson); } catch { process.stderr.write('audit no-JSON\n'); process.exit(2); }

  let aceptados = [];
  try {
    aceptados = (JSON.parse(readFileSync(rutaAceptados, 'utf8'))[proyecto] || []);
  } catch { /* sin registro: nada aceptado, que es el lado seguro */ }

  const vivas = aceptados.filter((a) => !a.revisar_antes_de || a.revisar_antes_de >= hoy);
  const caducadas = aceptados.filter((a) => a.revisar_antes_de && a.revisar_antes_de < hoy);

  const altas = [];
  for (const [nombre, v] of Object.entries(audit.vulnerabilities || {})) {
    if (v.severity !== 'high' && v.severity !== 'critical') continue;
    const textos = (v.via || []).map((x) => (typeof x === 'string' ? x : `${x.title || ''} ${x.cve || ''} ${x.url || ''}`));
    const aceptada = vivas.some(
      (a) => a.paquete === nombre && textos.some((t) => t.includes(a.aviso) || (a.cve && t.includes(a.cve))),
    );
    if (!aceptada) altas.push(`${nombre} (${v.severity})`);
  }

  for (const c of caducadas) {
    process.stderr.write(`ACEPTACION CADUCADA: ${c.paquete} (${c.cve}) vencio el ${c.revisar_antes_de} — vuelve a contar\n`);
  }
  process.stderr.write(`aceptadas vivas: ${vivas.length} · caducadas: ${caducadas.length} · altas sin aceptar: ${altas.length}\n`);
  if (altas.length) process.stdout.write(altas.join('\n') + '\n');
});
