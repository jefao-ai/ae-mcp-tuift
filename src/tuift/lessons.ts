// Lessons journal: a JSONL file (kit/licoes.jsonl by default, TUIFT_LESSONS to
// point elsewhere). Each lesson has a `quando` regex tested
// against a failed tool result; matches are appended to that error, so the
// next agent sees the known fix instead of rediscovering it. ae_lessons lists,
// searches and adds lessons.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { z } from "zod";

import { errorResult } from "../errors.js";
import { defineTool, jsonResult } from "../tools/define-tool.js";
import type { ToolResult } from "../tools/types.js";
import { LESSONS_PATH } from "./common.js";

export interface Lesson {
  id: string;
  quando: string;
  licao: string;
  fonte?: string;
  data?: string;
}

let cache: { raw: string; lessons: Lesson[] } | null = null;

export function loadLessons(): Lesson[] {
  if (!existsSync(LESSONS_PATH)) return [];
  const raw = readFileSync(LESSONS_PATH, "utf8");
  if (cache && cache.raw === raw) return cache.lessons;
  const lessons: Lesson[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("//")) continue;
    try {
      lessons.push(JSON.parse(t));
    } catch {
      /* skip bad line */
    }
  }
  cache = { raw, lessons };
  return lessons;
}

export function matchLessons(text: string, max = 3): Lesson[] {
  const out: Lesson[] = [];
  for (const l of loadLessons()) {
    try {
      const re = new RegExp(l.quando, "i");
      if (re.test(text)) out.push(l);
    } catch {
      /* bad regex */
    }
    if (out.length >= max) break;
  }
  return out;
}

/** Append matching lessons to a failed tool result (no-op on success). */
export function withLessons(result: ToolResult, toolName: string, args: unknown): ToolResult {
  if (!result.isError) return result;
  const text =
    result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n") +
    "\n" +
    toolName +
    "\n" +
    safeJson(args);
  const found = matchLessons(text);
  if (!found.length) return result;
  const block =
    `\nLIÇÕES CONHECIDAS (${path.basename(LESSONS_PATH)}):\n` +
    found.map((l) => `- [${l.id}] ${l.licao}`).join("\n");
  return { ...result, content: [...result.content, { type: "text", text: block }] };
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v).slice(0, 4000);
  } catch {
    return "";
  }
}

export const lessonsTool = defineTool({
  name: "ae_lessons",
  title: "AE lessons journal",
  description:
    "The journal of After Effects lessons (gotchas that cost real effort). `list` or `search` before an " +
    "unfamiliar task; `add` after you solve a problem that will recur (tool fault or AE quirk) — give a regex " +
    "`quando` that matches the error text, so the lesson is attached automatically the next time that error " +
    "appears. Keep each lesson one or two sentences, with the fix.",
  group: "inspect",
  blockedInReadOnly: false,
  effect: "write",
  inputShape: {
    action: z.enum(["list", "search", "add"]),
    query: z.string().optional().describe("For search: words or an error message."),
    lesson: z
      .object({
        id: z.string(),
        quando: z.string(),
        licao: z.string(),
        fonte: z.string().optional(),
      })
      .optional()
      .describe(
        "For add: id (kebab-case), quando (regex on the error text), licao (the fix), fonte.",
      ),
  },
  handler: async (args) => {
    if (args.action === "list")
      return jsonResult({ file: LESSONS_PATH.replace(/\\/g, "/"), lessons: loadLessons() });
    if (args.action === "search") {
      const q = args.query ?? "";
      const byRegex = matchLessons(q, 10);
      const words = q
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 2);
      const byWords = loadLessons().filter((l) =>
        words.some((w) => (l.licao + " " + l.id).toLowerCase().includes(w)),
      );
      const seen = new Set<string>();
      return jsonResult({
        lessons: [...byRegex, ...byWords]
          .filter((l) => !seen.has(l.id) && seen.add(l.id))
          .slice(0, 12),
      });
    }
    if (!args.lesson) return errorResult("INVALID_ARGS", "add needs `lesson`");
    try {
      new RegExp(args.lesson.quando, "i");
    } catch (e) {
      return errorResult("INVALID_ARGS", `bad regex in quando: ${String(e)}`);
    }
    if (loadLessons().some((l) => l.id === args.lesson!.id))
      return errorResult("INVALID_ARGS", `lesson id already exists: ${args.lesson.id}`);
    mkdirSync(path.dirname(LESSONS_PATH), { recursive: true });
    const entry: Lesson = { ...args.lesson, data: new Date().toISOString().slice(0, 10) };
    appendFileSync(LESSONS_PATH, JSON.stringify(entry) + "\n", "utf8");
    return jsonResult({ added: entry.id, file: LESSONS_PATH.replace(/\\/g, "/") });
  },
});
