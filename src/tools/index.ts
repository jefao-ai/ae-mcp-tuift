import { z } from "zod";
import { errorResult } from "../errors.js";
import type { ToolEffect } from "../policy.js";
import type { AeTransport } from "../transport/AeTransport.js";
import { resolveTarget } from "../transport/instances.js";
import type { ToolGroup } from "./define-tool.js";
import type { ToolResult } from "./types.js";

import { catalogTool } from "./catalog.js";
import { compInfoTool } from "./comp-info.js";
import { contextTool } from "./context.js";
import { doTool } from "./do.js";
import { layerInfoTool } from "./layer-info.js";
import { projectExportTool } from "./project-export.js";
import { projectImportTool } from "./project-import.js";
import { projectInfoTool } from "./project-info.js";
import { renderFrameTool } from "./render-frame.js";
import { saveProjectTool } from "./save-project.js";
import { versionInfoTool } from "./version-info.js";

// TUIFT additions (src/tuift): eyes, review, house moves, sound, render, safety, docs, lessons.
import { avaliarRenderTool } from "../tuift/avaliar.js";
import { beatsTool } from "../tuift/beats.js";
import { captureWebMotionTool, prepareWebMotionTool } from "../tuift/captura-web-tool.js";
import { checkpointTool } from "../tuift/checkpoint.js";
import { docsTool } from "../tuift/docs.js";
import { expressionsCheckTool } from "../tuift/expressions.js";
import { lessonsTool } from "../tuift/lessons.js";
import { planoCheckTool } from "../tuift/plano.js";
import { renderStatusTool, renderVideoTool } from "../tuift/render.js";
import { reviewMotionTool } from "../tuift/review.js";
import { seeTool } from "../tuift/see.js";
import { getSkillAssetTool, getSkillTool } from "../tuift/skills.js";
import { placeSfxTool, soundCuesTool } from "../tuift/sound.js";

export type AnyTool = {
  name: string;
  title: string;
  description: string;
  group: ToolGroup;
  blockedInReadOnly: boolean;
  effect: ToolEffect;
  strictArgs?: boolean;
  inputShape: z.ZodRawShape;
  handler: (args: any, transport: AeTransport) => Promise<ToolResult>;
};

/**
 * The one argument every AE-touching tool shares: which After Effects
 * instance to talk to. Added here, in one place, rather than in each tool —
 * a tool's own handler never sees it; the transport it receives is already
 * bound to that instance.
 */
export const INSTANCE_PARAM = z
  .string()
  .optional()
  .describe(
    "After Effects instance to address for this call, when several are running (AfterFX.exe -m): " +
      "an instance id (its AE_MCP_INSTANCE at launch, or the `name` given to instance.start) or the name " +
      "of the project file it has open. Omit to use this server's default (AE_MCP_INSTANCE, else the " +
      "single live instance). ae_context and ae_do instance.list show what is live.",
  );

/** Tools that never contact After Effects have no instance to pick. */
const INSTANCE_FREE_TOOLS = new Set([
  "ae_catalog",
  "ae_docs",
  "ae_get_skill",
  "ae_get_skill_asset",
  "ae_lessons",
  "ae_render_status",
  "ae_plano_check",
  "ae_avaliar_render",
  "ae_capturar_movimento_web",
  "ae_preparar_movimento_web",
]);

/**
 * A view of `transport` whose calls go to `instance` unless a call names one
 * itself — a Node-side operation bound to the main instance still has to
 * reach the worker it is starting.
 */
export function bindTransportToInstance(transport: AeTransport, instance: string): AeTransport {
  return {
    execute: (req) => transport.execute({ instance, ...req }),
    describeTarget: () => resolveTarget(instance),
    ...(transport.close ? { close: () => transport.close!() } : {}),
  };
}

/**
 * For tools declaring `strictArgs`: an argument the tool does not know is an
 * error, not a no-op. The server registers these tools with a loose object
 * schema so unknown keys reach this check instead of being stripped.
 */
function withStrictArgs(tool: AnyTool): AnyTool {
  if (!tool.strictArgs) return tool;
  return {
    ...tool,
    handler: async (args: Record<string, unknown> | undefined, transport: AeTransport) => {
      const known = Object.keys(tool.inputShape);
      const unknown = Object.keys(args ?? {}).filter((k) => !known.includes(k));
      if (unknown.length > 0) {
        return errorResult(
          "INVALID_ARGS",
          `${tool.name} does not accept ${unknown.map((k) => `'${k}'`).join(", ")}`,
          {
            details: { unknown, accepted: known },
            hint: `Accepted arguments: ${known.join(", ") || "none"}.`,
          },
        );
      }
      return tool.handler(args, transport);
    },
  };
}

function withInstanceParam(tool: AnyTool): AnyTool {
  if (INSTANCE_FREE_TOOLS.has(tool.name)) return tool;
  return {
    ...tool,
    inputShape: { ...tool.inputShape, instance: INSTANCE_PARAM },
    handler: async (args: Record<string, unknown> | undefined, transport: AeTransport) => {
      const { instance, ...rest } = args ?? {};
      const named = typeof instance === "string" ? instance.trim() : "";
      return tool.handler(rest, named ? bindTransportToInstance(transport, named) : transport);
    },
  };
}

/** Every MCP tool this server exposes, in registration order. */
export const ALL_TOOLS: AnyTool[] = [
  projectInfoTool,
  compInfoTool,
  layerInfoTool,
  renderFrameTool,
  saveProjectTool,
  projectExportTool,
  projectImportTool,
  versionInfoTool,
  catalogTool,
  doTool,
  contextTool,
  getSkillTool,
  getSkillAssetTool,
  seeTool,
  reviewMotionTool,
  expressionsCheckTool,
  soundCuesTool,
  placeSfxTool,
  beatsTool,
  captureWebMotionTool,
  prepareWebMotionTool,
  renderVideoTool,
  renderStatusTool,
  planoCheckTool,
  avaliarRenderTool,
  checkpointTool,
  docsTool,
  lessonsTool,
].map((tool) => withInstanceParam(withStrictArgs(tool as AnyTool)));
