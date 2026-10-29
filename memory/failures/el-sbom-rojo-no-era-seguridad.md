---
id: el-sbom-rojo-no-era-seguridad
title: el muro de la etapa 15 era un desajuste de instalacion, y la mitigacion declarada de body-parser es falsa
type: FAILURE
status: active
mecanismo: adapters/doxia/riesgos-aceptados-mitigaciones.test.mjs (3 tests, 2 mutantes del arbol caen) — el upgrade de vitest NO tiene guarda: requiere decision del usuario en ~/projects/main, fuera del alcance del motor
origin: harness
execution_id: t5-2026-10-29
confidence: 0.9
date: 2026-10-29
agent: orquestador
model: claude-opus-5
promoted_by: emmanuel
---

# El muro de la etapa 15 no era seguridad

> Lo reporte como *«8 vulnerabilidades high, `riesgos-aceptados.json` vacio»*.
> **Las dos mitades eran falsas**, y lo descubri al abrir el fichero que
> supuestamente estaba vacio: tiene 15 entradas con mitigacion, test y caducidad.

## Lo que estaba mal en mi reporte

| Afirme | Medido |
|---|---|
| 8 vulnerabilidades `high` | **5** en backend (+4 en frontend, ya con test) |
| `riesgos-aceptados.json` vacio | **15 entradas**, 0 caducadas, 0 sin aceptar |
| `sca` en rojo | `sca` en **PASS**: `aceptadas vivas: 9 · caducadas: 0 · altas sin aceptar: 0` |

El rojo era **`sbom`**, y su causa no tiene nada que ver con vulnerabilidades:

```
npm error code ESBOMPROBLEMS
npm error invalid: vitest@3.2.7, ^4.1.11 required by iab-group-portal@1.0.0
```

Un unico desajuste de instalacion. `npm sbom` se niega a generar un inventario
de una dependencia que no cumple su propio rango declarado — con razon: un SBOM
que describe un arbol distinto del instalado es peor que no tenerlo.

## El hallazgo real: 5 aceptaciones incumplian la regla #3 del propio fichero

> *"Exige `mitigacion` y `test`: si el riesgo esta cerrado por otra via, esa via
> tiene que tener nombre y guardian. Sin test, no se acepta."*

Cinco entradas decian `"test": "PENDIENTE: ..."`. El gate las contaba como
aceptadas y salia verde. **Una aceptacion con mitigacion no verificada es un WARN
que parece PASS**: el riesgo esta cerrado porque alguien lo escribio, no porque
lo este.

Al medirlas contra el codigo, una de las tres resulto **falsa**:

| CVE | Mitigacion declarada | Medido |
|---|---|---|
| `GHSA-xcx6-jx8p-x3h5` MSAL | «redirect_uri fijo en Azure AD» | **mas fuerte**: el authorization code flow NO EXISTE. Solo `acquireTokenByClientCredential` |
| `GHSA-q7qp-rjg7-q26m` multer | «los fileFilter son sincronos» | **confirmada, y mas fuerte**: no hay NINGUN fileFilter (0 en 8 ficheros) |
| `GHSA-27r3-jxmh-p828` body-parser | «la tasa la limita el ThrottlerGuard» | **FALSA** |

### Por que la de body-parser es falsa

`ThrottlerGuard` **si** es el primer `APP_GUARD` de `app.module.ts` — eso es
cierto y es lo que hacia creible la nota. Y es **irrelevante** para este CVE:

`body-parser` es middleware de **Express**, registrado en `main.ts:61`, y corre
**antes** de que Nest resuelva la ruta. Los guards de Nest se evaluan **despues**
del parseo del cuerpo. El DoS ocurre durante el parseo: cuando el guard llega a
ejecutarse, el dano ya se hizo.

La mitigacion real es el **limite de tamaño** de los parsers y lo que haga el
borde (CloudFront/WAF). El riesgo residual sigue ahi y ahora esta escrito.

## El upgrade de vitest: medido, con linea base

Pregunta: ¿subir a vitest 4 (salto MAYOR) rompe la suite de DoxIA?

**Metodo**: el mismo arbol, con `.git`, cambiando solo la version instalada, y
comparando los tests rojos **por nombre** — no por total, que puede esconder
regresiones compensadas con arreglos.

| Version | Ficheros rojos | Tests rojos |
|---|---:|---:|
| 3.2.7 (instalado hoy) | 6 | **56** |
| 4.1.12 | 6 | **56** |

```
NUEVOS con vitest 4 (regresiones):  0
ARREGLADOS por vitest 4:            0
COMUNES (preexistentes):           56
```

**Identicos test por test.** Y el SBOM pasa de **0 bytes a 491 296 bytes**.

### Dos errores de metodo propios en esta medicion

1. La primera pasada dio **58 rojos** y casi los atribui a vitest 4. El arbol se
   habia copiado **sin `.git`**, y hay specs que leen la historia de la rama
   (`ortografia-documentos.spec.ts` falla con *"¿ancla fuera de la historia de la
   rama?"*). Dos de los 58 eran mi copia, no vitest.
2. Mi primera «linea base» instalo **4.1.12**, no 3.2.7: `package.json` declara
   `^4.1.11`, asi que `npm install` resolvio la version nueva. Comparar 4 contra
   4 y llamarlo linea base no mide nada. Hubo que forzar `--save-exact`.

Los 56 rojos preexistentes se concentran en autenticacion:
`bff.f4` (18), `LoginPage.next` (13), `expedienteBackup` (12), `LoginPage.otp`
(10), `DescargarYArchivar.clave` (2), `sin-lockdown` (1). **No son de este
trabajo y no se tocan aqui.**

## Mecanismo

Las tres frases «PENDIENTE» son ahora predicados en
`adapters/doxia/riesgos-aceptados-mitigaciones.test.mjs`, y se probaron
**mutando el arbol**, no el test: sembrar `acquireTokenByCode` con `redirectUri`
de `req.body` y sembrar un `fileFilter` asincrono hacen caer su test.

Lo que **no** tiene guarda: el upgrade de vitest vive en `~/projects/main`, que
es del usuario (regla #16). Queda medido y decidible, no cerrado.
