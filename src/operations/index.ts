// Import all operation modules to trigger their registerOp() calls.
// Add new operation files here.

import { evalRunEnabled } from "../policy.js";
import { listOps, registerOp } from "../registry.js";

import "./layer.js";
import "./keyframe.js";
import "./expression.js";
import "./effect.js";
import "./transform.js";
import "./comp.js";
import "./shape.js";
import "./project.js";
import "./text.js";
import "./mask.js";
import "./command.js";
import "./property.js";
import "./marker.js";
import "./batch.js";
import "./timeline.js";
import "./layer-advanced.js";
import "./render.js";
import "./inspect.js";
import "./footage.js";
import "./item.js";
import "./font.js";
import "./egp.js";
import "./viewer.js";
import "./pref.js";
import "./shape-contents.js";
import "./layout.js";
import "./sample.js";
import "./instance.js";
import "./tuift.js";
import "./morph.js";
import "./pacote.js";
import "./cortex.js";
import "./kit.js";
import "./tracking.js";
import "./tracking-analysis.js";
import "./figma.js";

// Keep saved studio workflows that still use the old tda.* names executable.
for (const op of listOps("tuift")) {
  registerOp({ ...op, name: op.name.replace(/^tuift\./, "tda."), category: "tda" });
}

// eval.run executes arbitrary ExtendScript (file I/O, system.callSystem,
// Socket, …). Opt-in: it enters the registry only when AE_MCP_ENABLE_EVAL=1
// is set and read-only mode is off. `denyOperation` re-checks at call time,
// so policy holds even for a registry that was populated under different env.
if (evalRunEnabled()) {
  await import("./eval.js");
}
