// Run ae_render_video and follow it until it finishes (the job lives in this process).
// Usage: node scripts/tuift-render-job.mjs '<json args of ae_render_video>'
import * as path from "node:path";
import { fileURLToPath } from "node:url";

process.env.AE_MCP_EXE ??=
  "C:\\Program Files\\Adobe\\Adobe After Effects 2026\\Support Files\\AfterFX.exe";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const url = (p) => "file:///" + path.join(ROOT, p).split(path.sep).join("/");
await import(url("dist/operations/index.js"));
const { ALL_TOOLS } = await import(url("dist/tools/index.js"));
const { FileIpcTransport } = await import(url("dist/transport/FileIpcTransport.js"));
const tr = new FileIpcTransport();
const tool = (n) => ALL_TOOLS.find((t) => t.name === n);
const args = JSON.parse(process.argv[2]);
const r = await tool("ae_render_video").handler(args, tr);
console.log(r.content[0].text.split("\n")[0]);
const id = r.structuredContent?.jobId;
const t0 = Date.now();
while (id) {
  await new Promise((res) => setTimeout(res, 5000));
  const s = await tool("ae_render_status").handler({ jobId: id }, tr);
  const j = s.structuredContent;
  if (j.status !== "running") {
    console.log(
      JSON.stringify(
        {
          status: j.status,
          final: j.final,
          error: j.error,
          checks: j.checks,
          chunks: j.chunks.map((c) => [c.s, c.e, c.code, c.seconds]),
        },
        null,
        1,
      ),
    );
    break;
  }
  console.log(
    `... ${j.chunks.filter((c) => c.code !== undefined).length}/${j.chunks.length} (${Math.round((Date.now() - t0) / 1000)} s)`,
  );
}
process.exit(0);
