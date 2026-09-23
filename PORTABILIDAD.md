# Portabilidad: lo que falta, medido

**Fecha de la medición:** 2026-09-23
**Cómo se obtuvo:** copiando el motor a un repositorio vacío y ejecutando su
propia suite. No es una estimación ni una revisión visual.

---

## El resultado

| Entorno | Tests | Pasan | Fallan |
|---|---:|---:|---:|
| Dentro de DoxIA | 860 | **860** | 0 |
| Repositorio propio | 766 | 690 | **76** |

**Los 76 fallos no son un error de copia.** Son la medida exacta de cuánto
depende todavía el motor de su árbol anfitrión.

## La causa raíz es una sola

En el repositorio nuevo el motor **ya no está anidado** dentro del proyecto que
audita. `anfitrionPorDefecto()` —que por compatibilidad sigue deduciendo la raíz
de `import.meta.url`— la resuelve a `/tmp` en vez de al repositorio.

Cada ruta compuesta contra esa raíz apunta a la nada:

```
Error: ENOENT: no such file or directory, open '/tmp/scripts/gate.sh'
Error: Cannot find module '/tmp/harness/bin/vectores-plan.mjs'
Error: ENOENT: no such file or directory, scandir '/tmp/memory'
```

## Cada fallo nombra su puerto

| Puerto | Estado | Líneas de error | Qué acopla |
|---|---|---:|---|
| **PuertaDeCalidad** | escrito | 58 | `scripts/gate.sh`, `scripts/lib/*.sh` |
| **Repositorio** | pendiente | 28 | `git` sobre un no-repo |
| **Anfitrión** | escrito | 20 | `harnessDir` mal resuelto |
| **LocalizadorDeSpecs** | pendiente | 8 | `.kiro/specs/` |
| **AlmacénDeMemoria** | pendiente | 4 | `memory/*.md` |
| **TaxonomíaDeCódigo** | pendiente | 2 | `src/`, `backend/src/` |

Que *PuertaDeCalidad* y *Anfitrión* aparezcan como «escritos» y sigan fallando
no es contradicción: **el puerto existe, pero los 16 ficheros que importan
`ROOT` aún no lo usan.** Siguen consumiendo la constante deducida, que es
exactamente lo que la compatibilidad prometió para poder migrar de uno en uno.

> Un refactor que rompe todo a la vez no se puede verificar por partes.

## El próximo paso, concreto

Migrar los 16 consumidores de `ROOT` para que **reciban el anfitrión inyectado**
en lugar de importar la constante. Hasta entonces:

**Este repositorio es el motor _extraído_, no el motor _portable_.**

Y esa frase seguirá siendo la honesta hasta que una vuelta cierre en verde sobre
un repositorio tercero. La portabilidad no se declara: se demuestra.

---

## Reproducir la medición

```bash
git clone <este-repo> /tmp/prueba && cd /tmp/prueba
node --test .
```

Si el número de fallos baja de 76, algo mejoró de verdad. Si alguien lo declara
portable sin que ese número sea **0**, el comando de arriba lo desmiente.
