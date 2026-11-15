import { describe, expect, it } from "vitest";

import type { DecodedPng } from "../src/color/png16.js";
import { traceHull } from "../src/operations/morph.js";

function synth(
  w: number,
  h: number,
  inside: (x: number, y: number) => boolean,
  rgb: [number, number, number],
): DecodedPng {
  const color = new Float64Array(w * h * 3);
  const alpha = new Float64Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (!inside(x + 0.5, y + 0.5)) continue;
      const i = y * w + x;
      alpha[i] = 1;
      color.set(rgb, i * 3);
    }
  return { width: w, height: h, rgb: color, alpha, bitDepth: 8 };
}

describe("tuift.morph traceHull", () => {
  it("traces a circle as equal radii around its centre, with its colour", () => {
    const png = synth(200, 200, (x, y) => Math.hypot(x - 120, y - 80) <= 50, [0.1, 0.8, 0.4]);
    const h = traceHull(png, 36)!;
    expect(h.center[0]).toBeCloseTo(120, 0);
    expect(h.center[1]).toBeCloseTo(80, 0);
    for (const p of h.points) expect(Math.hypot(p[0] - 120, p[1] - 80)).toBeGreaterThan(48.5);
    for (const p of h.points) expect(Math.hypot(p[0] - 120, p[1] - 80)).toBeLessThan(51);
    expect(h.color.map((c) => Math.round(c * 10) / 10)).toEqual([0.1, 0.8, 0.4]);
    // first ray points up
    expect(h.points[0][0]).toBeCloseTo(120, 0);
    expect(h.points[0][1]).toBeLessThan(h.center[1]);
  });

  it("a square reaches further on the diagonals; inset shrinks every ray", () => {
    const png = synth(100, 100, (x, y) => x > 20 && x < 80 && y > 20 && y < 80, [0, 0, 0.36]);
    const h = traceHull(png, 8)!;
    const r = h.points.map((p) => Math.hypot(p[0] - h.center[0], p[1] - h.center[1]));
    expect(r[1]).toBeGreaterThan(r[0] * 1.3); // 45° vs straight up
    const hi = traceHull(png, 8, 2)!;
    const ri = hi.points.map((p) => Math.hypot(p[0] - hi.center[0], p[1] - hi.center[1]));
    ri.forEach((v, i) => expect(r[i] - v).toBeCloseTo(2, 0));
  });

  it("returns null for a fully transparent frame", () => {
    expect(
      traceHull(
        synth(10, 10, () => false, [1, 1, 1]),
        12,
      ),
    ).toBeNull();
  });
});
