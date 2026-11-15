// AE_MCP_TOOLS=core|all, the optional ae_docs tool, and outside programs that
// are not installed. Everything runs over the real stdio server and never
// reaches After Effects.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import "../src/operations/index.js";
import { ALL_TOOLS } from "../src/tools/index.js";
import { CORE_TOOLS, inProfile, toolProfile } from "../src/tools/profile.js";
import { programFailure, run } from "../src/tuift/common.js";
import { McpTestClient } from "./harness.js";

/** Tools that need Python, a browser, ffmpeg-based workflows, an outside reviewer or a docs folder. */
const OUTSIDE = [
  "ae_place_sfx",
  "ae_beats",
  "ae_capturar_movimento_web",
  "ae_avaliar_render",
  "ae_docs",
];

const names = (r: { tools: Array<{ name: string }> }) => r.tools.map((t) => t.name).toSorted();

describe("toolProfile()", () => {
  it("defaults to all and reads core", () => {
    expect(toolProfile({})).toEqual({ profile: "all", invalid: null });
    expect(toolProfile({ AE_MCP_TOOLS: "all" }).profile).toBe("all");
    expect(toolProfile({ AE_MCP_TOOLS: " CORE " })).toEqual({ profile: "core", invalid: null });
  });

  it("falls back to all on an unknown value and reports it", () => {
    expect(toolProfile({ AE_MCP_TOOLS: "tiny" })).toEqual({ profile: "all", invalid: "tiny" });
  });

  it("core is a strict subset of the real tools and leaves out the outside-program tools", () => {
    const all = new Set(ALL_TOOLS.map((t) => t.name));
    for (const n of CORE_TOOLS) expect(all.has(n), `${n} is a real tool`).toBe(true);
    expect(CORE_TOOLS.size).toBeLessThan(all.size);
    for (const n of OUTSIDE) expect(inProfile(n, "core"), n).toBe(false);
    for (const n of OUTSIDE) expect(inProfile(n, "all"), n).toBe(true);
  });
});

describe("mcp server, AE_MCP_TOOLS=all (default)", () => {
  const client = new McpTestClient();
  beforeAll(() => client.connect({ AE_MCP_TOOLS: "" }));
  afterAll(() => client.close());

  it("registers every tool except ae_docs, which waits for TUIFT_DOCS_DIR", async () => {
    const got = names(await client.listTools());
    expect(got).toEqual(
      ALL_TOOLS.map((t) => t.name)
        .filter((n) => n !== "ae_docs")
        .toSorted(),
    );
  });
});

describe("mcp server, AE_MCP_TOOLS=core", () => {
  const client = new McpTestClient();
  beforeAll(() => client.connect({ AE_MCP_TOOLS: "core" }));
  afterAll(() => client.close());

  it("registers exactly the core tools", async () => {
    expect(names(await client.listTools())).toEqual([...CORE_TOOLS].toSorted());
  });

  it("keeps what needs only After Effects (or nothing) and drops what needs outside programs", async () => {
    const got = names(await client.listTools());
    for (const n of [
      "ae_do",
      "ae_catalog",
      "ae_see",
      "ae_review_motion",
      "ae_plano_check",
      "ae_checkpoint",
      "ae_render_video",
      "ae_render_status",
      "ae_render_frame",
      "ae_lessons",
    ])
      expect(got, n).toContain(n);
    for (const n of OUTSIDE) expect(got, n).not.toContain(n);
  });

  it("still answers ae_catalog (the operations are unaffected by the profile)", async () => {
    const payload = await client.call<{ totalOperations: number }>("ae_catalog");
    expect(payload.totalOperations).toBeGreaterThan(200);
  });
});

async function size(env: Record<string, string>): Promise<number> {
  const c = new McpTestClient();
  await c.connect(env);
  try {
    return JSON.stringify((await c.listTools()).tools).length;
  } finally {
    await c.close();
  }
}

describe("tool list size", () => {
  it("core is clearly smaller than all", async () => {
    const all = await size({ AE_MCP_TOOLS: "all" });
    const core = await size({ AE_MCP_TOOLS: "core" });
    expect(core).toBeLessThan(all * 0.9);
  });
});

describe("mcp server with TUIFT_DOCS_DIR", () => {
  let dir = "";
  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "ae-mcp-docs-"));
    const guide = path.join(dir, "after-effects-scripting-guide", "docs");
    mkdirSync(guide, { recursive: true });
    writeFileSync(
      path.join(guide, "layer.md"),
      "### Layer.hasVideo\n\nTrue when the layer has video.\n",
    );
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("registers ae_docs when the folder exists, and searches it", async () => {
    const c = new McpTestClient();
    await c.connect({ TUIFT_DOCS_DIR: dir });
    try {
      expect(names(await c.listTools())).toContain("ae_docs");
      const res = await c.callRaw("ae_docs", { query: "hasVideo" });
      expect(res.content.map((p) => String(p.text ?? "")).join("\n")).toContain("Layer.hasVideo");
    } finally {
      await c.close();
    }
  });

  it("does not register ae_docs when the folder does not exist", async () => {
    const c = new McpTestClient();
    await c.connect({ TUIFT_DOCS_DIR: path.join(dir, "nope") });
    try {
      expect(names(await c.listTools())).not.toContain("ae_docs");
    } finally {
      await c.close();
    }
  });
});

describe("outside programs that are not installed", () => {
  const missing = path.join(os.tmpdir(), "ae-mcp-no-such-dir", "ffmpeg-nope.exe");
  const client = new McpTestClient();
  let tmp = "";
  beforeAll(async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "ae-mcp-miss-"));
    await client.connect({
      TUIFT_FFMPEG: missing,
      TUIFT_FFPROBE: path.join(path.dirname(missing), "ffprobe-nope.exe"),
      TUIFT_PYTHON: path.join(path.dirname(missing), "python-nope.exe"),
      TUIFT_WORK_DIR: tmp,
    });
  });
  afterAll(async () => {
    await client.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("ae_place_sfx without ffmpeg is a readable error and the server stays up", async () => {
    const text = await client.callExpectError("ae_place_sfx", {
      comp: "Main",
      items: [{ file: path.join(tmp, "pop.wav"), at: 1 }],
    });
    expect(text).toContain("[IO]");
    expect(text).toContain("ffmpeg-nope.exe was not found");
    expect(text).toContain("TUIFT_FFMPEG");
    // The old behaviour was an unhandled 'error' event that killed the process.
    const payload = await client.call<{ totalOperations: number }>("ae_catalog");
    expect(payload.totalOperations).toBeGreaterThan(0);
  });

  it("ae_beats without Python is a readable error", async () => {
    const text = await client.callExpectError("ae_beats", { file: path.join(tmp, "song.wav") });
    expect(text).toContain("python-nope.exe was not found");
    expect(text).toContain("TUIFT_PYTHON");
  });

  it("ae_avaliar_render without ffprobe/ffmpeg is a readable error", async () => {
    const video = path.join(tmp, "clip.mp4");
    writeFileSync(video, "not really a video");
    const text = await client.callExpectError("ae_avaliar_render", {
      video,
      outDir: path.join(tmp, "avaliacao"),
    });
    expect(text).toContain("was not found");
    const payload = await client.call<{ totalOperations: number }>("ae_catalog");
    expect(payload.totalOperations).toBeGreaterThan(0);
  });
});

describe("run() and programFailure()", () => {
  it("a program that does not exist gives code 127 and a message, not a throw", async () => {
    const r = await run(path.join(os.tmpdir(), "definitely-not-a-program-xyz"), ["-v"]);
    expect(r.code).toBe(127);
    expect(r.stderr).toContain("was not found");
  });

  it("names the variable to set for ffmpeg and python", () => {
    const e = Object.assign(new Error("spawn ffmpeg ENOENT"), { code: "ENOENT" });
    expect(programFailure("ffmpeg", e)).toContain("TUIFT_FFMPEG");
    expect(programFailure("python", e)).toContain("TUIFT_PYTHON");
    expect(programFailure("other", e)).toBe(
      'other was not found on this computer (looked for "other").',
    );
    expect(programFailure("x", Object.assign(new Error("denied"), { code: "EACCES" }))).toContain(
      "could not be started",
    );
  });
});
