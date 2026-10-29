---
id: la-portabilidad-estaba-en-los-tests
title: los ultimos 10 fallos de portabilidad eran afirmaciones sobre el anfitrion, no deuda del motor
type: FAILURE
status: fixed
mecanismo: lib/docs-enlaces.test.mjs (denominador relativo) · adapters/doxia/docs-enlaces.test.mjs (umbral absoluto aislado) · bin/vectores-plan.mjs (existsSync antes de readdirSync) · ports/host.test.mjs (afirma la FORMA, no el nombre del repo)
origin: harness
execution_id: t3-t4-2026-10-29
confidence: 0.9
date: 2026-10-29
agent: orquestador
model: claude-opus-5
promoted_by: emmanuel
---

# La portabilidad estaba en los tests, no en el motor

> `PORTABILIDAD.md` decia: *"Este repositorio es el motor extraido, no el motor
> portable. Esa frase seguira siendo la honesta hasta que una vuelta cierre en
> verde sobre un repositorio tercero."* Se cerro. Pero no arreglando el motor:
> arreglando tests que afirmaban cosas sobre DoxIA.

## Premisa

T3 y T4 estaban escritas como *"H2 cableado (~380 L)"* y *"H10: 6 puertos
(~420 L)"* — unas 800 lineas de codigo nuevo. Ninguna de las dos existia como
spec en el motor: H-002 es un spec de **DoxIA** (siembra una vulnerabilidad en
`src/app/admin/`), y H-010 no existe en ningun `.kiro/specs/`.

## Medicion

Se ejecuto la prueba que `PORTABILIDAD.md` define como criterio de "hecho":
copiar el motor a un repositorio tercero vacio y correr su propia suite.

| Forma | Fallos |
|---|---:|
| Propio repo (plano) | 0 |
| Repo tercero, motor anidado en `<host>/harness/` | **10** |

Los 10 en 4 ficheros, todos en `lib/` y `ports/` — es decir, **deuda del motor**
segun la atribucion del propio documento, no del adaptador.

## Las cuatro causas (ninguna era codigo que faltara)

| Fichero | Fallos | Causa |
|---|---:|---|
| `lib/router-catalogo.test.mjs` | 3 | leia las policies de `ROOT` (arbol auditado) en vez de `HARNESS` (el motor). Anidado buscaba `<host>/policy/` → ENOENT |
| `lib/vectores-plan.test.mjs` | 5 | `bin/vectores-plan.mjs:23` hacia `readdirSync(BASE)` sin comprobar que existe. ENOENT al importar tumbaba el modulo — **incluidos los 5 tests que YA tenian su `t.skip` para este caso y nunca llegaban a ejecutarla** |
| `ports/host.test.mjs` | 1 | afirmaba `harnessDir().endsWith('/harness-ring')`: **hardcodea el nombre del repositorio**, justo lo que un motor portable no puede asumir. La deduccion era correcta; el test era el bug |
| `lib/sandbox.test.mjs` | 1 | sonda `existsSync(join(ROOT,'package.json'))` para probar que la raiz sigue en pie. Un repo tercero puede no tener `package.json` |

Y uno mas, que aparecio al nacer `memory/` en el motor:

`lib/docs-enlaces.test.mjs` exigia `enlaces > 50`, piso calibrado sobre el
corpus de DoxIA (78 documentos, 134 enlaces el 21-ago). Con un `memory/` de un
documento fallaba **por falta de corpus, no por estar roto**. El umbral absoluto
se movio a `adapters/doxia/docs-enlaces.test.mjs`; en el motor el denominador se
comprueba RELATIVO a lo que hay.

## Resultado (VERIFIED)

```
propio repo (plano)                   947 · 874 pass · 0 fail · 73 skip
repo tercero, anidado <host>/harness/ 947 · 874 pass · 0 fail · 73 skip
repo tercero, plano, nombre distinto  947 · 874 pass · 0 fail · 73 skip
```

Las tres formas identicas. **Cero codigo nuevo de los ~800 L estimados.**

## La leccion

Una estimacion en lineas de codigo asume que lo que falta es codigo. Aqui lo que
faltaba era **borrar suposiciones sobre el anfitrion de dentro de los tests**, y
eso no se descubre leyendo: se descubre ejecutando en el entorno donde la
suposicion es falsa.

El caso de `vectores-plan` es el mas instructivo: cinco tests tenian la guarda
correcta escrita y ninguno la ejecutaba, porque el modulo moria al importarse.
Una guarda que no se alcanza no es una guarda.

## Pendiente, OBSERVED (no se usa para decidir nada)

En la primera corrida sobre un arbol recien creado aparecio **1 fallo** que no
se pudo reproducir: 3 corridas de la suite completa y 3 reproducciones de la
condicion exacta (arbol nuevo, primera corrida) dieron 0 fallos. Ningun fichero
falla aislado. Es un flaky real sin causa identificada — se nombra sin inventarle
un mecanismo.
