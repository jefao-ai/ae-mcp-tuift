// Tool profiles. Every registered tool is paid for on every request by agent
// programs that send the whole tool list each time (about 10,000 tokens for all
// of them), so AE_MCP_TOOLS=core registers only the tools that need nothing but
// After Effects itself (plus the few that need nothing at all).
//
//   all  (default) every tool.
//   core           no tool that needs Python, a browser, ffmpeg-only workflows,
//                  an external reviewer or a documentation folder of your own.

export type ToolProfile = "core" | "all";

/**
 * Tools of the `core` profile: they work with After Effects alone (reading,
 * saving, ae_do, looking at the comp, reviewing the motion, checkpoints,
 * rendering and its status) or with nothing (ae_catalog, ae_plano_check,
 * ae_lessons, ae_render_status, ae_preparar_movimento_web).
 */
export const CORE_TOOLS: ReadonlySet<string> = new Set([
  "ae_project_info",
  "ae_comp_info",
  "ae_layer_info",
  "ae_render_frame",
  "ae_save_project",
  "ae_project_export_json",
  "ae_project_import_json",
  "ae_version_info",
  "ae_catalog",
  "ae_do",
  "ae_context",
  "ae_see",
  "ae_review_motion",
  "ae_expressions_check",
  "ae_sound_cues",
  "ae_render_video",
  "ae_render_status",
  "ae_plano_check",
  "ae_checkpoint",
  "ae_lessons",
  "ae_preparar_movimento_web",
]);

/** Reads AE_MCP_TOOLS. An unknown value falls back to `all` and is reported in `invalid`. */
export function toolProfile(env: NodeJS.ProcessEnv = process.env): {
  profile: ToolProfile;
  invalid: string | null;
} {
  const raw = env.AE_MCP_TOOLS?.trim().toLowerCase();
  if (!raw || raw === "all") return { profile: "all", invalid: null };
  if (raw === "core") return { profile: "core", invalid: null };
  return { profile: "all", invalid: env.AE_MCP_TOOLS!.trim() };
}

/** True when `name` is registered under `profile`. */
export function inProfile(name: string, profile: ToolProfile): boolean {
  return profile === "all" || CORE_TOOLS.has(name);
}
