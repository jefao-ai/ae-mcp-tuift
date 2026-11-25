import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import * as path from "node:path";
import { z } from "zod";

import { errorResult } from "../errors.js";
import { defineTool, jsonResult } from "../tools/define-tool.js";
import { SERVER_ROOT } from "./common.js";
import { lerEnv } from "./env.js";

const manifestSchema = z.object({
  skills: z.array(
    z.object({
      name: z.string(),
      path: z.string(),
      description: z.string(),
      documents: z.record(z.string(), z.string()),
      files: z.record(z.string(), z.unknown()).default({}),
    }),
  ),
});

function containedPath(root: string, ...segments: string[]): string {
  const target = realpathSync(path.resolve(root, ...segments));
  const relative = path.relative(root, target);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(".." + path.sep) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("O arquivo está fora da pasta de habilidades.");
  }
  return target;
}

function loadManifest() {
  const configured = lerEnv("FNF_SKILLS")?.trim();
  const root = realpathSync(
    configured ||
      path.join(
        SERVER_ROOT,
        "node_modules",
        ".tuift-higgsfield",
        "node_modules",
        "fnf-after-effects-mcp",
        "skills",
      ),
  );
  const { skills } = manifestSchema.parse(
    JSON.parse(readFileSync(containedPath(root, "manifest.json"), "utf8")),
  );
  return {
    root,
    skills: skills.filter((skill) => existsSync(path.join(root, skill.path, "SKILL.md"))),
  };
}

export function skillsAvailable(): boolean {
  try {
    return loadManifest().skills.length > 0;
  } catch {
    return false;
  }
}

function skillFile(root: string, relativeRoot: string, file: string): string {
  const skillRoot = containedPath(root, relativeRoot);
  const target = containedPath(skillRoot, file);
  if (!statSync(target).isFile()) throw new Error("O caminho não é um arquivo.");
  return target;
}

export const getSkillTool = defineTool({
  name: "ae_get_skill",
  title: "Get AE workflow",
  description:
    "List installed Higgsfield workflows or read a named workflow and its references. Start native AE work with ae-clean-rig; read only the relevant modules.",
  group: "inspect",
  effect: "read",
  blockedInReadOnly: false,
  inputShape: {
    name: z.string().min(1).optional().describe("Exact workflow name. Omit for the index."),
    reference: z.string().min(1).optional().describe("A reference listed by that workflow."),
  },
  handler: async ({ name, reference }) => {
    if (reference && !name)
      return errorResult("INVALID_ARGS", "Informe a habilidade da referência.");
    try {
      const { root, skills } = loadManifest();
      if (!name) {
        return jsonResult({
          skills: skills.map((s) => ({
            name: s.name,
            description: s.description,
            references: Object.keys(s.documents).filter((key) => key !== "SKILL.md"),
          })),
        });
      }
      const skill = skills.find((s) => s.name === name);
      const file = reference ?? "SKILL.md";
      if (!skill || !Object.hasOwn(skill.documents, file)) {
        return errorResult("INVALID_ARGS", "Habilidade ou referência não encontrada.");
      }
      const body = readFileSync(skillFile(root, skill.path, file), "utf8");
      const index = reference
        ? ""
        : "\n\nReferências: " +
          Object.keys(skill.documents)
            .filter((key) => key !== "SKILL.md")
            .join(", ") +
          "\nArquivos: " +
          Object.keys(skill.files).join(", ");
      return { content: [{ type: "text", text: body + index }] };
    } catch (err) {
      return errorResult("IO", err instanceof Error ? err.message : String(err));
    }
  },
});

export const getSkillAssetTool = defineTool({
  name: "ae_get_skill_asset",
  title: "Get workflow asset path",
  description:
    "Resolve an asset listed in an installed Higgsfield workflow to a local file path for import.",
  group: "inspect",
  effect: "read",
  blockedInReadOnly: false,
  inputShape: {
    name: z.string().min(1).describe("Exact workflow name."),
    asset: z.string().min(1).describe("Asset path as listed in the workflow."),
  },
  handler: async ({ name, asset }) => {
    try {
      const { root, skills } = loadManifest();
      const skill = skills.find((s) => s.name === name);
      if (!skill || !(Object.hasOwn(skill.files, asset) || Object.hasOwn(skill.documents, asset))) {
        return errorResult("INVALID_ARGS", "Arquivo não consta no manifesto da habilidade.");
      }
      return jsonResult({ path: skillFile(root, skill.path, asset).replace(/\\/g, "/") });
    } catch (err) {
      return errorResult("IO", err instanceof Error ? err.message : String(err));
    }
  },
});
