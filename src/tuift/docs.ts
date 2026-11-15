// ae_docs — offline lookup in the docsforadobe guides (After Effects
// Scripting Guide + Expression Reference) that YOU cloned into a folder of your
// own (TUIFT_DOCS_DIR). The guides are not redistributed with this server, so the
// tool is only registered when that folder exists (see docsAvailable). The guides
// have no llms.txt; their Markdown sources split cleanly on headings
// ("### Class.member"), so a small section index with term scoring is enough.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import * as path from "node:path";
import { z } from "zod";

import { errorResult } from "../errors.js";
import { defineTool } from "../tools/define-tool.js";
import { DOCS_DIR, textAndJson } from "./common.js";

interface Section {
  guide: string;
  file: string;
  heading: string;
  body: string;
  added?: string;
}

let INDEX: Section[] | null = null;

const GUIDES: Record<string, string> = {
  scripting: "after-effects-scripting-guide",
  expressions: "after-effects-expression-reference",
};

/** True when TUIFT_DOCS_DIR points at an existing folder. */
export function docsAvailable(): boolean {
  return DOCS_DIR !== null && existsSync(DOCS_DIR);
}

function walk(dir: string, out: string[]): void {
  for (const n of readdirSync(dir)) {
    const p = path.join(dir, n);
    if (statSync(p).isDirectory()) {
      if (!n.startsWith(".")) walk(p, out);
    } else if (n.endsWith(".md")) out.push(p);
  }
}

function buildIndex(): Section[] {
  const all: Section[] = [];
  if (DOCS_DIR === null) return all;
  for (const [guide, folder] of Object.entries(GUIDES)) {
    const root = path.join(DOCS_DIR, folder, "docs");
    if (!existsSync(root)) continue;
    const files: string[] = [];
    walk(root, files);
    for (const f of files) {
      const rel = path.relative(root, f).replace(/\\/g, "/");
      const lines = readFileSync(f, "utf8").split(/\r?\n/);
      let cur: Section | null = null;
      for (const line of lines) {
        const m = line.match(/^(#{1,3})\s+(.*)$/);
        if (m) {
          if (cur) all.push(cur);
          cur = { guide, file: rel, heading: m[2].replace(/\u0060/g, "").trim(), body: "" };
        } else if (cur) {
          cur.body += line + "\n";
          const v = line.match(
            /(?:added|Added|introduced) in After Effects ([\d.]+)|After Effects (\d{2}\.\d)(?: \(\d{4}\))? and later/,
          );
          if (v && !cur.added) cur.added = v[1] ?? v[2];
        }
      }
      if (cur) all.push(cur);
    }
  }
  return all;
}

function score(s: Section, terms: string[]): number {
  const h = s.heading.toLowerCase();
  const b = s.body.toLowerCase();
  let sc = 0;
  for (const t of terms) {
    if (h === t) sc += 30;
    if (h.includes(t)) sc += 10;
    const hits = b.split(t).length - 1;
    sc += Math.min(hits, 10);
  }
  if (terms.length > 1 && terms.every((t) => h.includes(t) || b.includes(t))) sc += 8;
  return sc;
}

export const docsTool = defineTool({
  name: "ae_docs",
  title: "AE scripting docs (offline)",
  description:
    "Search the After Effects Scripting Guide and Expression Reference offline (your own docsforadobe clones, TUIFT_DOCS_DIR). Use it " +
    "before writing ExtendScript you are not sure about: exact member names, argument order, enum values, which AE " +
    "version added an API (e.g. CharacterRange 24.3, addVariableFontAxis 26.0, ParametricMesh 26.3). Returns the " +
    "best matching sections. Remember: scripts are ES3; expressions use the JavaScript engine.",
  group: "inspect",
  blockedInReadOnly: false,
  effect: "read",
  inputShape: {
    query: z
      .string()
      .min(2)
      .describe(
        "Words to find, e.g. 'setTemporalEaseAtKey', 'TextDocument justification', 'sourceRectAtTime'.",
      ),
    guide: z.enum(["scripting", "expressions", "both"]).optional().describe("Default both."),
    max: z.number().int().min(1).max(10).optional().describe("Sections to return (default 4)."),
  },
  handler: async (args) => {
    if (!INDEX) INDEX = buildIndex();
    if (!INDEX.length) {
      return errorResult("IO", `docs mirror not found in ${DOCS_DIR}`, {
        hint: "Clone docsforadobe/after-effects-scripting-guide and docsforadobe/after-effects-expression-reference side by side and set TUIFT_DOCS_DIR to the folder that holds both.",
      });
    }
    const terms = args.query
      .toLowerCase()
      .split(/[\s,()]+/)
      .filter((t) => t.length > 1);
    const pool =
      args.guide && args.guide !== "both" ? INDEX.filter((s) => s.guide === args.guide) : INDEX;
    const top = pool
      .map((s) => ({ s, sc: score(s, terms) }))
      .filter((x) => x.sc > 0)
      .sort((a, b) => b.sc - a.sc)
      .slice(0, args.max ?? 4);
    const text = top
      .map(
        ({ s }) =>
          "## " +
          s.heading +
          "  (" +
          s.guide +
          ": " +
          s.file +
          (s.added ? " · AE " + s.added + "+" : "") +
          ")\n" +
          s.body.trim().slice(0, 2200),
      )
      .join("\n\n---\n\n");
    if (!top.length)
      return textAndJson(
        { query: args.query, results: 0 },
        "Nada encontrado; tente outros termos (nome do método ou da classe).",
      );
    return { content: [{ type: "text", text }], isError: false };
  },
});
