# Harness Architecture Baseline

**Fase DISCOVER del propio harness.** Qué **es**, con evidencia medida. No qué debería ser — eso es
[`target-state.md`](../memory/architecture/target-state.md).

El harness exige a DoxIA que ninguna afirmación se emita sin evidencia. Este documento existe porque
esa exigencia se aplica **también a él**: un plano de control que no se somete a su propio proceso es
otra vez una regla escrita que nadie hace cumplir.

Medido sobre el árbol del 2026-08-13, tras el paso de *Agent* a *Capability*.

---

## 1. ¿Cuál es el dominio del Harness?

**Producir y verificar cambios en DoxIA, dejando evidencia de que se verificó.**

Lo que **no** es su dominio, y confundirlo lo rompe:

| No es | Por qué importa |
|---|---|
| Producir lógica de negocio | Eso es DoxIA. El harness no sabe qué es una patente aduanal |
| Decidir qué se construye | Eso lo deciden los ADR y los planes, con una persona |
| Desplegar | Regla #16: commit, push y deploy son humanos |

Es **plano de control**, no plano de datos. La prueba de que la separación se sostiene: borrar
`harness/` entero deja a DoxIA compilando, pasando tests y desplegando igual. Ningún fichero de
producción lo importa.

---

## 2. Bounded contexts

Siete, con dueño y frontera medible:

| Contexto | Qué gobierna | Dónde vive | LOC |
|---|---|---|---|
| **Knowledge** | Qué se sabe del sistema | `memory/` · `.kiro/steering/` · bóveda | — |
| **Policy** | Qué se exige y con qué modelo | `harness/policy/` · `scripts/gate.sh` | 194 |
| **Contracts** | Qué artefactos fluyen entre etapas | `harness/contracts/` | 145 |
| **Capabilities** | Qué transformaciones se necesitan | `harness/capabilities/` | 422 |
| **Orchestration** | En qué orden y con qué puertas | `harness/bin/` | 274 |
| **Compute** | Dónde corre | local · CI · *(sandbox: MISSING)* | — |
| **Adapters** | Traducción a cada runtime y proveedor | `harness/adapters/` | 263 |
| **State** | Dónde nos quedamos | `.harness/state/` · `harness/lib/state.mjs` | — |
| **Evidence** | Qué se comprobó y cómo | `.harness/evidence/` | — |

**La frontera que más cuesta y más paga:** *Knowledge* vs *State*. Lo durable va a `memory/`; lo
efímero —ronda, hallazgos vivos, tablero— a `.harness/state/`. Mezclarlos es cómo la memoria dejó de
ser fiable la última vez.

---

## 3. ¿Qué es núcleo y qué es adaptador?

**Núcleo** — `harness/lib/`, 736 líneas. No sabe quién lo invoca ni qué modelo ejecuta:

| Módulo | Qué decide | Puro |
|---|---|---|
| `frontmatter.mjs` | cómo se lee una capacidad | sí |
| `capabilities.mjs` | qué capacidades hay | E/S de lectura |
| `router.mjs` | qué modelo resuelve una clase | sí |
| `converge.mjs` | cuándo dos hallazgos son el mismo | sí |
| `plan.mjs` | cómo se pinea un plan | E/S de git |
| `state.mjs` | qué se recuerda entre sesiones | E/S de disco |

**Adaptadores** — `harness/adapters/`, 263 líneas. Traducen a un mundo concreto:

- *De entrada*: `kiro.mjs`, `claude-code.mjs` — generan los ficheros que cada IDE entiende.
- *De salida*: `models/{ollama,claude,opencode}.mjs` — un `probe()` y un `invoke()` cada uno.

**Composition root** — `bin/doxia.mjs`, 274 líneas. Único punto que conoce las dos capas. Orquesta;
no calcula. Toda lógica que merece un test vive en `lib/`.

---

## 4. ¿Qué dependencias están permitidas?

```
   capabilities/ ─┐            (datos: markdown, sin código)
      policy/ ────┤
    contracts/ ───┤
                  ▼
                lib/  ◄──────  adapters/
                  ▲                ▲
                  └──── bin/ ──────┘
```

| Desde → hacia | ¿Permitido? |
|---|---|
| `adapters/` → `lib/` | **sí** |
| `bin/` → `lib/`, `adapters/` | **sí** — es el composition root |
| `lib/` → `adapters/` | **NO** — invertiría la dependencia y ataría el núcleo a un proveedor |
| `lib/` → `bin/` | **NO** |
| entre adaptadores de modelo | **NO** — cada uno independiente |

**Verificado hoy, no supuesto:** ningún fichero de `lib/` importa de `adapters/`. Las únicas
menciones a un proveedor dentro del núcleo son **dos comentarios** (`router.mjs:23` citando
`claude:opus` como ejemplo, `frontmatter.mjs:5` citando una ruta de spec). Cero acoplamiento real.

Es la misma regla que `arch:check` aplica al backend. **Hoy no está automatizada para el harness** —
gap declarado, no resuelto.

---

## 5. ¿Qué contratos produce y consume cada etapa?

El modelo es un **anillo**, no una tubería:

```
Knowledge ─► Evidence ─► Decision ─► Plan ─► Execution ─► Validation ─► Evidence ─┐
    ▲                                                                             │
    └─────────────────────────────────────────────────────────────────────────────┘
```

Evidence aparece dos veces a propósito: la del final realimenta Knowledge. La evidencia de una vuelta
es el conocimiento de la siguiente.

| Etapa | Consume | Produce | Capability |
|---|---|---|---|
| Discover | `RepoRef` | `ArchitectureBaseline` | `researcher` |
| Baseline | `ArchitectureBaseline` | `FactSet` | `researcher` |
| Decision | `FactSet` | `DecisionRecord` | `architect` |
| Plan | `DecisionRecord` · `PlanRef` | `WorkPackage` | `architect` |
| Execution | `WorkPackage` | `ChangeSet` | `builder` |
| Validation | `ChangeSet` | `Finding` | `reviewer` · `security` |
| Adversarial | `Finding` | `Finding` + `verdict` | `reviewer` |
| Convergence | `Finding` | `Verdict` | **ninguna** — función pura |
| Evidence | `Verdict` · `ChangeSet` | `EvidencePackage` | `release` |

Definición en [`contracts/contracts.json`](contracts/contracts.json), con **8 tests** que impiden que
el ciclo, las capacidades y los contratos deriven: que cada etapa nombre una capacidad viva, que la
cadena encaje (lo que produce una etapa lo consume la siguiente), y que `Finding` **nunca** se
identifique por número de línea.

**Convergence sin capability es deliberado.** Un contrato que puede cumplirse sin un modelo se cumple
sin un modelo.

---

## 6. ¿Qué depende de Claude/Kiro y qué es agnóstico?

| Componente | Acoplamiento | Evidencia |
|---|---|---|
| `lib/` (736 LOC) | **agnóstico** | cero imports a adapters; solo 2 comentarios nombran proveedor |
| `capabilities/` (422 LOC) | **agnóstico** | declaran `model_class`, nunca proveedor |
| `contracts/` (145 LOC) | **agnóstico** | describen forma, no origen |
| `policy/router.json` | **declara** proveedores | es su función: es la tabla de bindings |
| `adapters/kiro.mjs` | **Kiro** | genera su JSON de permisos |
| `adapters/claude-code.mjs` | **Claude Code** | genera su markdown |
| `adapters/models/claude.mjs` | **Claude CLI** | — |
| `bin/doxia.mjs` | **ambos** | composition root: por definición conoce las dos capas |
| `scripts/gate.sh` | **ninguno** | bash + npm; corre en CI sin ningún IDE |

**El 76 % del harness (1 303 de 1 705 LOC en `lib` + `capabilities` + `contracts` + `policy`) no sabe
que Claude o Kiro existen.** El acoplamiento está confinado a 263 líneas de adaptadores.

**Asimetría honesta y no resuelta:** Kiro **aplica** los permisos de una capacidad
(`permissions.rules[].effect: deny`); Claude Code **no tiene** ese mecanismo. Allí `denied` es una
instrucción del prompt, y quien lo hace cumplir de verdad es el gate en `pre-commit`. Se documenta en
el fichero generado en vez de fingir paridad.

---

## 7. Estado por pieza — `EXISTING` / `PARTIAL` / `MISSING`

| Pieza | Estado | Nota |
|---|---|---|
| Knowledge · Memory · Evidence · Policy | **EXISTING** | la mitad *saber* estaba antes que esto |
| Contracts · Capabilities | **EXISTING** | 9 contratos, 7 capacidades, 32 tests |
| Orchestration | **PARTIAL** | CLI con `doctor`/`sync`/`plan`/`gate`/`state`; `run` solo `--self-review` |
| Adapters | **PARTIAL** | 3 proveedores cableados; 3 declarados sin adaptador |
| State | **EXISTING** | `board.json` + `PreCompact` + `SessionStart` |
| Compute | **PARTIAL** | local + CI |
| **Sandbox** | **MISSING** | — |
| **Observability** | **PARTIAL** | evidencia sí; traza por corrida no |

---

## 8. UNKNOWNs

Lo que **no** se puede afirmar hoy, y por qué:

1. **Si el ciclo completo converge.** Solo se ha ejecutado `--self-review`. Discover→Evidence de punta
   a punta, no.
2. **Si la diversidad de proveedor reduce los defectos de verdad.** ADR-003 se apoya en las diez
   rondas fallidas; su efecto **medido** requiere rondas con el harness puesto.
3. **Coste real de una vuelta.** Sin telemetría de tokens ni de tiempo.
4. **Si `deepseek-coder-v2:16b` produce hallazgos útiles** sobre este código. Su primera invocación
   desbordó contexto con 85 KB; se pasó a revisión por fichero y falta medir la calidad.
5. **Si los adaptadores generados se mantienen fieles** cuando cambie el esquema de Kiro o de Claude
   Code. Nada lo comprueba todavía.
6. **Si `arch:check` puede extenderse al harness** para automatizar §4.

---

## 9. Deuda propia, medida hoy

| Deuda | Severidad |
|---|---|
| La regla de dependencias de §4 **no está automatizada** — se verificó a mano | ALTA |
| `run` solo implementa `--self-review`; las otras 8 etapas no tienen orquestación | ALTA |
| Sandbox `MISSING`: una capacidad que escribe lo hace sobre el árbol real | ALTA |
| Sin traza por corrida: se sabe el veredicto, no el camino | MEDIA |
| Los adaptadores generados no se validan contra el esquema del destino | MEDIA |
| `harness/lib/core.mjs` existió como duplicado muerto de tres módulos | **cerrada** — eliminado |

La última entrada se deja escrita a propósito: apareció **en este mismo baseline**, y es la prueba de
que someter el harness a su propio proceso encuentra cosas.
