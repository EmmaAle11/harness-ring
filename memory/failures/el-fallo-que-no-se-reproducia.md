---
id: el-fallo-que-no-se-reproducia
title: el presupuesto de razonamiento no causaba el voto nulo; el instrumento cambio entre cargas
type: FAILURE
status: fixed
mecanismo: lib/matematicas.test.mjs (rango/varianza con k>=3) · bin/t1-medir-presupuesto.py (criterio pre-registrado, k=3 por condicion)
origin: humano
execution_id: t1-2026-10-29
confidence: 0.9
date: 2026-10-29
agent: orquestador
model: gpt-oss:20b
promoted_by: emmanuel
---

# El fallo que no se reproducia

> Iba a "arreglar" subiendo `maxTokens` un defecto que ya no existia. La correccion
> habria entrado en el repo con un commit que afirmaba resolver algo, sin que
> nadie pudiera notar que no resolvia nada.

## Premisa (lo que creia al empezar)

`gpt-oss:20b` agotaba su presupuesto razonando y devolvia `response: ''` con
`done_reason: 'length'`, dando un **voto NULO** que impedia el cuarto voto del
4×9. La tarea T1 estaba escrita como *"subir `maxTokens`: ~5 lineas"*.

## Medicion

Criterio **pre-registrado en el codigo antes de ver resultados**
(`bin/t1-medir-presupuesto.py`): k=3 repeticiones por presupuesto, greedy
(`temperature 0`, `top_k 1`, `seed 42`), artefacto real de 10 040 bytes.

| num_predict | votos | rango | sha de respuesta | nulos |
|---|---|---:|---|---:|
| 2048 | 7, 7, 7 | 0 | `cee5bb1bb53c` | 0 |
| 4096 | 7, 7, 7 | 0 | `cee5bb1bb53c` | 0 |
| 6144 | 7, 7, 7 | 0 | `cee5bb1bb53c` | 0 |

**9/9 llamadas: `done_reason: stop`, `eval_count: 387`, un unico sha.** Cero
nulos. El modelo nunca agoto el presupuesto, ni con el valor mas bajo.

## Conclusion (VERIFIED)

**El defecto no existe con la configuracion actual.** Subir `maxTokens` habria
sido codigo que no arregla nada — y el commit habria dicho lo contrario.
No se toco `policy/votacion.json`: YAGNI aplicado a una correccion, no a una
funcionalidad.

## El hallazgo COLATERAL, que si es real (OBSERVED)

Dos mediciones del **mismo artefacto con los mismos parametros greedy** dieron
resultados distintos en momentos distintos:

| momento | eval_count | voto |
|---|---:|---:|
| primera pasada (modelo recien cargado) | 264 | **8** |
| nueve llamadas posteriores | 387 | **7** |

Greedy con seed fijo es determinista **dentro de una carga del modelo**, pero
**no se sostuvo entre cargas**. Eso importa porque el umbral del 4×9 discrimina
entre 8 y 9: un juez cuyo voto depende de cuando se cargo el modelo no puede ser
una puerta numerica fiable. No esta explicado todavia — `OBSERVED`, no
`VERIFIED`, y no se usa para justificar ninguna decision.

## Mecanismo

Lo que impide repetir el error de metodo no es un test sobre `gpt-oss`: es que
**ninguna conclusion sobre un juez se publique con k=1**. `lib/matematicas.mjs`
expone `rango`, `varianza` (muestral, n−1) y `desviacion` con tests que caen si
se usa la poblacional, y el guion de medicion exige k≥3 por condicion.

Es el tercer caso de la misma clase: pre-registrar protege de mover el liston,
no de medir la variable equivocada. Aqui la variable equivocada era *el
presupuesto*; la real es *la carga del modelo*.
