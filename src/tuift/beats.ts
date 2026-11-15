// ae_beats — measure the music's beats and downbeats with beat_this (the
// catalog BPM can be wrong: "The London" catalog 130.8, real 98) and, if asked,
// write them as comp markers so cuts and hits snap to the real beat.

import * as path from "node:path";
import { z } from "zod";

import { errorResult } from "../errors.js";
import { defineTool } from "../tools/define-tool.js";
import { SERVER_ROOT, run, runJsx, textAndJson } from "./common.js";
import { lerEnv } from "./env.js";

const MARK_JSX = `
var c = AE.findCompByNameOrId(payload.comp);
if (!c) return { ok: false, error: "no comp matching " + String(payload.comp) };
var mk = c.markerProperty, n = 0;
if (payload.clear) { for (var k = mk.numKeys; k >= 1; k--) { var cm = mk.keyValue(k).comment; if (cm.indexOf("beat") === 0 || cm.indexOf("BAR") === 0) mk.removeKey(k); } }
var down = {}; for (var d = 0; d < payload.downbeats.length; d++) down[String(payload.downbeats[d])] = d + 1;
for (var i = 0; i < payload.beats.length; i++) {
  var b = payload.beats[i]; var t = b + payload.offset;
  if (t < 0 || t > c.duration) continue;
  var isDown = down.hasOwnProperty(String(b));
  if (payload.onlyDownbeats && !isDown) continue;
  var mv = new MarkerValue(isDown ? ("BAR " + down[String(b)]) : "beat");
  if (isDown) mv.label = 11;
  mk.setValueAtTime(Math.round(t / c.frameDuration) * c.frameDuration, mv); n++;
}
return { ok: true, markers: n };
`;

export const beatsTool = defineTool({
  name: "ae_beats",
  title: "Music beats → markers",
  description:
    "Measure beats and downbeats of a music file with beat_this (runs locally) and optionally write them as comp " +
    "markers ('BAR n' on downbeats, 'beat' on the rest), offset by where the music layer starts. Use before " +
    "cutting or timing hits on the beat — catalog BPMs can be wrong.",
  group: "operations",
  blockedInReadOnly: false,
  effect: "write",
  inputShape: {
    file: z.string().describe("Audio file (wav/mp3/m4a)."),
    comp: z
      .union([z.string(), z.number()])
      .optional()
      .describe("If given, write markers into this comp."),
    offset: z
      .number()
      .optional()
      .describe("Comp time where the audio file's 0 s sits (default 0)."),
    onlyDownbeats: z.boolean().optional().describe("Markers only on downbeats (default false)."),
    clear: z.boolean().optional().describe("Remove earlier beat/BAR markers first (default true)."),
  },
  handler: async (args, transport) => {
    const py = lerEnv("PYTHON") ?? "python";
    const r = await run(py, ["-I", path.join(SERVER_ROOT, "py", "beats.py"), args.file], {
      timeoutMs: 600_000,
    });
    if (r.code === 127) return errorResult("IO", r.stderr);
    if (r.code !== 0)
      return errorResult(
        "IO",
        `beat_this failed: ${r.stderr.trim().split("\n").slice(-3).join(" | ")}`,
      );
    let data: { beats: number[]; downbeats: number[]; bpm: number | null; device: string };
    try {
      data = JSON.parse(r.stdout.trim().split("\n").pop() ?? "{}");
    } catch {
      return errorResult("IO", "could not parse beat_this output", {
        details: { stdout: r.stdout.slice(-500) },
      });
    }
    let markers: number | undefined;
    if (args.comp !== undefined) {
      const m = await runJsx<{ markers: number }>(transport, MARK_JSX, "beats_markers", {
        payload: {
          comp: args.comp,
          beats: data.beats,
          downbeats: data.downbeats,
          offset: args.offset ?? 0,
          onlyDownbeats: args.onlyDownbeats ?? false,
          clear: args.clear !== false,
        },
      });
      if (!m.ok) return m.error;
      markers = m.value.markers;
    }
    return textAndJson(
      {
        bpm: data.bpm,
        beats: data.beats.length,
        downbeats: data.downbeats.length,
        firstBeats: data.beats.slice(0, 16),
        firstDownbeats: data.downbeats.slice(0, 8),
        markers,
        device: data.device,
      },
      `BPM medido ${data.bpm ?? "?"} — ${data.beats.length} batidas, ${data.downbeats.length} tempos fortes${markers !== undefined ? `, ${markers} marcadores gravados` : ""}.`,
    );
  },
});
