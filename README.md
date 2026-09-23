# HARNESS RING

Motor de automatización agéntica de **16 etapas** que orquesta modelos de
lenguaje para producir cambios de código **verificados**. JavaScript puro
(Node.js ESM), **cero dependencias npm**, `node --test` como runner.

---

## Aviso de honestidad, antes que nada

**Este motor todavía no es portable.** Nació dentro de un proyecto concreto
(DoxIA, una plataforma fiscal) y está en proceso de separarse. Clonarlo y
apuntarlo a otro repositorio hoy **no funcionaría**, y decirlo aquí es más útil
que descubrirlo en la primera vuelta.

Lo que está medido, no estimado:

| | |
|---|---|
| Ficheros del motor | 160 |
| Suite propia | **840 tests** |
| Vueltas archivadas | **44** |
| Raíces externas con uso **ejecutable** | **6** — `scripts`, `memory`, `.kiro`, `src`, `backend`, `.claude` |
| Puertos hexagonales escritos | **3 de 13** |

Esas 6 raíces son exactamente los puertos que faltan. Mientras existan, este
repositorio es **el motor extraído y en migración**, no un paquete instalable.

> La portabilidad no se declara, se demuestra: hasta que una vuelta cierre en
> verde sobre un repositorio tercero, la frase honesta es «el harness de DoxIA,
> con puertos dentro».

---

## Qué hace

Un pipeline de 16 etapas donde cada una consume contratos y produce artefactos
JSON verificables:

```
01 Knowledge → 02 Evidence → 03 Decision → 04 Plan → 05 Compute → 06 Sandbox
→ 07 Execution → 08 Security → 09 Validation → 10 Adversarial → 11 Convergence
→ 12 CapabilityLayer → 13 AdapterLayer → 14 Observability → 15 Evidence2
→ 16 Learning
```

**Un solo escritor de código.** Quien encuentra un defecto no lo arregla: esa
separación es lo que mantiene honesta la verificación. Cuatro escritores no
convergen, colisionan.

**El revisor no comparte familia de modelo con el constructor** (ADR-003). Si no
hay una tercera familia para el adversarial, el motor lo **declara**
(`independence: DEGRADED`) en lugar de fingir independencia.

Detalle de las 11 piezas y sus contratos: [`ESPECIFICACION.md`](ESPECIFICACION.md).

---

## Dónde muere el caudal

Medido sobre 41 vueltas con artefactos. No es una opinión sobre qué etapa parece
difícil: es dónde se detiene el flujo.

| Etapa | Llegan | Pasan | Tasa |
|---|---:|---:|---:|
| **07 Execution** | 42 | 21 | **50.0 %** |
| **11 Convergence** | 18 | 8 | **44.4 %** |
| 15 Evidence2 | 7 | 5 | 71.4 % |
| Las otras 13 | — | — | 90–100 % |

La correlación entre posición en el anillo y dificultad es **r = −0.0976: no
existe**. Lo que parecía tendencia —«cuanto más cerca del final, peor»— era el
embudo: una etapa no puede alcanzarse más veces que la anterior, así que el
alcance baja siempre por construcción. Con la tasa condicional, la correlación
desaparece.

---

## El ρ-gate

Parada temprana por **densidad de acción**:

```
ρ(t) = llamadas_a_herramienta(t) / iteraciones(t)
```

Responde a una pregunta: *¿el builder sigue tocando el repositorio, o lleva rato
razonando en círculo?* Cuando deja de tocarlo, no vuelve.

| Grupo | n | ρ |
|---|---:|---|
| Terminan OK | 15 | 0.900 – 0.958 |
| Agotan el presupuesto | 7 | 0.156 – 0.725 |

Retrovalidado contra las vueltas archivadas: **TP=7, FN=0, FP=0, TN=15** —
precisión y recall 1.00, con **52 % de las iteraciones** identificadas como cola
desperdiciada.

Un intento anterior de predecir el desenlace desde el vector de superficie del
cambio **fracasó**: 29 vueltas ocupaban 5 posiciones del espacio y el techo de
cualquier clasificador era +0.0 % sobre el baseline. La lección quedó escrita —
*el vector describe lo que la spec **pide**, no lo que la ejecución
**encuentra***. ρ solo existe durante la ejecución.

El umbral se recalibró tras fallar con una tarea 4,4× mayor que las usadas para
fijarlo. Se supo porque esa vuelta corrió **en sombra**: midiendo sin decidir.

---

## Arquitectura: puertos y adaptadores

```
ports/      los contratos: qué necesita el motor del mundo exterior
adapters/
  doxia/    todo lo que sabe que existe DoxIA — lo único que un proyecto reescribe
  models/   claude · deepseek · ollama · opencode
lib/        el motor
policy/     configuración que el motor LEE (no sabe)
capabilities/  cada fichero ES la definición y el prompt a la vez
```

### Estado de los puertos

| Puerto | Estado | Qué desacopla |
|---|---|---|
| **Anfitrión** | ✅ | de dónde sale la raíz del proyecto |
| **PuertaDeCalidad** | ✅ | `scripts/gate.sh` |
| **ProveedorDeModelos** | ✅ | ya existía y era correcto |
| AlmacénDeMemoria | ⬜ | `memory/*.md` |
| LocalizadorDeSpecs | ⬜ | `.kiro/specs/` |
| EjecutorDePruebas | ⬜ | vitest/jest, sufijos `.spec.ts` |
| EspacioDeTrabajo | ⬜ | git worktree + `node_modules` |
| TaxonomíaDeCódigo | ⬜ | TS/TSX, `src/`, `backend/src/` |
| + 5 más | ⬜ | escáner, entorno, repo, contexto, trazas |

**El bloqueante 0, ya resuelto.** El motor derivaba la raíz del proyecto de su
propia posición en disco (`import.meta.url`), con 67 referencias en 16 ficheros.
Instalado bajo `node_modules/`, habría auditado el gestor de paquetes. Ahora la
raíz se **inyecta**; el comportamiento deducido se conserva por compatibilidad y
**declara en su traza** que dedujo en vez de recibir.

### Dos reglas mecanizadas

1. **Ningún puerto importa un adaptador** — un test recorre `ports/` y falla si
   encuentra un `import` hacia `adapters/`. Sin eso, la inversión de
   dependencias estaría invertida al revés y el hexágono sería decorativo.
2. **Un adaptador ausente nunca devuelve PASS** — responde `NOT_CONFIGURED` y el
   motor para. *Cero hallazgos porque el control no corrió* y *cero hallazgos
   porque no había nada* son estados distintos, y quien los confunde es quien se
   pierde.

---

## Uso

```bash
node bin/doxia.mjs doctor              # qué proveedores responden de verdad
node bin/doxia.mjs run --ring <spec>   # recorre el anillo
node --test .                          # 840 tests
```

---

## Principios que este motor ya pagó caro

1. **Una cita inventada no demuestra lectura: la desmiente.**
2. **El workspace se construye desde HEAD**, no del árbol de trabajo.
3. **`s² = 0` no prueba determinismo** — solo dice que las vueltas pararon en la
   misma puerta.
4. **El piso de un gate va en la cifra del entorno más pobre**, no del árbol
   donde se escribe.
5. **Un resultado que parece bueno y no midió nada es peor que un error: se
   cita.**
6. **Medir antes de cortar.** Un umbral calibrado en un régimen falla en otro, y
   solo se sabe corriendo en sombra.
7. **Un test que pasa por el motivo equivocado no prueba nada.**

---

## Licencia

MIT
