// ae_expressions_check — assigning `.expression` always "succeeds"; the error
// only shows after evaluation. This walks every expression in one comp (or the
// whole project), forces evaluation at a few times and returns the errors and
// the expressions AE switched off. Expressions that use sourceRectAtTime /
// toComp / fromComp / toWorld / sampleImage are NOT force-evaluated: doing that
// from a script pops the "internal verification failure {no current context}"
// modal (field report, robocon-motion-rmrc) — their last error is read as is.

import { z } from "zod";

import { defineTool } from "../tools/define-tool.js";
import { runJsx, textAndJson } from "./common.js";

const JSX = `
var RISKY = /sourceRectAtTime|toComp|fromComp|toWorld|fromWorld|sampleImage/;
var comps = [];
if (payload.comp !== null) { var one = AE.findCompByNameOrId(payload.comp); if (!one) return { ok: false, error: "no comp matching " + String(payload.comp) }; comps.push(one); }
else { for (var i = 1; i <= app.project.numItems; i++) if (app.project.item(i) instanceof CompItem) comps.push(app.project.item(i)); }
var res = { scanned: 0, errors: [], disabled: [], skippedForce: 0, engine: AE.safeGet(function () { return app.project.expressionEngine; }, null) };
function pathOf(p) { var parts = []; var q = p; var guard = 0; while (q && guard++ < 12) { try { if (q.propertyDepth === 0) break; parts.unshift(q.name); q = q.parentProperty; } catch (e) { break; } } return parts.join(" > "); }
function walk(g, comp, layer, depth) {
  if (!g || depth > 8 || res.scanned > payload.max) return;
  var mn = ""; try { mn = g.matchName; } catch (e) {}
  if (mn === "ADBE Vector Materials Group" || mn === "ADBE Material Options Group") return;
  if (g.propertyType === PropertyType.PROPERTY) {
    var ex = ""; try { ex = (g.canSetExpression ? g.expression : ""); } catch (e1) { ex = ""; }
    if (!ex) return;
    res.scanned++;
    var on = true; try { on = g.expressionEnabled; } catch (e2) {}
    if (on && !RISKY.test(ex) && payload.force) {
      var ts = [layer.inPoint, (layer.inPoint + layer.outPoint) / 2, Math.max(layer.inPoint, layer.outPoint - comp.frameDuration)];
      for (var k = 0; k < ts.length; k++) { try { g.valueAtTime(ts[k], false); } catch (e3) {} }
    } else if (RISKY.test(ex)) res.skippedForce++;
    var err = ""; try { err = g.expressionError || ""; } catch (e4) {}
    var item = { comp: comp.name, layer: layer.name, layerIndex: layer.index, property: pathOf(g), matchName: mn, expression: ex.substr(0, 300) };
    if (err) { item.error = err; res.errors.push(item); }
    else if (!on) res.disabled.push(item);
    return;
  }
  for (var j = 1; j <= g.numProperties; j++) { try { walk(g.property(j), comp, layer, depth + 1); } catch (e5) {} }
}
for (var ci = 0; ci < comps.length; ci++) {
  var c = comps[ci];
  for (var li = 1; li <= c.numLayers; li++) walk(c.layer(li), c, c.layer(li), 0);
}
res.comps = comps.length;
return res;
`;

export const expressionsCheckTool = defineTool({
  name: "ae_expressions_check",
  title: "Check expressions",
  description:
    "Find broken expressions: walks every expression in a comp (or the whole project), forces evaluation at the " +
    "layer's in/mid/out times and reports `expressionError`, plus expressions AE has switched off. Setting an " +
    "expression never fails by itself — run this after writing expressions, renaming comps/layers/effects, or " +
    "importing. Expressions using sourceRectAtTime/toComp/sampleImage are read but not force-evaluated (doing so " +
    "from a script can open a blocking modal).",
  group: "inspect",
  blockedInReadOnly: false,
  effect: "read",
  inputShape: {
    comp: z
      .union([z.string(), z.number()])
      .optional()
      .describe("Comp name or id; omit to scan every comp."),
    force: z
      .boolean()
      .optional()
      .describe("Force evaluation before reading errors (default true)."),
    max: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Stop after this many expressions (default 2000)."),
  },
  handler: async (args, transport) => {
    const r = await runJsx<any>(transport, JSX, "expressions_check", {
      payload: { comp: args.comp ?? null, force: args.force !== false, max: args.max ?? 2000 },
      undoGroup: false,
      timeoutMs: 180_000,
    });
    if (!r.ok) return r.error;
    const v = r.value;
    const head = v.errors.length
      ? `${v.errors.length} expressão(ões) com erro em ${v.scanned} verificadas.`
      : `Nenhum erro em ${v.scanned} expressões.`;
    return textAndJson(v, head + (v.disabled.length ? ` ${v.disabled.length} desligada(s).` : ""));
  },
});
