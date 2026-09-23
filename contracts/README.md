# Contratos

Un **contrato** es un artefacto tipado que fluye entre etapas del ciclo. Es lo que hace que una
*Capability* sea sustituible: si dos implementaciones consumen y producen los mismos contratos, son
intercambiables — da igual que una sea Opus, otra `deepseek-coder-v2` en local, y la tercera un
script.

```
contract   Discover
consume    RepoRef
produce    ArchitectureBaseline
```

## Por qué esto sustituye la palabra «Agent»

*Agent* nombra **quién** hace el trabajo. *Capability* nombra **qué transformación** se necesita.
Mientras el vocabulario sea «agente», cambiar de proveedor parece un cambio de arquitectura; con
capacidades, es un cambio de binding.

| | Capability | Implementación |
|---|---|---|
| Qué es | el **puerto**: consume X, produce Y | el **adaptador**: quién y con qué modelo |
| Dónde vive | `harness/capabilities/*.md` | `harness/policy/router.json` + `adapters/models/` |
| Cambia cuando | cambia lo que el ciclo necesita | cambia el proveedor disponible |

Para la etapa 2 —donde entran modelos OpenSource— esto es la diferencia entre «reescribir los
agentes» y «añadir una fila al router».

## El modelo del harness

```
Knowledge ─► Evidence ─► Decision ─► Plan ─► Execution ─► Validation ─► Evidence ─┐
    ▲                                                                             │
    └─────────────────────────────────────────────────────────────────────────────┘
```

Empieza y termina en **Evidence**, y esa segunda Evidence realimenta Knowledge. No es una tubería con
dos extremos: es un anillo. La evidencia de una vuelta es el conocimiento de la siguiente.

## Las etapas y sus contratos

| Etapa | Consume | Produce | Capability |
|---|---|---|---|
| **Discover** | `RepoRef` | `ArchitectureBaseline` | `researcher` |
| **Baseline** | `ArchitectureBaseline` | `FactSet` | `researcher` |
| **Decision** | `FactSet` | `DecisionRecord` (ADR) | `architect` |
| **Plan** | `DecisionRecord` · `PlanRef` | `WorkPackage[]` | `architect` |
| **Execution** | `WorkPackage` | `ChangeSet` | `builder` |
| **Validation** | `ChangeSet` | `Finding[]` | `reviewer` · `security` |
| **Adversarial** | `Finding[]` | `Finding[]` con `verdict` | `reviewer` |
| **Convergence** | `Finding[]` | `Verdict` | *función pura* |
| **Evidence** | todo lo anterior | `EvidencePackage` | `release` |

**Convergence no tiene capability y es deliberado**: es una función pura
([ADR-004](../../memory/decisions/ADR-004-la-convergencia-es-determinista.md)). Un contrato que puede
cumplirse sin un modelo, se cumple sin un modelo.

## Reglas

1. **Un contrato se define por su forma, no por quién lo produce.** Si hace falta saber qué modelo lo
   generó para interpretarlo, no es un contrato.
2. **Toda capacidad declara `consume` y `produce` en su frontmatter.** Una que no lo declare no puede
   colocarse en el ciclo.
3. **`EvidencePackage` es el único contrato obligatorio.** Sin él no hay avance (regla #0).
4. **Los contratos se versionan.** Cambiar la forma de uno rompe a sus consumidores; se trata como
   cambio de API.
