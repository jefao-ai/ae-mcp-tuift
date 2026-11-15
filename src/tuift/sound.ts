// ae_sound_cues — read the animation and list where sound effects belong
// (entrances, arrivals/impacts, whooshes at peak speed, taps/clicks, typing),
// ranked; adapted to the house rule "um efeito para cada elemento que entra ou sai".
// ae_place_sfx — place SFX files so their LOUDEST sample lands on the event
// (at = evento − pico), measured here with ffmpeg, never guessed.

import { spawn } from "node:child_process";
import { z } from "zod";

import { errorResult } from "../errors.js";

import { defineTool } from "../tools/define-tool.js";
import { FFMPEG, programFailure, runJsx, textAndJson } from "./common.js";

const CUES_JSX = `
var c = AE.findCompByNameOrId(payload.comp);
if (!c) return { ok: false, error: "no comp matching " + String(payload.comp) };
function num(v) { if (v instanceof Array) { var o = []; for (var i = 0; i < v.length; i++) o.push(Number(v[i])); return o; } return [Number(v)]; }
function keys(p) { var o = []; if (!p) return o; var n = 0; try { n = p.numKeys; } catch (e) {} for (var k = 1; k <= n && k <= 80; k++) { try { o.push({ t: p.keyTime(k), v: num(p.keyValue(k)) }); } catch (e2) {} } return o; }
var out = { name: c.name, fps: c.frameRate, w: c.width, h: c.height, layers: [] };
for (var i = 1; i <= c.numLayers; i++) {
  var L = c.layer(i); if (!L.enabled || L.hasVideo === false) continue;
  if (L instanceof CameraLayer || L instanceof LightLayer) continue;
  var tr = L.property("ADBE Transform Group"); var pos = tr.property("ADBE Position");
  out.layers.push({ name: L.name, index: i, kind: (L instanceof TextLayer) ? "text" : "other", inPoint: L.inPoint, outPoint: L.outPoint,
    pos: pos.dimensionsSeparated ? [] : keys(pos), scale: keys(tr.property("ADBE Scale")), opacity: keys(tr.property("ADBE Opacity")), rot: keys(tr.property("ADBE Rotate Z")) });
}
return out;
`;

interface Cue {
  t: number;
  kind: string;
  layer: string;
  weight: number;
  note: string;
}

function dist(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < Math.min(a.length, b.length, 2); i++) s += (a[i] - b[i]) ** 2;
  return Math.sqrt(s);
}

export function findCues(data: any): Cue[] {
  const cues: Cue[] = [];
  const diag = Math.hypot(data.w, data.h);
  for (const L of data.layers) {
    const isTap = /cursor|toque|tap|clique|click|dedo|finger/i.test(L.name);
    const op = L.opacity as Array<{ t: number; v: number[] }>;
    for (let k = 0; k + 1 < op.length; k++) {
      if (op[k].v[0] <= 1 && op[k + 1].v[0] > 50)
        cues.push({
          t: op[k].t,
          kind: L.kind === "text" ? "texto_entra" : "entra",
          layer: L.name,
          weight: 2,
          note: "pop/whoosh curto, ou tecla se for digitação",
        });
      if (op[k].v[0] > 50 && op[k + 1].v[0] <= 1)
        cues.push({
          t: op[k + 1].t,
          kind: "sai",
          layer: L.name,
          weight: 1,
          note: "whoosh de saída, mais baixo",
        });
    }
    const sc = L.scale as Array<{ t: number; v: number[] }>;
    for (let k = 0; k + 1 < sc.length; k++) {
      const a = sc[k].v[0],
        b = sc[k + 1].v[0];
      if (a <= 5 && b >= 50)
        cues.push({
          t: sc[k].t,
          kind: "pop",
          layer: L.name,
          weight: 3,
          note: "pop (bolha, selo, botão)",
        });
      if (isTap && b < a && k + 2 < sc.length && sc[k + 2].v[0] > b)
        cues.push({
          t: sc[k + 1].t,
          kind: "clique",
          layer: L.name,
          weight: 3,
          note: "clique/toque no ponto mais fundo",
        });
    }
    const ps = L.pos as Array<{ t: number; v: number[] }>;
    for (let k = 0; k + 1 < ps.length; k++) {
      const d = dist(ps[k].v, ps[k + 1].v);
      const dur = ps[k + 1].t - ps[k].t;
      if (d < 5 || dur <= 0) continue;
      const speed = d / dur; // px/s
      if (speed > diag * 1.2)
        cues.push({
          t: ps[k].t + dur * 0.5,
          kind: "whoosh",
          layer: L.name,
          weight: 2 + Math.min(3, speed / diag),
          note: `whoosh no pico de velocidade (${Math.round(speed)} px/s)`,
        });
      if (dur <= 0.45 && d > diag * 0.08)
        cues.push({
          t: ps[k + 1].t,
          kind: "chegada",
          layer: L.name,
          weight: 2,
          note: "impacto/thud leve na chegada",
        });
    }
    if (L.kind === "text" && !op.length && L.inPoint > 0.01)
      cues.push({
        t: L.inPoint,
        kind: "texto_entra",
        layer: L.name,
        weight: 1,
        note: "texto entra cortando: tecla ou tick",
      });
  }
  cues.sort((a, b) => a.t - b.t);
  // merge cues closer than 40 ms: keep the heaviest, note the others
  const merged: Cue[] = [];
  for (const c of cues) {
    const last = merged[merged.length - 1];
    if (last && c.t - last.t < 0.04) {
      if (c.weight > last.weight)
        merged[merged.length - 1] = { ...c, note: `${c.note} (+${last.layer})` };
      else last.note += ` (+${c.layer})`;
    } else merged.push({ ...c });
  }
  return merged.map((c) => ({
    ...c,
    t: Math.round(c.t * data.fps) / data.fps,
    weight: Number(c.weight.toFixed(2)),
  }));
}

export const soundCuesTool = defineTool({
  name: "ae_sound_cues",
  title: "Sound cues from animation",
  description:
    "Read the comp's keyframes and list where sound effects belong — entrances (pop/whoosh), exits, scale pops, " +
    "taps/clicks (layers named cursor/toque/tap), whooshes at the peak speed of fast moves, arrivals (light thud), " +
    "typing — merged within 40 ms and ranked by weight. Use the list to pick SFX from the leveled library, then " +
    "ae_place_sfx. House rule: one effect per element that enters or leaves, below the music/voice.",
  group: "inspect",
  blockedInReadOnly: false,
  effect: "read",
  inputShape: { comp: z.union([z.string(), z.number()]).describe("Composition name or id.") },
  handler: async (args, transport) => {
    const r = await runJsx<any>(transport, CUES_JSX, "sound_cues", {
      payload: { comp: args.comp },
      undoGroup: false,
    });
    if (!r.ok) return r.error;
    const cues = findCues(r.value);
    return textAndJson(
      { comp: r.value.name, count: cues.length, cues },
      `${cues.length} pistas de efeito sonoro em ${r.value.name}.`,
    );
  },
});

/** Time (s) of the loudest sample of an audio file, decoded by ffmpeg (mono, 8 kHz). */
export function peakTime(file: string): Promise<{ peakSec: number; durationSec: number }> {
  return new Promise((resolve, reject) => {
    const sr = 8000;
    const p = spawn(
      FFMPEG,
      ["-loglevel", "error", "-i", file, "-ac", "1", "-ar", String(sr), "-f", "s16le", "-"],
      { windowsHide: true },
    );
    const chunks: Buffer[] = [];
    p.stdout.on("data", (b: Buffer) => chunks.push(b));
    let err = "";
    p.stderr.on("data", (b: Buffer) => (err += b.toString()));
    // No listener = an uncaught 'error' event = the whole server dies when ffmpeg is missing.
    p.on("error", (e) => reject(new Error(programFailure(FFMPEG, e))));
    p.on("close", (code) => {
      if (code !== 0) return reject(new Error(err.trim() || `ffmpeg exit ${code}`));
      const buf = Buffer.concat(chunks);
      let best = 0,
        at = 0;
      for (let i = 0; i + 1 < buf.length; i += 2) {
        const v = Math.abs(buf.readInt16LE(i));
        if (v > best) {
          best = v;
          at = i / 2;
        }
      }
      resolve({ peakSec: at / sr, durationSec: buf.length / 2 / sr });
    });
  });
}

const PLACE_JSX = `
var c = AE.findCompByNameOrId(payload.comp);
if (!c) return { ok: false, error: "no comp matching " + String(payload.comp) };
var folder = null;
for (var i = 1; i <= app.project.numItems; i++) { var it = app.project.item(i); if (it instanceof FolderItem && it.name === "SFX") { folder = it; break; } }
if (!folder) folder = app.project.items.addFolder("SFX");
var cache = {};
for (var j = 1; j <= app.project.numItems; j++) { var it2 = app.project.item(j); try { if (it2 instanceof FootageItem && it2.file) cache[it2.file.fsName.replace(/\\\\/g, "/").toLowerCase()] = it2; } catch (e) {} }
var out = [];
for (var k = 0; k < payload.items.length; k++) {
  var s = payload.items[k];
  var key = String(s.file).replace(/\\\\/g, "/").toLowerCase();
  var foot = cache[key];
  if (!foot) { var io = new ImportOptions(new File(s.file)); foot = app.project.importFile(io); foot.parentFolder = folder; cache[key] = foot; }
  var L = c.layers.add(foot);
  L.startTime = s.start;
  L.name = "SFX " + (s.label || foot.name);
  if (s.gainDb !== null) { try { L.audioLevels.setValue([s.gainDb, s.gainDb]); } catch (eg) {} }
  L.moveToEnd();
  out.push({ name: L.name, start: L.startTime, eventAt: s.at });
}
return { ok: true, placed: out };
`;

export const placeSfxTool = defineTool({
  name: "ae_place_sfx",
  title: "Place SFX on events",
  description:
    "Place sound-effect files in a comp so that each file's LOUDEST sample (measured with ffmpeg) lands exactly on " +
    "its event time (start = at − peak). Imports each file once into an 'SFX' folder, names layers 'SFX <label>', " +
    "sets Audio Levels in dB when given (0 = as recorded; leveled library files need no gain). One undo group.",
  group: "operations",
  blockedInReadOnly: true,
  effect: "write",
  inputShape: {
    comp: z.union([z.string(), z.number()]),
    items: z
      .array(
        z.object({
          file: z.string().describe("Absolute path to the audio file."),
          at: z.number().describe("Event time in comp seconds."),
          gainDb: z.number().optional().describe("Audio Levels in dB (e.g. -6)."),
          label: z.string().optional(),
        }),
      )
      .min(1)
      .max(200),
  },
  handler: async (args, transport) => {
    const items = [];
    for (const it of args.items) {
      let pk: { peakSec: number; durationSec: number };
      try {
        pk = await peakTime(it.file);
      } catch (e) {
        return errorResult("IO", e instanceof Error ? e.message : String(e), {
          details: { file: it.file },
        });
      }
      items.push({
        ...it,
        file: it.file.replace(/\\/g, "/"),
        start: it.at - pk.peakSec,
        peakSec: pk.peakSec,
        gainDb: it.gainDb ?? null,
      });
    }
    const r = await runJsx<any>(transport, PLACE_JSX, "place_sfx", {
      payload: { comp: args.comp, items },
    });
    if (!r.ok) return r.error;
    return textAndJson({
      placed: r.value.placed,
      peaks: items.map((i) => ({ file: i.file, peakSec: Number(i.peakSec.toFixed(3)) })),
    });
  },
});
