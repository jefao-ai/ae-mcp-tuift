// ae_review_motion — rule-based motion review ("humano ou robotizado?").
// One JSX pass collects keys, interpolation, expressions, timing and bounds of
// every layer; the rules run here in TypeScript against the house style
// (estilo-da-casa.json). Ideas from public After Effects MCP review tools,
// tuned to the house rules: camera never dead, mola padrão on entrances, stagger
// instead of simultaneous starts, motion blur on, text ≥ 22 px at 1080.

import { z } from "zod";

import { defineTool } from "../tools/define-tool.js";
import { errorResult } from "../errors.js";
import { type Cena, cenaNoTempo, filtrarCenas, LER_CENAS_FN } from "./cenas.js";
import { houseStyle, runJsx, textAndJson } from "./common.js";
import { checarEnquadramento, LIMITES_PADRAO } from "./enquadramento.js";
import {
  acharIdentidade,
  checarIdentidade,
  COLETA_IDENTIDADE_JSX,
  type ColetaIdentidade,
  lerIdentidade,
} from "./identidade.js";

const COLLECT_JSX = `
${LER_CENAS_FN}
var c = AE.findCompByNameOrId(payload.comp);
if (!c) return { ok: false, error: "no comp matching " + String(payload.comp) };
var LIN = KeyframeInterpolationType.LINEAR, HOLD = KeyframeInterpolationType.HOLD;
var MAXL = payload.maxLayers, MAXK = 80;
function num(v) { if (v instanceof Array) { var o = []; for (var i = 0; i < v.length; i++) o.push(Number(v[i])); return o; } return [Number(v)]; }
function interp(t) { return t === LIN ? "linear" : (t === HOLD ? "hold" : "bezier"); }
function propInfo(p, label) {
  if (!p) return null;
  var o = { name: label, keys: [], expr: null, exprOn: false, exprErr: "" };
  try { if (p.canSetExpression && p.expression !== "") { o.expr = String(p.expression).substr(0, 400); o.exprOn = p.expressionEnabled; o.exprErr = p.expressionError || ""; } } catch (e0) {}
  var n = 0; try { n = p.numKeys; } catch (e1) { n = 0; }
  for (var k = 1; k <= n && k <= MAXK; k++) {
    var kv = null; try { kv = num(p.keyValue(k)); } catch (e2) { kv = null; }
    var ie = null, oe = null;
    try { var a = p.keyInTemporalEase(k), b = p.keyOutTemporalEase(k); ie = [a[0].speed, a[0].influence]; oe = [b[0].speed, b[0].influence]; } catch (e3) {}
    o.keys.push({ t: p.keyTime(k), v: kv, i: interp(p.keyInInterpolationType(k)), o: interp(p.keyOutInterpolationType(k)), ie: ie, oe: oe });
  }
  if (n === 0) { try { o.static = num(p.value); } catch (e4) {} }
  return o;
}
// Animated sub-properties outside Transform (effects, masks, text animators,
// shape contents). Bounded: a per-layer visit budget and heavy groups skipped,
// so a 100+ layer comp stays well under the call timeout.
var SKIP = { "ADBE Vector Materials Group": 1, "ADBE Material Options Group": 1, "ADBE Transform Group": 1, "ADBE Layer Styles": 1,
  "ADBE Plane Options Group": 1, "ADBE Extrsn Options Group": 1, "ADBE Audio Group": 1, "ADBE Text Document": 1, "ADBE Text More Options": 1, "ADBE Text Path Options": 1 };
var T0 = $.hiresTimer, BUDGET_US = payload.budgetSec * 1000000, spent = 0, truncatedScan = false;
function anyKeyTimes(g, depth, acc, vis) {
  if (!g || depth > 6 || acc.length > 200 || vis.n > 160) return;
  vis.n++;
  var mn = ""; try { mn = g.matchName; } catch (e) {}
  if (SKIP[mn]) return;
  if (g.propertyType === PropertyType.PROPERTY) {
    try { var nk = g.numKeys; for (var k = 1; k <= nk && k <= 40; k++) acc.push(g.keyTime(k)); } catch (e1) {}
    try { if (g.canSetExpression && g.expressionEnabled && g.expression !== "") acc.push(-1); } catch (e2) {}
    return;
  }
  var np = 0; try { np = g.numProperties; } catch (e4) {}
  for (var i = 1; i <= np; i++) { try { anyKeyTimes(g.property(i), depth + 1, acc, vis); } catch (e3) {} }
}
var out = { name: c.name, w: c.width, h: c.height, fps: c.frameRate, duration: c.duration,
  waStart: c.workAreaStart, waDur: c.workAreaDuration, motionBlur: c.motionBlur,
  shutter: AE.safeGet(function () { return c.shutterAngle; }, null), layers: [] };
for (var li = 1; li <= c.numLayers && li <= MAXL; li++) {
  var L = c.layer(li);
  var kind = "av";
  if (L instanceof CameraLayer) kind = "camera"; else if (L instanceof LightLayer) kind = "light";
  else if (L instanceof TextLayer) kind = "text"; else if (L instanceof ShapeLayer) kind = "shape";
  else if (L.nullLayer) kind = "null"; else if (L.adjustmentLayer) kind = "adjustment";
  else if (L.source && L.source instanceof CompItem) kind = "precomp";
  else if (L.hasAudio && !L.hasVideo) kind = "audio";
  var tr = L.property("ADBE Transform Group");
  var info = { index: li, id: L.id, name: L.name, kind: kind, enabled: L.enabled, guide: AE.safeGet(function () { return L.guideLayer; }, false),
    inPoint: L.inPoint, outPoint: L.outPoint, parent: L.parent ? L.parent.index : null,
    threeD: AE.safeGet(function () { return L.threeDLayer; }, kind === "camera"), mb: AE.safeGet(function () { return L.motionBlur; }, false), props: [] };
  var pos = tr.property("ADBE Position");
  if (pos && pos.dimensionsSeparated) {
    info.props.push(propInfo(tr.property("ADBE Position_0"), "Position X"));
    info.props.push(propInfo(tr.property("ADBE Position_1"), "Position Y"));
  } else info.props.push(propInfo(pos, "Position"));
  if (kind !== "camera") { info.props.push(propInfo(tr.property("ADBE Scale"), "Scale")); }
  else { info.props.push(propInfo(tr.property("ADBE Anchor Point"), "Point of Interest")); }
  info.props.push(propInfo(tr.property("ADBE Rotate Z"), "Rotation"));
  if (kind !== "camera" && kind !== "light") info.props.push(propInfo(tr.property("ADBE Opacity"), "Opacity"));
  if (kind === "camera") { try { info.props.push(propInfo(L.property("ADBE Camera Options Group").property("ADBE Camera Zoom"), "Zoom")); } catch (ez) {} }
  spent += $.hiresTimer; // hiresTimer returns µs since the previous read
  var other = [];
  if (spent < BUDGET_US) anyKeyTimes(L, 0, other, { n: 0 }); else truncatedScan = true;
  info.otherKeys = other;
  if (kind === "text") {
    try { var td = L.property("ADBE Text Properties").property("ADBE Text Document").value; info.fontSize = td.fontSize; info.text = String(td.text).substr(0, 60); } catch (et) {}
  }
  if (kind === "text" || kind === "shape" || kind === "av" || kind === "precomp") {
    var tRest = Math.min(L.outPoint - c.frameDuration, Math.max(L.inPoint, payload.restTime !== null ? payload.restTime : L.inPoint + 1));
    info.restTime = tRest;
    try {
      var r = L.sourceRectAtTime(tRest, false);
      var ap = num(tr.property("ADBE Anchor Point").valueAtTime(tRest, false));
      var sc = num(tr.property("ADBE Scale").valueAtTime(tRest, false));
      var ps = pos.dimensionsSeparated ? [tr.property("ADBE Position_0").valueAtTime(tRest, false), tr.property("ADBE Position_1").valueAtTime(tRest, false)] : num(pos.valueAtTime(tRest, false));
      info.rect = [r.left, r.top, r.width, r.height]; info.anchor = ap; info.scaleAtRest = sc; info.posAtRest = ps;
    } catch (er) {}
  }
  out.layers.push(info);
}
// Enquadramento: retângulos reais, em coordenadas da comp, de cada texto e das caixas vivas no mesmo instante.
function mundo(L, t) {
  var r = L.sourceRectAtTime(t, false), x0 = r.left, y0 = r.top, x1 = r.left + r.width, y1 = r.top + r.height, cur = L, g = 0;
  while (cur && g < 12) {
    var T = cur.property("ADBE Transform Group"), P = T.property("ADBE Position");
    var a = T.property("ADBE Anchor Point").valueAtTime(t, false), s = T.property("ADBE Scale").valueAtTime(t, false);
    var p = P.dimensionsSeparated ? [T.property("ADBE Position_0").valueAtTime(t, false), T.property("ADBE Position_1").valueAtTime(t, false)] : P.valueAtTime(t, false);
    x0 = p[0] + (x0 - a[0]) * s[0] / 100; x1 = p[0] + (x1 - a[0]) * s[0] / 100;
    y0 = p[1] + (y0 - a[1]) * s[1] / 100; y1 = p[1] + (y1 - a[1]) * s[1] / 100;
    cur = cur.parent; g++;
  }
  return [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
}
function forma(L) { // uma forma só no shape: retângulo ou elipse (contorno de campo, botão, pílula, avatar)
  var R = L.property("ADBE Root Vectors Group"), achou = null, n = 0;
  for (var i = 1; i <= R.numProperties && n < 3; i++) {
    var g = R.property(i), v = g.matchName === "ADBE Vector Group" ? g.property("ADBE Vectors Group") : null;
    if (!v) { if (g.matchName === "ADBE Vector Shape - Rect") { achou = "rect"; n++; } else if (g.matchName === "ADBE Vector Shape - Ellipse") { achou = "elipse"; n++; } continue; }
    for (var j = 1; j <= v.numProperties; j++) {
      var m = v.property(j).matchName;
      if (m === "ADBE Vector Shape - Rect") { achou = "rect"; n++; } else if (m === "ADBE Vector Shape - Ellipse") { achou = "elipse"; n++; }
    }
  }
  return n === 1 ? achou : null;
}
var ENQ = { textos: [], linhas: [] }, FORMAS = [];
try {
  for (var e1 = 1; e1 <= c.numLayers && e1 <= MAXL; e1++) {
    var S = c.layer(e1);
    if (!(S instanceof ShapeLayer) || !S.enabled) continue;
    var tipo = forma(S); if (!tipo) continue;
    var rr = S.sourceRectAtTime(S.inPoint, false);
    if (rr.width < 24 || rr.height < 24) continue;
    FORMAS.push({ L: S, tipo: tipo });
  }
  var op = function (L, t) { return L.property("ADBE Transform Group").property("ADBE Opacity").valueAtTime(t, false); };
  for (var e2 = 1; e2 <= c.numLayers && e2 <= MAXL; e2++) {
    var X = c.layer(e2);
    if (!(X instanceof TextLayer) || !X.enabled) continue;
    var t0 = Math.min(X.outPoint - c.frameDuration, Math.max(X.inPoint, payload.restTime !== null ? payload.restTime : X.inPoint + 1));
    if (op(X, t0) < 5) continue;
    var td2 = X.property("ADBE Text Properties").property("ADBE Text Document").value;
    var item = { name: X.name, index: e2, t: t0, inPoint: X.inPoint, outPoint: X.outPoint, text: String(td2.text).substr(0, 40),
      centrado: td2.justification === ParagraphJustification.CENTER_JUSTIFY, rect: mundo(X, t0), caixas: [] };
    for (var e3 = 0; e3 < FORMAS.length; e3++) {
      var F = FORMAS[e3];
      if (F.tipo !== "rect" || F.L.inPoint > t0 || F.L.outPoint <= t0 || op(F.L, t0) < 5) continue;
      var wr = mundo(F.L, t0);
      if (item.rect[2] < wr[0] || item.rect[0] > wr[2] || item.rect[3] < wr[1] || item.rect[1] > wr[3]) continue;
      item.caixas.push({ name: F.L.name, rect: wr });
    }
    ENQ.textos.push(item);
  }
  for (var e4 = 0; e4 < FORMAS.length; e4++) {
    var G = FORMAS[e4];
    if (G.tipo !== "rect") continue;
    var tl = Math.min(G.L.outPoint - c.frameDuration, Math.max(G.L.inPoint, payload.restTime !== null ? payload.restTime : G.L.inPoint + 1));
    if (op(G.L, tl) < 5) continue;
    var gr = mundo(G.L, tl);
    if (gr[2] - gr[0] < c.width * 0.5 || gr[2] - gr[0] > c.width * 0.97 || gr[3] - gr[1] > c.height * 0.2) continue;
    var esq = gr[0], dir = gr[2], cy = (gr[1] + gr[3]) / 2;
    for (var e5 = 0; e5 < FORMAS.length; e5++) {
      var H = FORMAS[e5];
      if (H === G || H.L.inPoint > tl || H.L.outPoint <= tl || op(H.L, tl) < 5) continue;
      var hr = mundo(H.L, tl);
      if (cy >= hr[1] && cy <= hr[3] && hr[3] - hr[1] < (gr[3] - gr[1]) * 1.6) { esq = Math.min(esq, hr[0]); dir = Math.max(dir, hr[2]); }
    }
    ENQ.linhas.push({ name: G.L.name, t: tl, esq: esq, dir: dir });
  }
} catch (eEnq) { ENQ.erro = String(eEnq.message); }
out.enquadramento = ENQ;
out.cenas = TUIFT_lerCenas(c);
out.projeto = app.project.file ? app.project.file.fsName : null;
out.truncated = c.numLayers > MAXL; out.truncatedScan = truncatedScan;
return out;
`;

type Sev = "erro" | "aviso" | "info";
interface Issue {
  sev: Sev;
  rule: string;
  layer?: string;
  index?: number;
  at?: number;
  cena?: string;
  msg: string;
  fix?: string;
}

const MOVING = new Set([
  "Position",
  "Position X",
  "Position Y",
  "Scale",
  "Rotation",
  "Point of Interest",
  "Zoom",
]);

function same(a: number[] | null, b: number[] | null, tol = 1e-3): boolean {
  if (!a || !b || a.length !== b.length) return false;
  return a.every((v, i) => Math.abs(v - b[i]) <= tol * Math.max(1, Math.abs(v)));
}

export function reviewRules(data: any, style: any): Issue[] {
  const R = style.revisao;
  const fps: number = data.fps;
  const fd = 1 / fps;
  const issues: Issue[] = [];
  const firstMoveFrames: Map<number, string[]> = new Map();
  const shortSide = Math.min(data.w, data.h);
  let anyMoving = false;

  const byIndex = new Map<number, any>(data.layers.map((l: any) => [l.index, l]));
  const alive = (l: any) =>
    l.props.some(
      (p: any) =>
        p &&
        MOVING.has(p.name) &&
        p.expr &&
        p.exprOn &&
        /wiggle|tuift_vivo|noise|Math\.sin/i.test(p.expr),
    );
  /** A parent (any level up) that keeps drifting makes holds below it alive. */
  const aliveByParent = (l: any): boolean => {
    let cur = l.parent ? byIndex.get(l.parent) : undefined;
    for (let guard = 0; cur && guard < 20; guard++) {
      if (alive(cur)) return true;
      cur = cur.parent ? byIndex.get(cur.parent) : undefined;
    }
    return false;
  };

  // tuift.morph splits layers at its seams: the source is cut where its
  // "<name> · morph" copy takes over, the target starts where its morph copy
  // ends, and the MORPH blob/matte layers live only inside the morph. Those
  // in/out points are hand-offs, not pops — never report them as cuts.
  const MORPH_SUFFIX = " · morph";
  const morphCopies = data.layers.filter(
    (l: any) => typeof l.name === "string" && l.name.endsWith(MORPH_SUFFIX),
  );
  const isMorphPart = (l: any) =>
    typeof l.name === "string" && (l.name.endsWith(MORPH_SUFFIX) || l.name.startsWith("MORPH "));
  const seamIn = (l: any) =>
    morphCopies.some(
      (m: any) => m.name === l.name + MORPH_SUFFIX && Math.abs(m.outPoint - l.inPoint) <= fd,
    );
  const seamOut = (l: any) =>
    morphCopies.some(
      (m: any) => m.name === l.name + MORPH_SUFFIX && Math.abs(m.inPoint - l.outPoint) <= fd,
    );

  for (const L of data.layers) {
    if (!L.enabled && !(L.kind === "null")) continue;
    if (L.guide || L.kind === "audio") continue;
    const parentAlive = aliveByParent(L);
    const isCam = L.kind === "camera" || /\b(cam|camera|câmera|rig)\b/i.test(L.name);
    let layerMoves = false;
    let firstKey = Infinity;

    for (const p of L.props.filter(Boolean)) {
      const keys = p.keys as Array<{ t: number; v: number[] | null; i: string; o: string }>;
      const hasExpr = !!p.expr && p.exprOn;
      if (p.exprErr) {
        issues.push({
          sev: "erro",
          rule: "expressao_com_erro",
          layer: L.name,
          index: L.index,
          msg: `${p.name}: ${p.exprErr}`,
          fix: "ae_expressions_check e corrigir",
        });
      }
      if (keys.length >= 2) {
        firstKey = Math.min(firstKey, keys[0].t);
        if (MOVING.has(p.name)) {
          layerMoves = true;
          anyMoving = true;
        }
      }
      for (const k of keys) {
        const off = Math.abs(k.t * fps - Math.round(k.t * fps));
        if (off > 0.01) {
          issues.push({
            sev: "aviso",
            rule: "key_fora_da_grade",
            layer: L.name,
            index: L.index,
            at: k.t,
            msg: `${p.name}: key em ${k.t.toFixed(4)} s fora da grade de quadros`,
            fix: "encaixar em round(t*fps)/fps",
          });
          break;
        }
      }
      for (let k = 0; k + 1 < keys.length; k++) {
        const a = keys[k];
        const b = keys[k + 1];
        const dur = b.t - a.t;
        if (a.o === "hold") continue;
        const changes = !same(a.v, b.v);
        if (
          !changes &&
          dur >= R.paradaMortaSec &&
          MOVING.has(p.name) &&
          !hasExpr &&
          !parentAlive &&
          keys.length > 2 &&
          k > 0 &&
          k + 1 < keys.length - 1
        ) {
          issues.push({
            sev: isCam ? "erro" : "aviso",
            rule: "parada_morta",
            layer: L.name,
            index: L.index,
            at: a.t,
            msg: `${p.name} para morto ${dur.toFixed(2)} s (${a.t.toFixed(2)}–${b.t.toFixed(2)} s) e volta a andar: robotizado`,
            fix: "tuift.vivo (deriva lenta) nessa camada ou chaves lineares de deriva no trecho",
          });
        }
        // a slow linear move is a deliberate drift ("nunca para"), not a mechanical move
        const rate =
          changes && a.v && b.v
            ? Math.hypot(...a.v.map((x, d) => (b.v![d] ?? x) - x)) / Math.max(dur, 1e-6)
            : 0;
        const isDrift =
          p.name === "Scale" ? rate < 12 : p.name === "Rotation" ? rate < 6 : rate < 120;
        if (
          changes &&
          a.o === "linear" &&
          b.i === "linear" &&
          !hasExpr &&
          p.name !== "Opacity" &&
          !isDrift
        ) {
          issues.push({
            sev: "aviso",
            rule: "linear_sem_mola",
            layer: L.name,
            index: L.index,
            at: a.t,
            msg: `${p.name}: movimento linear sem expressão de mola (${a.t.toFixed(2)}–${b.t.toFixed(2)} s) — mecânico`,
            fix: "tuift.mola (entrada de cartão/botão) ou tuift.curva (câmera/troca de cena)",
          });
        }
        if (changes && dur < R.movimentoMecanicoSec && p.name !== "Opacity") {
          issues.push({
            sev: "info",
            rule: "movimento_rapido",
            layer: L.name,
            index: L.index,
            at: a.t,
            msg: `${p.name}: ${Math.round(dur * 1000)} ms — abaixo de ${R.movimentoMecanicoSec * 1000} ms soa mecânico (ok se for chicote proposital)`,
          });
        }
      }
    }

    if (isCam && L.kind !== "light" && !parentAlive) {
      const moving = L.props.filter((p: any) => p && MOVING.has(p.name));
      const hasWiggle = moving.some(
        (p: any) => p.expr && p.exprOn && /wiggle|tuift_vivo|noise|Math\.sin/i.test(p.expr),
      );
      if (!hasWiggle) {
        const allKeys = moving
          .flatMap((p: any) => p.keys.map((k: any) => k.t))
          .sort((x: number, y: number) => x - y);
        if (!allKeys.length) {
          issues.push({
            sev: "erro",
            rule: "camera_parada",
            layer: L.name,
            index: L.index,
            msg: "câmera/rig sem keys nem deriva: parada o vídeo todo",
            fix: "tuift.camera_viva",
          });
        } else {
          const start = Math.max(L.inPoint, data.waStart);
          const end = Math.min(L.outPoint, data.waStart + data.waDur);
          if (allKeys[0] - start > R.paradaMortaSec)
            issues.push({
              sev: "aviso",
              rule: "camera_parada",
              layer: L.name,
              index: L.index,
              at: start,
              msg: `câmera parada nos primeiros ${(allKeys[0] - start).toFixed(2)} s`,
              fix: "tuift.camera_viva",
            });
          if (end - allKeys[allKeys.length - 1] > R.paradaMortaSec)
            issues.push({
              sev: "aviso",
              rule: "camera_parada",
              layer: L.name,
              index: L.index,
              at: allKeys[allKeys.length - 1],
              msg: `câmera parada nos últimos ${(end - allKeys[allKeys.length - 1]).toFixed(2)} s`,
              fix: "tuift.camera_viva",
            });
        }
      }
    }

    if (layerMoves && !L.mb && L.kind !== "camera" && L.kind !== "null" && L.kind !== "light") {
      issues.push({
        sev: "info",
        rule: "motion_blur_camada",
        layer: L.name,
        index: L.index,
        msg: "camada se move sem a chave de motion blur",
        fix: "layer.set_props motionBlur:true",
      });
    }

    const visualKinds = new Set(["text", "shape", "av", "precomp"]);
    if (visualKinds.has(L.kind)) {
      const startsLate =
        L.inPoint > data.waStart + fd && L.inPoint < data.waStart + data.waDur - fd;
      const near = (t: number) => {
        const anyProp = L.props.some(
          (p: any) =>
            p && (p.keys.some((k: any) => k.t >= t - fd && k.t <= t + 0.5) || (p.expr && p.exprOn)),
        );
        const other = (L.otherKeys as number[]).some(
          (k) => k === -1 || (k >= t - fd && k <= t + 0.5),
        );
        return anyProp || other;
      };
      if (startsLate && !near(L.inPoint) && !isMorphPart(L) && !seamIn(L)) {
        issues.push({
          sev: "info",
          rule: "entra_cortando",
          layer: L.name,
          index: L.index,
          at: L.inPoint,
          msg: `aparece em ${L.inPoint.toFixed(2)} s sem animação de entrada (pop)`,
          fix: "tuift.entrada (mola padrão) ou transição de propósito",
        });
      }
      const endsEarly = L.outPoint < data.waStart + data.waDur - fd;
      const nearOut =
        L.props.some(
          (p: any) =>
            p && p.keys.some((k: any) => k.t >= L.outPoint - 0.6 && k.t <= L.outPoint + fd),
        ) ||
        (L.otherKeys as number[]).some(
          (k) => k === -1 || (k >= L.outPoint - 0.6 && k <= L.outPoint + fd),
        );
      if (endsEarly && !nearOut && !isMorphPart(L) && !seamOut(L)) {
        issues.push({
          sev: "info",
          rule: "sai_cortando",
          layer: L.name,
          index: L.index,
          at: L.outPoint,
          msg: `some em ${L.outPoint.toFixed(2)} s sem animação de saída`,
          fix: "tuift.saida ou corte seco de propósito",
        });
      }
      if (firstKey !== Infinity) {
        const f = Math.round(firstKey * fps);
        if (!firstMoveFrames.has(f)) firstMoveFrames.set(f, []);
        firstMoveFrames.get(f)!.push(L.name);
      }
    }

    const visibleAtRest = (L.scaleAtRest?.[0] ?? 100) > 5;
    if (L.kind === "text" && L.fontSize && visibleAtRest) {
      const sx = (L.scaleAtRest?.[0] ?? 100) / 100;
      const px = (L.fontSize * sx * 1080) / shortSide;
      if (px < R.textoMinPx1080) {
        issues.push({
          sev: "aviso",
          rule: "texto_pequeno",
          layer: L.name,
          index: L.index,
          msg: `texto "${L.text ?? ""}" com ~${px.toFixed(1)} px (normalizado a 1080) — mínimo ${R.textoMinPx1080}`,
        });
      }
    }

    if (L.rect && L.posAtRest && !L.threeD && L.parent === null) {
      const sx = (L.scaleAtRest?.[0] ?? 100) / 100;
      const sy = (L.scaleAtRest?.[1] ?? 100) / 100;
      const [rl, rt, rw, rh] = L.rect;
      const left = L.posAtRest[0] + (rl - L.anchor[0]) * sx;
      const top = L.posAtRest[1] + (rt - L.anchor[1]) * sy;
      const right = left + rw * sx;
      const bottom = top + rh * sy;
      const m = R.margemSeguraPx;
      const fullFrame = rw * sx >= data.w * 0.9 && rh * sy >= data.h * 0.9;
      if (
        !fullFrame &&
        rw > 0 &&
        (left < m || top < m || right > data.w - m || bottom > data.h - m)
      ) {
        const outside = right < 0 || bottom < 0 || left > data.w || top > data.h;
        issues.push({
          sev: outside ? "info" : "aviso",
          rule: outside ? "fora_do_quadro" : "margem_segura",
          layer: L.name,
          index: L.index,
          at: L.restTime,
          msg: outside
            ? `fora do quadro em ${Number(L.restTime).toFixed(2)} s`
            : `encosta na borda (margem < ${m} px) em ${Number(L.restTime).toFixed(2)} s: [${Math.round(left)}, ${Math.round(top)}, ${Math.round(right)}, ${Math.round(bottom)}]`,
        });
      }
    }
  }

  for (const [f, names] of firstMoveFrames) {
    if (names.length >= R.inicioSimultaneoMin) {
      issues.push({
        sev: "aviso",
        rule: "inicio_simultaneo",
        at: f / fps,
        msg: `${names.length} camadas começam a se mexer no mesmo quadro (${(f / fps).toFixed(2)} s): ${names.slice(0, 6).join(", ")}${names.length > 6 ? "…" : ""}`,
        fix: "tuift.stagger",
      });
    }
  }
  if (data.enquadramento) {
    const lim = { ...LIMITES_PADRAO, ...R.enquadramento };
    for (const p of checarEnquadramento(
      data.enquadramento.textos ?? [],
      data.enquadramento.linhas ?? [],
      data.w,
      data.h,
      lim,
    )) {
      issues.push(p);
    }
  }
  if (anyMoving && data.motionBlur === false) {
    issues.push({
      sev: "aviso",
      rule: "motion_blur_comp",
      msg: "comp com motion blur desligado e camadas em movimento",
      fix: `comp.set_props motionBlur:true (obturador ${style.motionBlur.shutterAngle}°)`,
    });
  }
  return issues;
}

export const reviewMotionTool = defineTool({
  name: "ae_review_motion",
  title: "Review motion (humano ou robotizado?)",
  description:
    "Rule-based motion review of a comp without rendering, using the studio house style: camera/rig that stops " +
    "dead, holds that freeze and restart (robotizado), linear moves with no spring, several layers starting on the " +
    "same frame (needs stagger), layers that pop in/out with no entrance/exit, keys off the frame grid, motion " +
    "blur off, text too small, layers touching the safe margin, expression errors. Returns a score and issues with " +
    "the tuift.* operation that fixes each. Run after building and after every fix round; then LOOK with ae_see. " +
    "With scene markers (tuift.cena) each issue carries its scene, and `cena` limits the review to some of them. " +
    "With an identidade.json near the .aep (or `identidade`), fonts, colors, radii and margin outside the video's identity are reported too.",
  group: "inspect",
  blockedInReadOnly: false,
  effect: "read",
  inputShape: {
    comp: z.union([z.string(), z.number()]).describe("Composition name or item id."),
    restTime: z
      .number()
      .optional()
      .describe("Time at which to judge layout/bounds (default: 1 s after each layer's in point)."),
    maxLayers: z
      .number()
      .int()
      .positive()
      .max(1000)
      .optional()
      .describe("Layer cap (default 300)."),
    includeInfo: z.boolean().optional().describe("Include 'info' severity items (default true)."),
    cena: z
      .union([z.string(), z.array(z.string()).min(1)])
      .optional()
      .describe("Only issues inside these scenes from tuift.cena: 'S03', 'S03_PROVA' or a list."),
    identidade: z
      .union([z.string(), z.record(z.string(), z.unknown())])
      .optional()
      .describe(
        "The video's identity: path to a JSON or the object itself { fontes, paleta, toleranciaCor, neutrosLivres, " +
          "margemPx, raiosPx, ignorar, profundo }. Default: identidade.json next to the .aep or up to 3 folders above.",
      ),
  },
  handler: async (args, transport) => {
    const r = await runJsx<any>(transport, COLLECT_JSX, "review_motion", {
      payload: {
        comp: args.comp,
        restTime: args.restTime ?? null,
        maxLayers: args.maxLayers ?? 300,
      },
      undoGroup: false,
      timeoutMs: 300_000,
    });
    if (!r.ok) return r.error;
    const cenas: Cena[] = r.value.cenas ?? [];
    const escolhidas = args.cena ? filtrarCenas(cenas, args.cena) : null;
    if (escolhidas && !escolhidas.length)
      return errorResult("INVALID_ARGS", "no scene marker matches `cena`", {
        details: { cenasNaComp: cenas.map((x) => x.nome) },
        hint: "Mark the scenes with ae_do tuift.cena.",
      });

    const origemIdentidade = args.identidade ?? acharIdentidade(r.value.projeto);
    const lida = origemIdentidade ? lerIdentidade(origemIdentidade as any) : null;
    const base = houseStyle();
    const margemDaIdentidade = lida?.identidade?.margemPx;
    const style =
      typeof margemDaIdentidade === "number"
        ? { ...base, revisao: { ...base.revisao, margemSeguraPx: margemDaIdentidade } }
        : base;
    let issues = reviewRules(r.value, style);

    if (lida?.erro) {
      issues.push({ sev: "erro", rule: "identidade_invalida", msg: lida.erro });
    } else if (lida?.identidade) {
      const coleta = await runJsx<ColetaIdentidade>(
        transport,
        COLETA_IDENTIDADE_JSX,
        "review_identidade",
        {
          payload: {
            comp: args.comp,
            profundo: lida.identidade.profundo !== false,
            maxCamadas: 3000,
            limiteMs: 60_000,
          },
          undoGroup: false,
          timeoutMs: 120_000,
        },
      );
      if (!coleta.ok) return coleta.error;
      issues.push(...checarIdentidade(coleta.value, lida.identidade));
    }

    for (const i of issues) {
      if (i.at !== undefined) i.cena = cenaNoTempo(cenas, i.at);
    }
    if (escolhidas) {
      const nomes = new Set(escolhidas.map((x) => x.nome));
      issues = issues.filter((i) => i.cena !== undefined && nomes.has(i.cena));
    }
    if (args.includeInfo === false) issues = issues.filter((i) => i.sev !== "info");
    const count = (s: Sev) => issues.filter((i) => i.sev === s).length;
    const score = Math.max(0, 100 - 8 * count("erro") - 3 * count("aviso") - 1 * count("info"));
    const grade =
      score >= 90 ? "A" : score >= 80 ? "B" : score >= 65 ? "C" : score >= 50 ? "D" : "F";
    const byRule: Record<string, number> = {};
    const porCena: Record<string, number> = {};
    for (const i of issues) {
      byRule[i.rule] = (byRule[i.rule] ?? 0) + 1;
      if (cenas.length) {
        const chave = i.cena ?? "sem_cena";
        porCena[chave] = (porCena[chave] ?? 0) + 1;
      }
    }
    const order = { erro: 0, aviso: 1, info: 2 } as const;
    issues.sort((a, b) => order[a.sev] - order[b.sev] || (a.at ?? 0) - (b.at ?? 0));
    const headline = `${r.value.name}: nota ${score} (${grade}) — ${count("erro")} erro(s), ${count("aviso")} aviso(s), ${count("info")} info. Depois de corrigir, rode de novo e OLHE com ae_see.`;
    return textAndJson(
      {
        comp: r.value.name,
        score,
        grade,
        counts: { erro: count("erro"), aviso: count("aviso"), info: count("info") },
        byRule,
        ...(cenas.length ? { porCena } : {}),
        identidade: lida
          ? (lida.arquivo?.replace(/\\/g, "/") ?? "objeto passado em `identidade`")
          : null,
        issues: issues.slice(0, 120),
        truncatedLayers: r.value.truncated,
      },
      headline,
    );
  },
});
