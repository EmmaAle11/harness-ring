# Dataset — fuentes para entrenamiento y fundamentación

> **Los PDF no están versionados.** Este directorio contiene 21 documentos (40.2
> MB) que viven en el disco pero no en el repositorio: `.gitignore` los excluye
> por **ISO/IEC 27001 A.5.32** (propiedad intelectual) y **A.5.37**
> (procedimientos documentados). Un repositorio de código no es un almacén
> documental, y redistribuir material de terceros no es nuestro derecho.
>
> Lo que **sí** se versiona es `MANIFIESTO.json`: procedencia, tamaño, número de
> páginas y **SHA-256** de cada fuente. Así el dataset es auditable y
> reproducible — si una fuente cambia, el hash lo delata — sin publicar lo ajeno.

## Contenido

| Carpeta | Ficheros | Tamaño | Propósito |
|---|---:|---:|---|
| `algoritmos/` | 15 | 21.2 MB | Algoritmos y métricas de laboratorios y conferencias |
| `skill-mat/` | 5 | 18.6 MB | Papers fundacionales de entrenamiento de LLM |
| `alineamiento/` | 1 | 0.4 MB | Norma de conducta de laboratorio de IA |

### `algoritmos/` — divulgación científica

- **MIT 6.S191** *Introduction to Deep Learning* — lecciones L1, L2, L5, L7
- **EMNLP 2018** — `D18-2000` … `D18-2012` (9 papers de demostración de sistemas)
- **Stanford CS231n** *Deep Learning for Computer Vision*
- **The Annotated Transformer** (Harvard NLP)

### `skill-mat/` — los papers que fundamentan el método

| arXiv | Trabajo | Qué aporta al harness |
|---|---|---|
| `1706.03762` | *Attention Is All You Need* | la arquitectura que ejecutan los proveedores del anillo |
| `2001.08361` | *Scaling Laws for Neural Language Models* | por qué el tamaño del modelo no es la única variable |
| `2203.15556` | *Training Compute-Optimal LLMs* (Chinchilla) | cómputo óptimo — base de `compute.decide()` |
| `2305.18290` | *Direct Preference Optimization* | alineamiento sin modelo de recompensa |
| `2401.02954` | *DeepSeek LLM* | el proveedor que el anillo usa hoy |

### `alineamiento/` — el criterio, no solo la capacidad

`MAI_CodeOfConduct.pdf` — código de conducta de laboratorio de IA. Es la fuente
normativa para decidir **qué no debe hacer el anillo**, que es una pregunta
distinta de qué puede hacer.

## Cómo se trajeron

Movimiento (`mv`), no copia: las rutas de origen quedaron vacías y se eliminaron.

```
DOXIA-main/data_set_algortimos  →  dataset/algoritmos/
DOXIA-main/dataset_skill_mat    →  dataset/skill-mat/
Descargas/MAI_CodeOfConduct.pdf →  dataset/alineamiento/
```

**Integridad verificada por hash**: se calculó SHA-256 de los 21 ficheros antes
de mover y después. **21 de 21 idénticos, 0 perdidos.** Ninguno estaba versionado
en DoxIA, así que el movimiento no rompe historial.

## Reproducir la verificación

```bash
# el manifiesto declara un hash por fuente; esto comprueba que siguen coincidiendo
python3 - <<'EOF'
import json, hashlib, os
os.chdir('dataset')
M = json.load(open('MANIFIESTO.json'))
malos = 0
for f in M['fuentes']:
    p = f"{f['carpeta']}/{f['fichero']}"
    if not os.path.exists(p):
        print(f"AUSENTE  {p}"); malos += 1; continue
    h = hashlib.sha256(open(p,'rb').read()).hexdigest()
    if h != f['sha256']:
        print(f"CAMBIADO {p}"); malos += 1
print(f"{len(M['fuentes'])-malos}/{len(M['fuentes'])} intactos")
EOF
```

## Qué NO es este directorio

- **No es un corpus de entrenamiento listo.** Son fuentes primarias; la
  extracción a texto, el troceado y el embedding son pasos posteriores y aún no
  están hechos.
- **No es exhaustivo.** Una auditoría previa descartó 4 de 15 documentos de
  `algoritmos/` por no aportar algoritmos — el "CS231n" es el calendario del
  curso y la "L7" es una charla sobre Asimov. Esa criba está medida, no supuesta,
  y se conservan igualmente para que la decisión sea revisable.
- **No contiene datos personales.** Todo es material público de laboratorios y
  conferencias. El barrido ISO del repositorio no encontró PII en lo versionado.
