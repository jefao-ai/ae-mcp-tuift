#!/usr/bin/env node
// Proves the bundle runs from where it is extracted, with no install step:
// extracts it into a temp folder whose path contains a space, starts
// `node dist/index.js` there, does an MCP `initialize` and `tools/list` over
// stdio in both profiles, and stops it. After Effects is never involved.
// Usage: node scripts/verify-bundle.mjs [after-effects-mcp-<version>.tgz]
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = resolve(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const archive = resolve(process.argv[2] ?? join(root, `after-effects-mcp-${pkg.version}.tgz`));
if (!existsSync(archive)) {
  console.error(`${archive} not found. Run npm run bundle first.`);
  process.exit(1);
}

const dest = mkdtempSync(join(tmpdir(), "ae mcp verify "));
let failed = false;
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failed = true;
};

try {
  // Copy the archive next to where it is extracted and use a relative name: GNU tar on
  // Windows reads "C:" in an archive path as a host name and rejects backslashes in -C.
  copyFileSync(archive, join(dest, "bundle.tgz"));
  const x = spawnSync("tar", ["-xzf", "bundle.tgz"], { cwd: dest, stdio: "inherit" });
  rmSync(join(dest, "bundle.tgz"), { force: true });
  check(x.status === 0, `extracted into "${dest}"`);

  const top = readdirSync(dest);
  check(
    top.length === 1 && top[0] === "after-effects-mcp",
    `single top-level folder: ${top.join(", ")}`,
  );
  const dir = join(dest, "after-effects-mcp");
  const inside = readdirSync(dir).toSorted();
  console.log(`     contents: ${inside.join(", ")}`);
  for (const need of [
    "dist",
    "jsx",
    "kit",
    "package.json",
    "LICENSE",
    "NOTICE.md",
    "node_modules",
    "THIRD_PARTY_LICENSES.txt",
  ])
    check(inside.includes(need), `has ${need}`);
  check(!inside.includes("src") && !inside.includes("tests"), "no sources or tests");
  const modules = readdirSync(join(dir, "node_modules"));
  check(
    !["typescript", "vitest", "oxlint", "lefthook", "rimraf", "oxfmt"].some((m) =>
      modules.includes(m),
    ),
    `node_modules is production only (${modules.length} entries)`,
  );

  for (const profile of ["core", "all"]) {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(dir, "dist", "index.js")],
      cwd: dir,
      env: { ...process.env, AE_MCP_TOOLS: profile },
      stderr: "ignore",
    });
    const client = new Client({ name: "verify-bundle", version: "0.0.0" }, { capabilities: {} });
    try {
      await client.connect(transport); // sends initialize
      const info = client.getServerVersion();
      const { tools } = await client.listTools();
      check(
        info?.name === "ae-mcp-tuift" && info?.version === pkg.version && tools.length > 0,
        `${profile}: initialize ok (${info?.name} ${info?.version}), tools/list returned ${tools.length} tools, ${JSON.stringify(tools).length} characters`,
      );
    } catch (err) {
      check(false, `${profile}: ${err instanceof Error ? err.message : err}`);
    } finally {
      await client.close().catch(() => undefined);
    }
  }
} finally {
  rmSync(dest, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
