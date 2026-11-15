// tuift.morph — "Morph It!" by name: one layer (or several) turns into another
// with the house spring. Works for any layer that renders pixels (PNG/JPG
// footage, shape, text, precomp), not just vector paths:
//
//   1. probe: render each layer ALONE to PNG (saveFrameToPng with every other
//      layer switched off for the call) at the moment it matters — the source
//      at `at`, the target once the morph has settled;
//   2. trace (Node): radial hull of the alpha — N rays from the bbox centre,
//      farthest opaque sample per ray. Same ray angles on both sides give a
//      vertex-to-vertex correspondence that never twists; dominant colour by
//      histogram;
//   3. build: a shape layer "blob" whose path is an expression interpolating the
//      two hulls by a progress p(t) (ease-in + Ebberts overshoot = the house
//      mola), colour following p; a hidden copy of the blob is the track matte
//      of the source (fading out, shrinking) and the target (growing in), so the
//      silhouette is ALWAYS the blob's and the details ride inside it. The
//      source is split at `at` and the target at the settle time, so outside
//      the morph both layers stay exactly as the user made them.

import { promises as fs } from "node:fs";
import * as path from "node:path";

import { decodePng, type DecodedPng } from "../color/png16.js";
import { readFileSettled } from "../color/settled-read.js";
import { houseStyle, WORK_DIR, stamp } from "../tuift/common.js";
import { registerOp, jsxFail, jsxVal } from "../registry.js";
import type { AeTransport } from "../transport/AeTransport.js";

type Pt = [number, number];

export interface Hull {
  center: Pt;
  points: Pt[];
  inT: Pt[];
  outT: Pt[];
  color: [number, number, number];
  bbox: [number, number, number, number];
}

function alphaAt(png: DecodedPng, x: number, y: number): number {
  const a = png.alpha;
  if (!a) return 1;
  const { width: w, height: h } = png;
  if (x < 0 || y < 0 || x > w - 1 || y > h - 1) return 0;
  const x0 = Math.floor(x),
    y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, w - 1),
    y1 = Math.min(y0 + 1, h - 1);
  const fx = x - x0,
    fy = y - y0;
  const top = a[y0 * w + x0] * (1 - fx) + a[y0 * w + x1] * fx;
  const bot = a[y1 * w + x0] * (1 - fx) + a[y1 * w + x1] * fx;
  return top * (1 - fy) + bot * fy;
}

/** Radial hull + dominant colour of a layer rendered alone. Null when nothing is opaque. */
export function traceHull(png: DecodedPng, rays: number, inset = 0): Hull | null {
  const { width: w, height: h, rgb } = png;
  const a = png.alpha;
  if (!a) throw new Error("the probe PNG has no alpha channel");
  let minX = w,
    minY = h,
    maxX = -1,
    maxY = -1;
  const bins = new Map<number, { n: number; r: number; g: number; b: number }>();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const al = a[i];
      if (al < 0.5) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (al < 0.9) continue;
      // un-premultiplied? saveFrameToPng writes straight alpha; clamp anyway.
      const r = Math.min(1, rgb[i * 3]),
        g = Math.min(1, rgb[i * 3 + 1]),
        b = Math.min(1, rgb[i * 3 + 2]);
      const key = (Math.round(r * 15) << 8) | (Math.round(g * 15) << 4) | Math.round(b * 15);
      const bin = bins.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
      bin.n++;
      bin.r += r;
      bin.g += g;
      bin.b += b;
      bins.set(key, bin);
    }
  }
  if (maxX < 0) return null;
  let best = { n: 0, r: 0, g: 0, b: 0 };
  for (const bin of bins.values()) if (bin.n > best.n) best = bin;
  const color: [number, number, number] =
    best.n > 0 ? [best.r / best.n, best.g / best.n, best.b / best.n] : [1, 1, 1];

  const cx = (minX + maxX + 1) / 2,
    cy = (minY + maxY + 1) / 2;
  const rMax = Math.hypot(maxX - minX + 2, maxY - minY + 2) / 2 + 2;
  const points: Pt[] = [];
  for (let k = 0; k < rays; k++) {
    // k = 0 points straight up; angles grow clockwise on screen (y down).
    const ang = -Math.PI / 2 + (2 * Math.PI * k) / rays;
    const dx = Math.cos(ang),
      dy = Math.sin(ang);
    let r = 0;
    for (let s = rMax; s > 0; s -= 0.5) {
      if (alphaAt(png, cx + dx * s - 0.5, cy + dy * s - 0.5) >= 0.5) {
        r = s;
        break;
      }
    }
    r = Math.max(0, r - inset);
    points.push([cx + dx * r, cy + dy * r]);
  }
  // Catmull-Rom tangents (relative, as AE paths want them).
  const inT: Pt[] = [],
    outT: Pt[] = [];
  for (let k = 0; k < rays; k++) {
    const p0 = points[(k - 1 + rays) % rays],
      p2 = points[(k + 1) % rays];
    const tx = (p2[0] - p0[0]) / 6,
      ty = (p2[1] - p0[1]) / 6;
    outT.push([tx, ty]);
    inT.push([-tx, -ty]);
  }
  return { center: [cx, cy], points, inT, outT, color, bbox: [minX, minY, maxX + 1, maxY + 1] };
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const arr = (pts: Pt[]) => "[" + pts.map((p) => `[${r2(p[0])},${r2(p[1])}]`).join(",") + "]";

interface Timing {
  t0: number;
  d: number;
  tEnd: number;
  mola: { amp: number; freq: number; decay: number } | null;
}

function meanRadius(h: Hull): number {
  let s = 0;
  for (const q of h.points) s += Math.hypot(q[0] - h.center[0], q[1] - h.center[1]);
  return s / h.points.length || 1;
}

/**
 * Expression text shared by every property of the rig. Defines
 *   p  — progress with the spring (ease-in to the target, then Ebberts overshoot);
 *   q  — p clamped to 0..1: drives the SHAPE and the colour (the outline never overshoots);
 *   sc — scale pop after arrival (= p once the shape has landed): the overshoot lives here;
 *   cc — the travelling centre, cA → cB by p.
 */
function progressExpr(t: Timing, a: Hull, b: Hull): string {
  const m = t.mola;
  return (
    `var t0=${t.t0},d=${t.d},tEnd=${t.tEnd};` +
    (m
      ? `function P(t){var u=(t-t0)/d;if(u<=0)return 0;if(u<1)return u*u;var s=t-t0-d;` +
        `var w=Math.max(0,Math.min(1,(tEnd-t)/0.25));` +
        `return 1+(2/d)*${m.amp}*Math.sin(${m.freq}*s*2*Math.PI)/Math.exp(${m.decay}*s)*w;}`
      : `function P(t){var u=(t-t0)/d;if(u<=0)return 0;if(u>=1)return 1;` +
        `return u<.5?4*u*u*u:1-Math.pow(-2*u+2,3)/2;}`) +
    `var p=P(time),q=Math.max(0,Math.min(1,p)),sc=(time>t0+d)?p:1;` +
    `var cA=[${r2(a.center[0])},${r2(a.center[1])}],cB=[${r2(b.center[0])},${r2(b.center[1])}];` +
    `var cc=[cA[0]+(cB[0]-cA[0])*p,cA[1]+(cB[1]-cA[1])*p];` +
    `var rA=${r2(meanRadius(a))},rB=${r2(meanRadius(b))},rq=rA+(rB-rA)*q;`
  );
}

const rel = (h: Hull): Pt[] => h.points.map((q) => [q[0] - h.center[0], q[1] - h.center[1]]);

function pathExpr(t: Timing, a: Hull, b: Hull): string {
  return (
    `// tuift.morph path
${progressExpr(t, a, b)}` +
    `var A=${arr(rel(a))},B=${arr(rel(b))},Ai=${arr(a.inT)},Bi=${arr(b.inT)},Ao=${arr(a.outT)},Bo=${arr(b.outT)};` +
    `function L(x,y){return [(x[0]+(y[0]-x[0])*q)*sc,(x[1]+(y[1]-x[1])*q)*sc];}` +
    `var P2=[],I2=[],O2=[];for(var i=0;i<A.length;i++){var v=L(A[i],B[i]);` +
    `P2.push([cc[0]+v[0],cc[1]+v[1]]);I2.push(L(Ai[i],Bi[i]));O2.push(L(Ao[i],Bo[i]));}` +
    `createPath(P2,I2,O2,true);`
  );
}

function colorExpr(t: Timing, a: Hull, b: Hull): string {
  const c = (h: Hull) => `[${h.color.map(r2).join(",")},1]`;
  return `// tuift.morph color
${progressExpr(t, a, b)}var k=Math.min(1,q/0.85);var a=${c(a)},b=${c(b)};[a[0]+(b[0]-a[0])*k,a[1]+(b[1]-a[1])*k,a[2]+(b[2]-a[2])*k,1];`;
}

/** Transform-effect expressions for the source (fades out) and the target (fades in), both riding the blob. */
function riderExprs(t: Timing, a: Hull, b: Hull, role: "de" | "para") {
  const pre = progressExpr(t, a, b);
  const own = role === "de" ? "cA" : "cB";
  const ownR = role === "de" ? "rA" : "rB";
  return {
    anchor: `${pre}fromComp(${own});`,
    position: `${pre}fromComp(cc);`,
    scale:
      role === "de"
        ? `${pre}var f=linear(time,t0,t0+d*0.45,1,0.85);100*f*rq/${ownR}*sc;`
        : `${pre}100*rq/${ownR}*sc;`,
    opacity:
      role === "de"
        ? `linear(time,${t.t0},${r2(t.t0 + t.d * 0.4)},100,0);`
        : `${pre}linear(q,0.45,0.9,0,100);`,
  };
}

const PROBE_JSX = (
  comp: unknown,
  probes: Array<{ ref: unknown; time: number | null; role: string }>,
  _dir: string,
) => `
  var _comp = AE.findCompByNameOrId(${jsxVal(comp)});
  if (!_comp) return { ok: false, error: "no comp matching " + ${jsxVal(String(comp))} };
  var probes = ${jsxVal(probes)};
  var out = [];
  for (var k = 0; k < probes.length; k++) {
    var L = AE.findLayerInComp(_comp, probes[k].ref);
    if (!L) return { ok: false, error: "no layer matching " + (typeof probes[k].ref === "object" ? "id " + probes[k].ref.id : probes[k].ref) };
    out.push({ index: L.index, id: L.id, name: L.name, inPoint: L.inPoint, outPoint: L.outPoint, role: probes[k].role, hasVideo: L.hasVideo });
  }
  return { ok: true, layers: out, comp: { name: _comp.name, id: _comp.id, width: _comp.width, height: _comp.height, fps: _comp.frameRate, frameDuration: _comp.frameDuration, duration: _comp.duration, time: _comp.time } };
`;

const SNAP_JSX = (compId: number, snaps: Array<{ index: number; time: number; file: string }>) => `
  var _comp = AE.findCompByNameOrId({ id: ${compId} });
  if (!_comp) _comp = (function(){ for (var i = 1; i <= app.project.numItems; i++) { var it = app.project.item(i); if (it instanceof CompItem && it.id === ${compId}) return it; } return null; })();
  if (!_comp) return { ok: false, error: "comp vanished" };
  var snaps = ${jsxVal(snaps)};
  var st = [];
  for (var i = 1; i <= _comp.numLayers; i++) { var l = _comp.layer(i); st.push({ e: l.enabled, s: (l.solo === true) }); }
  var written = [];
  try {
    for (var k = 0; k < snaps.length; k++) {
      var T = _comp.layer(snaps[k].index);
      for (var i = 1; i <= _comp.numLayers; i++) { var l = _comp.layer(i); try { if (l.solo) l.solo = false; } catch (e1) {} if (l !== T) { try { l.enabled = false; } catch (e2) {} } }
      T.enabled = true;
      var f = new File(snaps[k].file);
      _comp.saveFrameToPng(snaps[k].time, f);
      written.push(f.fsName);
    }
  } finally {
    for (var i = 1; i <= _comp.numLayers; i++) { var l = _comp.layer(i); try { l.enabled = st[i - 1].e; } catch (e3) {} try { if (st[i - 1].s) l.solo = true; } catch (e4) {} }
  }
  return { ok: true, written: written };
`;

const BUILD_JSX = (compId: number, spec: unknown) => `
  var _comp = null;
  for (var i = 1; i <= app.project.numItems; i++) { var it = app.project.item(i); if (it instanceof CompItem && it.id === ${compId}) { _comp = it; break; } }
  if (!_comp) return { ok: false, error: "comp vanished" };
  var S = ${jsxVal(spec)};
  function byId(id) { for (var i = 1; i <= _comp.numLayers; i++) if (_comp.layer(i).id === id) return _comp.layer(i); return null; }
  function fxProp(fx, mn, idx) { try { var p = fx.property(mn); if (p) return p; } catch (e) {} return fx.property(idx); }
  function rider(layer, ex) {
    var fx = layer.property("ADBE Effect Parade").addProperty("ADBE Geometry2");
    fx.name = "tuift.morph";
    fxProp(fx, "ADBE Geometry2-0001", 1).expression = ex.anchor;
    fxProp(fx, "ADBE Geometry2-0002", 2).expression = ex.position;
    fxProp(fx, "ADBE Geometry2-0003", 4).expression = ex.scale;
    fxProp(fx, "ADBE Geometry2-0008", 9).expression = ex.opacity;
    return fx;
  }
  function blob(name, pathEx, colorEx, enabled) {
    var L = _comp.layers.addShape();
    L.name = name;
    var tr = L.property("ADBE Transform Group");
    tr.property("ADBE Anchor Point").setValue([0, 0]);
    tr.property("ADBE Position").setValue([0, 0]);
    var g = L.property("ADBE Root Vectors Group").addProperty("ADBE Vector Group");
    g.name = "blob";
    var c = g.property("ADBE Vectors Group");
    var sh = c.addProperty("ADBE Vector Shape - Group");
    sh.property("ADBE Vector Shape").expression = pathEx;
    var fill = c.addProperty("ADBE Vector Graphic - Fill");
    fill.property("ADBE Vector Fill Color").expression = colorEx;
    L.inPoint = S.t0; L.outPoint = S.tEnd;
    L.enabled = enabled;
    L.label = 11;
    return L;
  }
  var para = byId(S.paraId);
  if (!para) return { ok: false, error: "target layer vanished" };
  // target: [t0, tEnd) rides the blob; [tEnd, out) stays the user's layer untouched
  var paraIn = para.inPoint, paraOut = para.outPoint;
  var paraA = para.duplicate();
  paraA.name = para.name + " · morph";
  paraA.inPoint = Math.max(paraIn, S.t0); paraA.outPoint = Math.min(paraOut, S.tEnd);
  if (paraOut > S.tEnd) para.inPoint = S.tEnd; else para.enabled = false;
  var made = [], mattes = [];
  var lowest = paraA;
  for (var k = 0; k < S.sources.length; k++) {
    var src = S.sources[k];
    var de = byId(src.id);
    if (!de) return { ok: false, error: "source layer vanished" };
    var b = blob("MORPH " + de.name + " > " + para.name, src.pathVisible, src.color, true);
    var m = blob("MORPH matte " + de.name, src.pathMatte, src.color, false);
    mattes.push(m);
    // source: [in, t0) untouched; [t0, t1) fades inside the matte
    var deB = null;
    if (de.outPoint > S.t0) {
      if (de.inPoint < S.t0) { deB = de.duplicate(); deB.inPoint = S.t0; de.outPoint = S.t0; }
      else deB = de;
      deB.name = de.name + " · morph";
      deB.outPoint = Math.min(deB.outPoint, S.t1);
      rider(deB, src.deExprs);
      deB.setTrackMatte(m, TrackMatteType.ALPHA);
      if (deB.index > lowest.index) lowest = deB;
    }
    made.push({ blob: b.name, matte: m.name, source: deB ? deB.name : null });
    b.moveAfter(lowest); m.moveBefore(b);
  }
  rider(paraA, S.paraExprs);
  paraA.setTrackMatte(mattes[0], TrackMatteType.ALPHA);
  return { ok: true, layers: made, target: paraA.name, targetAfter: para.name };
`;

// ---------------------------------------------------------------- estilo "voo"
// The motion of the one-click morph plugins, tracked frame by frame from a
// public ad (Ae → Ai, 19/10/2026; the AE UI is static there, so
// the positions are real comp motion). One value per 1/30 s:
//   source (16 frames, 0.53 s): anticipation JUMP back and up (~0.67 of its size)
//   in 0.1 s, a short hang at the top, then a dive down and forward that tilts
//   to +24° and shrinks to ~84%, and a final rush that rises into the target;
//   target: appears where it rests and HOPS ~0.72 of its size along the arrival
//   direction, grows to 126%, swings +16° → −17° → 0 like a pendulum, dips a bit
//   past rest and settles by ~0.75 s.
// Along-axis values are fractions of the source→target distance D; the
// backward/vertical ones use D clamped to 4–8 icon sizes, so short hops keep the
// same character. `mola.amp` scales the target's pop, `mola.tempo` stretches all.

const FLY_A = [
  0, -0.026, -0.0434, -0.0478, -0.0492, -0.0478, -0.0383, -0.0318, -0.0253, -0.0083, 0.0192, 0.0622,
  0.1309, 0.244, 0.816, 0.95, 1,
];
const FLY_B = [
  0, -0.0464, -0.0783, -0.0885, -0.0914, -0.0885, -0.0681, -0.058, -0.048, -0.0176, 0.0335, 0.0989,
  0.1685, 0.237, 0.216, 0.11, 0,
];
const FLY_S = [
  1, 1, 1, 0.978, 0.957, 0.936, 0.898, 0.882, 0.866, 0.841, 0.842, 0.834, 0.839, 0.853, 0.92, 0.95,
  0.99,
];
const FLY_R = [0, 0, 0, 0, 0, 0, 6.3, 8.2, 10, 13.1, 20.6, 24.3, 23.6, 24.2, 20.6, 18, 16];
const POP_HOP = [
  0, 0.378, 0.611, 0.716, 0.707, 0.625, 0.505, 0.36, 0.21, 0.083, -0.019, -0.088, -0.141, -0.161,
  -0.153, -0.145, -0.122, -0.097, -0.06, -0.035, -0.015, -0.005, 0, 0,
];
const POP_SCALE = [
  0.99, 1, 1.035, 1.13, 1.18, 1.25, 1.26, 1.22, 1.19, 1.14, 1.1, 1.06, 1.02, 0.985, 0.978, 0.982,
  0.988, 0.994, 0.998, 1, 1, 1, 1, 1,
];
const POP_ROT = [
  16, 14, 8, 5, 0, -7, -14, -16, -17, -15, -12, -8.5, -4.6, -1.5, 0.5, 1, 0.5, 0, 0, 0, 0, 0, 0, 0,
];
const FLY_FRAMES = FLY_A.length - 1;

/** Catmull-Rom over a per-frame table (ES3, for expressions). */
const TABLE_FN =
  "function T(x,q){if(q<=0)return x[0];var n=x.length-1;if(q>=n)return x[n];var i=Math.floor(q),f=q-i;" +
  "var a=x[Math.max(i-1,0)],b=x[i],c=x[i+1],d=x[Math.min(i+2,n)];" +
  "return 0.5*(2*b+(c-a)*f+(2*a-5*b+4*c-d)*f*f+(3*b-a-3*c+d)*f*f*f);}";

interface VooSource {
  id: number;
  p0: Pt;
  u: Pt;
  dist: number;
  deff: number;
  sign: number;
}

function vooSourceExprs(t0: number, tempo: number, s: VooSource) {
  const pre =
    `var q=(time-${t0})*30/${tempo},A=${JSON.stringify(FLY_A)},B=${JSON.stringify(FLY_B)},S=${JSON.stringify(FLY_S)},R=${JSON.stringify(FLY_R)};` +
    TABLE_FN;
  const [px, py] = [r2(s.p0[0]), r2(s.p0[1])];
  return {
    anchor: `fromComp([${px},${py}]);`,
    position:
      `// tuift.morph voo\n${pre}var a=T(A,q),al=(a>=0)?a*${r2(s.dist)}:a*${r2(s.deff)},b=T(B,q)*${r2(s.deff)};` +
      `fromComp([${px}+${r2(s.u[0])}*al,${py}+${r2(s.u[1])}*al+b]);`,
    scale: `${pre}100*T(S,q);`,
    rotation: `${pre}${s.sign}*T(R,q);`,
  };
}

function vooTargetExprs(
  tArr: number,
  p1: Pt,
  k: { amp: number; tempo: number; hop: Pt; sign: number },
) {
  const pre =
    `var q=(time-${tArr})*30/${k.tempo},H=${JSON.stringify(POP_HOP)},S=${JSON.stringify(POP_SCALE)},R=${JSON.stringify(POP_ROT)};` +
    TABLE_FN;
  return {
    anchor: `fromComp([${r2(p1[0])},${r2(p1[1])}]);`,
    position: `// tuift.morph voo\n${pre}var h=T(H,q)*${k.amp};fromComp([${r2(p1[0])}+${r2(k.hop[0])}*h,${r2(p1[1])}+${r2(k.hop[1])}*h]);`,
    scale: `${pre}100*(1+(T(S,q)-1)*${k.amp});`,
    rotation: `${pre}${k.sign}*T(R,q)*${Math.min(1, k.amp)};`,
  };
}

// Several sources → one (the ad's 6 icons → Spotify, tracked the same way):
// almost no anticipation (a 1-frame flinch), all shrink to ~82% and tilt ±25°
// (towards where each one goes) while starting to move, dip and converge in
// the last 4 frames (14 frames total); the target pops 92 → 121 → 96 → 100%
// with a small upward hop (~0.2 of its size).
const MULTI_A = [
  0, -0.005, -0.005, 0, 0.005, 0.015, 0.03, 0.055, 0.1, 0.17, 0.28, 0.47, 0.72, 0.9, 1,
];
const MULTI_B = [
  0, -0.005, -0.005, 0, 0.005, 0.015, 0.03, 0.06, 0.1, 0.15, 0.2, 0.25, 0.22, 0.12, 0,
];
const MULTI_S = [
  1, 0.988, 0.97, 0.95, 0.91, 0.87, 0.84, 0.82, 0.82, 0.83, 0.85, 0.88, 0.9, 0.92, 0.92,
];
const MULTI_R = [0, 0, 0, 1.5, 5, 10, 14, 18, 22, 24, 24.5, 24, 22, 20, 18];
const MULTI_FRAMES = MULTI_A.length - 1;
const MULTI_POP_SCALE = [
  0.92, 0.95, 0.99, 1.1, 1.18, 1.21, 1.2, 1.18, 1.15, 1.1, 1.05, 1.01, 0.985, 0.968, 0.958, 0.957,
  0.962, 0.968, 0.975, 0.982, 0.99, 0.995, 1,
];
const MULTI_POP_HOP = [
  -0.01, 0.11, 0.18, 0.205, 0.205, 0.18, 0.13, 0.09, 0.055, 0.02, -0.02, -0.04, -0.055, -0.055,
  -0.045, -0.035, -0.025, -0.015, -0.008, -0.003, 0, 0, 0,
];

function multiSourceExprs(t0: number, tempo: number, s: VooSource) {
  const pre =
    `var q=(time-${t0})*30/${tempo},A=${JSON.stringify(MULTI_A)},B=${JSON.stringify(MULTI_B)},S=${JSON.stringify(MULTI_S)},R=${JSON.stringify(MULTI_R)};` +
    TABLE_FN;
  const [px, py] = [r2(s.p0[0]), r2(s.p0[1])];
  return {
    anchor: `fromComp([${px},${py}]);`,
    position:
      `// tuift.morph voo (varios)\n${pre}var al=T(A,q)*${r2(s.dist)},b=T(B,q)*${r2(s.dist)};` +
      `fromComp([${px}+${r2(s.u[0])}*al,${py}+${r2(s.u[1])}*al+b]);`,
    scale: `${pre}100*T(S,q);`,
    rotation: `${pre}${s.sign}*T(R,q);`,
  };
}

function multiTargetExprs(tArr: number, p1: Pt, k: { amp: number; tempo: number; hop: Pt }) {
  const pre =
    `var q=(time-${tArr})*30/${k.tempo},H=${JSON.stringify(MULTI_POP_HOP)},S=${JSON.stringify(MULTI_POP_SCALE)};` +
    TABLE_FN;
  return {
    anchor: `fromComp([${r2(p1[0])},${r2(p1[1])}]);`,
    position: `// tuift.morph voo (varios)\n${pre}var h=T(H,q)*${k.amp};fromComp([${r2(p1[0])}+${r2(k.hop[0])}*h,${r2(p1[1])}+${r2(k.hop[1])}*h]);`,
    scale: `${pre}100*(1+(T(S,q)-1)*${k.amp});`,
    rotation: `0;`,
  };
}

const BUILD_VOO_JSX = (compId: number, spec: unknown) => `
  var _comp = null;
  for (var i = 1; i <= app.project.numItems; i++) { var it = app.project.item(i); if (it instanceof CompItem && it.id === ${compId}) { _comp = it; break; } }
  if (!_comp) return { ok: false, error: "comp vanished" };
  var S = ${jsxVal(spec)};
  function byId(id) { for (var i = 1; i <= _comp.numLayers; i++) if (_comp.layer(i).id === id) return _comp.layer(i); return null; }
  function rider(layer, ex) {
    var fx = layer.property("ADBE Effect Parade").addProperty("ADBE Geometry2");
    fx.name = "tuift.morph";
    fx = layer.property("ADBE Effect Parade").property(layer.property("ADBE Effect Parade").numProperties);
    fx.property("ADBE Geometry2-0001").expression = ex.anchor;
    fx.property("ADBE Geometry2-0002").expression = ex.position;
    fx.property("ADBE Geometry2-0003").expression = ex.scale;
    fx.property("ADBE Geometry2-0007").expression = ex.rotation;
    // blur only from the effect itself, off by default (the reference ad is crisp)
    fx.property("ADBE Geometry2-0009").setValue(0);
    fx.property("ADBE Geometry2-0010").setValue(S.shutter);
  }
  var para = byId(S.paraId);
  if (!para) return { ok: false, error: "target layer vanished" };
  var paraIn = para.inPoint, paraOut = para.outPoint;
  var paraA = para.duplicate();
  paraA.name = para.name + " · morph";
  paraA.inPoint = Math.max(paraIn, S.tArr); paraA.outPoint = Math.min(paraOut, S.tEnd);
  if (paraOut > S.tEnd) para.inPoint = S.tEnd; else para.enabled = false;
  rider(paraA, S.paraExprs);
  var made = [];
  for (var k = 0; k < S.sources.length; k++) {
    var src = S.sources[k];
    var de = byId(src.id);
    if (!de) return { ok: false, error: "source layer vanished" };
    if (de.outPoint <= S.t0) continue;
    var deB = de;
    if (de.inPoint < S.t0) { deB = de.duplicate(); deB.inPoint = S.t0; de.outPoint = S.t0; }
    deB.name = de.name + " · morph";
    deB.outPoint = Math.min(deB.outPoint, S.tArr);
    rider(deB, src.exprs);
    made.push(deB.name);
  }
  return { ok: true, estilo: "voo", sources: made, target: paraA.name, targetAfter: para.name, shutterAngle: S.shutter };
`;

registerOp({
  name: "tuift.morph",
  category: "tuift",
  description:
    "Ready-made morph by name: turns one layer (or several, e.g. 6 app icons) into another — 'make the AE icon turn " +
    "into the Spotify one'. Any layer that renders pixels works (PNG/JPG footage, shape, text, precomp). " +
    "estilo 'voo' (default) copies the motion of the one-click morph plugins, tracked frame by frame on their ad: one source " +
    "makes an anticipation JUMP back and up, hangs, dives tilting ~24° and shrinking, rushes up into the target, and the target " +
    "lands with a big hop (~0.7 of its size along the arrival), 126% pop and a pendulum swing (+16° → −17° → 0); several " +
    "sources tilt ±25°, shrink to ~82% and converge together, the target pops 121% with a small hop. Place source and target " +
    "apart (or several sources around one target). estilo 'forma': the outline itself morphs in place. Outside the morph both " +
    "layers stay as they were (they are split, not edited). After it: ae_see at the returned seeTimes and ae_review_motion.",
  params: [
    { name: "comp", type: "any", description: "Comp name or id", required: true },
    {
      name: "de",
      type: "any",
      description:
        "Source layer (index, name or {id}) or an array of them (several morph into one)",
      required: true,
    },
    {
      name: "para",
      type: "any",
      description: "Target layer (index, name or {id})",
      required: true,
    },
    {
      name: "at",
      type: "number",
      description:
        "Start time in seconds (default: the comp's current time, or 0.5 s when it is 0)",
      required: false,
    },
    {
      name: "dur",
      type: "number",
      description: "Travel/morph duration in seconds (default 0.45 voo, 0.5 forma)",
      required: false,
    },
    {
      name: "estilo",
      type: "string",
      description:
        "'voo' (default: flies and lands with an elastic pop) or 'forma' (outline morphs in place)",
      required: false,
    },
    {
      name: "mola",
      type: "any",
      description:
        "true (default), false (no pop) or an object. voo: { amp (1 = the measured pop, 92→121→96→100%), tempo (1 = as measured; 1.5 = 50% slower) }. forma: { amp, freq, decay } (default .05 · 2 · 4)",
      required: false,
    },
    {
      name: "blur",
      type: "number",
      description:
        "voo: motion blur shutter angle in degrees (default 0 = crisp, like the reference ad; 90 = light blur)",
      required: false,
    },
    {
      name: "raios",
      type: "number",
      description: "Vertices of the traced outline (default 72; more = sharper corners)",
      required: false,
    },
  ],
  toJsx() {
    return jsxFail(
      "tuift.morph runs in Node (it traces rendered silhouettes); call it through ae_do, not inside batch.run",
    );
  },
  async run(args, transport: AeTransport) {
    const deRefs = Array.isArray(args.de) ? (args.de as unknown[]) : [args.de];
    const estilo = String(args.estilo ?? "voo").toLowerCase();
    if (estilo !== "voo" && estilo !== "forma")
      return { ok: false, error: "estilo must be 'voo' or 'forma'" };
    const voo = estilo === "voo";
    const s = houseStyle().mola;
    const molaArg = args.mola;
    const vooK = {
      amp: molaArg === false ? 0 : Number((molaArg as any)?.amp ?? 1),
      tempo: Math.max(0.25, Number((molaArg as any)?.tempo ?? 1)),
    };
    const mola =
      molaArg === false
        ? null
        : {
            amp: Number((molaArg as any)?.amp ?? s.amp),
            freq: Number((molaArg as any)?.freq ?? s.freq),
            decay: Number((molaArg as any)?.decay ?? s.decay),
          };
    const rays = Math.max(12, Math.min(360, Math.round(Number(args.raios ?? 72))));

    const probes = [
      ...deRefs.map((ref) => ({ ref, time: null, role: "de" })),
      { ref: args.para, time: null, role: "para" },
    ];
    const info = await transport.execute({
      code: PROBE_JSX(args.comp, probes, ""),
      label: "tuift.morph probe",
      undoGroup: false,
      timeoutMs: 30_000,
    });
    if (!info.ok) return { ok: false, error: info.error ?? "probe failed" };
    const pr = info.result as any;
    if (!pr?.ok) return pr;
    const comp = pr.comp;
    const fd = comp.frameDuration as number;
    const snapFrame = (t: number) => Math.round(t / fd) * fd;
    let at = args.at !== undefined ? Number(args.at) : comp.time > 0 ? comp.time : 0.5;
    at = snapFrame(at);
    const multi = deRefs.length > 1;
    const flyFrames = multi ? MULTI_FRAMES : FLY_FRAMES;
    if (voo && args.dur !== undefined)
      vooK.tempo = Math.max(0.25, Number(args.dur) / (flyFrames / 30));
    const d = voo
      ? snapFrame((flyFrames / 30) * vooK.tempo)
      : snapFrame(Math.max(fd * 4, Number(args.dur ?? 0.5)));
    const t1 = at + d;
    const tEnd = snapFrame(
      t1 + (voo ? (POP_SCALE.length / 30) * vooK.tempo + 0.05 : mola ? 1.0 : 0),
    );
    const timing: Timing = { t0: at, d, tEnd, mola };

    const layers = pr.layers as Array<any>;
    const para = layers[layers.length - 1];
    const sources = layers.slice(0, -1);
    const ids = new Set<number>();
    for (const l of layers) {
      if (!l.hasVideo) return { ok: false, error: `layer '${l.name}' has no pixels to morph` };
      if (ids.has(l.id)) return { ok: false, error: `layer '${l.name}' is both source and target` };
      ids.add(l.id);
    }
    const clampIn = (l: any, t: number) => Math.min(Math.max(t, l.inPoint), l.outPoint - fd);
    const dir = path.join(WORK_DIR, "morph", stamp());
    await fs.mkdir(dir, { recursive: true });
    const snaps = layers.map((l, i) => ({
      index: l.index,
      time: l.role === "para" ? clampIn(l, tEnd) : clampIn(l, at),
      file: path.join(dir, `${i}-${l.role}.png`).split(path.sep).join("/"),
    }));
    const snap = await transport.execute({
      code: SNAP_JSX(comp.id, snaps),
      label: "tuift.morph snapshot",
      undoGroup: false,
      timeoutMs: 120_000,
    });
    if (!snap.ok) return { ok: false, error: snap.error ?? "snapshot failed" };
    if (!(snap.result as any)?.ok) return snap.result;

    const hulls: Array<{ visible: Hull; matte: Hull }> = [];
    for (let i = 0; i < snaps.length; i++) {
      const buf = await readFileSettled(snaps[i].file);
      const png = decodePng(buf);
      const matte = traceHull(png, rays, 0);
      const visible = traceHull(png, rays, 0.75);
      if (!matte || !visible)
        return {
          ok: false,
          error: `layer '${layers[i].name}' is fully transparent at ${snaps[i].time.toFixed(2)} s`,
        };
      hulls.push({ visible, matte });
    }
    const pH = hulls[hulls.length - 1];
    const r3 = (n: number) => Math.round(n * 1000) / 1000;
    const colors = hulls.map((h, i) => ({
      layer: layers[i].name,
      rgb: h.matte.color.map((c) => Math.round(c * 255)),
    }));

    if (voo) {
      const p1 = pH.matte.center;
      const sizeOf = (h: Hull) => Math.max(h.bbox[2] - h.bbox[0], h.bbox[3] - h.bbox[1]);
      const vs: VooSource[] = sources.map((l, i) => {
        const h = hulls[i].matte;
        const p0 = h.center;
        const dx = p1[0] - p0[0],
          dy = p1[1] - p0[1];
        const dist = Math.hypot(dx, dy);
        const u: Pt = dist > 1 ? [dx / dist, dy / dist] : [1, 0];
        const sz = sizeOf(h);
        const deff = Math.min(8 * sz, Math.max(4 * sz, dist));
        const sign = Math.abs(dx) < 1 ? (i % 2 ? -1 : 1) : Math.sign(dx);
        return { id: l.id, p0, u, dist, deff, sign };
      });
      // arrival direction (mean over sources, from the last flight sample): the target's hop continues it
      const n = FLY_FRAMES - 1;
      let hx = 0,
        hy = 0,
        sg = 0;
      for (const v of vs) {
        const al = FLY_A[n] * v.dist,
          b = FLY_B[n] * v.deff;
        const ddx = p1[0] - (v.p0[0] + v.u[0] * al),
          ddy = p1[1] - (v.p0[1] + v.u[1] * al + b);
        const nn = Math.hypot(ddx, ddy);
        if (nn > 1) {
          hx += ddx / nn;
          hy += ddy / nn;
        }
        sg += v.sign;
      }
      let hn = Math.hypot(hx, hy);
      if (hn < 0.2) {
        hx = 0;
        hy = -1;
        hn = 1;
      }
      const hopLen = sizeOf(pH.matte);
      const k = {
        amp: vooK.amp,
        tempo: vooK.tempo,
        hop: [(hx / hn) * hopLen, (hy / hn) * hopLen] as Pt,
        sign: sg >= 0 ? 1 : -1,
      };
      const spec = {
        t0: at,
        tArr: t1,
        tEnd,
        paraId: para.id,
        shutter: Number(args.blur ?? 0),
        paraExprs: multi
          ? multiTargetExprs(t1, p1, { amp: k.amp, tempo: k.tempo, hop: [0, -sizeOf(pH.matte)] })
          : vooTargetExprs(t1, p1, k),
        sources: vs.map((v) => ({
          id: v.id,
          exprs: multi ? multiSourceExprs(at, vooK.tempo, v) : vooSourceExprs(at, vooK.tempo, v),
        })),
      };
      const built = await transport.execute({
        code: BUILD_VOO_JSX(comp.id, spec),
        label: "tuift.morph",
        undoGroup: true,
        timeoutMs: 60_000,
      });
      if (!built.ok) return { ok: false, error: built.error ?? "build failed" };
      const res = built.result as any;
      if (!res?.ok) return res;
      return {
        ok: true,
        comp: comp.name,
        at: r3(at),
        dur: r3(d),
        arrival: r3(t1),
        settle: r3(tEnd),
        mola: vooK,
        ...res,
        colors,
        probes: snaps.map((x) => x.file),
        seeTimes: [
          at,
          at + 0.1,
          at + 0.17,
          at + 0.3,
          at + 0.4,
          at + 0.47,
          t1,
          t1 + 0.1,
          t1 + 0.2,
          t1 + 0.3,
          t1 + 0.43,
          tEnd,
        ].map(r3),
      };
    }

    const spec = {
      t0: at,
      t1,
      tEnd,
      paraId: para.id,
      paraExprs: riderExprs(timing, hulls[0].matte, pH.matte, "para"),
      sources: sources.map((l, i) => ({
        id: l.id,
        pathVisible: pathExpr(timing, hulls[i].visible, pH.visible),
        pathMatte: pathExpr(timing, hulls[i].matte, pH.matte),
        color: colorExpr(timing, hulls[i].matte, pH.matte),
        deExprs: riderExprs(timing, hulls[i].matte, pH.matte, "de"),
      })),
    };
    const built = await transport.execute({
      code: BUILD_JSX(comp.id, spec),
      label: "tuift.morph",
      undoGroup: true,
      timeoutMs: 60_000,
    });
    if (!built.ok) return { ok: false, error: built.error ?? "build failed" };
    const res = built.result as any;
    if (!res?.ok) return res;
    return {
      ok: true,
      comp: comp.name,
      estilo: "forma",
      at: r3(at),
      dur: r3(d),
      settle: r3(tEnd),
      mola,
      ...res,
      colors,
      probes: snaps.map((x) => x.file),
      seeTimes: [at, at + d * 0.25, at + d * 0.5, at + d * 0.75, t1, t1 + 0.12, t1 + 0.3, tEnd].map(
        r3,
      ),
    };
  },
});
