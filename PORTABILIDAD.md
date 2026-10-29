# Portabilidad: medida, cerrada, y cómo volver a comprobarla

**Última medición:** 2026-10-29
**Cómo se obtuvo:** copiando el motor a repositorios terceros vacíos y
ejecutando su propia suite. No es una estimación ni una revisión visual.

---

## El resultado actual

| Entorno | Tests | Pasan | Fallan | Saltados |
|---|---:|---:|---:|---:|
| Este repositorio (plano) | 947 | **874** | **0** | 73 |
| Repo tercero, motor anidado en `<host>/harness/` | 947 | **874** | **0** | 73 |
| Repo tercero, plano, nombre distinto | 947 | **874** | **0** | 73 |

**Las tres formas dan el mismo resultado.** Los 73 saltados son condicionales
declarados (`t.skip` con motivo): los tests del adaptador DoxIA, que afirman
cosas ciertas sobre DoxIA y falsas sobre cualquier otro repositorio.

### Cómo se llegó aquí, y lo que costó

| Medición | Fallos |
|---|---:|
| 2026-09-23 · primera extracción | 94 |
| tras corregir la resolución de raíz (`ports/host.mjs`) | 70 |
| tras separar motor y adaptador | 10 |
| **2026-10-29 · hoy** | **0** |

Los últimos 10 **no eran código que faltara**: eran tests que afirmaban cosas
sobre el árbol anfitrión. Estaban estimados en ~800 líneas de código nuevo y se
cerraron sin escribir ninguna. El detalle, con la atribución fichero por
fichero, está en
[`memory/failures/la-portabilidad-estaba-en-los-tests.md`](memory/failures/la-portabilidad-estaba-en-los-tests.md).

El caso más instructivo: cinco tests de `vectores-plan` tenían escrita la guarda
`t.skip` correcta para «sin histórico» y **ninguno la ejecutaba**, porque
`readdirSync` sobre un directorio inexistente tumbaba el módulo al importarse.
Una guarda que no se alcanza no es una guarda.

---

## La medición histórica (2026-09-23), que explica el diseño

| Entorno | Tests | Pasan | Fallan |
|---|---:|---:|---:|
| Dentro de DoxIA | 875 | **875** | 0 |
| Este repositorio (estructura plana) | 862 | 766 | **94** |
| Motor en árbol ajeno, con nivel `harness/` | 875 | 811 | **64** |

**Los fallos no eran un error de copia.** Eran la medida exacta de cuánto
dependía el motor de su árbol anfitrión. La asimetría *era* el dato: el mismo
código pasaba entero cuando DoxIA estaba presente.

> 862 = 766 pass + 94 fail + **2 skipped**. Los saltados son condicionales
> declarados (`t.skip`), no aprobados: ausencia de qué comprobar y comprobación
> correcta son estados distintos, y un recuento que los suma miente.

## Atribución — sin ella, la cifra infla el problema

Medido sobre los 64 fallos del árbol ajeno, leyendo el motivo de cada uno:

| Causa | Fallos | ¿Deuda de portabilidad? |
|---|---:|---|
| Tests del adaptador DoxIA (`gate.sh`, `.kiro/`, `memory/`, CI, husky, backend) | **44** | **No** — pertenecen al adaptador |
| Atribuidos a la resolución de `ROOT` | 17 | Parcialmente — ver abajo |
| Deuda ajena | 3 | No |

44 de 64 son tests que afirman cosas **ciertas sobre DoxIA y falsas sobre
cualquier otro repositorio**. Contarlos como deuda del motor exagera el problema.

## La atribución a `ROOT` se midió mal, y se corrigió

Un primer instrumento forzaba `ROOT` a la ruta de DoxIA y reportó «7 de 7 fallos
curados» en `sandbox`. Era falso: apuntar `ROOT` al árbol real entrega
**raíz + contenido** a la vez, y curaba dos cosas atribuyéndolo a una.

El discriminador honesto apunta `ROOT` a un directorio que existe y está **vacío**:

| Escenario | Rojos en `sandbox.test.mjs` |
|---|---:|
| sin tocar nada | 7 |
| `ROOT` = DoxIA (raíz **+ contenido**) | 0 |
| `ROOT` = directorio vacío (**solo** la raíz) | **13** |

**Curados con solo la raíz: 0.** Los 13 necesitan el árbol: `remove NUNCA borra
fuera de workspaces` comprueba `existsSync(join(ROOT, 'package.json'))`, y en un
árbol limpio no hay `package.json`.

> **Inyectar la raíz es necesario pero no suficiente.** Tres consumidores ya la
> aceptan y los fallos no bajaron: 64 antes, 64 después. Falta el cableado desde
> el borde, y hasta que exista no hay mejora que publicar.

## Ya migrado al PuertoAnfitrión

| Módulo | Helper | Verificación |
|---|---|---|
| `lib/capabilities.mjs` | `ANFITRION.raiz()` | la raíz se inyecta, ya no se deduce de `import.meta.url` |
| `lib/artifact.mjs` | `raizDe(opciones)` | 18 tests |
| `lib/index-repo.mjs` | `raizDeIndice(r)` | 3 tests; siembra un repo ajeno y comprueba que lo indexa |
| `lib/sandbox.mjs` | `raizSandbox(r)` | 5 tests · **4 mutantes cazados** |

Quedan ~11 consumidores, y **ninguno arregla un fallo medido**: su valor es
coherencia, no reparación. Eso también está medido.

### Los guardarraíles no se relajaron

`sandbox.mjs` decide qué se puede borrar — existe por un incidente que borró 1181
ficheros. La raíz inyectada **no abre nada**: la primera guarda exige que la ruta
esté dentro de `WORKSPACES`, y eso no depende de la raíz. Probado por mutación:
abrir cualquiera de los cuatro límites hace caer un test.

Hallazgo colateral: los **23 tests propios de `sandbox` sobreviven a los 4
mutantes**. Cubren el camino feliz; ninguno probaba que el límite *rechaza*.

## Motor y adaptador, separados por medición

Los tests que exigen el árbol anfitrión viven en `adapters/doxia/`. El corte no se
decidió leyendo: se midió ejecutando cada fichero en un árbol sin DoxIA, y los
casos que fallaban allí son exactamente los que se quedaron en el adaptador.

| Fichero | Motor | Adaptador |
|---|---:|---:|
| `contracts` | 25 | 6 |
| `security` | 21 | 5 |
| `credenciales-sinteticas` | 8 | 5 |
| `artifact` | 7 | 4 |
| `cerrojo-full` | 0 | 8 |
| `memoria-sin-pii` | **no se parte** | — |

`memoria-sin-pii` se dejó entero a propósito: sus 5 casos cuelgan de `barrer`, el
predicado exportado que define qué es PII. Duplicarlo para aislar 2 casos dejaría
dos regex de RFC divergiendo en silencio — dos autoridades para el mismo hecho.

Antes de esto, un solo `readFileSync` en el top-level tumbaba el fichero entero
donde no existía `.kiro/`: **81 casos no fallaban, no se ejecutaban**. Con la
lectura perezosa pasaron de 0 a 64 ejecutables fuera del anfitrión.

---

## Reproducir la medición

```bash
git clone https://github.com/EmmaAle11/harness-ring
cd harness-ring
node --test .
```

Sin `npm install`: cero dependencias, solo builtins `node:`.

### Medir la portabilidad como se mide aquí

```bash
mkdir -p /tmp/prueba/harness && cp -r . /tmp/prueba/harness/
cd /tmp/prueba && git init -q -b main && git add -A
git -c user.email=t@t -c user.name=t commit -q -m i
cd harness && node --test .
```

---

## El estado de la frase que cerraba este documento

Durante un mes esto decía:

> **Este repositorio es el motor _extraído_, no el motor _portable_.**
> Esa frase seguirá siendo la honesta hasta que una vuelta cierre en verde sobre
> un repositorio tercero. [...] Si alguien la declara sin que los 20 fallos
> no-adaptador sean **0**, el comando de arriba lo desmiente.

**Los fallos no-adaptador son 0, medidos en tres formas distintas de árbol.** La
condición que este documento se puso a sí mismo está cumplida, y el comando de
arriba es la forma de desmentirlo si deja de serlo.

Lo que **todavía no** está demostrado, y por eso la frase no se sustituye por una
victoria más amplia:

- **La suite pasa en un repo tercero; una VUELTA del anillo no se ha cerrado
  ahí.** Son cosas distintas: los tests prueban que el motor no asume DoxIA, no
  que el ciclo de 16 etapas produzca una vuelta verde sobre otro proyecto.
- El adaptador de DoxIA sigue siendo el único que existe. Un segundo adaptador es
  lo que probaría que la frontera está en el sitio correcto.

**El motor ya no depende de su anfitrión. Que sirva para otro proyecto es la
siguiente medición, no un corolario de esta.**
