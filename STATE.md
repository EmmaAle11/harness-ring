# Harness DoxIA — Estado del sistema

**2026-08-18** · `doxia-platform` @ `HEAD` (rama `fix/archivero-solicitar-actualizacion`) ·
`doxia-second-brain` @ `fa9db6f`

> Las secciones 1-4 son **historia con ancla de commit** y valen para su fecha. Lo que está VIGENTE
> hoy es el `HARNESS READINESS REPORT — FASE 11` en la bóveda, y las comprobaciones ejecutables de
> [`READINESS.md`](READINESS.md): ninguna afirmación escrita aquí gana a un comando que se corre.

Este fichero es el **punto de reanudación**. Todo lo que hace falta para retomar el trabajo sin releer
la conversación está aquí o en las rutas que nombra. El conocimiento durable vive en
[`memory/`](../memory/README.md), que sobrevive a cualquier compactación.

| Estado | Significa |
|---|---|
| **VERIFICADA** | Existe **y** hay evidencia de que hace lo que dice, con comando para repetirlo |
| **PARCIAL** | Funciona a medias, y se sabe exactamente qué falta |
| **AUSENTE** | No existe |

---

## 1. Los cinco subsistemas

| # | Subsistema | Objetivo | Hoy | Estado |
|---|---|---|---|---|
| 1 | **Compute** | 7.5 → 9 | **9** | VERIFICADA |
| 2 | **CapabilityLayer** | 8 → 9 | **9** | VERIFICADA |
| 3 | **AdapterLayer** | 8 → 9 | **9** | VERIFICADA |
| 4 | **Learning** | 6 → 9 | **9** | VERIFICADA |
| 5 | **Autonomous Ring** | 6.5 → 9 | **9** | VERIFICADA |

**160 tests** en verde (`node --test`), gate `--fast` PASS. **Los cinco cerrados.**

### 1 · Compute — scheduler, no router · `8477af0`

Provider y Model son entidades separadas (`harness/policy/catalog.json`). La selección es una tubería
y cada modelo descartado deja dicho quién lo tiró:

```
forbidden → capacidades del modelo → presupuesto → proveedor vivo → modelo instalado → diversidad
```

El orden importa: se descarta antes por lo *imposible* que por lo *caro*, para que el motivo que
sobrevive sea el que de verdad excluyó al modelo. `forbidden` es la única lista que gana a `prefer`, y
el fallback solo cae dentro de `prefer` menos `forbidden` — nunca a «cualquier modelo disponible».

**ADR-003 veta por FAMILIA, no por proveedor.** Medido: el backend de `opencode` es
`deepseek-v4-flash-free`. El «tercer proveedor» era DeepSeek disfrazado.

- `harness/lib/compute.mjs` · `harness/policy/catalog.json` · `harness/lib/compute.test.mjs`
- `router.mjs` ya no implementa selección: delega en `compute.decide()`. Una sola autoridad.

### 2 · CapabilityLayer — contrato operativo · `c5ffaad`

Los 7 manifiestos declaran los 15 campos obligatorios y se validan **estáticamente al cargar**.
Sigue siendo **un fichero** por capacidad: sacar el contrato a un `.yaml` aparte habría creado la
duplicación que esta fase eliminó. `writes`/`denied` **desaparecieron**; los adaptadores de Kiro y
Claude Code leen del contrato.

`denyPaths` (rutas) y `forbidden` (acciones) van separados — una lista que mezcla ambas no se puede
hacer cumplir. `denyPaths` gana siempre a `permissions.write`, y en Kiro las reglas `deny` se emiten
**antes** del `allow`.

Los **6 tests** de capability (Contract · Permission · Input · Output · Boundary · Evidence) corren
**sin invocar un modelo**. Esa es la tesis: el modelo puede fallar y el harness no debe depender de
que entienda sus límites.

- `harness/lib/capability-contract.mjs` · `harness/capabilities/*.md`

### 3 · AdapterLayer — un solo contrato · `7109f02`, `cb01218`

Las seis operaciones (`probe · invoke · stream · cancel · capabilities · normalize`) en los cuatro
adaptadores. `ExecutionRequest` → `ExecutionResult`: misma forma venga de donde venga. Ocho códigos
de fallo, y la distinción no es cosmética — `TIMEOUT` y `RATE_LIMIT` se reintentan; `AUTH_FAILURE`,
`MODEL_UNAVAILABLE` y `CONTEXT_OVERFLOW` **no**.

Negociación **antes** de invocar: `opencode` declara `structured_output: false` y se rechaza en 0 ms.

`invoke()` real medido: `deepseek-v4-pro` 1 113 ms · `claude:haiku` 9 208 ms ·
`ollama:qwen3.8:27b` 21 292 ms (18,3 GB) · `opencode` 2 983 ms.

- `harness/adapters/models/contract.mjs` + los cuatro adaptadores

### 4 · Learning — tres niveles · `9a30825`

`Capture` → `Classification` → `Promotion`. **Learning nunca escribe en `memory/`**: produce
candidatos y la política los resuelve en `PROMOTE` / `REJECT` / `REVIEW`.

La confianza **no la declara el modelo**: se deriva de cuántas corridas distintas vieron lo mismo
(1 = 0.5 · 2 = 0.75 · 3+ = 0.9). Nada llega a 1.0 — repetirse no es ser cierto.

`ARCHITECTURE_DECISION` y `VULNERABILITY` **nunca** se auto-promueven. Los rechazados se guardan
también: un candidato que desaparece sin rastro no se puede auditar.

Provenance obligatorio: `origin · execution_id · evidence[] · date · agent · model · confidence ·
promoted_by`.

- `harness/lib/learning.mjs` · `harness/policy/learning.json` · salida en `.harness/learning/<id>.json`

### 5 · Autonomous Ring — **9** · VERIFICADA

**EL ANILLO CERRO — 5/5.**

| | RUN-N | RUN-N+1 |
|---|---|---|
| id | `H-20260816-ec7c627f` | `H-20260816-a0162f70` |
| veredicto | **PASSED 16/16** | **PASSED 16/16** |
| duracion | 1 817 s | 1 958 s |
| reworks | 2 | 2 |

```
doxia fitness H-20260816-ec7c627f --next H-20260816-a0162f70
  ok  FT-1  24/16 etapas, en orden, con artefacto
  ok  FT-2  una sola orden, cero pausas humanas
  ok  FT-3  3 ficheros, todos dentro del workspace
  ok  FT-4  2 proveedores: claude, deepseek · builder=claude reviewer=deepseek
  ok  FT-5  H-20260816-a0162f70 consume lo que H-20260816-ec7c627f aprendio
  EL ANILLO CERRO — 5/5
```

La flecha `Learning → Knowledge` es literal: el `01-knowledge.json` de N+1 cita
`H-20260816-ec7c627f` y la entrada que N declaro. Y la repetibilidad ya opera —
dos candidatos subieron a `PROMOTE` con `confidence 0.75` porque **dos corridas
distintas** vieron lo mismo, que es exactamente lo que la politica de Fase 4 exige.

`release` se invoca (`inv=1`) desde que redacta el `summary` del EvidencePackage;
su veredicto sigue siendo determinista.

---|---|
| **16/16 PASSED** | ✔ `H-20260815-0b5e1031` |
| Artefactos de cierre consolidados | ✔ ambos |
| REWORK disparado y convergido | ✔ |
| FT-1 · FT-2 · FT-3 | ✔ |
| FT-4 medido en PASS | ✘ fix commiteado, **sin demostrar** |
| FT-5 · segunda vuelta encadenada | ✘ fix commiteado, **sin demostrar** |

**RUN-0002** (`H-20260815-5efe1ec0`) llegó a 15/16 y cayó en el segundo rework: el builder listó
`UpgradeScreen.tsx` en `files` sin devolver su contenido, y el guard lo detuvo. Es el limite real de
pedirle a un modelo que devuelva un fichero de 37 KB VERBATIM dentro de un JSON, tres veces por
vuelta.

---

## 2. Lo que encontró ejecutar el anillo

Cinco vueltas reales de ~27 min. Ninguno de estos defectos se veía leyendo.

1. **La evidencia describía el árbol principal, no el workspace.** `Evidence2` invocaba el `gate.sh`
   del árbol principal; `gate.sh` calcula su `ROOT` desde `BASH_SOURCE` y hace `cd` allí, ignorando el
   `cwd`. El `EvidencePackage` **nunca describió el cambio**, y corría vitest y jest en el árbol
   principal — lo que el sandbox existe para evitar.
2. **`checkTrace` no entendía REWORK.** Reportaba «recorrió 18 de 16 etapas» sobre una vuelta válida.
   FT-1 habría fallado en **cualquier** vuelta con reintento.
3. **Execution escribía y mostraba un solo fichero**, descartando el resto en silencio.
4. **`resolverModelo` se quedó atrás** al convertir Compute en scheduler: consumidor olvidado.
5. **`CONTEXT_OVERFLOW` en el revisor**: se le mandaba el cambio duplicado (`contents` + `diff`),
   52 KB. Ahora solo el diff: 5,6 KB.
6. **El sandbox dejaba de aislar dentro de un hook de git** (`GIT_DIR` heredado).
7. **El gate no corría los tests del propio harness.** 160 tests que no hacía cumplir nadie.

### Lo que el revisor adversarial encontró solo

`deepseek-v4-pro` sobre código de `claude:opus`:

- Una aserción **tautológica**: comparar dos llamadas a la misma función determinista no prueba nada.
- Que para el fichero rechazado más pequeño el mensaje quedaba «pesa 10.0 MB, el máximo es 10 MB».
- *«Si se revierten los cambios de UpgradeScreen, las pruebas pasan igual»* — **aplicó la regla
  `el-fix-que-no-existe` del propio repo sin que nadie se la pidiera**.

ADR-003 no es decorativo: un proveedor distinto encontró lo que el escritor no vio.

---

## 3. Configuración viva

| | |
|---|---|
| `builder` · `architect` | `claude:opus` |
| `reviewer` · `security` | `deepseek:deepseek-v4-pro` |
| `researcher` · `release` | `claude:haiku` |
| `trigger` | `claude:sonnet` |
| offline de `review` | `ollama:qwen3.8:27b` (18 GB) |

`DEEPSEEK_API_KEY` en `.env` (gitignored). Ollama 0.32.13. **Prohibición #1 (`noTraining`) intacta:
no se ha entrenado nada.**

> `qwen3.8:27b` y `deepseek-coder-v2:16b` **nunca residentes a la vez**: 18 + 8,9 = 27 de 30 GB.

---

## 4. Cómo reanudar

```bash
# desde la raíz del worktree, sea cual sea (`git rev-parse --show-toplevel`)

# sin comillas: los globs los expande bash. Con comillas los expandiría node,
# que es una capacidad de la v21 y aquí hay v20 -> "Could not find" sobre 325 tests verdes.
node --test --test-reporter=tap harness/lib/*.test.mjs harness/adapters/models/*.test.mjs
bash scripts/gate.sh --fast
node harness/bin/doxia.mjs doctor

# La vuelta completa (~27 min). Deja artefactos en .harness/runs/<id>/
node harness/bin/doxia.mjs run --ring h-001-ring-execution

# Limpiar workspaces de vueltas abortadas antes de relanzar
for w in $(git worktree list --porcelain | grep "^worktree.*workspaces" | cut -d' ' -f2); do
  git worktree remove --force "$w"; done && git worktree prune
```

La tarea que ejecuta el anillo está en `.kiro/specs/h-001-ring-execution/h-001.json` → `task`.
Hoy: extraer `src/lib/formatFileSize.ts` + su spec y usarla en `UpgradeScreen.tsx`.

---

## NEXT MATURITY TARGET — Fase 11: DOS ejes, convergencia y escala

El anillo ya se vio cerrar (Fase 10). La Fase 11 tiene que demostrar **dos** cosas, y cerrar sólo una
deja la fase abierta: que una tarea acotada **converge** de forma reproducible con fuentes de
razonamiento independientes, y que el anillo **escala** más allá de la forma de H-001 — mover una
función de 30 líneas entre cuatro ficheros pequeños.

El segundo eje y su orden los declara
[ADR-008](../memory/decisions/ADR-008-la-escala-se-abre-por-la-salida-no-por-la-entrada.md); esta
tabla no los repite, sólo dice **qué está medido**.

### Eje 1 — convergencia

| Criterio de salida | Cómo se comprueba | ✔ / ✘ |
|---|---|---|
| Dos vueltas consecutivas `PASSED` | `doxia run --ring` ×2 | **✔ vuelta** — 5 seguidas, `650da267` → `a54e8beb` (16-ago 21:50 → 17-ago 00:28 UTC), las 5 con 16/16 |
| Ninguna vuelta con más de 2 reworks | `trace.metrics.reworks` | **✔ vuelta** — **9 de 9** corridas del 21 y 22-ago llevan el campo y ninguna pasa de 1. El «NO MEDIBLE» de ayer medía la historia ENTERA, donde 8 de 18 son de un harness anterior que no lo escribía: el denominador equivocado |
| `run_gate --full` ejecutado por el builder | `toolsUsed` incluye `run_gate` con `mode: full` | **✔ vuelta** — `84b9ad17`, 21-ago; nunca en las 17 anteriores |
| `DONE` sin mutación se rechaza | `agentic.faltaParaDone` + vuelta real | ✔ test · ✘ vuelta |
| Change Surface calculada y registrada | `trace.changeSurface[]` | **✔ vuelta** — **9/9** corridas del 21-22 ago la traen |
| Identidad estable de hallazgos | `findings.fingerprint` | **✔ vuelta, por otro mecanismo** — `9004564e`: 3 pasadas votaron los 2 hallazgos con **0 votos huérfanos**. La identidad DENTRO de una petición es el ordinal desde `0a62446b`; `fingerprint` sigue siendo la de ENTRE rondas y ésa sigue sin ejercitarse |
| Oscilación detectada al provocarla | `convergenceStatus: OSCILLATING` | ✔ test · ✘ vuelta |
| Builder y refutador en familias distintas | `ExecutionAssignment.independence` | **✔ INVOCADO, CONFORME Y ÚTIL** — `33a622d0`: refutó un hallazgo **3-0** y la vuelta cerró con `findingsConfirmed: 0`. Mató un hallazgo falso, que es para lo que existe. Antes: **✔ INVOCADO Y CONFORME** — `9004564e`: 3 pasadas, 3 OK, 6 votos, **0 huérfanos**, 0 sin revisar. Costó cinco capas: la familia que faltaba en `prefer`, un modelo que piensa más de lo que le queda de techo, tres pasadas compitiendo por una CPU, un contrato que pedía el trabajo de otro y un id demasiado caro de copiar |
| Duración por proveedor registrada | `trace.providers[].durationMs` | **✔ vuelta** — **9/9** |
| Coste/tokens, o `MISSING` explícito | `trace.providers[].tokensStatus` | **✔ vuelta** — **9/9**, declarado o `MISSING` |
| A01 detectado y bloqueante | `policy/security.json` | ✘ — la semilla de `h-002` es **A03** (XSS), no A01 |
| **La puerta de seguridad MUERDE lo que se le siembra** | `Security.seeds` | **✔ vuelta y PUBLICADO** — `33a622d0` (22-ago) cerró **PASSED 16/16** con `seeds: {detectada, corregida, verdeDespues}` en el artefacto. Antes — `84b9ad17`: `run_gate` en rojo → el builder lee la evidencia → parchea `AdminRespaldosS3.tsx` → `run_gate` en verde. Es VAL-011 en vivo, y hasta hoy **había que reconstruirlo a mano de las llamadas**: la etapa 8 daba los mismos 12 hallazgos con semilla y sin ella. Desde `1c2fa3fc` sale publicado |
| Secret scanning bloquea una credencial sembrada | `task.seed` + Security | ✘ |
| `MAX_REWORK` NO subido para cumplir nada | sigue en 4 | ✔ |
| Ninguna severidad P0-P5 rebajada | `converge.bloqueantes` sobre toda la escala | ✔ |

### Eje 2 — escala (C-1…C-7)

Los criterios los declara
[ADR-008](../memory/decisions/ADR-008-la-escala-se-abre-por-la-salida-no-por-la-entrada.md); aquí sólo
va **lo medido el 21-ago**.

| Criterio de salida (ADR-008) | ✔ / ✘ | Evidencia |
|---|---|---|
| Una vuelta lee `aafa.service.ts` **por símbolo**, resuelve un hallazgo y cierra 16/16 | **✔ CUMPLIDO** | `2b680088`: **PASSED 16/16** en 41,5 min. 3 `read_symbol` --`_docIsExpiringOrExpired`, `_extractDocExpiration`, `_computeSubmissionHealth`-- sobre 20.998 líneas **sin abrir el fichero ni una vez**; 7 mutaciones, las 7 aplicadas; 0 reworks; `gate --full` con 14 PASS y 0 FAIL. Matiz honesto: Validation dio **0 hallazgos**, así que cerró resolviendo la TAREA, no un hallazgo |
| Una vuelta `move` renombra ≥ 50 ficheros en `R100` con `gate --full` PASS | ✘ | `h-005` mueve 6, no 50; sin correr |
| Una vuelta `feature` crea un componente de ≥ 400 líneas sin que la etapa 7 la rechace | ✘ | sin spec |
| Ninguna vuelta muere con `OUTPUT_TRUNCATED` en 10 corridas seguidas | **✔ CUMPLIDO** | **35 corridas en disco, las 35 con artefactos, CERO con `OUTPUT_TRUNCATED`** (25-ago). El criterio pide 10 seguidas. Y el techo de salida NO subio para conseguirlo: `maxOutputTokens` sigue en 32 768 — lo que lo cerro fue `reduccion` por contrato de artefacto, que es el escalon que ADR-008 mandaba en vez de un numero |
| Una campaña de ≥ 5 vueltas reanuda tras agotar `maxWallMs` | ✘ | `campaign.mjs` existe; ninguna campaña ha reanudado |
| `contracts.test.mjs` falla si un campo nuevo llega solo al modelo | **✔** | y hoy se endureció: ya no fija la FORMA del fuente sino que el marcador de la ronda y el contenido de los ficheros no llegan al modelo |

**La escalera de tamaño**, por el fichero mayor que la tarea nombra:

| corrida | spec | objetivo | KB | × base | superficie | riesgo | etapas |
|---|---|---|---:|---:|---|---|---|
| `84b9ad17` | h-002 | `gate.sh` | 38,3 | 1× | 2 f / 57 l | LOW | **16/16 PASSED** |
| `54e6667b` | h-003 | `ArchiveroModule.tsx` | 214,2 | 5,6× | 4 f / 126 l | MEDIUM | 10/16 |
| `575882c8` | h-004 | `aafa.service.ts` | **1.146,5** | **30×** | 4 f / 84 l | LOW | 10/16 |
| `c2668d7b` | h-004 | `aafa.service.ts` | **1.146,5** | **30×** | 4 f / 85 l | LOW | 15/16 |
| `6ebd7317` | h-004 | `aafa.service.ts` | **1.146,5** | **30×** | 4 f / 82 l | LOW | 15/16 |
| `0925bcf5` | h-003 | `ArchiveroModule.tsx` | 214,2 | **5,6×** | 4 f / 138 l | MEDIUM | **16/16 PASSED** |
| `2b680088` | **h-004** | `aafa.service.ts` | **1.146,5** | **30×** | 4 f / 90 l | LOW | **16/16 PASSED** |

**El tamaño no paró ninguna vuelta, y a 30× la vuelta CIERRA.** La superficie **baja** a 82-90 líneas y el
riesgo vuelve a `LOW`: el presupuesto mide la superficie del **cambio**, no el tamaño del **fichero**,
que es la tesis de C-5. Las paradas fueron de la etapa 10 (el refutador) y de la 15 (pisos que yo
había puesto mal).

### El refutador, arreglado por capas — y cada una sólo se vio al quitar la anterior

| # | Lo que se veía | Lo que era |
|---|---|---|
| 1 | `DEGRADED`, «sin tercera familia viva» | la había; faltaba en `review.prefer` |
| 2 | `[PROVIDER_FAILURE] fetch failed` ×3 | el modelo asignado **piensa**: gasta el techo antes de emitir |
| 3 | `[TIMEOUT]` ×2 | 3 pasadas **en paralelo** sobre una CPU: 3,5× peor de pared, 21× por petición |
| 4 | el contrato rechaza la única respuesta | se le pedía devolver los hallazgos **enteros** para poder identificarlo |
| 5 | `orphanVotes: 6`, todo `UNREVIEWED` | una huella de 100 chars **no se copia: se inventa** |

Medido contra el modelo real con un `FindingSet` real y el camino de producción entero:
**huella → 2/3 pasadas, 6 votos huérfanos, 3 sin revisar; ordinal → 3/3, 0 huérfanos, 0 sin revisar.**

**Y después, DENTRO de un anillo.** `H-20260822-9004564e` (h-005, segunda vuelta) produjo 2 hallazgos
y la etapa 10 los votó:

```
passes 3 · passesOk 3 · disagreements 0 · undecided 0 · unreviewed 0 · orphanVotes 0
P4  CONFIRMED  {confirmed: 3, refuted: 0}
P5  CONFIRMED  {confirmed: 3, refuted: 0}
```

Seis votos emitidos, **seis casados**, cero huérfanos. Convergence bloqueó con los dos confirmados,
que es lo que tiene que hacer. **La fila de Fase 11 pasa de `✔ asignado · ✘ invocado` a `✔ invocado
y conforme`**, y con ella el mecanismo que llevaba 21 vueltas sin funcionar.

**La columna que manda es la segunda mitad de cada `✔ test · ✘ vuelta`.** Una capacidad que solo
existe en tests no está demostrada: es la lección de
[`el-gancho-apuntaba-a-un-arbol-que-ya-no-existe`](../memory/failures/el-gancho-apuntaba-a-un-arbol-que-ya-no-existe.md),
y aquí se aplica a nueve capacidades a la vez.

### ⛔ BLOQUEO VIVO — ninguna vuelta puede correr hoy (25-ago)

**Las filas `✘ vuelta` de este tablero no se cierran leyendo: se cierran corriendo el anillo. Y el
anillo no arranca.** Medido, no supuesto — `decide()` lo dice con su propia regla:

```
clase `review` exige   structured_output + long_context
  deepseek:*           so ✔  lc ✔  remoto   ->  CAIDO, HTTP 401
  opencode:default     so ✘  lc ✔  remoto   ->  rechazado: «no soporta structured_output»
  ollama:*             so ✔          LOCAL  ->  el usuario los descarto el 25-ago
```

`ADR-003` prohíbe que el revisor comparta familia con el escritor, y el escritor es `claude:opus`. Así
que **no hay ni un candidato para `review`** que sea a la vez remoto y capaz. Se probó reordenar
`review.prefer` para poner `opencode` delante de los locales y **no sirve**: la parada no es de orden,
es de capacidad.

**Es decisión del usuario, y son dos caminos:**

1. **Reponer la clave de DeepSeek** — devuelve el camino remoto entero y con él la segunda familia.
2. **Readmitir los locales sólo para `review`** — funciona hoy sin tocar nada, y el precio es el que ya
   se aceptó: `voters: 1`, sin tercera familia, `independence: DEGRADED` escrito en el artefacto.

Hasta entonces lo que se puede cerrar de Fase 11 es lo que se mide **sobre corridas ya hechas**, y eso
es lo que se ha hecho arriba.

### Lo que sigue abierto además

- **SAST corre; A01 y A07 siguen `MISSING`** en el mapa OWASP. Se declaran, no se aprueban.
- **`test:e2e` apunta a un config inexistente** → `NOT_CONFIGURED`.
- **`opencode` no aporta diversidad**: mismo backend que DeepSeek (`providerFamily`). La tercera
  familia real es `ollama:qwen3.8:27b` —entró en `review.prefer` con `f3edc779`; antes la lista no la
  veía y 19 vueltas salieron `DEGRADED` por un motivo falso—, y su coste medido es **~90 s por pasada
  de refutación** sobre CPU: tres pasadas ≈ 4,5 min por ronda.
- **El coste en dinero es `MISSING` por diseño**: hay tokens de deepseek y ollama, pero el catálogo
  declara el coste por *tier* cualitativo y no por precio. Multiplicar sería fabricar la medida.
- **Los `gate` del manifiesto siguen siendo prosa** salvo los que tienen `assert*` propio
  (`assertPlanDentroDelAlcance`, `assertSuperficie`, `assertSecurityGate`, `faltaParaDone`).
- **El techo de lectura y el de transcripción dejaron de ser un número global** (`14940ffe`, 25-ago).
  `maxToolResultChars` 8 000 → **20 000**, medido sobre el p100 real de 30 truncaduras en 36 corridas;
  y `maxTranscriptChars` pasa a **derivarse de la ventana del modelo** — el 60 000 global estaba
  calibrado para `qwen2.5-coder` (61 728) y era 8× corto para los otros nueve. `maxOutputTokens` **no
  se tocó**: ADR-008 lo prohíbe y además no era el límite que mordía. Es infraestructura del eje 2; la
  fila `move ≥ 50` sigue `✘` hasta que una vuelta lo demuestre.
- **Graphify sigue `MISSING`** y así se declara en cada traza (ADR-006). No entra por la puerta de
  atrás de Observability.
