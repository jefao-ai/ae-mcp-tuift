// Call one tool of this server directly (no MCP client), for debugging.
// Usage: node scripts/tuift-call.mjs <tool> '<json args>'   e.g.
//   node scripts/tuift-call.mjs ae_do '{"operation":"comp.sample","args":{...}}'
import * as path from "node:path";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

process.env.AE_MCP_ENABLE_EVAL ??= "1";
process.env.AE_MCP_EXE ??=
  "C:\\Program Files\\Adobe\\Adobe After Effects 2026\\Support Files\\AfterFX.exe";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const url = (p) => "file:///" + path.join(ROOT, p).replace(/\\/g, "/");
await import(url("dist/operations/index.js"));
const { ALL_TOOLS } = await import(url("dist/tools/index.js"));
const { FileIpcTransport } = await import(url("dist/transport/FileIpcTransport.js"));
const { withLessons } = await import(url("dist/tuift/lessons.js"));
const [name, json] = process.argv.slice(2);
const t = ALL_TOOLS.find((x) => x.name === name);
if (!t) {
  console.error("unknown tool", name);
  process.exit(2);
}
const { readFileSync } = await import("node:fs");
const args = json
  ? JSON.parse(json.startsWith("@") ? readFileSync(json.slice(1), "utf8") : json)
  : {};
const r = withLessons(await t.handler(args, new FileIpcTransport()), name, args);
for (const c of r.content) {
  if (c.type === "image") {
    const f = path.join(ROOT, "teste", "out", `call-${Date.now()}.jpg`);
    writeFileSync(f, Buffer.from(c.data, "base64"));
    console.log("[image] " + f);
  } else console.log(c.text);
}
process.exit(r.isError ? 1 : 0);
