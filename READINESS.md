# Harness Readiness — dónde está el estado

> **Este fichero no es el informe.** Lo fue hasta el 2026-08-14, y para el 17 mentía en casi todas sus
> filas: decía 15 etapas cuando había 16, `Learning AUSENTE` cuando ya cerraba el anillo, `SAST ✘`
> cuando semgrep llevaba un día corriendo dentro del workspace. Un snapshot de estado versionado junto
> al código **es una segunda autoridad que nadie recuerda actualizar**, que es el defecto dominante de
> este repositorio aplicado a su propia documentación
> ([una autoridad por hecho](../memory/patterns/una-autoridad-por-hecho.md)).
>
> Los `HARNESS READINESS REPORT` viven **fechados en la bóveda**, en
> `doxia-second-brain: DoxIA.md/Ingenieria/Plans/`. Cada uno vale para su fecha y ninguno pretende
> seguir siendo cierto después — que es justo lo que este fichero pretendía.

## Lo único que sí es durable

| Qué | Dónde |
|---|---|
| El **orden del anillo** y sus contratos | `.kiro/specs/h-001-ring-execution/h-001.json` — **la autoridad** |
| Su reflejo comprobado etapa por etapa | `harness/contracts/contracts.json` + `lib/contracts.test.mjs` |
| Por qué el orden es ese | [`README.md`](README.md#el-anillo--16-etapas-cerrado) |
| Qué se ha **demostrado**, con su evidencia y cómo re-verificarlo | [`memory/validations/`](../memory/validations/) |
| Qué **falló**, medido | [`memory/failures/`](../memory/failures/) |
| El estado de esta sesión | `bash scripts/harness-status.sh` · `node harness/bin/doxia.mjs doctor` |

## El anillo, hoy

```
PRODUCEN   Knowledge ─► Evidence ─► Decision ─► Plan ─► Compute ─► Sandbox ─► Execution ─►
JUZGAN     Security ─► Validation ─► Adversarial ─► Convergence ─►
REGISTRAN  Capability layer ─► Adapter layer ─► Observability ─► Evidence2 ─► Learning ─► ⟲
```

**Security va en la 8** desde el 2026-08-17. Detrás de `Convergence` no podía bloquear nunca: toda
regla capaz de bloquear describe algo que el revisor adversarial caza antes, así que el escáner
llegaba siempre segundo y sobre código ya corregido. Además es determinista y barata, y ahora corre
delante de las cuatro invocaciones de modelo que vienen detrás. El porqué completo, en
[`README.md`](README.md#el-anillo--16-etapas-cerrado); la medida, en `H-20260817-ccd41639`.

## Cómo se comprueba el estado sin leer un documento

```bash
node --test --test-reporter=tap harness/lib/*.test.mjs harness/adapters/models/*.test.mjs
bash scripts/gate.sh --full                       # la puerta entera, con sus pisos
node harness/bin/doxia.mjs doctor                 # qué proveedor responde de verdad
node harness/bin/doxia.mjs trace <executionId>    # una corrida, reconstruida sola
node harness/bin/doxia.mjs fitness <id> --next <id2>
```

**Ninguna de esas cinco cosas puede quedarse obsoleta**, porque ninguna es una afirmación escrita: son
comprobaciones que se ejecutan. Ésa es la diferencia entre esto y lo que había aquí antes.
