// Render and wait in ONE process (ae_render_status keeps jobs in memory).
// Usage: node scripts/tuift-render-wait.mjs '<ae_render_video json>'
import * as path from "node:path";
import { fileURLToPath } from "node:url";
process.env.AE_MCP_ENABLE_EVAL ??= "1";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const url = (p) => "file:///" + path.join(ROOT, p).split(path.sep).join("/");
await import(url("dist/operations/index.js"));
const { ALL_TOOLS } = await import(url("dist/tools/index.js"));
const { FileIpcTransport } = await import(url("dist/transport/FileIpcTransport.js"));
const t = new FileIpcTransport();
const get = (n) => ALL_TOOLS.find((x) => x.name === n);
const r = await get("ae_render_video").handler(JSON.parse(process.argv[2]), t);
const txt = r.content.map((c) => c.text ?? "").join("\n");
const jobId = (txt.match(/"jobId":\s*"([^"]+)"/) ?? [])[1];
if (!jobId) {
  console.log(txt);
  process.exit(1);
}
for (;;) {
  await new Promise((res) => setTimeout(res, 3000));
  const s = await get("ae_render_status").handler({ jobId }, t);
  const st = s.content.map((c) => c.text ?? "").join("\n");
  if (/"status":\s*"(done|failed|error)"/.test(st)) {
    console.log(st);
    process.exit(/"done"/.test(st) ? 0 : 1);
  }
}
