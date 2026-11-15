// ae_checkpoint — save points for the .aep before risky work (JUNKDOGE
// ae_checkpoint/ae_revert, tzdwindows snapshots). create: saves the project
// and copies it to <project dir>/_checkpoints/. list: shows them. revert:
// checkpoints the current state first ("antes-de-reverter"), then opens the
// chosen checkpoint and saves it back over the project's own path, so the
// project keeps its name and location.

import { existsSync, mkdirSync, promises as fs } from "node:fs";
import * as path from "node:path";
import { z } from "zod";

import { errorResult } from "../errors.js";
import { defineTool } from "../tools/define-tool.js";
import type { AeTransport } from "../transport/AeTransport.js";
import { runJsx, slug, stamp, textAndJson } from "./common.js";

async function currentProject(transport: AeTransport, save: boolean) {
  return runJsx<{ path: string; dirty: boolean }>(
    transport,
    `if (!app.project.file) return { ok: false, error: "the project has never been saved; save it first (ae_save_project with a path)" };
     if (${save ? "true" : "false"}) app.project.save();
     return { path: app.project.file.fsName.replace(/\\\\/g, "/"), dirty: app.project.dirty };`,
    "checkpoint_project",
    { undoGroup: false },
  );
}

function cpDir(project: string): string {
  return path.join(path.dirname(project), "_checkpoints");
}

async function makeCheckpoint(project: string, label: string): Promise<string> {
  const dir = cpDir(project);
  mkdirSync(dir, { recursive: true });
  const stem = path.basename(project, ".aep");
  const file = path.join(dir, `${stem}__${stamp()}__${slug(label)}.aep`);
  await fs.copyFile(project, file);
  return file;
}

export const checkpointTool = defineTool({
  name: "ae_checkpoint",
  title: "Project checkpoints",
  description:
    "Save points for the open .aep. `create` (before a structural change, a big batch or a rebuild) saves the " +
    "project and copies it to <project folder>/_checkpoints/. `list` shows them. `revert` first checkpoints the " +
    "current state, then restores the chosen checkpoint over the project file and reopens it. AE undo is per call " +
    "and a batch is not transactional — checkpoints are the real safety net.",
  group: "document",
  blockedInReadOnly: true,
  effect: "write",
  inputShape: {
    action: z.enum(["create", "list", "revert"]),
    label: z.string().optional().describe("Short label for create (e.g. antes-da-cena-3)."),
    checkpoint: z
      .string()
      .optional()
      .describe("For revert: file name (or full path) from `list`; default the newest."),
  },
  handler: async (args, transport) => {
    const cur = await currentProject(transport, args.action !== "list");
    if (!cur.ok) return cur.error;
    const project = cur.value.path;
    const dir = cpDir(project);
    const listAll = async () =>
      existsSync(dir)
        ? (await fs.readdir(dir))
            .filter((f) => f.toLowerCase().endsWith(".aep"))
            .sort()
            .reverse()
        : [];

    if (args.action === "create") {
      const file = await makeCheckpoint(project, args.label ?? "checkpoint");
      return textAndJson({ checkpoint: file.replace(/\\/g, "/") }, "Checkpoint criado.");
    }
    if (args.action === "list") {
      return textAndJson({
        project,
        folder: dir.replace(/\\/g, "/"),
        checkpoints: await listAll(),
      });
    }
    const all = await listAll();
    const pick = args.checkpoint ?? all[0];
    if (!pick) return errorResult("INVALID_ARGS", "no checkpoints for this project");
    const src = path.isAbsolute(pick) ? pick : path.join(dir, pick);
    if (!existsSync(src)) return errorResult("INVALID_ARGS", `checkpoint not found: ${pick}`);
    const safety = await makeCheckpoint(project, "antes-de-reverter");
    await fs.copyFile(src, project);
    const reopen = await runJsx(
      transport,
      `app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES);
       app.open(new File(${JSON.stringify(project)}));
       return { ok: true, project: app.project.file ? app.project.file.fsName : null };`,
      "checkpoint_revert",
      { undoGroup: false, timeoutMs: 300_000 },
    );
    if (!reopen.ok) return reopen.error;
    return textAndJson(
      { restored: path.basename(src), project, safetyCheckpoint: safety.replace(/\\/g, "/") },
      `Projeto revertido para ${path.basename(src)}. O estado anterior ficou em ${path.basename(safety)}.`,
    );
  },
});
