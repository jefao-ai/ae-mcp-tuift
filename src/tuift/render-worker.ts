// Detached render worker: ae_render_video writes job-spec.json and starts this
// file with `node render-worker.js <job-spec.json>`, so the render keeps going
// after the MCP server that launched it exits. The job reports through its
// job.json, which ae_render_status reads from any server session.

import { readFileSync } from "node:fs";

import { runJob, type JobOpts } from "./render.js";

const specFile = process.argv[2];
if (!specFile) {
  process.stderr.write("usage: render-worker.js <job-spec.json>\n");
  process.exit(2);
}
const spec = JSON.parse(readFileSync(specFile, "utf8")) as {
  job: Parameters<typeof runJob>[0];
  opts: JobOpts;
};
spec.job.pid = process.pid;
await runJob(spec.job, spec.opts, true);
