#!/usr/bin/env node
import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { runCli } from "./cli.js";
import { AGENT_INSTALL_CMD, RUNTIME_DIR, instanceTargetFromEnv } from "./config.js";
import { errorResult } from "./errors.js";
import { denyTool, policySummary, readOnlyMode } from "./policy.js";
import { FileIpcTransport } from "./transport/FileIpcTransport.js";

// Load all operations into the registry (must run before catalog/do handle calls).
import "./operations/index.js";
import { ALL_TOOLS, type AnyTool } from "./tools/index.js";
import { withLessons } from "./tuift/lessons.js";
import { docsAvailable } from "./tuift/docs.js";
import { skillsAvailable } from "./tuift/skills.js";
import { buildInstructions } from "./instructions.js";
import { inProfile, toolProfile } from "./tools/profile.js";

// Read the real package version at runtime so the server never self-reports a
// stale literal. dist/index.js sits one level below package.json in both the
// repo and the published tarball.
const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

const transport = new FileIpcTransport();

const { profile, invalid: invalidProfile } = toolProfile();
const hasSkills = skillsAvailable();

// Tools of this session: profile, then the optional docs folder, then read-only mode.
const skipped: string[] = [];
const selected = ALL_TOOLS.filter((tool) => {
  if (!inProfile(tool.name, profile)) return false;
  if (tool.name === "ae_docs" && !docsAvailable()) return false;
  if ((tool.name === "ae_get_skill" || tool.name === "ae_get_skill_asset") && !hasSkills)
    return false;
  if (denyTool(tool.name, tool.blockedInReadOnly)) {
    skipped.push(tool.name);
    return false;
  }
  return true;
});

const server = new McpServer(
  {
    name: "ae-mcp-tuift",
    version,
  },
  { instructions: buildInstructions(new Set(selected.map((t) => t.name))) },
);

/**
 * MCP behaviour hints, derived from each tool's declared `effect` rather than
 * from a name list that has to be kept in sync by hand. `ae_do` declares
 * itself destructive: its real effect depends on the operation it dispatches,
 * and clients that see no annotation at all tend to treat a tool as safe.
 */
function annotationsFor(tool: AnyTool): { readOnlyHint?: boolean; destructiveHint?: boolean } {
  switch (tool.effect) {
    case "read":
      return { readOnlyHint: true };
    case "destructive":
      return { destructiveHint: true };
    case "write":
      return { destructiveHint: false };
  }
}

function register(tool: AnyTool): void {
  server.registerTool(
    tool.name,
    {
      title: tool.title,
      description: tool.description,
      // strictArgs tools must SEE unknown keys to refuse them (a plain shape strips them).
      inputSchema: tool.strictArgs ? z.looseObject(tool.inputShape) : tool.inputShape,
      annotations: annotationsFor(tool),
    },
    async (args: unknown) => {
      try {
        return withLessons(await tool.handler(args as any, transport), tool.name, args);
      } catch (err) {
        // A handler throwing is a bug in this server, not a modelling error —
        // report it under its own code so it is never mistaken for a
        // retryable AE hiccup.
        return errorResult("TRANSPORT", err instanceof Error ? err.message : String(err), {
          details: { tool: tool.name },
          stack: err instanceof Error ? (err.stack ?? null) : null,
        });
      }
    },
  );
}

for (const tool of selected) register(tool);

/** One line on where calls will go, so a misrouted session is visible in the client's server log. */
async function instanceBanner(): Promise<string> {
  const named = instanceTargetFromEnv();
  const target = await transport.describeTarget();
  switch (target.mode) {
    case "pull":
      return `instance: ${target.instance.id} (resident agent${named ? `, AE_MCP_INSTANCE=${named}` : ", the only live one"})`;
    case "push":
      return `instance: none registered yet — calls launch AfterFX.exe -r into the running After Effects (instances started with -m need the agent: ${AGENT_INSTALL_CMD})`;
    case "error":
      return `instance: UNRESOLVED — ${target.message}`;
  }
}

async function main(): Promise<void> {
  // With arguments the binary is a maintenance CLI (install-agent, instances,
  // …), not a server. MCP clients never pass any.
  const argv = process.argv.slice(2);
  if (argv.length > 0) {
    process.exitCode = await runCli(argv);
    return;
  }

  if (invalidProfile !== null) {
    console.error(
      `[mcp-aftereffects] AE_MCP_TOOLS=${invalidProfile} is not a profile (use core or all); using all.`,
    );
  }
  console.error(`[mcp-aftereffects] policy: ${policySummary()}`);
  console.error(`[mcp-aftereffects] tool profile: ${profile} (${selected.length} tools)`);
  console.error(`[mcp-aftereffects] mailbox: ${RUNTIME_DIR}`);
  console.error(`[mcp-aftereffects] ${await instanceBanner()}`);
  if (readOnlyMode()) {
    console.error(
      `[mcp-aftereffects] read-only mode — ${skipped.length > 0 ? `tools withheld: ${skipped.join(", ")}; ` : ""}` +
        "ae_do accepts only operations that cannot modify the project.",
    );
  } else {
    console.error(
      "[mcp-aftereffects] WRITE ACCESS IS ON — tools can create, mutate and delete project content. " +
        "Set AE_MCP_READONLY=1 for inspection-only sessions.",
    );
  }
  const stdio = new StdioServerTransport();
  await server.connect(stdio);
}

main().catch((err) => {
  process.stderr.write(`mcp-aftereffects fatal: ${err && err.stack ? err.stack : String(err)}\n`);
  process.exit(1);
});
