---
id: convergencia
type: POLICY
title: Cómo se unifican los hallazgos de varios agentes
status: active
---

# Convergencia

Varios agentes miran el mismo diff con lentes distintas. **El mismo defecto va a aparecer varias
veces.** Unificarlo es el paso que decide si el resultado es útil o una lista de 47 líneas donde 30
son la misma cosa.

## La regla: esto NO lo hace un modelo

Deduplicar es determinista, y un LLM aquí solo añade varianza: la misma entrada da salidas distintas
y no hay forma de auditar por qué fusionó dos hallazgos o por qué no.

**El LLM propone. Una función pura unifica.**

## Clave de identidad

Dos hallazgos son **el mismo** si coinciden en las tres:

```
(fichero_normalizado, símbolo, claim_normalizado)
```

- **fichero_normalizado** — ruta relativa a la raíz del repo. Sin `./`, sin ruta absoluta.
- **símbolo** — la función, clase o constante. **Nunca la línea**: las líneas se mueven entre rondas
  y dos hallazgos idénticos quedarían separados por un `prettier`.
- **claim_normalizado** — la afirmación en minúsculas, sin acentos, sin puntuación, con espacios
  colapsados. No es semántica: es una comparación de texto, y eso es una virtud. Una fusión que no se
  puede explicar es peor que un duplicado.

## Al fusionar

| Campo | Regla |
|---|---|
| Severidad | **la más grave** de las que se fusionan |
| Confianza | la más alta |
| Evidencia | **se acumulan todas** — dos lentes que llegan al mismo sitio por caminos distintos es la señal más fuerte que produce el harness |
| Lentes | se acumulan |
| Agentes | se acumulan |

Un hallazgo visto por `reviewer` **y** por `security` no es un duplicado molesto: es corroboración
independiente, y hay que poder verla.

## Antes de deduplicar: refutar

El orden del ciclo es `Review → Adversarial → Convergence`. Refutar va **primero**, y lo dicta la
evidencia de esta rama: *47 crudos → 13 refutados → 11 causas raíz*. Si se deduplica antes, un
hallazgo fabricado se fusiona con uno real y sobrevive escondido dentro de él, con la credibilidad
prestada del verdadero.

Un hallazgo sobrevive si su **premisa** se comprueba en el código. En la ronda 4 de esta rama, **15 de
23 cayeron** porque el mecanismo citado era falso o la cita estaba fabricada.

Se marca `REFUTED` cuando:

- El símbolo citado no existe.
- El mecanismo descrito no está en esa ruta de ejecución.
- El comando de reproducción no reproduce.
- El código citado es inalcanzable.

**Verificas la premisa, no solo la conclusión.** Una conclusión correcta sostenida por una premisa
falsa vuelve a aparecer en la ronda siguiente, y la corrección que genera suele abrir un defecto
peor.

## El umbral (`llm_evaluation` del DoD)

```
DONE  =  0 hallazgos P0–P5 CONFIRMADOS tras refutación
```

No es «pocos hallazgos» ni «ninguno grave». Es cero, y con la evidencia de que se buscó. La tasa de
refutación se registra: en esta rama subió 26 % → 42 % → 59 % a lo largo de las rondas, y esa curva
es la que dice si el harness está convergiendo o dando vueltas.
