import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { capturarMovimentoWeb, converterCapturaAE } from "../src/tuift/captura-web.js";

const root = process.env.TUIFT_PLAYWRIGHT_ROOT;
const fixture = (name: string) => pathToFileURL(path.join(process.cwd(), "fixtures", name)).href;

describe.skipIf(!root)("captura web no Chromium existente", () => {
  it("captura rotações CSS individuais, pivô e deslocamento em tempos exatos", async () => {
    const out = await capturarMovimentoWeb({
      url: fixture("captura-web.html"),
      selector: "#card",
      viewport: [320, 180],
      fps: 30,
      duration: 1.1,
      playwrightRoot: root,
    });
    const conversion = converterCapturaAE(out, [80, 60]);
    const last = conversion.samples.at(-1)!;
    expect(out.animations.count).toBe(2);
    expect(out.samples).toHaveLength(34);
    expect(last.anchor[0]).toBeCloseTo(40, 5);
    expect(last.anchor[1]).toBeCloseTo(60, 5);
    expect(last.rotation).toBeCloseTo(30, 3);
    expect(last.opacity).toBeCloseTo(100, 4);
    expect(conversion.maxCornerError).toBeLessThan(0.001);
  }, 30000);

  it("recusa página que continua se movendo quando o relógio CSS está parado", async () => {
    await expect(
      capturarMovimentoWeb({
        url: fixture("captura-web-js-instavel.html"),
        selector: "#card",
        viewport: [320, 180],
        fps: 30,
        duration: 1,
        playwrightRoot: root,
      }),
    ).rejects.toThrow(/mudou com o relógio CSS parado/);
  }, 30000);
});
