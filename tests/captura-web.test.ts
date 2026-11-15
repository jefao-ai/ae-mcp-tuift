import { describe, expect, it } from "vitest";
import {
  converterCapturaAE,
  converterQuadroAE,
  prepararLoteAE,
  type Point,
  type WebCapture,
  type WebSample,
} from "../src/tuift/captura-web.js";
import { redactCaptureError } from "../src/tuift/captura-web-tool.js";

function sample(angle: number, time = 0, options: { sx?: number; sy?: number } = {}): WebSample {
  const w = 200,
    h = 100,
    anchor: Point = [100, 100],
    position: Point = [320, 240];
  const sx = options.sx ?? 0.8,
    sy = options.sy ?? 1.2;
  const co = Math.cos((angle * Math.PI) / 180),
    si = Math.sin((angle * Math.PI) / 180);
  const p = (x: number, y: number): Point => [
    position[0] + co * sx * (x - anchor[0]) - si * sy * (y - anchor[1]),
    position[1] + si * sx * (x - anchor[0]) + co * sy * (y - anchor[1]),
  ];
  return {
    time,
    quad: [p(0, 0), p(w, 0), p(w, h), p(0, h)],
    cssSize: [100, 50],
    cssOrigin: [50, 50],
    opacity: 0.7,
    individualRotate: `${angle}deg`,
    individualTranslate: "none",
    individualScale: "none",
  };
}

describe("captura web para AE", () => {
  it("remove tokens da URL dos erros de captura", () => {
    const url = "https://example.test/?token=segredo%2Fab&pagina=2";
    const safe = redactCaptureError(`falhou ${url}; valor segredo/ab`, url);
    expect(safe).not.toContain("segredo");
    expect(safe).toContain("redigido");
    expect(safe).toContain("pagina=2");
  });
  it("recupera posição, pivô, rotação, escala e opacidade em uma peça rotacionada", () => {
    const x = converterQuadroAE(sample(27), [200, 100]);
    expect(x.anchor[0]).toBeCloseTo(100, 8);
    expect(x.anchor[1]).toBeCloseTo(100, 8);
    expect(x.position[0]).toBeCloseTo(320, 8);
    expect(x.position[1]).toBeCloseTo(240, 8);
    expect(x.scale[0]).toBeCloseTo(80, 8);
    expect(x.scale[1]).toBeCloseTo(120, 8);
    expect(x.rotation).toBeCloseTo(27, 8);
    expect(x.opacity).toBeCloseTo(70, 8);
    expect(x.cornerError).toBeLessThan(1e-9);
  });

  it("mantém continuidade na passagem de 180 graus e suporta espelhamento", () => {
    const input: WebCapture = {
      version: 1,
      source: { url: "file:///test", selector: "#a", viewport: [640, 480], fps: 30, duration: 1 },
      clock: "css-waapi",
      animations: { count: 1, names: ["test"] },
      warnings: [],
      samples: [sample(179, 0, { sy: -1.2 }), sample(-179, 1 / 30, { sy: -1.2 })],
    };
    const out = converterCapturaAE(input, [200, 100]);
    expect(out.samples[0].rotation).toBeCloseTo(179, 8);
    expect(out.samples[1].rotation).toBeCloseTo(181, 8);
    expect(out.samples[1].scale[1]).toBeCloseTo(-120, 8);
  });

  it("recusa perspectiva e cisalhamento que uma camada 2D não reproduz", () => {
    const perspective = sample(0);
    perspective.quad[2][0] += 4;
    expect(() => converterQuadroAE(perspective, [200, 100])).toThrow(/perspectiva/);
    const shear = sample(0);
    shear.quad[3][0] += 12;
    shear.quad[2][0] += 12;
    expect(() => converterQuadroAE(shear, [200, 100])).toThrow(/cisalhamento/);
  });

  it("gera lote com pré-checagem, sem apagar keys e com interpolação linear", () => {
    const input: WebCapture = {
      version: 1,
      source: { url: "file:///test", selector: "#a", viewport: [640, 480], fps: 30, duration: 1 },
      clock: "css-waapi",
      animations: { count: 1, names: ["test"] },
      warnings: [],
      samples: [sample(0, 0), sample(10, 1 / 30)],
    };
    const conversion = converterCapturaAE(input, [200, 100]);
    const batch = prepararLoteAE(conversion, {
      comp: "Teste",
      layer: "Fonte",
      sourceSize: [200, 100],
    });
    expect(batch.operation).toBe("batch.run");
    expect(batch.args.stopOnError).toBe(true);
    expect(batch.args.ops).toHaveLength(6);
    const preflight = batch.args.ops[0] as { args: { code: string } };
    expect(preflight.args.code).toContain("p.numKeys||p.expressionEnabled");
    const position = batch.args.ops[2] as {
      args: { interp: string; spatialTangents: string; replace: boolean; keys: unknown[] };
    };
    expect(position.args.interp).toBe("linear");
    expect(position.args.spatialTangents).toBe("linear");
    expect(position.args.replace).toBe(false);
    expect(position.args.keys).toHaveLength(2);
    expect(() =>
      prepararLoteAE(conversion, { comp: "Teste", layer: "Fonte", sourceSize: [199, 100] }),
    ).toThrow(/tamanho/);
  });
});
