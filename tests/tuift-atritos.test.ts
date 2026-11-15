// Frictions found by a "new user" test (19/10/2026):
// review flags at the morph's own seams, render status across server
// sessions, and the strict ae_catalog arguments.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import "../src/operations/index.js";
import { DEFAULT_STYLE, WORK_DIR } from "../src/tuift/common.js";
import { renderStatusTool } from "../src/tuift/render.js";
import { reviewRules } from "../src/tuift/review.js";
import { ALL_TOOLS } from "../src/tools/index.js";
import { nullTransport } from "./helpers/null-transport.js";

const textOf = (r: { content: Array<{ type: string; text?: string }> }) =>
  r.content.map((c) => c.text ?? "").join("\n");

function layer(index: number, name: string, inPoint: number, outPoint: number) {
  return {
    index,
    name,
    kind: "av",
    enabled: true,
    inPoint,
    outPoint,
    props: [],
    otherKeys: [],
    parent: null,
    mb: false,
  };
}

describe("ae_review_motion at tuift.morph seams", () => {
  const data = (layers: unknown[]) => ({ fps: 30, w: 1080, h: 1080, waStart: 0, waDur: 4, layers });

  it("does not report entra/sai cortando at the morph hand-offs", () => {
    const issues = reviewRules(
      data([
        layer(1, "spotify", 2, 4), // target after the morph: starts where its morph copy ends
        layer(2, "spotify · morph", 1.2, 2),
        layer(3, "ae · morph", 1, 1.5),
        layer(4, "ae", 0, 1), // source before the morph: ends where its morph copy starts
        layer(5, "MORPH ae > spotify", 1, 2),
      ]),
      DEFAULT_STYLE,
    );
    const cuts = issues.filter((i) => i.rule === "entra_cortando" || i.rule === "sai_cortando");
    expect(cuts).toEqual([]);
  });

  it("still reports a real cut on an unrelated layer", () => {
    const issues = reviewRules(data([layer(1, "card", 1, 2)]), DEFAULT_STYLE);
    const rules = issues.map((i) => i.rule);
    expect(rules).toContain("entra_cortando");
    expect(rules).toContain("sai_cortando");
  });
});

describe("ae_render_status across server sessions", () => {
  it("finds a job through the on-disk index when it is not in memory", async () => {
    const id = `teste-indice-${process.pid}-${Date.now()}`;
    const outDir = path.join(WORK_DIR, "render", id);
    const index = path.join(WORK_DIR, "render-jobs", `${id}.json`);
    mkdirSync(outDir, { recursive: true });
    mkdirSync(path.dirname(index), { recursive: true });
    try {
      const final = path.join(outDir, "comp.mp4");
      writeFileSync(
        path.join(outDir, "job.json"),
        JSON.stringify({
          id,
          comp: "comp",
          project: "x.aep",
          outDir,
          final,
          status: "done",
          chunks: [{ s: 0, e: 29, file: "a.mp4", code: 0 }],
          startedAt: new Date().toISOString(),
        }),
      );
      writeFileSync(index, JSON.stringify({ id, outDir, startedAt: new Date().toISOString() }));
      const r = await renderStatusTool.handler({ jobId: id }, nullTransport());
      expect(r.isError).toBe(false);
      expect(textOf(r)).toContain("Pronto:");
      const list = await renderStatusTool.handler({}, nullTransport());
      expect(textOf(list)).toContain(id);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
      rmSync(index, { force: true });
    }
  });

  it("reports a running job whose worker is gone as failed", async () => {
    const id = `teste-orfao-${process.pid}-${Date.now()}`;
    const outDir = path.join(WORK_DIR, "render", id);
    const index = path.join(WORK_DIR, "render-jobs", `${id}.json`);
    mkdirSync(outDir, { recursive: true });
    mkdirSync(path.dirname(index), { recursive: true });
    try {
      writeFileSync(
        path.join(outDir, "job.json"),
        JSON.stringify({
          id,
          comp: "comp",
          project: "x.aep",
          outDir,
          final: path.join(outDir, "comp.mp4"),
          status: "running",
          chunks: [{ s: 0, e: 29, file: "a.mp4" }],
          startedAt: new Date().toISOString(),
          pid: 2 ** 22 + 7, // no such process
        }),
      );
      writeFileSync(index, JSON.stringify({ id, outDir }));
      const r = await renderStatusTool.handler({ jobId: id }, nullTransport());
      expect(textOf(r)).toContain("Falhou");
    } finally {
      rmSync(outDir, { recursive: true, force: true });
      rmSync(index, { force: true });
    }
  });

  it("unknown job ids are a coded error with a hint", async () => {
    const r = await renderStatusTool.handler({ jobId: "nao-existe-123" }, nullTransport());
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("INVALID_ARGS");
  });
});

describe("ae_catalog arguments", () => {
  const catalog = ALL_TOOLS.find((t) => t.name === "ae_catalog")!;

  it("returns the schema of one operation", async () => {
    const r = await catalog.handler({ operation: "tuift.morph" }, nullTransport());
    expect(r.isError).toBe(false);
    const payload = r.structuredContent as {
      operations: Array<{ name: string; params: unknown[] }>;
    };
    expect(payload.operations).toHaveLength(1);
    expect(payload.operations[0].name).toBe("tuift.morph");
    expect(payload.operations[0].params.length).toBeGreaterThan(0);
  });

  it("unknown operation names suggest the category's operations", async () => {
    const r = await catalog.handler({ operation: "tuift.morf" }, nullTransport());
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("UNKNOWN_OPERATION");
    expect(textOf(r)).toContain("tuift.morph");
  });

  it("refuses arguments it does not know instead of ignoring them", async () => {
    const r = await catalog.handler({ operacao: "tuift.morph" }, nullTransport());
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("INVALID_ARGS");
    expect(textOf(r)).toContain("operacao");
  });
});
