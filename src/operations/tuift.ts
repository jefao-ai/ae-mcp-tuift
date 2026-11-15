// tuift.* — the studio's house moves as first-class operations, so an agent
// never re-derives them in eval.run: mola padrão (Overshoot BOUNCr), entrance
// and exit presets, stagger, "vivo" drift, living camera and named easing
// curves. Numbers come from the house style (kit/estilo-da-casa.json, or the file
// named by TUIFT_HOUSE_STYLE) at call time.

import { registerOp, jsxFail, jsxVal, jsxCompPreamble } from "../registry.js";
import { normalizarNomeCena } from "../tuift/cenas.js";
import { houseStyle } from "../tuift/common.js";

const COMP = { name: "comp", type: "any" as const, description: "Comp name or id", required: true };
const LAYERS = {
  name: "layer",
  type: "any" as const,
  description: "Layer index, name, { id }, 'selected', 'all', or an array of those",
  required: true,
};

function molaExpr(ampIn: unknown, freqIn: unknown, decayIn: unknown): string {
  const amp = Number(ampIn),
    freq = Number(freqIn),
    decay = Number(decayIn);
  if (![amp, freq, decay].every(Number.isFinite))
    throw new Error("amp, freq and decay must be numbers");
  // Ebberts overshoot on the velocity arriving at the last key.
  return (
    `// tuift.mola amp ${amp} freq ${freq} decay ${decay}\n` +
    `var amp=${amp},freq=${freq},decay=${decay};var n=0;if(numKeys>0){n=nearestKey(time).index;if(key(n).time>time)n--;}` +
    `var t=(n==0)?0:time-key(n).time;if(n>0&&t<1){var v=velocityAtTime(key(n).time-thisComp.frameDuration/10);` +
    `value+v*amp*Math.sin(freq*t*2*Math.PI)/Math.exp(decay*t);}else{value;}`
  );
}

/** JSX helpers shared by the tuift ops (defined inline per call; ES3). */
const TUIFT_LIB = `
var TUIFT = {};
TUIFT.prop = function (layer, name) {
  var tr = layer.property("ADBE Transform Group");
  var map = { "Position": "ADBE Position", "Scale": "ADBE Scale", "Rotation": "ADBE Rotate Z", "Opacity": "ADBE Opacity", "Anchor Point": "ADBE Anchor Point" };
  if (map.hasOwnProperty(name)) return tr.property(map[name]);
  return AE.propertyAtPath(layer, name);
};
TUIFT.targets = function (p) { var f = AE.separationFollowers(p); return f ? f : [p]; };
TUIFT.frame = function (comp, t) { return Math.round(t / comp.frameDuration) * comp.frameDuration; };
TUIFT.clearRange = function (p, a, b) { for (var k = p.numKeys; k >= 1; k--) { var kt = p.keyTime(k); if (kt >= a - 1e-6 && kt <= b + 1e-6) p.removeKey(k); } };
TUIFT.linearKeys = function (p, t0, v0, t1, v1, clearFrom) {
  var ts = TUIFT.targets(p);
  var v0n = AE.nativeValue(p, v0), v1n = AE.nativeValue(p, v1);
  for (var i = 0; i < ts.length; i++) {
    var q = ts[i];
    TUIFT.clearRange(q, (clearFrom === undefined || clearFrom === null) ? t0 : Math.min(clearFrom, t0), t1);
    var a = AE._componentFor(v0n, i, ts.length), b = AE._componentFor(v1n, i, ts.length);
    var k0 = q.addKey(t0); q.setValueAtKey(k0, a);
    var k1 = q.addKey(t1); q.setValueAtKey(k1, b);
    k0 = q.nearestKeyIndex(t0); k1 = q.nearestKeyIndex(t1);
    q.setInterpolationTypeAtKey(k0, KeyframeInterpolationType.LINEAR, KeyframeInterpolationType.LINEAR);
    q.setInterpolationTypeAtKey(k1, KeyframeInterpolationType.LINEAR, KeyframeInterpolationType.LINEAR);
  }
  return ts;
};
TUIFT.easeKeys = function (p, t0, v0, t1, v1, outInf, inInf) {
  var ts = TUIFT.targets(p);
  var v0n = AE.nativeValue(p, v0), v1n = AE.nativeValue(p, v1);
  for (var i = 0; i < ts.length; i++) {
    var q = ts[i];
    TUIFT.clearRange(q, t0, t1);
    var a = AE._componentFor(v0n, i, ts.length), b = AE._componentFor(v1n, i, ts.length);
    var k0 = q.addKey(t0); q.setValueAtKey(k0, a);
    var k1 = q.addKey(t1); q.setValueAtKey(k1, b);
    k0 = q.nearestKeyIndex(t0); k1 = q.nearestKeyIndex(t1);
    AE.setEase(q, k0, 0.1, outInf, 0, 0);
    AE.setEase(q, k1, inInf, 0.1, 0, 0);
  }
  return ts;
};
TUIFT.setExpr = function (p, expr) { var ts = TUIFT.targets(p); for (var i = 0; i < ts.length; i++) ts[i].expression = expr; return ts.length; };
TUIFT.isVivo = function (e) { return e.indexOf("tuift_vivo") >= 0; };
TUIFT.add = function (v, d) { if (v instanceof Array) { var o = []; for (var i = 0; i < v.length; i++) o.push(v[i] + (d[i] || 0)); return o; } return v + d; };
`;

registerOp({
  name: "tuift.mola",
  category: "tuift",
  description:
    "Mola padrão da casa (overshoot spring): two LINEAR keys from→to over 0.25 s plus an overshoot expression (amp .05 · freq 2 · decay 4, ~112%, settles ~0.6 s). Use for every card/button/bubble/notification/badge entrance and UI morph. Without from/to it only adds the expression to the property's existing keys (they must arrive with speed: linear or ease-out). Values are in the layer's own space — relative to its parent when parented.",
  params: [
    COMP,
    LAYERS,
    {
      name: "property",
      type: "string",
      description:
        "Position | Scale | Rotation | Opacity | Anchor Point | a property path (default Scale)",
      required: false,
    },
    {
      name: "from",
      type: "any",
      description: "Start value (number or array). With `to`, keys are created.",
      required: false,
    },
    {
      name: "to",
      type: "any",
      description: "End value. Default: the property's current value.",
      required: false,
    },
    {
      name: "at",
      type: "number",
      description: "Start time in seconds (default each layer's in point)",
      required: false,
    },
    {
      name: "dur",
      type: "number",
      description: "Seconds from→to (default house style, 0.25)",
      required: false,
    },
    {
      name: "amp",
      type: "number",
      description: "Overshoot amplitude (default .05)",
      required: false,
    },
    {
      name: "freq",
      type: "number",
      description: "Oscillation frequency (default 2)",
      required: false,
    },
    { name: "decay", type: "number", description: "Decay (default 4)", required: false },
  ],
  toJsx(args) {
    const s = houseStyle().mola;
    const expr = molaExpr(args.amp ?? s.amp, args.freq ?? s.freq, args.decay ?? s.decay);
    return `
      ${jsxCompPreamble(args)}
      ${TUIFT_LIB}
      var _layers = AE.resolveLayers(_comp, ${jsxVal(args.layer)});
      if (_layers.length === 0) return { ok: false, error: "no layers matched" };
      var _pname = ${jsxVal(args.property ?? "Scale")};
      var _from = ${jsxVal(args.from ?? null)}, _to = ${jsxVal(args.to ?? null)}, _at = ${jsxVal(args.at ?? null)};
      var _dur = ${jsxVal(args.dur ?? s.durSec)};
      var _out = [];
      for (var i = 0; i < _layers.length; i++) {
        var L = _layers[i];
        var p = TUIFT.prop(L, _pname);
        if (!p) { _out.push({ name: L.name, ok: false, error: "property not found: " + _pname }); continue; }
        var t0 = TUIFT.frame(_comp, _at === null ? L.inPoint : _at), t1 = TUIFT.frame(_comp, t0 + _dur);
        if (_from !== null) {
          var to = _to !== null ? _to : AE.readValue(p, t1);
          TUIFT.linearKeys(p, t0, _from, t1, to);
        }
        TUIFT.setExpr(p, ${jsxVal(expr)});
        _out.push({ name: L.name, ok: true, property: _pname, start: t0, end: t1 });
      }
      return { ok: true, layers: _out };
    `;
  },
});

registerOp({
  name: "tuift.entrada",
  category: "tuift",
  description:
    "House entrance on one or many layers: 'pop' (scale 0→100 with mola padrão + quick fade), 'sobe'/'desce'/'esquerda'/'direita' (slides `offset` px into place with mola + fade). Optional `stagger` seconds between layers in stack order (or `order`). Entrances start already in motion — never a dead first frame: the keys begin one frame before the layer shows, so its first visible frame is already partly scaled/faded in.",
  params: [
    COMP,
    LAYERS,
    {
      name: "kind",
      type: "string",
      description: "pop | sobe | desce | esquerda | direita (default pop)",
      required: false,
    },
    {
      name: "at",
      type: "number",
      description: "Start time (default each layer's in point)",
      required: false,
    },
    {
      name: "offset",
      type: "number",
      description: "Slide distance in px (default 60)",
      required: false,
    },
    {
      name: "stagger",
      type: "number",
      description: "Seconds between consecutive layers (default 0)",
      required: false,
    },
    {
      name: "order",
      type: "string",
      description: "index | reverse (default index)",
      required: false,
    },
    {
      name: "fade",
      type: "number",
      description: "Fade-in seconds (default 0.12; 0 = no opacity keys)",
      required: false,
    },
  ],
  toJsx(args) {
    const s = houseStyle().mola;
    const kind = String(args.kind ?? "pop");
    if (!["pop", "sobe", "desce", "esquerda", "direita"].includes(kind))
      return jsxFail(`unknown kind ${kind}`);
    const expr = molaExpr(s.amp, s.freq, s.decay);
    return `
      ${jsxCompPreamble(args)}
      ${TUIFT_LIB}
      var _layers = AE.resolveLayers(_comp, ${jsxVal(args.layer)});
      if (_layers.length === 0) return { ok: false, error: "no layers matched" };
      _layers.sort(function (a, b) { return a.index - b.index; });
      if (${jsxVal(args.order ?? "index")} === "reverse") _layers.reverse();
      var _kind = ${jsxVal(kind)}, _off = ${jsxVal(args.offset ?? 60)}, _st = ${jsxVal(args.stagger ?? 0)};
      var _at = ${jsxVal(args.at ?? null)}, _dur = ${jsxVal(s.durSec)}, _fade = ${jsxVal(args.fade ?? 0.12)};
      var _out = [];
      for (var i = 0; i < _layers.length; i++) {
        var L = _layers[i];
        var t0 = TUIFT.frame(_comp, (_at === null ? L.inPoint : _at) + i * _st);
        if (L.inPoint > t0) L.inPoint = t0;
        // keys start one frame BEFORE the layer shows: its first visible frame
        // (t0) is already on the way in, never an empty scale-0 / opacity-0 frame
        var k0 = t0 - _comp.frameDuration, t1 = TUIFT.frame(_comp, k0 + _dur);
        if (_kind === "pop") {
          var sc = TUIFT.prop(L, "Scale"); var full = AE.readValue(sc, t1);
          var zero = []; for (var d = 0; d < full.length; d++) zero.push(0);
          TUIFT.linearKeys(sc, k0, zero, t1, full, L.inPoint); TUIFT.setExpr(sc, ${jsxVal(expr)});
        } else {
          var ps = TUIFT.prop(L, "Position"); var fin = AE.readValue(ps, t1);
          var dl = { sobe: [0, _off], desce: [0, -_off], esquerda: [_off, 0], direita: [-_off, 0] }[_kind];
          TUIFT.linearKeys(ps, k0, TUIFT.add(fin, dl), t1, fin, L.inPoint); TUIFT.setExpr(ps, ${jsxVal(expr)});
        }
        if (_fade > 0) {
          var op = TUIFT.prop(L, "Opacity"); var o1 = AE.readValue(op, t1);
          var tsOp = TUIFT.targets(op); for (var c0 = 0; c0 < tsOp.length; c0++) TUIFT.clearRange(tsOp[c0], Math.min(L.inPoint, k0), t1);
          TUIFT.linearKeys(op, k0, 0, Math.max(t0, TUIFT.frame(_comp, k0 + _fade)), o1);
        }
        _out.push({ name: L.name, start: t0, end: t1 });
      }
      return { ok: true, kind: _kind, layers: _out };
    `;
  },
});

registerOp({
  name: "tuift.saida",
  category: "tuift",
  description:
    "House exit: the layer leaves ACCELERATING (slow start, fastest at the cut) — opacity to 0 plus optional slide ('sobe'/'desce'/'esquerda'/'direita') or 'encolhe' (scale to 90%). Ends at the layer's out point unless `end` is given.",
  params: [
    COMP,
    LAYERS,
    {
      name: "kind",
      type: "string",
      description: "fade | sobe | desce | esquerda | direita | encolhe (default fade)",
      required: false,
    },
    {
      name: "end",
      type: "number",
      description: "Time the layer is gone (default out point)",
      required: false,
    },
    { name: "dur", type: "number", description: "Seconds (default 0.25)", required: false },
    { name: "offset", type: "number", description: "Slide px (default 40)", required: false },
    {
      name: "stagger",
      type: "number",
      description: "Seconds between layers (default 0)",
      required: false,
    },
  ],
  toJsx(args) {
    const kind = String(args.kind ?? "fade");
    if (!["fade", "sobe", "desce", "esquerda", "direita", "encolhe"].includes(kind))
      return jsxFail(`unknown kind ${kind}`);
    return `
      ${jsxCompPreamble(args)}
      ${TUIFT_LIB}
      var _layers = AE.resolveLayers(_comp, ${jsxVal(args.layer)});
      if (_layers.length === 0) return { ok: false, error: "no layers matched" };
      _layers.sort(function (a, b) { return a.index - b.index; });
      var _kind = ${jsxVal(kind)}, _dur = ${jsxVal(args.dur ?? 0.25)}, _off = ${jsxVal(args.offset ?? 40)}, _st = ${jsxVal(args.stagger ?? 0)}, _end = ${jsxVal(args.end ?? null)};
      var _out = [];
      for (var i = 0; i < _layers.length; i++) {
        var L = _layers[i];
        var t1 = TUIFT.frame(_comp, (_end === null ? L.outPoint : _end) + i * _st), t0 = TUIFT.frame(_comp, t1 - _dur);
        var op = TUIFT.prop(L, "Opacity"); var o0 = AE.readValue(op, t0);
        TUIFT.easeKeys(op, t0, o0, t1, 0, 60, 0.1);
        if (_kind === "encolhe") {
          var sc = TUIFT.prop(L, "Scale"); var s0 = AE.readValue(sc, t0); var s1 = []; for (var d = 0; d < s0.length; d++) s1.push(s0[d] * 0.9);
          TUIFT.easeKeys(sc, t0, s0, t1, s1, 75, 0.1);
        } else if (_kind !== "fade") {
          var ps = TUIFT.prop(L, "Position"); var p0 = AE.readValue(ps, t0);
          var dl = { sobe: [0, -_off], desce: [0, _off], esquerda: [-_off, 0], direita: [_off, 0] }[_kind];
          TUIFT.easeKeys(ps, t0, p0, t1, TUIFT.add(p0, dl), 75, 0.1);
        }
        if (L.outPoint < t1) L.outPoint = t1;
        _out.push({ name: L.name, start: t0, end: t1 });
      }
      return { ok: true, kind: _kind, layers: _out };
    `;
  },
});

registerOp({
  name: "tuift.stagger",
  category: "tuift",
  description:
    "Offset layers in time (start time AND all their keys move together) so they don't start on the same frame. Steps from the house style: letras 0.035 s, itens 0.075 s, seções 0.15 s — or give `step`. Order: index | reverse | center (from the middle out) | random (seeded).",
  params: [
    COMP,
    LAYERS,
    {
      name: "step",
      type: "number",
      description: "Seconds between layers (default by `scale`)",
      required: false,
    },
    {
      name: "scale",
      type: "string",
      description: "letras | itens | secoes (default itens)",
      required: false,
    },
    {
      name: "order",
      type: "string",
      description: "index | reverse | center | random (default index)",
      required: false,
    },
    {
      name: "seed",
      type: "number",
      description: "Seed for random order (default 1)",
      required: false,
    },
  ],
  toJsx(args) {
    const st = houseStyle().stagger;
    const scale = String(args.scale ?? "itens");
    const step =
      args.step ??
      (scale === "letras" ? st.letrasSec : scale === "secoes" ? st.secoesSec : st.itensSec);
    return `
      ${jsxCompPreamble(args)}
      var _layers = AE.resolveLayers(_comp, ${jsxVal(args.layer)});
      if (_layers.length < 2) return { ok: false, error: "stagger needs at least 2 layers" };
      _layers.sort(function (a, b) { return a.index - b.index; });
      var _order = ${jsxVal(args.order ?? "index")}, _step = ${jsxVal(step)}, _seed = ${jsxVal(args.seed ?? 1)};
      var _rank = [];
      for (var i = 0; i < _layers.length; i++) _rank.push(i);
      if (_order === "reverse") _rank.reverse();
      else if (_order === "center") { var mid = (_layers.length - 1) / 2; for (var j = 0; j < _layers.length; j++) _rank[j] = Math.round(Math.abs(j - mid) * 2) ; }
      else if (_order === "random") { var s = _seed; for (var r = _rank.length - 1; r > 0; r--) { s = (s * 9301 + 49297) % 233280; var q = Math.floor(s / 233280 * (r + 1)); var tmp = _rank[r]; _rank[r] = _rank[q]; _rank[q] = tmp; } }
      var fd = _comp.frameDuration, _out = [];
      for (var k = 0; k < _layers.length; k++) {
        var L = _layers[k]; var sh = Math.round((_rank[k] * _step) / fd) * fd;
        L.startTime = L.startTime + sh;
        _out.push({ name: L.name, shift: sh });
      }
      return { ok: true, step: _step, layers: _out };
    `;
  },
});

registerOp({
  name: "tuift.vivo",
  category: "tuift",
  description:
    "Keep a layer alive during holds (o imperfeito humaniza): slow seeded drift on Position (and a hint of Rotation). If the property already has an expression (e.g. a mola), the drift goes on a new parent null 'VIVO <name>' instead, so nothing is overwritten. Defaults from house style: freq 0.5 Hz, 6 px, 0.4°.",
  params: [
    COMP,
    LAYERS,
    {
      name: "freq",
      type: "number",
      description: "Wiggle frequency (default 0.5)",
      required: false,
    },
    {
      name: "amp",
      type: "number",
      description: "Position amplitude px (default 6)",
      required: false,
    },
    {
      name: "rot",
      type: "number",
      description: "Rotation amplitude degrees (default 0.4; 0 = none)",
      required: false,
    },
  ],
  toJsx(args) {
    const v = houseStyle().vivo;
    const f = Number(args.freq ?? v.freq);
    const a = Number(args.amp ?? v.ampPx);
    const r = Number(args.rot ?? v.rotDeg);
    if (![f, a, r].every(Number.isFinite)) return jsxFail("freq, amp and rot must be numbers");
    return `
      ${jsxCompPreamble(args)}
      ${TUIFT_LIB}
      var _layers = AE.resolveLayers(_comp, ${jsxVal(args.layer)});
      if (_layers.length === 0) return { ok: false, error: "no layers matched" };
      var _out = [];
      for (var i = 0; i < _layers.length; i++) {
        var L = _layers[i];
        var seed = L.index * 7 + 3;
        var pe = "// tuift_vivo\\nseedRandom(" + seed + ",true); wiggle(${f}, ${a})";
        var re = "// tuift_vivo\\nseedRandom(" + (seed + 1) + ",true); wiggle(${f * 0.8}, ${r})";
        var pos = TUIFT.prop(L, "Position"), rot = TUIFT.prop(L, "Rotation");
        var busy = (pos.expression !== "" && !TUIFT.isVivo(pos.expression)) || (${r} > 0 && rot.expression !== "" && !TUIFT.isVivo(rot.expression));
        if (!busy) {
          TUIFT.setExpr(pos, pe); if (${r} > 0) rot.expression = re;
          _out.push({ name: L.name, mode: "expression" });
        } else {
          if (L.parent && L.parent.name === "VIVO " + L.name) { _out.push({ name: L.name, mode: "already", nullLayer: L.parent.name }); continue; }
          var n = _comp.layers.addNull(_comp.duration); n.name = "VIVO " + L.name; n.enabled = false;
          n.moveBefore(L);
          if (L.threeDLayer) n.threeDLayer = true;
          n.transform.anchorPoint.setValue(L.threeDLayer ? [0, 0, 0] : [0, 0]);
          // layer.parent = x compensates (no jump); setParentWithJump does NOT.
          if (L.parent) n.parent = L.parent;
          var lp = AE.readValue(pos, L.inPoint);
          n.transform.position.setValue(L.threeDLayer ? [lp[0], lp[1], lp[2] || 0] : [lp[0], lp[1]]);
          L.parent = n;
          n.transform.position.expression = pe; if (${r} > 0) n.transform.rotation.expression = re;
          _out.push({ name: L.name, mode: "parent null", nullLayer: n.name });
        }
      }
      return { ok: true, layers: _out };
    `;
  },
});

registerOp({
  name: "tuift.camera_viva",
  category: "tuift",
  description:
    "Living camera (câmera nunca parada): puts a parent null 'CAM VIVO' above a camera or a rig null with a continuous slow push (linear keys over the whole comp) plus seeded slow wiggle, so the shot never stops dead between moves. Existing camera keys are untouched.",
  params: [
    COMP,
    {
      name: "layer",
      type: "any",
      description: "Camera or rig null (index, name or { id })",
      required: true,
    },
    {
      name: "push",
      type: "number",
      description:
        "Total push over the comp: % scale for 2D rigs, px of Z for cameras (default 2 / 60)",
      required: false,
    },
    {
      name: "freq",
      type: "number",
      description: "Wiggle frequency (default 0.5)",
      required: false,
    },
    { name: "amp", type: "number", description: "Wiggle px (default 6)", required: false },
  ],
  toJsx(args) {
    const v = houseStyle().vivo;
    const f = Number(args.freq ?? v.freq);
    const a = Number(args.amp ?? v.ampPx);
    if (![f, a].every(Number.isFinite)) return jsxFail("freq and amp must be numbers");
    return `
      ${jsxCompPreamble(args)}
      ${TUIFT_LIB}
      var _ls = AE.resolveLayers(_comp, ${jsxVal(args.layer)});
      if (_ls.length !== 1) return { ok: false, error: "give exactly one camera or rig layer" };
      var L = _ls[0];
      var isCam = (L instanceof CameraLayer);
      if (L.parent && L.parent.name === "CAM VIVO") return { ok: true, reused: true, nullLayer: "CAM VIVO", target: L.name };
      var n = _comp.layers.addNull(_comp.duration); n.name = "CAM VIVO"; n.enabled = false;
      var is3 = isCam || L.threeDLayer;
      if (is3) n.threeDLayer = true;
      n.moveBefore(L);
      n.transform.anchorPoint.setValue(is3 ? [0, 0, 0] : [0, 0]);
      if (L.parent) n.parent = L.parent;
      n.transform.position.setValue(isCam ? [0, 0, 0] : (is3 ? [_comp.width / 2, _comp.height / 2, 0] : [_comp.width / 2, _comp.height / 2]));
      // layer.parent = x compensates (no jump); setParentWithJump does NOT.
      L.parent = n;
      var push = ${jsxVal(args.push ?? null)};
      if (isCam) {
        var pz = push === null ? 60 : push; var p = n.transform.position;
        p.setValueAtTime(0, [0, 0, 0]); p.setValueAtTime(_comp.duration, [0, 0, pz]);
      } else {
        var pc = push === null ? 2 : push; var s = n.transform.scale;
        s.setValueAtTime(0, [100, 100]); s.setValueAtTime(_comp.duration, [100 + pc, 100 + pc]);
      }
      n.transform.position.expression = "// tuift_vivo\\nseedRandom(11,true); value + (wiggle(${f}, ${a}) - value)";
      n.transform.rotation.expression = "// tuift_vivo\\nseedRandom(12,true); wiggle(${f * 0.7}, 0.3)";
      return { ok: true, nullLayer: n.name, target: L.name, camera: isCam };
    `;
  },
});

registerOp({
  name: "tuift.curva",
  category: "tuift",
  description:
    "Apply a named house curve to the keys of a property (both ends of each move, speed 0): 'saas' = bezier(.86,0,.07,1) for camera and scene changes; 'entrada' = (.33,0,.67,1); 'board' = (.333,0,.2285,1) for continuous whiteboard camera. Optionally only keys within [from, to] seconds.",
  params: [
    COMP,
    LAYERS,
    {
      name: "property",
      type: "string",
      description:
        "Position | Scale | Rotation | Opacity | Point of Interest | path (default Position)",
      required: false,
    },
    {
      name: "curve",
      type: "string",
      description: "saas | entrada | board (default saas)",
      required: false,
    },
    {
      name: "from",
      type: "number",
      description: "Only keys at or after this time",
      required: false,
    },
    {
      name: "to",
      type: "number",
      description: "Only keys at or before this time",
      required: false,
    },
  ],
  toJsx(args) {
    const curves = houseStyle().curvas;
    const name = String(args.curve ?? "saas");
    const c = curves[name];
    if (!c) return jsxFail(`unknown curve ${name}`);
    return `
      ${jsxCompPreamble(args)}
      ${TUIFT_LIB}
      var _layers = AE.resolveLayers(_comp, ${jsxVal(args.layer)});
      if (_layers.length === 0) return { ok: false, error: "no layers matched" };
      var _pn = ${jsxVal(args.property ?? "Position")}, _a = ${jsxVal(args.from ?? -1e9)}, _b = ${jsxVal(args.to ?? 1e9)};
      var _out = [];
      for (var i = 0; i < _layers.length; i++) {
        var L = _layers[i];
        var p = _pn === "Point of Interest" ? L.property("ADBE Transform Group").property("ADBE Anchor Point") : TUIFT.prop(L, _pn);
        if (!p) { _out.push({ name: L.name, ok: false, error: "property not found" }); continue; }
        var ts = TUIFT.targets(p), n = 0;
        for (var t = 0; t < ts.length; t++) {
          var q = ts[t];
          for (var k = 1; k <= q.numKeys; k++) {
            var kt = q.keyTime(k); if (kt < _a - 1e-6 || kt > _b + 1e-6) continue;
            AE.setEase(q, k, ${c.in}, ${c.out}, 0, 0); n++;
          }
        }
        _out.push({ name: L.name, keys: n });
      }
      return { ok: true, curve: ${jsxVal(name)}, layers: _out };
    `;
  },
});

registerOp({
  name: "tuift.cena",
  category: "tuift",
  description:
    "Mark the scenes of a comp as named markers (S01_GANCHO, S02_PROVA…), each with its duration. ae_see { cenas: true } then " +
    "shows the middle and settled frame of each scene, ae_review_motion reports issues per scene, and ae_render_video " +
    "{ redoCena: 'S03' } re-renders only that scene. Names are normalized ('gancho' at position 1 becomes S01_GANCHO). " +
    "Other comp markers are left alone; with `substituir` (default) the previous scene markers are replaced.",
  params: [
    COMP,
    {
      name: "cenas",
      type: "array",
      description:
        "[{ nome, inicio, fim }] in seconds. Without `fim`, the scene ends where the next one starts (or at the comp's end). ae_plano_check returns this list ready.",
      required: true,
    },
    {
      name: "substituir",
      type: "boolean",
      description: "Remove the existing scene markers first (default true)",
      required: false,
      default: true,
    },
  ],
  toJsx(args) {
    const entrada = args.cenas as Array<{ nome?: string; inicio?: unknown; fim?: unknown }>;
    if (!Array.isArray(entrada) || !entrada.length)
      return jsxFail("cenas must be a non-empty array");
    const cenas: Array<{ nome: string; inicio: number; fim: number | null }> = [];
    for (const [i, c] of entrada.entries()) {
      const inicio = Number(c?.inicio);
      const fim = c?.fim === undefined || c?.fim === null ? null : Number(c.fim);
      if (!Number.isFinite(inicio) || inicio < 0)
        return jsxFail(`cena ${i + 1}: inicio must be a number of seconds`);
      if (fim !== null && (!Number.isFinite(fim) || fim <= inicio))
        return jsxFail(`cena ${i + 1}: fim must be greater than inicio`);
      cenas.push({ nome: normalizarNomeCena(i, c?.nome), inicio, fim });
    }
    return `
      ${jsxCompPreamble(args)}
      var _cenas = ${jsxVal(cenas)};
      var _m = _comp.markerProperty;
      var _tiradas = 0;
      if (${jsxVal(args.substituir !== false)}) {
        for (var _k = _m.numKeys; _k >= 1; _k--) {
          if (/^S[0-9]{2,3}_/.test(String(_m.keyValue(_k).comment || ""))) { _m.removeKey(_k); _tiradas++; }
        }
      }
      var _feitas = [];
      for (var _i = 0; _i < _cenas.length; _i++) {
        var _c = _cenas[_i];
        if (_c.inicio >= _comp.duration) return { ok: false, error: _c.nome + " starts after the end of the comp" };
        var _fim = _c.fim !== null ? _c.fim : (_i + 1 < _cenas.length ? _cenas[_i + 1].inicio : _comp.duration);
        _fim = Math.min(_fim, _comp.duration);
        var _ini = Math.round(_c.inicio / _comp.frameDuration) * _comp.frameDuration;
        var _mv = new MarkerValue(_c.nome);
        _mv.duration = Math.max(0, _fim - _ini);
        _m.setValueAtTime(_ini, _mv);
        _feitas.push({ nome: _c.nome, inicio: _ini, fim: _fim });
      }
      return { ok: true, comp: _comp.name, removidas: _tiradas, cenas: _feitas };
    `;
  },
});
