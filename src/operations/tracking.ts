// Tracking controls use effect match names, which are stable across UI languages.
// The Creative MCP tracking module and Adobe's documentation describe the controls.
// This bridge uses the existing TUIFT operation registry and the resident AE agent.
import {
  jsxCompLayerPreamble,
  jsxCompPreamble,
  jsxFail,
  jsxVal,
  registerOp,
  type OperationParam,
} from "../registry.js";

const COMP: OperationParam = {
  name: "comp",
  type: "any",
  description: "Composition name or id.",
  required: true,
};
const LAYER: OperationParam = {
  name: "layer",
  type: "any",
  description: "Layer index, name or { id }.",
  required: true,
};
const LAYERS: OperationParam = {
  ...LAYER,
  description: "Layer index, name, { id }, 'selected', 'all', or a list of those.",
};
const TIME: OperationParam = {
  name: "time",
  type: "number",
  description: "Composition time in seconds. Defaults to the current time.",
};

type Control = {
  field: string;
  suffix: string;
  type: "number" | "boolean" | "string";
  description: string;
  range?: readonly [number, number];
  options?: readonly string[];
};

function menu(
  field: string,
  suffix: string,
  options: readonly string[],
  description: string,
): Control {
  return {
    field,
    suffix,
    type: "string",
    options,
    description: description + " " + options.join(" | "),
  };
}

function slider(
  field: string,
  suffix: string,
  range: readonly [number, number],
  description: string,
): Control {
  return { field, suffix, type: "number", range, description };
}

function checkbox(field: string, suffix: string, description: string): Control {
  return { field, suffix, type: "boolean", description };
}

const STABILIZER = "ADBE SubspaceStabilizer";
const CAMERA_TRACKER = "ADBE 3D Tracker";
const OBJECTIVES = [
  "stabilize",
  "reversible_stabilization",
  "reverse_stabilization",
  "apply_motion_to_target",
  "apply_motion_to_target_over_original",
];
const WARP: readonly Control[] = [
  menu("result", "0019", ["smooth_motion", "no_motion"], "Stabilization result."),
  slider("smoothness", "0020", [0, 1000], "Smoothness percentage."),
  menu(
    "method",
    "0028",
    ["position", "position_scale_rotation", "perspective", "subspace_warp"],
    "Stabilization method.",
  ),
  checkbox("preserveScale", "0044", "Preserve scale."),
  menu(
    "framing",
    "0022",
    ["stabilize_only", "stabilize_crop", "stabilize_crop_auto_scale", "stabilize_synthesize_edges"],
    "Treatment of moving edges.",
  ),
  slider("maximumScale", "0004", [100, 10000], "Maximum auto-scale percentage."),
  slider("actionSafeMargin", "0003", [0, 100], "Action-safe margin percentage."),
  slider("additionalScale", "0016", [1, 10000], "Additional scale percentage."),
  checkbox("detailedAnalysis", "0036", "Enable detailed analysis."),
  checkbox("fastAnalysis", "0308", "Enable fast analysis when available."),
  menu(
    "rollingShutterRipple",
    "0037",
    ["automatic_reduction", "enhanced_reduction"],
    "Rolling shutter correction.",
  ),
  slider("cropLessSmoothMore", "0023", [0, 100], "Trade-off between cropping and smoothing."),
  slider("synthesisInputRange", "0038", [0, 999], "Synthesis input range in seconds."),
  slider("synthesisEdgeFeather", "0035", [0, 999], "Feather for synthesized edges."),
  menu("objective", "0047", OBJECTIVES, "Stabilization objective."),
  slider("targetLayer", "0046", [1, 10000], "Target layer index for an apply-motion objective."),
  checkbox("showTrackPoints", "0280", "Show track points in the composition viewer."),
  slider("trackPointSize", "0301", [0, 10000], "Track point size percentage."),
  checkbox("autoDeletePoints", "0306", "Auto-delete track points across time."),
  checkbox("hideWarningBanner", "0026", "Hide this effect's warning banner."),
];
const CROPS: readonly Control[] = [
  slider("left", "0031", [0, 999], "Left edge crop in pixels."),
  slider("top", "0032", [0, 999], "Top edge crop in pixels."),
  slider("right", "0033", [0, 999], "Right edge crop in pixels."),
  slider("bottom", "0034", [0, 999], "Bottom edge crop in pixels."),
];
const CAMERA: readonly Control[] = [
  menu(
    "solveMethod",
    "0410",
    ["auto_detect", "typical", "mostly_flat_scene", "tripod_pan"],
    "Scene model for the 3D camera solve.",
  ),
  checkbox("detailedAnalysis", "0036", "Enable detailed analysis."),
  checkbox("autoDeletePoints", "0306", "Auto-delete track points across time."),
  checkbox("hideWarningBanner", "0026", "Hide this effect's warning banner."),
  slider(
    "horizontalAngleOfView",
    "0414",
    [0, 180],
    "Horizontal field of view in degrees when specified in the effect.",
  ),
  menu("showTrackPoints", "0405", ["source_2d", "solved_3d"], "Points displayed in the viewer."),
  checkbox("renderTrackPoints", "0406", "Include track points in rendered frames."),
  slider("trackPointSize", "0407", [0, 10000], "Track point size percentage."),
  slider("targetSize", "0409", [0, 10000], "Target size percentage."),
];

function controlValues(preset: readonly Control[], args: Record<string, unknown>) {
  const values: Array<{ field: string; suffix: string; value: number }> = [];
  for (const item of preset) {
    const provided = args[item.field];
    if (provided === undefined) continue;
    if (item.options) {
      const number = item.options.indexOf(String(provided)) + 1;
      if (!number) throw new Error(item.field + ": " + item.options.join(" | "));
      values.push({ field: item.field, suffix: item.suffix, value: number });
    } else if (item.range) {
      const [min, max] = item.range;
      if (
        typeof provided !== "number" ||
        !Number.isFinite(provided) ||
        provided < min ||
        provided > max
      )
        throw new Error(item.field + " precisa estar entre " + min + " e " + max);
      values.push({ field: item.field, suffix: item.suffix, value: provided });
    } else {
      values.push({ field: item.field, suffix: item.suffix, value: provided === true ? 1 : 0 });
    }
  }
  return values;
}

const LAYER_SET = `
function trackingLayers(c, selector) {
    var selectors = selector instanceof Array ? selector : [selector];
    var found = [], ids = {};
    for (var i = 0; i < selectors.length; i++) {
        var resolved = AE.resolveLayers(c, selectors[i]);
        if (!resolved.length) throw new Error("Nenhuma camada para o seletor " + String(selectors[i]));
        for (var j = 0; j < resolved.length; j++) {
            var item = resolved[j];
            if (!ids[item.index]) { found.push(item); ids[item.index] = true; }
        }
    }
    if (!found.length) throw new Error("Selecione ao menos uma camada.");
    return found;
}
`;

const EFFECT_STATE = `
function trackingEffectState(effect) {
    var controls = [];
    for (var i = 1; i <= effect.numProperties; i++) {
        var p = effect.property(i);
        if (p.propertyType !== PropertyType.PROPERTY || p.propertyValueType === PropertyValueType.NO_VALUE) continue;
        var value = AE.safeGet(function () { return p.value; }, null);
        if (typeof value === "number" || typeof value === "boolean") {
            controls.push({ name: p.name, matchName: p.matchName, value: value });
        }
    }
    return { name: effect.name, index: effect.propertyIndex, matchName: effect.matchName,
             enabled: effect.enabled, controls: controls };
}
`;

const WRITE_VALUE = `
function updateTrackingValue(p, value, at, keyframe) {
    var old = { control: p, key: 0, createdKey: false, value: p.value };
    if (keyframe) {
        var nearest = p.numKeys ? p.nearestKeyIndex(at) : 0;
        if (nearest && Math.abs(p.keyTime(nearest) - at) < 0.000001) {
            old.key = nearest;
            old.value = p.keyValue(nearest);
        } else {
            old.createdKey = true;
        }
        p.setValueAtTime(at, value);
    } else {
        p.setValue(value);
    }
    return old;
}
function restoreTrackingValues(changes, at) {
    for (var i = changes.length - 1; i >= 0; i--) {
        var old = changes[i], p = old.control;
        try {
            if (old.createdKey) p.removeKey(p.nearestKeyIndex(at));
            else if (old.key) p.setValueAtKey(old.key, old.value);
            else p.setValue(old.value);
        } catch (restoreError) {}
    }
}
`;

function effectScript(
  args: Record<string, unknown>,
  matchName: string,
  preset: readonly Control[],
): string {
  try {
    const values = controlValues(preset, args);
    const crop = args.synthesisEdgeCropping as Record<string, unknown> | undefined;
    if (crop) {
      if (Object.keys(crop).some((key) => !CROPS.some((edge) => edge.field === key)))
        return jsxFail("synthesisEdgeCropping aceita left, top, right ou bottom.");
      values.push(...controlValues(CROPS, crop));
    }
    if (args.targetLayer !== undefined) {
      if (!Number.isInteger(args.targetLayer))
        return jsxFail("targetLayer precisa ser um índice inteiro.");
      if (
        args.objective !== undefined &&
        !String(args.objective).startsWith("apply_motion_to_target")
      )
        return jsxFail("targetLayer exige um objetivo de aplicação de movimento.");
    }
    return `
        ${jsxCompPreamble(args)}
        ${LAYER_SET}
        ${EFFECT_STATE}
        ${WRITE_VALUE}
        var layers = trackingLayers(_comp, ${jsxVal(args.layer)});
        var effectName = ${jsxVal(matchName)}, options = ${jsxVal(values)};
        var target = ${jsxVal(args.targetLayer ?? null)}, createNew = ${jsxVal(args.addNew === true)};
        if (target !== null && target > _comp.numLayers) return { ok: false, error: "Camada de destino inexistente." };
        var jobs = [];
        for (var i = 0; i < layers.length; i++) {
            var layer = layers[i];
            if (!(layer instanceof AVLayer) || !layer.source || !layer.hasVideo || layer.source.duration <= 0) {
                return { ok: false, error: "A camada precisa ter vídeo ou uma pré-composição com duração: " + layer.name };
            }
            if (layer.width !== _comp.width || layer.height !== _comp.height) {
                return { ok: false, error: "A camada precisa ter as dimensões da composição. Pré-componha se necessário: " + layer.name };
            }
            if (layer.locked) return { ok: false, error: "Camada bloqueada: " + layer.name };
            if (target !== null && target === layer.index) return { ok: false, error: "A camada de destino deve ser diferente da origem." };
            var effects = layer.property("ADBE Effect Parade"), existing = null;
            for (var f = 1; f <= effects.numProperties && !createNew; f++) {
                if (effects.property(f).matchName === effectName) { existing = effects.property(f); break; }
            }
            if (!existing && !effects.canAddProperty(effectName))
                return { ok: false, error: "O After Effects não permite adicionar o efeito à camada " + layer.name };
            if (target !== null && ${jsxVal(args.objective === undefined)}) {
                var objective = existing ? existing.property(effectName + "-0047").value : 1;
                if (objective !== 4 && objective !== 5)
                    return { ok: false, error: "Defina um objetivo de aplicação de movimento para targetLayer." };
            }
            jobs.push({ layer: layer, effects: effects, existing: existing });
        }

        var added = [], updated = [], results = [], at = _comp.time, viewerReady = false;
        try {
            for (var j = 0; j < jobs.length; j++) {
                var job = jobs[j], fx = job.existing;
                if (!fx) {
                    // Native analysis can stay idle when the composition has no active viewer.
                    if (!viewerReady) {
                        _comp.openInViewer();
                        viewerReady = true;
                    }
                    job.layer.selected = true;
                    fx = job.effects.addProperty(effectName);
                    added.push(fx);
                }
                var applied = {};
                for (var k = 0; k < options.length; k++) {
                    var opt = options[k], control = fx.property(effectName + "-" + opt.suffix);
                    if (!control) throw new Error("Controle indisponível nesta versão: " + opt.field);
                    var original = updateTrackingValue(control, opt.value, at, control.canVaryOverTime && control.numKeys > 0);
                    if (job.existing) updated.push(original);
                    applied[opt.field] = control.canVaryOverTime ? control.valueAtTime(at, false) : control.value;
                }
                results.push({ layer: job.layer.index, layerId: job.layer.id, added: !job.existing,
                               set: applied, effect: trackingEffectState(fx) });
            }
        } catch (e) {
            restoreTrackingValues(updated, at);
            for (var a = added.length - 1; a >= 0; a--) {
                try { added[a].remove(); } catch (removeError) {}
            }
            return { ok: false, error: AE.errText(e) };
        }
        return { ok: true, layers: results, analysis: "managed_by_after_effects" };
    `;
  } catch (e) {
    return jsxFail(e instanceof Error ? e.message : String(e));
  }
}

function effectOperation(
  opName: string,
  description: string,
  matchName: string,
  controls: readonly Control[],
) {
  const params: OperationParam[] = [
    COMP,
    LAYERS,
    {
      name: "addNew",
      type: "boolean",
      description: "Add a separate effect instance. Reuse the existing effect by default.",
    },
    ...controls.map(({ field, type, description: help }) => ({
      name: field,
      type,
      description: help,
    })),
  ];
  if (matchName === STABILIZER)
    params.push({
      name: "synthesisEdgeCropping",
      type: "object",
      description: "Pixel crop values by edge: left, top, right, bottom.",
    });
  registerOp({
    name: opName,
    category: "tracking",
    description,
    params,
    toJsx: (args) => effectScript(args, matchName, controls),
  });
}

effectOperation(
  "tracking.warp_stabilizer",
  "Apply or configure After Effects' native Warp Stabilizer. Reports applied controls; After Effects manages analysis separately.",
  STABILIZER,
  WARP,
);
effectOperation(
  "tracking.camera_tracker",
  "Apply or configure the native 3D Camera Tracker. Reports applied controls; creating a camera from solved points is a separate panel action.",
  CAMERA_TRACKER,
  CAMERA,
);

const ACTIONS: Record<string, number> = {
  track_motion: 2568,
  track_mask: 10311,
  track_property: 2643,
};

registerOp({
  name: "tracking.start",
  category: "tracking",
  description:
    "Prepare point, mask or property tracking on one layer. Point and mask analysis controls are separate. Does not launch Mocha or switch the workspace.",
  params: [
    COMP,
    LAYER,
    TIME,
    {
      name: "action",
      type: "string",
      description: "track_motion | track_mask | track_property",
      required: true,
    },
    {
      name: "masks",
      type: "array",
      description: "Track Mask only: one-based mask indexes. Defaults to all masks on the layer.",
    },
    {
      name: "property",
      type: "array",
      description: "Track Property only: path from the layer, preferably match names.",
    },
  ],
  toJsx(args) {
    const action = String(args.action);
    if (!Object.hasOwn(ACTIONS, action))
      return jsxFail(
        "Use track_motion, track_mask ou track_property. Os demais comandos exigem interface ou Mocha.",
      );
    const masks = args.masks as unknown[] | undefined;
    if (
      masks &&
      (action !== "track_mask" || !masks.every((m) => Number.isInteger(m) && Number(m) > 0))
    )
      return jsxFail("masks exige track_mask e índices inteiros positivos.");
    const property = args.property as unknown[] | undefined;
    if (
      (action === "track_property" && !property?.length) ||
      (property && action !== "track_property")
    )
      return jsxFail("Informe property somente com track_property.");
    if (property && !validPropertyPath(property))
      return jsxFail("Caminho de propriedade inválido.");
    if (typeof args.time === "number" && args.time < 0)
      return jsxFail("time precisa ser maior ou igual a zero.");

    return `
      ${jsxCompLayerPreamble(args)}
      var action = ${jsxVal(action)}, at = ${jsxVal(args.time ?? null)};
      if (at !== null && at >= _comp.duration) return { ok: false, error: "Tempo fora da composição." };
      if (_layer.locked) return { ok: false, error: "A camada está bloqueada." };
      var trackerRoot = _layer.property("ADBE MTrackers");
      if ((action === "track_motion" || action === "track_mask") &&
          (!(_layer instanceof AVLayer) || !_layer.source || !_layer.hasVideo || _layer.source.duration <= 0))
          return { ok: false, error: "Escolha uma camada de vídeo ou uma pré-composição." };
      if (action === "track_motion" && !trackerRoot)
          return { ok: false, error: "A camada não suporta o rastreador de pontos." };
      var before = trackerRoot ? trackerRoot.numProperties : 0;
      var selection = [], propertyPath = ${jsxVal(property ?? [])}, masks = ${jsxVal(masks ?? [])};
      if (action === "track_mask") {
          var maskGroup = _layer.property("ADBE Mask Parade");
          if (!maskGroup || !maskGroup.numProperties) return { ok: false, error: "A camada precisa ter uma máscara." };
          if (!masks.length) for (var m = 1; m <= maskGroup.numProperties; m++) masks.push(m);
          for (var i = 0; i < masks.length; i++) {
              if (masks[i] > maskGroup.numProperties) return { ok: false, error: "Índice de máscara inexistente: " + masks[i] };
              selection.push(maskGroup.property(masks[i]));
          }
      }
      if (action === "track_property") {
          var current = _layer;
          for (var p = 0; p < propertyPath.length && current; p++)
              current = AE.safeGet(function () { return current.property(propertyPath[p]); }, null);
          if (!current || current.propertyType !== PropertyType.PROPERTY || !current.canVaryOverTime)
              return { ok: false, error: "Escolha uma propriedade animável." };
          selection.push(current);
      }

      _comp.openInViewer();
      if (at !== null) _comp.time = at;
      for (var l = 1; l <= _comp.numLayers; l++) _comp.layer(l).selected = false;
      var selectedProperties = _layer.selectedProperties;
      for (var x = selectedProperties.length - 1; x >= 0; x--) selectedProperties[x].selected = false;
      _layer.selected = true;
      for (var j = 0; j < selection.length; j++) selection[j].selected = true;
      app.executeCommand(${jsxVal(ACTIONS[action])});
      var afterRoot = _layer.property("ADBE MTrackers");
      var count = afterRoot ? afterRoot.numProperties : 0;
      if (action === "track_motion" && count <= before)
          return { ok: false, error: "O After Effects não criou o ponto de tracking." };
      return { ok: true, action: action, layer: _layer.index, trackers: count,
               masks: masks, analysisStarted: false };
    `;
  },
});

function validPropertyPath(path: unknown[]): boolean {
  return path.every(
    (part) =>
      (typeof part === "string" && part.length > 0) ||
      (typeof part === "number" && Number.isInteger(part) && part > 0),
  );
}

const POINT_FIELDS = [
  ["featureCenter", "ADBE MTracker Pt Feature Center"],
  ["featureSize", "ADBE MTracker Pt Feature Size"],
  ["searchOffset", "ADBE MTracker Pt Search Ofst"],
  ["searchSize", "ADBE MTracker Pt Search Size"],
  ["attachPoint", "ADBE MTracker Pt Attach Pt"],
  ["attachPointOffset", "ADBE MTracker Pt Attach Pt Ofst"],
] as const;

const READ_VALUE = `
function trackingValue(p, at, keys, limit) {
    var r = { value: AE.safeGet(function () { return p.canVaryOverTime ? p.valueAtTime(at, false) : p.value; }, null),
              numKeys: p.numKeys, animatable: p.canVaryOverTime };
    if (keys) {
        r.keys = [];
        for (var k = 1; k <= p.numKeys && k <= limit; k++) {
            r.keys.push({ time: p.keyTime(k), value: p.keyValue(k) });
        }
        r.truncated = p.numKeys > limit;
    }
    return r;
}
`;

registerOp({
  name: "tracking.get_data",
  category: "tracking",
  description:
    "Read point tracks, face measurements or applied tracking effects. Can return sampled values and keyframes for point and face data.",
  readOnly: true,
  params: [
    COMP,
    LAYERS,
    TIME,
    { name: "source", type: "string", description: "trackers (default), face, or effects." },
    { name: "keyframes", type: "boolean", description: "Include tracking keys." },
    {
      name: "limit",
      type: "number",
      description: "Maximum keys per property, default 200 and maximum 10000.",
    },
  ],
  toJsx(args) {
    const source = String(args.source ?? "trackers");
    const limit = Number(args.limit ?? 200);
    if (!["trackers", "face", "effects"].includes(source))
      return jsxFail("Use source trackers, face ou effects.");
    if (!Number.isInteger(limit) || limit < 1 || limit > 10000)
      return jsxFail("limit precisa estar entre 1 e 10000.");
    if (typeof args.time === "number" && args.time < 0)
      return jsxFail("time precisa ser maior ou igual a zero.");
    return `
      ${jsxCompPreamble(args)}
      ${LAYER_SET}
      ${EFFECT_STATE}
      ${READ_VALUE}
      var layers = trackingLayers(_comp, ${jsxVal(args.layer)}), out = [];
      var at = ${jsxVal(args.time ?? null)}, withKeys = ${jsxVal(args.keyframes === true)};
      if (at === null) at = _comp.time;
      var source = ${jsxVal(source)}, limit = ${jsxVal(limit)};
      var fields = ${jsxVal([...POINT_FIELDS, ["confidence", "ADBE MTracker Pt Confidence"]])};
      for (var i = 0; i < layers.length; i++) {
          var layer = layers[i], entry = { layer: layer.index, layerId: layer.id, name: layer.name };
          if (source === "trackers") {
              entry.trackers = [];
              var root = layer.property("ADBE MTrackers");
              for (var g = 1; root && g <= root.numProperties; g++) {
                  var tr = root.property(g), points = [];
                  for (var n = 1; n <= tr.numProperties; n++) {
                      var point = tr.property(n), info = { index: n, name: point.name };
                      for (var q = 0; q < fields.length; q++) {
                          var p = point.property(fields[q][1]);
                          if (p) info[fields[q][0]] = trackingValue(p, at, withKeys, limit);
                      }
                      points.push(info);
                  }
                  entry.trackers.push({ index: g, name: tr.name, trackPoints: points });
              }
          } else {
              entry.effects = [];
              var effects = layer.property("ADBE Effect Parade");
              for (var f = 1; effects && f <= effects.numProperties; f++) {
                  var fx = effects.property(f);
                  if (source === "effects") {
                      if (fx.matchName === ${jsxVal(STABILIZER)} || fx.matchName === ${jsxVal(CAMERA_TRACKER)})
                          entry.effects.push(trackingEffectState(fx));
                  } else if (/face/i.test(fx.matchName) || /face|rosto|facial/i.test(fx.name)) {
                      var group = null, values = [];
                      for (var v = 1; v <= fx.numProperties; v++) {
                          var prop = fx.property(v);
                          if (prop.propertyType !== PropertyType.PROPERTY) continue;
                          if (prop.propertyValueType === PropertyValueType.NO_VALUE) { if (prop.name) group = prop.name; continue; }
                          var data = trackingValue(prop, at, withKeys, limit);
                          data.group = group;
                          data.name = prop.name;
                          data.matchName = prop.matchName;
                          values.push(data);
                      }
                      entry.effects.push({ name: fx.name, matchName: fx.matchName, index: fx.propertyIndex, values: values });
                  }
              }
          }
          out.push(entry);
      }
      return { ok: true, time: at, source: source, layers: out };
    `;
  },
});

registerOp({
  name: "tracking.set_point",
  category: "tracking",
  description:
    "Edit a motion track point in source pixels. Supplying time writes keys for animatable fields. The response lists which settings are static. Confidence is read-only.",
  params: [
    COMP,
    LAYER,
    TIME,
    { name: "tracker", type: "any", description: "Tracker index or exact name, default 1." },
    { name: "point", type: "any", description: "Point index or exact name, default 1." },
    ...POINT_FIELDS.map(([name]) => ({
      name,
      type: "array" as const,
      description: "Two coordinates or dimensions in pixels [x, y].",
    })),
  ],
  toJsx(args) {
    const tracker = args.tracker ?? 1,
      point = args.point ?? 1;
    if (!validPropertyPath([tracker, point]))
      return jsxFail("Use nome ou índice inteiro positivo para tracker e point.");
    if (typeof args.time === "number" && args.time < 0)
      return jsxFail("time precisa ser maior ou igual a zero.");
    const changes: Array<[string, string, unknown]> = [];
    for (const [field, match] of POINT_FIELDS) {
      const value = args[field];
      if (value === undefined) continue;
      if (
        !Array.isArray(value) ||
        value.length !== 2 ||
        !value.every((item) => typeof item === "number" && Number.isFinite(item))
      )
        return jsxFail(field + " precisa de duas coordenadas numéricas.");
      if (field.endsWith("Size") && value.some((item) => item <= 0))
        return jsxFail(field + " precisa de dimensões positivas.");
      changes.push([field, match, value]);
    }
    if (!changes.length) return jsxFail("Informe ao menos um campo do ponto de tracking.");
    return `
      ${jsxCompLayerPreamble(args)}
      ${WRITE_VALUE}
      if (_layer.locked) return { ok: false, error: "A camada está bloqueada." };
      var root = _layer.property("ADBE MTrackers");
      var tracker = root ? AE.safeGet(function () { return root.property(${jsxVal(tracker)}); }, null) : null;
      if (!tracker) return { ok: false, error: "Tracker inexistente. Prepare o tracking primeiro." };
      var point = AE.safeGet(function () { return tracker.property(${jsxVal(point)}); }, null);
      if (!point) return { ok: false, error: "Ponto de tracking inexistente." };
      var changes = ${jsxVal(changes)}, properties = [], at = ${jsxVal(args.time ?? null)};
      for (var n = 0; n < changes.length; n++) {
          var p = point.property(changes[n][1]);
          if (!p) return { ok: false, error: "Controle não encontrado: " + changes[n][0] };
          properties.push(p);
      }
      var keyTime = at === null ? _comp.time : at, updated = [];
      var set = {}, keyframed = [], staticFields = [];
      try {
          for (var i = 0; i < changes.length; i++) {
              var prop = properties[i], field = changes[i][0];
              var keyframe = prop.canVaryOverTime && (at !== null || prop.numKeys > 0);
              updated.push(updateTrackingValue(prop, changes[i][2], keyTime, keyframe));
              if (keyframe) keyframed.push(field);
              else staticFields.push(field);
              set[field] = prop.canVaryOverTime ? prop.valueAtTime(keyTime, false) : prop.value;
          }
      } catch (e) {
          restoreTrackingValues(updated, keyTime);
          return { ok: false, error: AE.errText(e) };
      }
      return { ok: true, layer: _layer.index, tracker: tracker.name, point: point.name,
               set: set, keyframed: keyframed, staticFields: staticFields };
    `;
  },
});
