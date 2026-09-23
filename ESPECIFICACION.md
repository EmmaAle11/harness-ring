# DoxIA Harness — especificación

La máquina que produce y verifica cambios en DoxIA. **Vive en el repositorio**, no en un IDE: Kiro,
Claude Code, OpenCode, CI y cron son *adaptadores de entrada*; Ollama, Claude y el resto son
*adaptadores de salida* ([ADR-001](../memory/decisions/ADR-001-el-harness-vive-en-el-repositorio.md)).

Qué existe hoy: `plataforma-doxia.md`. Qué construimos:
[`target-state.md`](../memory/architecture/target-state.md). Por qué así:
[`memory/decisions/`](../memory/decisions/).

---

## Las 11 piezas

`EXISTING` = construido y verificado · `PARTIAL` = existe incompleto · `MISSING` = no existe.
No hay `PASS` por buena intención: la misma regla que el gate aplica al código se aplica aquí.

| # | Pieza | Qué es | Dónde vive | Estado |
|---|---|---|---|---|
| 1 | **Knowledge** | Arquitectura, dominio, specs, ADRs, políticas | `memory/` · `.kiro/specs/` · `.kiro/steering/` · bóveda | **EXISTING** |
| 2 | **Memory** | Decisiones, fallos, patrones, vulnerabilidades | `memory/` (6 de 9 clases, anclada por símbolo) | **EXISTING** |
| 3 | **Evidence** | Paquete inmutable por corrida | `.harness/evidence/<sha>-<n>.json` + `.log` + `.sbom.json` | **EXISTING** |
| 4 | **Policy** | Qué se exige y con qué modelo | `scripts/gate.sh` (DoD) · `policy/router.json` · `policy/convergencia.md` | **EXISTING** |
| 5 | **Compute** | Dónde corren los agentes | local + `.github/workflows/ci.yml` | **PARTIAL** — sin sandbox |
| 6 | **Models** | Los proveedores y su resolución | `policy/router.json` + `adapters/models/` | **PARTIAL** — 3 cableados, 3 declarados |
| 7 | **State** | El tablero vivo, que sobrevive a `/compact` | `.harness/state/board.json` | **EXISTING** |
| 8 | **Identity** | Qué puede hacer cada capacidad | `capabilities/*.md` → `permissions` generados | **EXISTING** en Kiro · **PARTIAL** en Claude Code |
| 9 | **Sandbox** | Dónde puede equivocarse sin daño | worktree git aislado | **MISSING** |
| 10 | **Observability** | Traza completa de cada ejecución | evidencia + `state` + `runs/` | **PARTIAL** — evidencia sí, traza no |
| 11 | **Harness** | El orquestador que las une | `bin/doxia.mjs` | **PARTIAL** — `run` solo `--self-review` |

**Lo que falta es exactamente lo que hace que el sistema se ejecute solo:** State, Sandbox, los
adaptadores de modelo y el orquestador. Knowledge, Memory, Evidence y Policy —la mitad *saber*— ya
están. Es el mismo diagnóstico del BASELINE §19: *la capa de conocimiento está muy por delante de la
capa de automatización*.

---

## El anillo — 16 etapas, cerrado

```
PRODUCEN ──────────────────────────────────────────────────────────────────────
Knowledge ─► Evidence ─► Decision ─► Plan ─► Compute ─► Sandbox ─► Execution ─►
JUZGAN ────────────────────────────────────────────────────────────────────────
Security ─► Validation ─► Adversarial ─► Convergence ─►
REGISTRAN ─────────────────────────────────────────────────────────────────────
Capability layer ─► Adapter layer ─► Observability ─► Evidence ─► Learning ─► ⟲
```

| # | Etapa | Dueño | Produce |
|---|---|---|---|
| 1 | **Knowledge** | `researcher` | `ArchitectureBaseline` |
| 2 | **Evidence** | `researcher` | `FactSet` |
| 3 | **Decision** | `architect` | `DecisionRecord` (ADR) |
| 4 | **Plan** | `architect` | `WorkPackage` |
| 5 | **Compute** | *función pura* | `ExecutionAssignment` — **quién** |
| 6 | **Sandbox** | *función pura* | `Workspace` — **dónde** |
| 7 | **Execution** | `builder` | `ChangeSet` |
| 8 | **Security** | `security` | `SecurityReport` — SCA · SBOM · SAST · secretos |
| 9 | **Validation** | `reviewer` | `FindingSet` — los 12 lentes |
| 10 | **Adversarial** | `reviewer` ×3 | `FindingSet` con `verdict`, por mayoría |
| 11 | **Convergence** | *función pura* | `Verdict` — **0 P0–P5** |
| 12 | **Capability layer** | *función pura* | `CapabilitySet` |
| 13 | **Adapter layer** | *función pura* | `AdapterBinding` — qué proveedor sirvió de verdad |
| 14 | **Observability** | *función pura* | `ExecutionTrace` — **detrás de todo lo que describe** |
| 15 | **Evidence** | `release` | `EvidencePackage` |
| 16 | **Learning** | `trigger` | `LearningRecord` → `memory/` |

### Las tres reglas de orden, y lo que costó cada una

**Compute y Sandbox van ANTES de Execution.** Se decide **quién** ejecuta y **dónde** puede
equivocarse antes de dejarle escribir. Al revés, la ejecución ocurre sobre el árbol real y el
aislamiento llega tarde — y este repo tiene dos incidentes medidos que lo demuestran.

**Security va ANTES de Validation** *(2026-08-17)*. Por dos razones que apuntan al mismo sitio:

1. **Es determinista y barata** —semgrep, `npm audit`, barrido de secretos— y va delante de **cuatro
   invocaciones de modelo** (1 de `Validation` + 3 de `Adversarial`). Lo que se puede decidir sin un
   LLM se decide sin un LLM, y además antes de gastarlos.
2. **Detrás de `Convergence` no podía bloquear nunca.** Medido en `H-20260817-ccd41639`: el revisor
   adversarial cazó la XSS sembrada en la etapa 8, `Convergence` bloqueó en la 10, y `Security`
   —entonces en la 11— **no llegó a correr**. Tras el REWORK el builder ya la había corregido, así que
   escaneaba código limpio. Y no era mala suerte: **toda regla capaz de bloquear** (`xss-innerhtml`,
   `eval`, `shell-injection`) describe algo que un revisor competente encuentra. El escáner iba
   siempre segundo **por construcción**.

**Refutar va antes de converger.** Lo dicta la evidencia de esta rama: *47 crudos → 13 refutados → 11
causas raíz*. Deduplicar primero fusionaría un hallazgo real con uno fabricado y le prestaría
credibilidad.

### Y la regla que ordena las mitades

**Ninguna etapa puede resumir lo que todavía no ha ocurrido.** Se descubrió ejecutando:
`Observability` estaba en la posición 9 y su traza reportaba **10 de 16 etapas**, porque las seis
siguientes aún no existían. Por eso las etapas que **registran** van detrás de todo lo que describen.

**Corolario que el anillo no resuelve desde dentro:** `Evidence` y `Learning` tampoco son visibles
para `Observability`. El paquete completo lo sella el orquestador al cerrar la vuelta: una etapa
*dentro* del anillo no puede describir el cierre del anillo.

**Todo lo anterior a Compute es libre de LLM:** son datos y funciones puras. Compute es el punto
exacto donde entra un modelo, y quien lo elige es el router, no otro modelo.

**Lo que lo hace un anillo y no una tubería es el tramo final: Learning → Knowledge.** Una vuelta
empieza sabiendo lo que aprendió la anterior. Sin ese tramo, cada ronda vuelve a descubrir la misma
clase de defecto — que es lo que midieron las rondas 5 a 9: *cinco seguidas encontrando defectos en
las correcciones de la anterior*.

**Commit y Deploy son humanos y no están en el anillo.** Regla #16, y la única barrera real entre una
capacidad y producción. El 2026-08-14 resultó ser además la política de respaldo que salvó el trabajo.

---

## Las capacidades

**Una *Capability* es un puerto: consume unos contratos y produce otros.** Quién la ejecuta —Opus,
`deepseek-coder-v2` en local, un script— es el adaptador, y vive en `policy/router.json`. Mientras el
vocabulario sea «agente», cambiar de proveedor parece un cambio de arquitectura; con capacidades es
un cambio de binding. Ver [`contracts/`](contracts/README.md).

Una por papel, no una por lente. Los 12 lentes son una lista de comprobación dentro del prompt del
`reviewer` — convertir cada lente en un agente está prohibido por el plan, y produce el patrón
`Agente A → código, B → código, C → código` que no converge: colisiona.

| Capability | Etapas | Escribe | Clase de modelo |
|---|---|---|---|
| [`trigger`](capabilities/trigger.md) | orquesta · Learn | `.harness/` | `plan` |
| [`researcher`](capabilities/researcher.md) | Discover · Baseline | — | `read` |
| [`architect`](capabilities/architect.md) | Spec · Plan · Memory | `.kiro/specs/` · `memory/` | `design` |
| [`builder`](capabilities/builder.md) | Build | `src/` · `backend/src/` | `edit` |
| [`reviewer`](capabilities/reviewer.md) | Review · Adversarial | hallazgos | `review` ≠ builder |
| [`security`](capabilities/security.md) | Review | `memory/vulnerabilities/` | `review` |
| [`release`](capabilities/release.md) | Gate · Observe | `.harness/` | `read` |

**Quien encuentra un defecto no lo arregla.** Esa separación es lo que mantiene honesta la
verificación.

### Las herramientas

Una capacidad no ejecuta nada: **pide**. El registro vive en
[`policy/tools.json`](policy/tools.json) y el flujo no admite atajos:

```
MODEL ─► ToolCall ─► HARNESS POLICY ─► TOOL CONTRACT ─► SANDBOX ─► ToolResult ─► MODEL ─► …
                                                                   DONE · BLOCKED · FAILED
```

**La política no se declara en el registro.** Quien autoriza sigue siendo el contrato de la
capacidad, con los predicados que ya existían: `checkWriteBoundary` para rutas (`permissions.write` /
`denyPaths`) y `checkAction` para acciones (`permissions.execute` / `forbidden`). El registro solo
dice qué existe y de qué clase es —`read`, `write`, `exec`— y cuál es la cadena exacta que se compara
contra `permissions.execute`.

Un rechazo **vuelve al modelo con su regla**: es la diferencia entre una política que enseña y una
que solo castiga. Los topes —iteraciones, llamadas, reloj de llamada, reloj de bucle, presupuesto de
transcripción— son del harness y **ningún prompt puede levantarlos**.

---

## Invariantes

Si alguna se rompe, esto dejó de ser un harness:

1. **Un solo escritor de código:** `builder`.
2. **Revisor ≠ escritor**, a nivel de proveedor. Sin dos proveedores vivos → **parada dura**.
3. **Sin evidencia no hay avance.** Lo no comprobable se declara, nunca se aprueba.
4. **La convergencia no la hace un modelo.**
5. **Commit, push y deploy los ejecuta la persona.**
6. **Durable en `memory/`, efímero en `.harness/state/`.** No se mezclan.
7. **No se entrena ningún modelo.**

---

## Estructura

```
harness/
├── README.md              este fichero — la especificación
├── BASELINE.md            DISCOVER del propio harness: dominio, contextos, acoplamiento
├── READINESS.md           puntero: los informes fechados viven en la bóveda, no aquí
├── capabilities/*.md      7 capacidades: definición Y prompt en el mismo fichero
├── contracts/             los artefactos tipados que fluyen entre etapas
├── policy/
│   ├── router.json        clase de tarea → proveedor
│   ├── catalog.json       Provider y Model como entidades separadas
│   ├── learning.json      qué se promueve a memory/ y qué no
│   ├── tools.json         el registro de herramientas y los topes del bucle
│   └── convergencia.md    regla de unificación determinista
├── adapters/              generadores por runtime y por proveedor
├── lib/                   núcleo: frontmatter, router, convergencia (con tests)
└── bin/doxia.mjs          el CLI

.harness/                  runtime, no versionado
├── evidence/              paquetes por corrida
├── state/board.json       el tablero vivo
└── runs/                  traza por ejecución
```

`doxia doctor` · `sync` · `plan` · `run` · `gate` · `state`
