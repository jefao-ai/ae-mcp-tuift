// Shared plumbing for the TUIFT additions (src/tuift/*): paths to the house
// style, lessons and docs folder, plus small helpers to run JSX through the
// same transport the upstream tools use.

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { errorResult } from "../errors.js";
import type { AeTransport, EvalResult } from "../transport/AeTransport.js";
import { lerEnv } from "./env.js";
import type { ToolResult } from "../tools/types.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** Repo root of this server (dist/tuift → ../..). */
export const SERVER_ROOT = path.resolve(HERE, "..", "..");

/** Defaults shipped with the server (house style + general lessons). */
export const KIT_DIR = path.join(SERVER_ROOT, "kit");

function dataPath(envVar: string | undefined, file: string): string {
  return envVar || path.join(KIT_DIR, file);
}

/** Machine-readable house style (TUIFT_HOUSE_STYLE points to a file of your own). */
export const HOUSE_STYLE_PATH = dataPath(lerEnv("HOUSE_STYLE"), "estilo-da-casa.json");

/** Review rules and decided cases for ae_avaliar_render. Optional: missing file = no extra rules (TUIFT_REVIEW_RULES). */
export const REVIEW_PATH = dataPath(lerEnv("REVIEW_RULES"), "revisao-casa.json");

/** Lessons journal attached to failures (must be writable for ae_lessons add). */
export const LESSONS_PATH = dataPath(lerEnv("LESSONS"), "licoes.jsonl");

/** ffmpeg / ffprobe executables (PATH by default). */
export const FFMPEG = lerEnv("FFMPEG") || "ffmpeg";
export const FFPROBE =
  lerEnv("FFPROBE") ||
  (lerEnv("FFMPEG")
    ? path.join(
        path.dirname(lerEnv("FFMPEG")!),
        path.basename(lerEnv("FFMPEG")!).replace(/ffmpeg/i, "ffprobe"),
      )
    : "ffprobe");

/**
 * Folder with the After Effects scripting and expression guides you cloned
 * yourself (docsforadobe). No default: the guides are not redistributed here,
 * so ae_docs is only registered when TUIFT_DOCS_DIR points at that folder.
 */
export const DOCS_DIR = lerEnv("DOCS_DIR") ?? null;

/** Where checkpoints, sheets and render jobs are written by default. */
export const WORK_DIR = lerEnv("WORK_DIR") ?? path.join(os.tmpdir(), "ae-mcp-tuift");

export interface HouseStyle {
  [key: string]: any;
}

let cachedStyle: { mtime: number; style: HouseStyle } | null = null;

/** Built-in defaults; the JSON house-style file overrides any key. */
export const DEFAULT_STYLE: HouseStyle = {
  mola: { durSec: 0.25, amp: 0.05, freq: 2, decay: 4 },
  // cubic-bezier(x1,y1,x2,y2) with y1=0,y2=1 → AE: out influence x1·100, in influence (1−x2)·100, speeds 0.
  curvas: {
    saas: { out: 86, in: 93 }, // (.86,0,.07,1) câmera e troca de cena
    entrada: { out: 33, in: 33 }, // (.33,0,.67,1)
    board: { out: 33.3, in: 77.15 }, // (.333,0,.2285,1) lousa contínua
  },
  vivo: { freq: 0.5, ampPx: 6, rotDeg: 0.4 },
  motionBlur: { shutterAngle: 70, shutterPhase: -35 },
  stagger: { letrasSec: 0.035, itensSec: 0.075, secoesSec: 0.15 },
  revisao: {
    paradaMortaSec: 0.5,
    movimentoMecanicoSec: 0.15,
    movimentoPesadoSec: 1.0,
    inicioSimultaneoMin: 3,
    textoMinPx1080: 22,
    margemSeguraPx: 48,
    enquadramento: {
      padMinPx: 12,
      padMinRel: 0.25,
      centroPx: 4,
      centroRel: 0.1,
      assimetriaPx: 8,
      linhaMargemPx: 12,
      umaLinhaRel: 3.8,
      caixaMaxFrame: 0.35,
    },
  },
  render: { trechoSec: 30, trechoSec3d: 15, trechoSecPesado: 10, memUsage: [20, 30], lufs: -14 },
  // ae_plano_check: números dos ritmos por perfil
  plano: {
    buracoSec: 0.04,
    sobreposicaoMaxSec: 0.35,
    trocaNaFalaSec: 0.3,
    textoMaxPalavras: 9,
    perfis: {
      narrado: {
        cenaMinSec: 3,
        cenaMaxSec: 8,
        cenasPorMinutoMax: 15,
        elementosPor10sMax: 7,
        elementosJuntosMax: 3,
        semMudarMaxSec: 6,
        vidaPrincipalMinSec: 3,
        vidaApoioMinSec: 1.5,
      },
      cinetico: { cenaMinSec: 0.4, semMudarMaxSec: 3, elementosPor10sMin: 8 },
      livre: {},
    },
  },
  // ae_avaliar_render: faixas da nota medida; calibradas em vídeos aprovados
  avaliacao: {
    pronto: 85,
    revisar: 70,
    silencioDb: -35,
    silencioMinSec: 0.5,
    silencioLongoSec: 2,
    picoMaxDb: -1,
    perfis: {
      narrado: { eventosPor10s: [2, 5], paradoPct: [25, 40], repousoMaxSec: 6 },
      cinetico: { eventosPor10s: [6, 20], paradoPct: [0, 25], repousoMaxSec: 1.5 },
      musica: { eventosPor10s: [1, 20], paradoPct: [0, 45], repousoMaxSec: 3 },
      livre: { eventosPor10s: [1, 20], paradoPct: [0, 60], repousoMaxSec: 8 },
    },
  },
};

export function houseStyle(): HouseStyle {
  try {
    const st = existsSync(HOUSE_STYLE_PATH) ? readFileSync(HOUSE_STYLE_PATH, "utf8") : null;
    if (!st) return DEFAULT_STYLE;
    const mtime = Date.now();
    if (cachedStyle && cachedStyle.style.__raw === st) return cachedStyle.style;
    const parsed = JSON.parse(st) as HouseStyle;
    const merged: HouseStyle = { ...DEFAULT_STYLE };
    for (const [k, v] of Object.entries(parsed)) {
      merged[k] =
        v &&
        typeof v === "object" &&
        !Array.isArray(v) &&
        DEFAULT_STYLE[k] &&
        typeof DEFAULT_STYLE[k] === "object"
          ? { ...DEFAULT_STYLE[k], ...v }
          : v;
    }
    Object.defineProperty(merged, "__raw", { value: st, enumerable: false });
    cachedStyle = { mtime, style: merged };
    return merged;
  } catch {
    return DEFAULT_STYLE;
  }
}

/** Turn a transport failure into a ToolResult; null when the call succeeded. */
export function transportFailure(r: EvalResult, label: string): ToolResult | null {
  if (r.ok) {
    const res = r.result as { ok?: boolean; error?: string } | null;
    if (res && typeof res === "object" && !Array.isArray(res) && res.ok === false) {
      return errorResult(
        "OPERATION_FAILED",
        `${label}: ${res.error ?? "operation reported ok:false"}`,
        {
          details: res as Record<string, unknown>,
        },
      );
    }
    return null;
  }
  return errorResult(r.errorCode ?? "JSX_THROW", `${label}: ${r.error ?? "failed"}`, {
    details: r.dialogs ? { dialogs: r.dialogs } : undefined,
    stack: r.stack,
    logs: r.logs,
    durationMs: r.durationMs,
  });
}

export async function runJsx<T = any>(
  transport: AeTransport,
  code: string,
  label: string,
  opts: {
    payload?: unknown;
    timeoutMs?: number;
    undoGroup?: boolean;
    suppressDialogs?: boolean;
  } = {},
): Promise<{ ok: true; value: T; raw: EvalResult } | { ok: false; error: ToolResult }> {
  const r = await transport.execute({ code, label, ...opts });
  const fail = transportFailure(r, label);
  if (fail) return { ok: false, error: fail };
  return { ok: true, value: r.result as T, raw: r };
}

export function textAndJson(payload: Record<string, unknown>, extraText?: string): ToolResult {
  const envelope = { ok: true, ...payload };
  const text = (extraText ? extraText + "\n\n" : "") + JSON.stringify(envelope, null, 2);
  return { content: [{ type: "text", text }], structuredContent: envelope, isError: false };
}

/**
 * Readable text for an outside program that could not be started (almost always
 * "not installed"). Spawning a missing program raises an `error` event, which
 * crashes the whole server when nobody listens: every spawn here listens and
 * turns it into this message.
 */
export function programFailure(cmd: string, e: NodeJS.ErrnoException): string {
  const name = path.basename(cmd);
  if (e.code === "ENOENT") {
    const tip =
      name.toLowerCase().startsWith("ffmpeg") || name.toLowerCase().startsWith("ffprobe")
        ? " Install ffmpeg and put it on PATH, or set TUIFT_FFMPEG (and TUIFT_FFPROBE) to the full path."
        : name.toLowerCase().startsWith("python")
          ? " Install Python 3 and put it on PATH, or set TUIFT_PYTHON to the full path."
          : "";
    return `${name} was not found on this computer (looked for "${cmd}").${tip}`;
  }
  return `${name} could not be started: ${e.message}`;
}

export function run(
  cmd: string,
  args: string[],
  opts: { timeoutMs?: number; cwd?: string } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      {
        timeout: opts.timeoutMs ?? 120_000,
        maxBuffer: 64 * 1024 * 1024,
        cwd: opts.cwd,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        if (err && /^E[A-Z]+$/.test(String((err as NodeJS.ErrnoException).code))) {
          // The program never ran (ENOENT, EACCES, ...): say so instead of an empty stderr.
          resolve({
            code: 127,
            stdout: String(stdout),
            stderr: programFailure(cmd, err as NodeJS.ErrnoException),
          });
          return;
        }
        const code = err && typeof (err as any).code === "number" ? (err as any).code : err ? 1 : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

/** Safe file stem for generated outputs. */
export function slug(s: string): string {
  return (
    s
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "x"
  );
}

export function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
