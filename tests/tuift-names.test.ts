// The house operations are `tuift.*` (category `tuift`), and the markers they
// write into expressions are `tuift_vivo` / `// tuift.mola`.

import { afterEach, describe, expect, it } from "vitest";

import "../src/operations/index.js";
import { getOp, listOps } from "../src/registry.js";
import { DEFAULT_STYLE } from "../src/tuift/common.js";
import { matchLessons } from "../src/tuift/lessons.js";
import { reviewRules } from "../src/tuift/review.js";
import { catalogTool } from "../src/tools/catalog.js";
import { doTool } from "../src/tools/do.js";
import { nullTransport } from "./helpers/null-transport.js";

afterEach(() => {
  delete process.env.AE_MCP_ALLOW_CATEGORIES;
});

const textOf = (r: { content: Array<{ type: string; text?: string }> }) =>
  r.content.map((c) => c.text ?? "").join("\n");

/** ae_do unwraps `{ result, context }`, so the canned answer must have both. */
const OK_RESPONSE = { result: { result: { ok: true }, context: {} } };

const NAMES = [
  "mola",
  "entrada",
  "saida",
  "stagger",
  "vivo",
  "camera_viva",
  "curva",
  "cena",
  "morph",
] as const;

const ARGS: Record<string, Record<string, unknown>> = {
  cena: { comp: "Main", cenas: [{ nome: "gancho", inicio: 0 }] },
  morph: { comp: "Main", de: "A", para: "B" },
};
const argsFor = (n: string) => ARGS[n] ?? { comp: "Main", layer: "Card" };

describe("house operation names", () => {
  it("registers the nine house operations as tuift.* in category tuift", () => {
    expect(
      listOps("tuift")
        .map((o) => o.name)
        .sort(),
    ).toEqual(NAMES.map((n) => `tuift.${n}`).sort());
  });

  for (const n of NAMES.filter((x) => x !== "morph")) {
    it(`ae_do tuift.${n} runs and is labelled tuift.${n}`, async () => {
      const t = nullTransport(OK_RESPONSE);
      const r = await doTool.handler({ operation: `tuift.${n}`, args: argsFor(n) }, t);
      expect(r.isError, textOf(r)).toBe(false);
      expect(t.calls[0].label).toBe(`tuift.${n}`);
    });
  }

  it("errors name the operation tuift.*", async () => {
    const r = await doTool.handler(
      { operation: "tuift.mola", args: { comp: "Main" } },
      nullTransport(),
    );
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("INVALID_ARGS");
    expect(textOf(r)).toContain("tuift.mola");
  });

  it("a typo suggests the real name", async () => {
    const r = await doTool.handler({ operation: "tuift.morpg", args: {} }, nullTransport());
    expect(textOf(r)).toContain("UNKNOWN_OPERATION");
    expect(textOf(r)).toContain("tuift.morph");
  });

  it("batch.run accepts tuift.* operations", () => {
    const jsx = getOp("batch.run")!.toJsx({
      ops: [{ operation: "tuift.mola", args: argsFor("mola") }],
    });
    expect(jsx).not.toContain("unknown operation");
  });

  it("AE_MCP_ALLOW_CATEGORIES=tuift allows the house operations", async () => {
    process.env.AE_MCP_ALLOW_CATEGORIES = "tuift";
    const r = await doTool.handler(
      { operation: "tuift.vivo", args: argsFor("vivo") },
      nullTransport(OK_RESPONSE),
    );
    expect(r.isError, textOf(r)).toBe(false);
  });
});

describe("ae_catalog", () => {
  it("lists the tuift category and only operations of the categories this server ships", async () => {
    const r = await catalogTool.handler({}, nullTransport());
    const p = r.structuredContent as {
      categories: Array<{ category: string; operations: string[] }>;
    };
    // Every category here is backed by code in this repository; nothing needs an outside panel or library.
    expect(p.categories.map((c) => c.category).filter((c) => c !== "eval")).toEqual([
      "batch",
      "command",
      "comp",
      "effect",
      "egp",
      "expression",
      "font",
      "footage",
      "instance",
      "item",
      "keyframe",
      "layer",
      "marker",
      "mask",
      "pref",
      "project",
      "property",
      "render",
      "shape",
      "text",
      "timeline",
      "transform",
      "tuift",
      "viewer",
    ]);
    expect(p.categories.flatMap((c) => c.operations)).toContain("tuift.mola");
  });

  it("a category answers with its operations and no legacy note", async () => {
    const r = await catalogTool.handler({ category: "tuift" }, nullTransport());
    expect(r.isError).toBe(false);
    const p = r.structuredContent as {
      category: string;
      operations: Array<{ name: string }>;
      note?: string;
    };
    expect(p.category).toBe("tuift");
    expect(p.operations.map((o) => o.name).sort()).toEqual(NAMES.map((n) => `tuift.${n}`).sort());
    expect(p.note).toBeUndefined();
  });
});

describe("markers in expressions", () => {
  const cam = (expr: string) => ({
    fps: 30,
    w: 1080,
    h: 1080,
    waStart: 0,
    waDur: 4,
    layers: [
      {
        index: 1,
        name: "CAM",
        kind: "camera",
        enabled: true,
        inPoint: 0,
        outPoint: 4,
        props: [{ name: "Position", expr, exprOn: true, keys: [] }],
        otherKeys: [],
        parent: null,
        mb: false,
      },
    ],
  });
  const stillCamera = (d: unknown) =>
    reviewRules(d, DEFAULT_STYLE).some((i) => i.rule === "camera_parada");

  it("review: a camera with the // tuift_vivo tag counts as alive", () => {
    expect(stillCamera(cam("value"))).toBe(true); // no tag, no drift
    expect(stillCamera(cam("// tuift_vivo\nvalue"))).toBe(false);
  });

  it("tuift.vivo writes tuift_vivo and treats a layer already tagged as its own (idempotent)", () => {
    const jsx = getOp("tuift.vivo")!.toJsx({ comp: "Main", layer: "Card" });
    expect(jsx).toContain("// tuift_vivo");
    const helper = /TUIFT\.isVivo = function[^\n]*?\};/.exec(jsx)?.[0];
    expect(helper).toBeDefined();
    const TUIFT: { isVivo?: (e: string) => boolean } = {};
    new Function("TUIFT", helper!)(TUIFT);
    expect(TUIFT.isVivo!("// tuift_vivo\nwiggle(1,2)")).toBe(true);
    expect(TUIFT.isVivo!("wiggle(1,2)")).toBe(false);
    expect(jsx).toContain("!TUIFT.isVivo(pos.expression)");
  });

  it("tuift.camera_viva writes the tuift_vivo tag", () => {
    const jsx = getOp("tuift.camera_viva")!.toJsx({ comp: "Main", layer: "Card" });
    expect(jsx).toContain("// tuift_vivo");
  });

  it("tuift.mola writes the tuift.mola marker comment", () => {
    const mola = getOp("tuift.mola")!.toJsx(argsFor("mola"));
    expect(mola).toContain("// tuift.mola amp");
  });

  it("lessons that mention tuift.mola match its errors", () => {
    const found = matchLessons("tuift.mola failed on layer X");
    expect(found.map((l) => l.id)).toContain("mola-precisa-velocidade");
  });
});
