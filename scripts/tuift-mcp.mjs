// Entry that starts the server with eval.run enabled (for builders that need ExtendScript).
// Equivalent to: AE_MCP_ENABLE_EVAL=1 node dist/index.js
process.env.AE_MCP_ENABLE_EVAL ||= "1";
await import("../dist/index.js");
