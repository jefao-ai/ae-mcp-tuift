// ae_see — the agent's eyes. Renders N frames of a comp (explicit times, or
// evenly spaced over the work area / a range), tiles them into ONE labelled
// contact sheet and RETURNS IT AS AN IMAGE, so the model actually looks at the
// result instead of trusting a path. Optional side-by-side against a reference
// (video or images) with a difference column — the REF | NEW check that the
// community converged on for "recreate this reference" work.

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { z } from "zod";

import { decodePng, encodePngSrgb8, type DecodedPng } from "../color/png16.js";
import { readFileSettled } from "../color/settled-read.js";
import { composeContactSheet, resample } from "../color/sheet.js";
import { errorResult } from "../errors.js";
import { jsxVal } from "../registry.js";
import { defineTool } from "../tools/define-tool.js";
import { renderFrameTool } from "../tools/render-frame.js";
import type { ToolResult } from "../tools/types.js";
import { type Cena, filtrarCenas, LER_CENAS_FN, temposDaCena } from "./cenas.js";
import { FFMPEG, WORK_DIR, run, runJsx, slug, stamp } from "./common.js";

async function compTiming(transport: any, comp: string | number) {
  return runJsx<{
    fps: number;
    duration: number;
    waStart: number;
    waDur: number;
    name: string;
    w: number;
    h: number;
    cenas: Cena[];
  }>(
    transport,
    `${LER_CENAS_FN}
     var c = AE.findCompByNameOrId(${jsxVal(comp)});
     if (!c) return { ok: false, error: "no comp matching " + ${jsxVal(String(comp))} };
     return { fps: c.frameRate, duration: c.duration, waStart: c.workAreaStart, waDur: c.workAreaDuration,
              name: c.name, w: c.width, h: c.height, cenas: TUIFT_lerCenas(c) };`,
    "see_timing",
    { undoGroup: false },
  );
}

/** Evenly spaced, frame-snapped times inside [start, end). */
export function spacedTimes(start: number, end: number, count: number, fps: number): number[] {
  const last = Math.max(start, end - 1 / fps);
  if (count <= 1) return [Math.round(((start + last) / 2) * fps) / fps];
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const t = start + ((last - start) * i) / (count - 1);
    out.push(Math.round(t * fps) / fps);
  }
  return [...new Set(out)];
}

async function toJpeg(png: string): Promise<{ data: string; mime: string; path: string }> {
  const jpg = png.replace(/\.png$/i, ".jpg");
  const r = await run(FFMPEG, ["-y", "-loglevel", "error", "-i", png, "-q:v", "4", jpg]);
  if (r.code === 0)
    return { data: (await fs.readFile(jpg)).toString("base64"), mime: "image/jpeg", path: jpg };
  return { data: (await fs.readFile(png)).toString("base64"), mime: "image/png", path: png };
}

/** Tempos e rótulos da folha por cena; acima de 32 quadros cai para só o meio de cada cena. */
export function temposPorCena(
  cenas: Cena[],
  fps: number,
  quadrosPorCena: number,
): { times: number[]; labels: string[]; quadros: number } {
  const monta = (q: number) => {
    const times: number[] = [];
    const labels: string[] = [];
    for (const c of cenas) {
      for (const t of temposDaCena(c, fps, q)) {
        times.push(t);
        labels.push(`${c.nome} ${t.toFixed(2)}s`);
      }
    }
    return { times, labels, quadros: q };
  };
  const pedido = monta(quadrosPorCena);
  return pedido.times.length <= 32 ? pedido : monta(1);
}

function diffImage(a: DecodedPng, b: DecodedPng): DecodedPng {
  const w = Math.min(a.width, b.width);
  const h = Math.min(a.height, b.height);
  const ra = resample(a, w, h);
  const rb = resample(b, w, h);
  const rgb = new Float64Array(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    const d =
      (Math.abs(ra[i * 3] - rb[i * 3]) +
        Math.abs(ra[i * 3 + 1] - rb[i * 3 + 1]) +
        Math.abs(ra[i * 3 + 2] - rb[i * 3 + 2])) /
      3;
    const v = Math.min(1, d * 3); // amplify: small mismatches become visible
    rgb[i * 3] = v;
    rgb[i * 3 + 1] = v * 0.35;
    rgb[i * 3 + 2] = 0;
  }
  return { width: w, height: h, rgb, bitDepth: 8 };
}

function meanDiff(a: DecodedPng, b: DecodedPng): number {
  const w = 160;
  const h = Math.max(1, Math.round((a.height * w) / a.width));
  const ra = resample(a, w, h);
  const rb = resample(b, w, h);
  let s = 0;
  for (let i = 0; i < ra.length; i++) s += Math.abs(ra[i] - rb[i]);
  return s / ra.length;
}

export const seeTool = defineTool({
  name: "ae_see",
  title: "See frames (contact sheet as image)",
  description:
    "LOOK at the comp: renders several frames and returns ONE labelled contact sheet as an IMAGE you can see " +
    "(plus the file paths). Use after every build step and before saying anything is done — a successful tool " +
    "call is not visual proof. Give `times`, or `count` frames evenly spaced over the work area (or `range`). " +
    "Check the MIDDLE of movements, not only the rest poses. With `reference` (a video file or a list of " +
    "images) each row is REF | NOSSO (| DIF), at the same times — the side-by-side used to recreate a reference. " +
    "Keep sheets to 6–16 frames; for long pieces call it per scene. With scene markers (tuift.cena), `cenas: true` " +
    "(or a list such as ['S03', 'S04']) picks the middle and the settled frame of each scene and labels them by name.",
  group: "render",
  blockedInReadOnly: false,
  effect: "write",
  inputShape: {
    comp: z.union([z.string(), z.number()]).describe("Composition name or item id."),
    times: z
      .array(z.number().nonnegative())
      .min(1)
      .max(32)
      .optional()
      .describe("Exact times in seconds."),
    count: z
      .number()
      .int()
      .min(1)
      .max(32)
      .optional()
      .describe("Frames evenly spaced over the range (default 9)."),
    range: z
      .tuple([z.number().nonnegative(), z.number().positive()])
      .optional()
      .describe("[start, end] seconds for `count`; default = work area."),
    cenas: z
      .union([z.boolean(), z.array(z.string()).min(1)])
      .optional()
      .describe(
        "Use the scene markers made by tuift.cena instead of `times`/`count`: true = every scene, or names like " +
          "['S03', 'S04_PROVA', 'prova'].",
      ),
    quadrosPorCena: z
      .number()
      .int()
      .min(1)
      .max(3)
      .optional()
      .describe(
        "With `cenas`: 1 = middle, 2 = middle and settled (default), 3 = entrance, middle, settled.",
      ),
    columns: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Tiles per row (default 3; 2 or 3 with reference)."),
    thumbWidth: z
      .number()
      .int()
      .min(120)
      .max(1280)
      .optional()
      .describe(
        "Tile width in px (default 360; use 640+ to judge detail such as small text or glow).",
      ),
    reference: z
      .object({
        video: z
          .string()
          .optional()
          .describe("Reference video file; frames are taken at the same times (+offset)."),
        images: z
          .array(z.string())
          .optional()
          .describe("Reference images, one per time, in order."),
        offset: z
          .number()
          .optional()
          .describe("Seconds added to each time when sampling the reference video."),
        diff: z.boolean().optional().describe("Add a difference column (default true)."),
      })
      .optional(),
    outDir: z
      .string()
      .optional()
      .describe("Where to keep the frames and sheet (default: temp work dir)."),
  },
  handler: async (args, transport): Promise<ToolResult> => {
    const timing = await compTiming(transport, args.comp);
    if (!timing.ok) return timing.error;
    const tm = timing.value;
    let times = args.times;
    let labelsPorCena: string[] | undefined;
    let avisoCenas: string | undefined;
    if (args.cenas) {
      if (args.times) return errorResult("INVALID_ARGS", "give `cenas` or `times`, not both");
      const escolhidas = args.cenas === true ? tm.cenas : filtrarCenas(tm.cenas, args.cenas);
      if (!escolhidas.length)
        return errorResult("INVALID_ARGS", "no scene markers match `cenas`", {
          details: { cenasNaComp: tm.cenas.map((c) => c.nome) },
          hint: "Mark the scenes first: ae_do tuift.cena { comp, cenas: [{ nome, inicio, fim }] }.",
        });
      const pedido = args.quadrosPorCena ?? 2;
      const r = temposPorCena(escolhidas, tm.fps, pedido);
      if (r.times.length > 32)
        return errorResult(
          "INVALID_ARGS",
          `${r.times.length} scenes do not fit one sheet (max 32)`,
          { hint: "Ask for part of them: cenas: ['S01', 'S02', ...]." },
        );
      times = r.times;
      // Fonte da folha: 12 px por letra. O rótulo que não cabe no quadro corta o nome, nunca o tempo.
      const cabem = Math.max(8, Math.floor((args.thumbWidth ?? 360) / 12));
      labelsPorCena = r.labels.map((l) => {
        if (l.length <= cabem) return l;
        const corte = l.lastIndexOf(" ");
        return l.slice(0, cabem - (l.length - corte)) + l.slice(corte);
      });
      if (r.quadros !== pedido)
        avisoCenas = "muitas cenas para uma folha: mostrei só o meio de cada uma";
    }
    if (!times) {
      const [a, b] = args.range ?? [tm.waStart, tm.waStart + tm.waDur];
      times = spacedTimes(a, Math.min(b, tm.duration), args.count ?? 9, tm.fps);
    }
    const dir = path.resolve(
      args.outDir ?? path.join(WORK_DIR, "see", `${slug(tm.name)}-${stamp()}`),
    );
    await fs.mkdir(dir, { recursive: true });
    const thumbWidth = args.thumbWidth ?? 360;

    const rendered = await renderFrameTool.handler(
      {
        compNameOrId: args.comp,
        times,
        outPath: path.join(dir, "f.png"),
        contactSheet:
          args.reference || labelsPorCena
            ? undefined
            : { columns: args.columns ?? Math.min(3, times.length), thumbWidth },
      } as any,
      transport,
    );
    if (rendered.isError) return rendered;
    const sc = (rendered.structuredContent ?? {}) as any;
    const payload = (sc.result && typeof sc.result === "object" ? sc.result : sc) as any;
    const frames: string[] = (payload.frames ?? []).map((f: any) => f.writtenTo).filter(Boolean);
    if (!frames.length && payload.writtenTo) frames.push(payload.writtenTo);

    let sheetPath: string | undefined = payload.contactSheet?.writtenTo;
    const scores: Array<{ time: number; meanDiff: number }> = [];
    if (args.reference) {
      const ref = args.reference;
      const refFiles: string[] = [];
      if (ref.video) {
        for (const [i, t] of times.entries()) {
          const out = path.join(dir, `ref_${i}.png`);
          // -ss AFTER -i: on this PC an input-side seek decodes blocky H.264 frames.
          const r = await run(FFMPEG, [
            "-y",
            "-loglevel",
            "error",
            "-i",
            ref.video,
            "-ss",
            String(Math.max(0, t + (ref.offset ?? 0))),
            "-frames:v",
            "1",
            "-pix_fmt",
            "rgb24",
            out,
          ]);
          if (r.code !== 0)
            return errorResult(
              "IO",
              `ffmpeg could not read the reference at ${t}s: ${r.stderr.trim()}`,
            );
          refFiles.push(out);
        }
      } else if (ref.images?.length) {
        for (const [i, img] of ref.images.entries()) {
          const out = path.join(dir, `ref_${i}.png`);
          const r = await run(FFMPEG, [
            "-y",
            "-loglevel",
            "error",
            "-i",
            img,
            "-pix_fmt",
            "rgb24",
            out,
          ]);
          if (r.code !== 0) return errorResult("IO", `could not read reference image ${img}`);
          refFiles.push(out);
        }
      } else {
        return errorResult("INVALID_ARGS", "reference needs `video` or `images`");
      }
      const withDiff = ref.diff !== false;
      const tiles: DecodedPng[] = [];
      const labels: string[] = [];
      const n = Math.min(frames.length, refFiles.length);
      for (let i = 0; i < n; i++) {
        const a = decodePng(await fs.readFile(refFiles[i]));
        const b = decodePng(await readFileSettled(frames[i]));
        tiles.push(a, b);
        labels.push(`REF ${times[i].toFixed(2)}s`, `NOSSO ${times[i].toFixed(2)}s`);
        scores.push({ time: times[i], meanDiff: Number(meanDiff(a, b).toFixed(4)) });
        if (withDiff) {
          tiles.push(diffImage(a, b));
          labels.push(`DIF ${scores[i].meanDiff.toFixed(3)}`);
        }
      }
      const sheet = composeContactSheet(tiles, { columns: withDiff ? 3 : 2, thumbWidth, labels });
      sheetPath = path.join(dir, "comparacao.png");
      await fs.writeFile(sheetPath, encodePngSrgb8(sheet.width, sheet.height, sheet.rgb));
    }
    if (labelsPorCena && !args.reference) {
      const imagens: DecodedPng[] = [];
      for (const f of frames) imagens.push(decodePng(await readFileSettled(f)));
      const sheet = composeContactSheet(imagens, {
        columns: args.columns ?? Math.min(3, times.length),
        thumbWidth,
        labels: labelsPorCena,
      });
      sheetPath = path.join(dir, "cenas.png");
      await fs.writeFile(sheetPath, encodePngSrgb8(sheet.width, sheet.height, sheet.rgb));
    }
    if (!sheetPath)
      return errorResult("IO", "contact sheet was not produced", { details: payload });

    const img = await toJpeg(sheetPath);
    const summary = {
      ok: true,
      comp: tm.name,
      size: [tm.w, tm.h],
      fps: tm.fps,
      times,
      sheet: img.path.replace(/\\/g, "/"),
      frames: frames.map((f) => f.replace(/\\/g, "/")),
      ...(scores.length ? { referenceDiff: scores } : {}),
      ...(labelsPorCena ? { rotulos: labelsPorCena } : {}),
      ...(avisoCenas ? { avisoCenas } : {}),
      ...(payload.colorWarning ? { colorWarning: payload.colorWarning } : {}),
    };
    return {
      content: [
        { type: "image", data: img.data, mimeType: img.mime },
        { type: "text", text: JSON.stringify(summary, null, 2) },
      ],
      structuredContent: summary,
      isError: false,
    };
  },
});
