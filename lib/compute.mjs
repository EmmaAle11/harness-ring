// Compute — el SCHEDULER. ComputeRequest -> ComputeDecision.
//
// Antes era un router: recorria `prefer` y devolvia el primero cuyo proveedor
// respondiera. Eso basta para elegir, pero no para EXPLICAR, y sin explicacion no
// hay reproducibilidad auditable: dos corridas podian elegir distinto y nadie
// sabia por que.
//
// Aqui la eleccion es el residuo de una TUBERIA de filtros, y cada modelo que se
// cae deja dicho quien lo tiro. La decision no es un string: es el registro de
// como se llego a el (1.5).
//
// PURO: sin E/S. La salud la mide `probe()`, el inventario lo da la maquina, y
// ambos entran como argumento. Que Compute sea determinista es lo que convierte
// ADR-003 en una garantia y no en una intencion: si un modelo eligiera al
// revisor, podria elegirse a si mismo (ADR-004).

/** free < cheap < paid < premium. Un tier fuera de la lista no se asume barato. */
const TIERS = ['free', 'cheap', 'paid', 'premium'];
const dentroDePresupuesto = (tier, max) => {
  const i = TIERS.indexOf(tier), m = TIERS.indexOf(max);
  return i >= 0 && m >= 0 && i <= m;
};

export const modelKey = (c) => `${c.provider}:${c.model}`;

/**
 * `provider:model` -> [provider, model]. El modelo PUEDE llevar dos puntos
 * (`deepseek-coder-v2:16b`), asi que solo se parte por el primero.
 */
export const parteDe = (id) => {
  const s = String(id ?? '');
  const i = s.indexOf(':');
  return i < 0 ? [s, undefined] : [s.slice(0, i), s.slice(i + 1)];
};

/**
 * La FAMILIA de razonamiento de un modelo. Es la unidad real de independencia
 * (ADR-003), y NO es el proveedor.
 *
 * EL DEFECTO QUE CIERRA. `providerFamily` mapea el proveedor entero, y eso basta
 * para `opencode -> deepseek`. Pero ollama no sirve UNA familia: sirve las que
 * tenga descargadas. Con `providerFamily.ollama = 'local'`, un revisor
 * `ollama:deepseek-coder-v2` sobre un escritor `deepseek:deepseek-v4-pro`
 * pasaba el filtro de diversidad -- y hereda exactamente el punto ciego que
 * ADR-003 existe para evitar. El razonamiento que justifico vetar opencode se
 * aplica igual aqui y no se habia aplicado.
 *
 * Por eso el mapa por MODELO gana al mapa por proveedor: la familia es una
 * propiedad de quien razona, no de quien lo sirve.
 */
export const familiaDe = (catalog, provider, model) =>
  // `undefined`, no `false`: con `&&` el caso «sin modelo» devolvia `false`, y
  // `false ?? x` NO cae al siguiente -- `??` solo salta null/undefined. La
  // familia acababa siendo el booleano `false`, que casa consigo mismo y habria
  // hecho que dos modelos sin nombre parecieran la misma familia. Lo encontro el
  // test del caso mas aburrido: un proveedor sin declarar.
  (model === undefined ? undefined : catalog?.modelFamily?.[`${provider}:${model}`])
  ?? catalog?.providerFamily?.[provider]
  ?? provider;

/** `claude:*` veta el proveedor entero; `claude:opus`, solo ese modelo. */
const coincide = (patron, provider, model) => {
  const [p, m] = String(patron).split(':');
  return p === provider && (m === '*' || m === undefined || m === model);
};

/**
 * Construye la solicitud normalizada de una capacidad (1.2).
 * La capacidad declara su `model_class`; NUNCA un proveedor.
 */
export function computeRequest(capability, { router, task = null, context = 'repository', avoid = [] } = {}) {
  const cls = router.classes?.[capability.model_class] ?? {};
  return {
    capability: capability.id,
    modelClass: capability.model_class,
    risk: cls.risk ?? 'medium',
    task,
    context,
    requiredCapabilities: cls.requires ?? [],
    budget: { maxCostTier: cls.maxCostTier ?? 'premium' },
    forbidden: cls.forbidden ?? [],
    avoid,
  };
}

/**
 * ComputeRequest -> ComputeDecision (1.3).
 *
 * Orden de la tuberia, y el orden importa: se descarta antes por lo que es
 * IMPOSIBLE (prohibido, incapaz) que por lo que es CARO o LENTO. Asi el motivo
 * que sobrevive en el registro es el que de verdad excluyo al modelo.
 *
 *   forbidden -> capacidades del modelo -> presupuesto -> proveedor vivo
 *             -> modelo instalado -> diversidad (ADR-003)
 *
 * @param req      ComputeRequest
 * @param catalog  policy/catalog.json  (Provider y Model, separados)
 * @param router   policy/router.json   (clases y su `prefer` ordenado)
 * @param health   { alive:Set<provider>, models:Map<provider,Set<model>> }
 */
/**
 * PROVEEDORES VETADOS DE POR VIDA. No es una preferencia de coste ni un fallback:
 * es una prohibicion permanente que `decide()` aplica ANTES que cualquier otra
 * regla, de modo que ninguna ruta pueda devolverlos al anillo.
 *
 * POR QUE NO BASTA CON SACARLO DEL `prefer`: `prefer` es una PREFERENCIA y el
 * adaptador sigue registrado en PROVIDERS. Una spec que nombre el modelo, un
 * `avoid` que empuje el fallback, o una clase nueva que lo liste, lo reactivan
 * sin que nadie lo note. Un proveedor prohibido tiene que fallar CERRADO en el
 * unico punto por el que se decide.
 *
 * gemini — decision del usuario, 2026-09-22: «ya no lo uses, de por vida».
 *   CONSECUENCIA MEDIDA Y ACEPTADA: quedan dos familias --anthropic (builder) y
 *   deepseek (reviewer)--, asi que la etapa 10 no encuentra una TERCERA para
 *   refutar y `adversarial` cae al modelo del reviewer. `independence.status`
 *   pasa a DEGRADED y lo DECLARA en el binding: no se rompe, se dice. Las 3
 *   pasadas del adversarial pasan a ser tres muestras del MISMO criterio --miden
 *   su varianza, no lo corroboran--. En H-20260917-fef6f11b gemini confirmo 3
 *   hallazgos P3/P5 con 0 desacuerdos; esa refutacion independiente se pierde, y
 *   se pierde a sabiendas.
 */
export const PROVEEDORES_VETADOS = new Set(['gemini']);

export function decide(req, { catalog, router, health }) {
  const cls = router.classes?.[req.modelClass];
  if (!cls) {
    return { error: `capacidad '${req.capability}': clase de modelo desconocida '${req.modelClass}'` };
  }

  const specDe = (c) => catalog.models.find((m) => m.provider === c.provider && m.model_id === c.model);
  const familia = (p, m) => familiaDe(catalog, p, m);
  const familiasVetadas = new Set(req.avoid.map((id) => familia(...parteDe(id))));

  const considerados = [];
  const viables = [];

  for (const c of cls.prefer) {
    const id = modelKey(c);
    const spec = specDe(c);
    const rechaza = (regla, motivo) => { considerados.push({ model: id, aceptado: false, regla, motivo }); };

    // EL VETO VA PRIMERO: antes que forbidden, que el catalogo y que la salud.
    // Un proveedor prohibido no se razona, se descarta.
    if (PROVEEDORES_VETADOS.has(c.provider)) {
      rechaza('veto', `proveedor vetado de por vida: '${c.provider}' no puede elegirse en ninguna clase`); continue;
    }
    if (req.forbidden.some((f) => coincide(f, c.provider, c.model))) {
      rechaza('forbidden', `prohibido para la clase '${req.modelClass}'`); continue;
    }
    if (!spec) {
      rechaza('catalog', 'no existe en el catalogo: no se puede razonar sobre sus capacidades'); continue;
    }
    const faltan = req.requiredCapabilities.filter((k) => !spec[k]);
    if (faltan.length) {
      rechaza('capabilities', `no soporta ${faltan.join(', ')}`); continue;
    }
    if (!dentroDePresupuesto(spec.cost?.tier, req.budget.maxCostTier)) {
      rechaza('budget', `coste '${spec.cost?.tier}' supera el maximo '${req.budget.maxCostTier}'`); continue;
    }
    if (!health.alive.has(c.provider)) {
      rechaza('health', 'proveedor no responde'); continue;
    }
    const inv = health.models?.get(c.provider);
    if (inv && !inv.has(c.model)) {
      rechaza('availability', 'el proveedor responde pero no sirve este modelo'); continue;
    }
    if (familiasVetadas.has(familia(c.provider, c.model))) {
      // No es el proveedor: es la FAMILIA. opencode sirve deepseek, y un revisor
      // opencode sobre un escritor deepseek hereda el mismo punto ciego.
      rechaza('diversity', `familia '${familia(c.provider, c.model)}' ya se uso (ADR-003)`); continue;
    }

    considerados.push({ model: id, aceptado: true, regla: null, motivo: null });
    viables.push({ ...c, spec });
  }

  if (!viables.length) {
    // Un error que solo dice "no hay candidatos" obliga a reconstruir a mano por
    // que. Se nombra la causa DOMINANTE, y el detalle completo viaja en
    // `considered`.
    //
    // El orden NO es alfabetico ni por frecuencia. `diversity` primero porque es
    // la unica parada que no se arregla encendiendo algo. `health` el ULTIMO,
    // aunque suela ser el motivo mas repetido: si un proveedor estaba vivo y se
    // rechazo por incapaz, decir "ningun proveedor vivo" es sencillamente falso,
    // y manda a arreglar lo que no estaba roto.
    const reglas = new Set(considerados.filter((x) => !x.aceptado).map((x) => x.regla));
    const detalle = considerados.map((x) => `${x.model} (${x.regla}: ${x.motivo})`).join(' · ');
    let error;

    if (reglas.has('diversity')) {
      error =
        `capacidad '${req.capability}': no hay modelo de una familia DISTINTA de ` +
        `[${[...familiasVetadas].join(', ')}] para la clase '${req.modelClass}'. El harness se ` +
        `detiene: una revision con la familia que escribio hereda su punto ciego (ADR-003). ${detalle}`;
    } else if (reglas.has('availability')) {
      error =
        `capacidad '${req.capability}': proveedor vivo pero ningun modelo de la clase ` +
        `'${req.modelClass}' esta instalado. ${detalle}`;
    } else if (reglas.has('capabilities') || reglas.has('budget') || reglas.has('forbidden')) {
      const primero = considerados.find((x) => ['capabilities', 'budget', 'forbidden'].includes(x.regla));
      error =
        `capacidad '${req.capability}': ningun modelo apto para la clase '${req.modelClass}' ` +
        `— ${primero.model} ${primero.motivo}. ${detalle}`;
    } else if (reglas.has('health')) {
      error =
        `capacidad '${req.capability}': ningun proveedor vivo para la clase '${req.modelClass}'. ` +
        `Requiere alguno de: ${[...new Set(cls.prefer.map((c) => c.provider))].join(', ')}`;
    } else {
      error = `capacidad '${req.capability}': ningun modelo viable para la clase '${req.modelClass}'. ${detalle}`;
    }
    return { error, considered: considerados };
  }

  // `prefer` esta ordenado: el primero viable es el primario, el resto son los
  // UNICOS fallbacks legitimos. Caer fuera de esta lista seria "cualquier modelo
  // disponible", que es justo lo que 1.4 prohibe.
  const [elegido, ...resto] = viables;
  return {
    capability: req.capability,
    provider: elegido.provider,
    model: elegido.model,
    id: modelKey(elegido),
    reason: elegido.why ?? cls.why,
    fallback: resto.map(modelKey),
    considered: considerados,
    policy: {
      modelClass: req.modelClass,
      risk: req.risk,
      requiredCapabilities: req.requiredCapabilities,
      budget: req.budget,
      forbidden: req.forbidden,
      avoidedFamilies: [...familiasVetadas],
    },
  };
}
