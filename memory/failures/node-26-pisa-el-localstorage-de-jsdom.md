---
id: node-26-pisa-el-localstorage-de-jsdom
title: Node >= 22 define localStorage como global undefined y pisa el de jsdom, tumbando 56 tests
type: FAILURE
status: fixed
mecanismo: test/setup-localstorage.ts en DoxIA (restaura el API solo si el entorno no la trae; se autodesactiva cuando upstream lo arregle) · harness/security/vitest-cerrado.test.mjs exige vitest >= 4.1.11 en el lock
origin: harness
execution_id: t5-cierre-2026-10-29
confidence: 0.9
date: 2026-10-29
agent: orquestador
model: claude-opus-5
promoted_by: emmanuel
---

# Node 26 pisa el localStorage de jsdom

> 56 tests rojos que parecian deuda de autenticacion eran **un global de Node
> que tapa el del DOM simulado**. Ningun test estaba mal escrito y ningun
> codigo de produccion estaba roto.

## El sintoma

```
TypeError: Cannot read properties of undefined (reading 'clear')
 ❯ src/app/clientPortal/lib/expedienteBackup.spec.ts:8:31
      8| beforeEach(() => localStorage.clear());
```

56 tests en 6 ficheros: `bff.f4` (18), `LoginPage.next` (13),
`expedienteBackup` (12), `LoginPage.otp` (10), `DescargarYArchivar.clave` (2),
`sin-lockdown` (1). Todos de sesion/almacenamiento.

## Las dos hipotesis que REFUTE antes de acertar

**1. «Es vitest 4, que es un salto mayor.»** Medido en el mismo arbol con `.git`,
comparando los rojos **por nombre** y no por total:

| | ficheros | tests rojos |
|---|---:|---:|
| vitest 3.2.7 | 6 | 56 |
| vitest 4.1.12 | 6 | 56 |

`nuevos 0 · arreglados 0 · comunes 56` — identicos test por test.

**2. «Es jsdom 29, demasiado nuevo.»** Medido con tres versiones sobre los 3
ficheros mas rojos: jsdom **29.1.1 → 40 fallos**, **26.1.0 → 40**, **24.1.3 →
40**. La version de jsdom es irrelevante.

## La causa real

Node ≥ 22 define `localStorage` como **global nativo experimental**:

```
ExperimentalWarning: localStorage is not available because
--localstorage-file was not provided
```

Sin ese flag el global existe y vale `undefined`, y **tapa el que jsdom instala
en `window`**. Las sondas lo confirman:

```
window.location.href : http://localhost:3000/     <- origen correcto, no opaco
'localStorage' in window : true                   <- el descriptor existe
typeof localStorage      : undefined              <- y vale undefined
```

Descarta de paso el `SecurityError: localStorage is not available for opaque
origins` de jsdom, que seria el sospechoso natural: ese se da con
`about:blank`, y aqui la URL es real.

Node medido: **v26.8.1**.

## El hallazgo colateral, que era la mitad del problema

```
package-lock.json  ->  vitest 4.1.12
node_modules/      ->  vitest 3.2.7
```

El lock ya tenia 4.1.12 desde el 14/10 (cierre de `GHSA-82fw`), y existe un
guardian —`harness/security/vitest-cerrado.test.mjs`— que lo exige. **El arbol
instalado estaba desincronizado del lock**, y eso ademas rompia el SBOM:

```
npm error ESBOMPROBLEMS
npm error invalid: vitest@3.2.7, ^4.1.11 required
```

No habia ninguna decision de upgrade pendiente: habia un `npm ci` sin hacer.

## El arreglo y su resultado (VERIFIED)

`npm ci` + `test/setup-localstorage.ts` (20 L) + una linea en `vitest.config.ts`:

```
antes:   56 rojos en 6 ficheros   ·  SBOM 0 bytes
despues: 3361 / 3361 verdes · 0   ·  SBOM 491 293 bytes, CycloneDX 1.5, 514 componentes
```

## Mecanismo, y su limite declarado

El apaño restaura el API **solo si el entorno no la trae**
(`typeof globalThis.localStorage === 'undefined'`), asi que **se autodesactiva**
el dia que Node o jsdom dejen de pisarse. No es un arreglo de raiz: lo correcto
es que upstream lo resuelva.

Limite que no se disimula: el almacen es un `Map` por worker y **no persiste
entre ficheros**. Es lo que estos tests esperan (`beforeEach(clear)`), pero un
test futuro que dependa de persistencia real fallara y el motivo no sera obvio.

## La leccion

Dos veces atribui el fallo a la herramienta mas nueva y visible (vitest 4,
jsdom 29) antes de mirar el runtime. Lo que lo destapo no fue leer codigo: fue
imprimir `typeof localStorage`, `window.location.origin` y `'localStorage' in
window` por separado — tres sondas que distinguen «no existe» de «existe y vale
undefined» de «lanza al acceder». Un `TypeError` sobre `undefined` no dice cual
de las tres es.
