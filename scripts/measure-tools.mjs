#!/usr/bin/env node
// Size of the MCP tool list (what an agent program pays on every request) in
// each profile, measured over stdio on the built server (run `npm run build`
// first). After Effects is never contacted.
// Usage: node scripts/measure-tools.mjs [--per-tool]
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolve } from "node:path";

const entry = resolve(import.meta.dirname, "..", "dist", "index.js");
const perTool = process.argv.includes("--per-tool");

for (const profile of ["all", "core"]) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    env: { ...process.env, AE_MCP_TOOLS: profile },
    stderr: "ignore",
  });
  const client = new Client({ name: "measure-tools", version: "0.0.0" }, { capabilities: {} });
  await client.connect(transport);
  const { tools } = await client.listTools();
  await client.close();
  const chars = JSON.stringify(tools).length;
  console.log(
    `${profile}: ${tools.length} tools, ${chars} characters, ~${Math.round(chars / 4)} to ${Math.round(chars / 3.5)} tokens (4 to 3.5 characters per token)`,
  );
  if (perTool) {
    for (const t of tools.toSorted((a, b) => JSON.stringify(b).length - JSON.stringify(a).length)) {
      console.log(`  ${String(JSON.stringify(t).length).padStart(6)}  ${t.name}`);
    }
  }
}
