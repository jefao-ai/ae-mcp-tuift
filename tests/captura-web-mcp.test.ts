import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { RUNTIME_ROOT } from "../src/config.js";
import { McpTestClient } from "./harness.js";

const browserRoot = process.env.TUIFT_PLAYWRIGHT_ROOT;

describe("captura web pelo servidor MCP real", () => {
  const client = new McpTestClient();
  let dir: string;
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "ae-captura-web-test-"));
    await client.connect();
  }, 30000);
  afterAll(async () => {
    await client.close();
    for (const file of ["capture.json", "batch.json"]) {
      await fs.unlink(path.join(dir, file)).catch(() => undefined);
    }
    await fs.rmdir(dir).catch(() => undefined);
  });

  it("registra as ferramentas sem pedir instância AE", async () => {
    const list = (await client.listTools()) as {
      tools: Array<{ name: string; inputSchema?: { properties?: Record<string, unknown> } }>;
    };
    for (const name of ["ae_capturar_movimento_web", "ae_preparar_movimento_web"]) {
      const tool = list.tools.find((x) => x.name === name);
      expect(tool).toBeDefined();
      expect(tool?.inputSchema?.properties?.instance).toBeUndefined();
    }
    const error = await client.callExpectError("ae_capturar_movimento_web", {
      url: "file:///anything",
      selector: "#x",
      viewport: [320, 180],
      fps: 30,
      duration: 1,
      outPath: "relative.json",
      playwrightRoot: browserRoot,
    });
    expect(error).toContain("outPath precisa ser um caminho absoluto");
  });

  it("recusa escrita dentro da caixa IPC antes de abrir navegador", async () => {
    const error = await client.callExpectError("ae_capturar_movimento_web", {
      url: "file:///anything",
      selector: "#x",
      viewport: [320, 180],
      fps: 30,
      duration: 1,
      outPath: path.join(RUNTIME_ROOT, "test-captura-negada.json"),
      playwrightRoot: browserRoot,
    });
    expect(error).toContain("caixa IPC");
  });

  it("recusa saída que aponta para a caixa IPC por junção", async () => {
    const junction = path.join(dir, "ipc-link");
    await fs.symlink(RUNTIME_ROOT, junction, process.platform === "win32" ? "junction" : "dir");
    try {
      const error = await client.callExpectError("ae_capturar_movimento_web", {
        url: "file:///anything",
        selector: "#x",
        viewport: [320, 180],
        fps: 30,
        duration: 1,
        outPath: path.join(junction, "test-captura-negada.json"),
        playwrightRoot: browserRoot,
      });
      expect(error).toContain("caixa IPC");
    } finally {
      if (process.platform === "win32") await fs.rmdir(junction);
      else await fs.unlink(junction);
    }
  });

  it.skipIf(!browserRoot)(
    "captura, prepara lote e recusa sobrescrita usando MCP stdio",
    async () => {
      const capturePath = path.join(dir, "capture.json"),
        batchPath = path.join(dir, "batch.json");
      const captured = await client.call<{ ok: boolean; frames: number; writtenTo: string }>(
        "ae_capturar_movimento_web",
        {
          url: pathToFileURL(path.join(process.cwd(), "fixtures", "captura-web.html")).href,
          selector: "#card",
          viewport: [320, 180],
          fps: 30,
          duration: 1.1,
          outPath: capturePath,
          playwrightRoot: browserRoot,
        },
        { timeoutMs: 30000 },
      );
      expect(captured.ok).toBe(true);
      expect(captured.frames).toBe(34);
      const prepared = await client.call<{ ok: boolean; frames: number; operations: number }>(
        "ae_preparar_movimento_web",
        {
          capturePath,
          outPath: batchPath,
          sourceSize: [80, 60],
          comp: "Demo",
          layer: "Card",
        },
      );
      expect(prepared.ok).toBe(true);
      expect(prepared.frames).toBe(34);
      expect(prepared.operations).toBe(6);
      const file = JSON.parse(await fs.readFile(batchPath, "utf8"));
      expect(file.batch.operation).toBe("batch.run");
      expect(file.batch.args.stopOnError).toBe(true);
      const duplicate = await client.callExpectError("ae_preparar_movimento_web", {
        capturePath,
        outPath: batchPath,
        sourceSize: [80, 60],
        comp: "Demo",
        layer: "Card",
      });
      expect(duplicate).toContain("já existe");
    },
    30000,
  );
});
