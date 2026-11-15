import { promises as fs } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import { rejectedOutputPath } from "../config.js";
import { errorResult } from "../errors.js";
import { defineTool, jsonResult } from "../tools/define-tool.js";
import {
  capturarMovimentoWeb,
  converterCapturaAE,
  prepararLoteAE,
  type WebCapture,
} from "./captura-web.js";

const point = z.tuple([z.number().positive(), z.number().positive()]);
const id = z.union([z.string().min(1), z.number().int().positive()]);

/** Evita que um erro de navegação devolva valores de autenticação na URL. */
export function redactCaptureError(message: string, sourceUrl: string): string {
  try {
    const url = new URL(sourceUrl);
    const values: string[] = [];
    const entries = Array.from(url.searchParams.entries());
    for (const [key, value] of entries) {
      if (/token|secret|password|passwd|api.?key|auth|code/i.test(key) && value) {
        values.push(value, encodeURIComponent(value));
        url.searchParams.set(key, "[redigido]");
      }
    }
    let result = message.split(sourceUrl).join(url.toString());
    for (const value of values) result = result.split(value).join("[redigido]");
    return result;
  } catch {
    return message;
  }
}

/** Resolves an existing output directory so junctions cannot target the IPC mailbox. */
async function validateOutput(outPath: string): Promise<string> {
  if (!path.isAbsolute(outPath)) throw new Error("outPath precisa ser um caminho absoluto");
  const resolved = path.resolve(outPath);
  const parent = await fs.realpath(path.dirname(resolved));
  const physical = path.join(parent, path.basename(resolved));
  if (rejectedOutputPath(resolved) || rejectedOutputPath(physical))
    throw new Error("a saída não pode ficar dentro da caixa IPC da ponte");
  try {
    await fs.lstat(resolved);
    throw new Error("outPath já existe; escolha um arquivo novo");
  } catch (e) {
    if (!(e && typeof e === "object" && "code" in e && e.code === "ENOENT")) throw e;
  }
  return resolved;
}

async function writeNew(outPath: string, value: unknown): Promise<number> {
  const content = JSON.stringify(value, null, 2) + "\n";
  await fs.writeFile(outPath, content, { encoding: "utf8", flag: "wx" });
  return Buffer.byteLength(content, "utf8");
}

export const captureWebMotionTool = defineTool({
  name: "ae_capturar_movimento_web",
  title: "Capturar movimento CSS de página",
  description:
    "Captura quadros de um elemento 2D de página CSS/WAAPI sem abrir o AE. Mede os quatro cantos reais, pivô e opacidade; grava JSON novo no outPath. Não controla JavaScript, canvas, WebGL, vídeo ou rolagem; filtros e máscaras são avisados.",
  group: "inspect",
  blockedInReadOnly: false,
  effect: "write",
  strictArgs: true,
  inputShape: {
    url: z.string().min(1).describe("URL http(s) ou file da página; sem usuário/senha na URL."),
    selector: z
      .string()
      .min(1)
      .describe("Seletor CSS do elemento; apenas o primeiro correspondente."),
    viewport: z
      .tuple([z.number().int().min(1).max(8192), z.number().int().min(1).max(8192)])
      .describe("[largura, altura] do viewport e da futura comp em pixels."),
    fps: z.number().min(1).max(120).describe("Taxa de quadros da comp."),
    duration: z
      .number()
      .min(0)
      .max(120)
      .describe("Duração a capturar em segundos, até 6000 amostras."),
    outPath: z
      .string()
      .min(1)
      .describe("Caminho absoluto novo, com pasta existente, para o JSON de captura."),
    playwrightRoot: z
      .string()
      .optional()
      .describe("Pasta que contém node_modules/playwright; o TUIFT já possui a dependência."),
    browserExecutable: z
      .string()
      .optional()
      .describe("Executável Chromium opcional; omita para o browser do Playwright."),
    timeoutMs: z
      .number()
      .positive()
      .optional()
      .describe("Tempo máximo de carregamento da página em ms."),
  },
  handler: async (args) => {
    let outPath: string;
    try {
      outPath = await validateOutput(args.outPath);
    } catch (e) {
      return errorResult("IO", e instanceof Error ? e.message : String(e));
    }
    const begin = performance.now();
    try {
      const capture = await capturarMovimentoWeb(args);
      const bytes = await writeNew(outPath, capture);
      return jsonResult({
        writtenTo: outPath.replace(/\\/g, "/"),
        bytes,
        frames: capture.samples.length,
        fps: capture.source.fps,
        animations: capture.animations,
        warnings: capture.warnings,
        durationMs: Math.round(performance.now() - begin),
      });
    } catch (e) {
      return errorResult(
        "TRANSPORT",
        redactCaptureError(e instanceof Error ? e.message : String(e), args.url),
      );
    }
  },
});

export const prepareWebMotionTool = defineTool({
  name: "ae_preparar_movimento_web",
  title: "Preparar chaves AE do movimento web",
  description:
    "Lê uma captura JSON e grava um arquivo novo com conversão 2D e lote batch.run para ae_do. Não altera o AE. O lote verifica comp, camada, footage e keys antes de aplicar; requer eval.run habilitado e não é transacional.",
  group: "inspect",
  blockedInReadOnly: false,
  effect: "write",
  strictArgs: true,
  inputShape: {
    capturePath: z.string().min(1).describe("Caminho absoluto da captura JSON existente."),
    outPath: z
      .string()
      .min(1)
      .describe("Caminho absoluto novo, com pasta existente, para a conversão e o lote."),
    sourceSize: point.describe("[largura, altura] em pixels do footage a animar no AE."),
    comp: id.describe("Nome único ou ID da comp AE, com viewport e fps da captura."),
    layer: id.describe("Nome único ou índice de camada nova, 2D, sem parent nem keys."),
    timeOffset: z
      .number()
      .nonnegative()
      .optional()
      .describe("Deslocamento das chaves em segundos; padrão 0."),
  },
  handler: async (args) => {
    let outPath: string;
    try {
      outPath = await validateOutput(args.outPath);
    } catch (e) {
      return errorResult("IO", e instanceof Error ? e.message : String(e));
    }
    if (!path.isAbsolute(args.capturePath))
      return errorResult("INVALID_ARGS", "capturePath precisa ser absoluto");
    let capture: WebCapture;
    try {
      const physical = await fs.realpath(args.capturePath);
      if (rejectedOutputPath(physical))
        return errorResult("FORBIDDEN", "captura não pode ficar na caixa IPC da ponte");
      const info = await fs.stat(physical);
      if (!info.isFile() || info.size > 20 * 1024 * 1024)
        return errorResult("IO", "captura precisa ser arquivo de até 20 MB");
      try {
        capture = JSON.parse(await fs.readFile(physical, "utf8")) as WebCapture;
      } catch {
        return errorResult("VALIDATION", "JSON de captura inválido ou não legível");
      }
    } catch (e) {
      return errorResult("IO", e instanceof Error ? e.message : String(e));
    }
    const begin = performance.now();
    try {
      const conversion = converterCapturaAE(capture, args.sourceSize);
      const batch = prepararLoteAE(conversion, args);
      const bytes = await writeNew(outPath, { conversion, batch });
      return jsonResult({
        writtenTo: outPath.replace(/\\/g, "/"),
        bytes,
        frames: conversion.samples.length,
        maxCornerError: conversion.maxCornerError,
        warnings: conversion.warnings,
        operations: batch.args.ops.length,
        next: "Leia batch do arquivo e envie a ae_do; faça checkpoint e confira cada resultado.",
        durationMs: Math.round(performance.now() - begin),
      });
    } catch (e) {
      return errorResult("VALIDATION", e instanceof Error ? e.message : String(e));
    }
  },
});
