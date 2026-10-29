#!/usr/bin/env python3
"""T1 — ¿el presupuesto de razonamiento MUEVE el voto, o es ruido?

Pre-registro del criterio ANTES de ver los resultados (RULES.md, CoT):

  Con greedy (temperature 0, top_k 1, seed fijo) la misma peticion debe dar el
  MISMO voto. Asi que:

  - si k repeticiones del MISMO presupuesto dan el mismo voto -> determinismo OK
  - si presupuestos distintos dan votos distintos DE FORMA ESTABLE  -> el
    presupuesto es una variable del juicio, y eso es un DEFECTO del instrumento:
    el voto debe depender del artefacto, no de cuanto le deje pensar
  - si los votos se solapan entre presupuestos -> es ruido, y el presupuesto solo
    decide SI hay voto (la conclusion que ya tenia registrada)

El fallo original (voto NULO por agotar presupuesto razonando) NO se reprodujo en
la primera pasada: con 2048 el modelo voto. Eso tambien se mide aqui.
"""
import json, urllib.request, time, sys, os

ART_PATH = "/home/emmanuel/Documentos/DoxIA/DoxIA.md/Ingenieria/Harness/Cierre de hallazgos en formato de coste.md"
OUT = os.environ.get("OUT", "/tmp/t1-presupuesto.jsonl")
MODELO = "gpt-oss:20b"
PRESUPUESTOS = [2048, 4096, 6144]
K = 3

ART = open(ART_PATH).read()
PROMPT = (
    "Eres un juez tecnico. Puntua de 0 a 10 el rigor del siguiente artefacto.\n"
    "Responde en una sola linea con el formato exacto `PUNTAJE: N` y despues una critica breve.\n\n"
    + ART
)

import re
def parsear(texto):
    m = re.search(r"PUNTAJE\s*:\s*(\d+)", texto, re.I)
    return int(m.group(1)) if m else None

def pedir(num_predict):
    body = json.dumps({
        "model": MODELO, "prompt": PROMPT, "stream": False,
        "options": {"temperature": 0, "top_k": 1, "seed": 42, "num_predict": num_predict},
    }).encode()
    req = urllib.request.Request("http://localhost:11434/api/generate", body,
                                 {"Content-Type": "application/json"})
    t = time.time()
    with urllib.request.urlopen(req, timeout=1800) as f:
        d = json.load(f)
    resp = d.get("response", "")
    return {
        "num_predict": num_predict,
        "voto": parsear(resp),
        "done_reason": d.get("done_reason"),
        "eval_count": int(d.get("eval_count", 0)),
        "segundos": round(time.time() - t, 1),
        "respuesta_vacia": not resp.strip(),
        "sha_respuesta": __import__("hashlib").sha256(resp.encode()).hexdigest()[:12],
    }

with open(OUT, "w") as fh:
    for n in PRESUPUESTOS:
        for i in range(K):
            r = pedir(n)
            r["repeticion"] = i + 1
            fh.write(json.dumps(r) + "\n")
            fh.flush()
            print(f"  {n:>5} #{i+1}  voto={str(r['voto']):>4}  {r['done_reason']:<6} "
                  f"eval={r['eval_count']:>4} {r['segundos']:>5.0f}s sha={r['sha_respuesta']}",
                  flush=True)
print(f"\nescrito: {OUT}")
