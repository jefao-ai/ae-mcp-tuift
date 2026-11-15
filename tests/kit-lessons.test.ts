// The lessons and the house style that ship in kit/: every line is valid JSON,
// every `quando` still compiles, and the lessons still match the errors they
// were written for.

import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { loadLessons, matchLessons } from "../src/tuift/lessons.js";

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "kit");

describe("kit/licoes.jsonl", () => {
  const lines = readFileSync(path.join(KIT, "licoes.jsonl"), "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim() && !l.startsWith("//"));

  it("is valid JSON on every line, with unique ids and a compiling regex", () => {
    const ids = new Set<string>();
    for (const line of lines) {
      const l = JSON.parse(line) as { id: string; quando: string; licao: string };
      expect(l.id).toMatch(/^[a-z0-9-]+$/);
      expect(ids.has(l.id), `duplicate id ${l.id}`).toBe(false);
      ids.add(l.id);
      expect(() => new RegExp(l.quando, "i"), l.id).not.toThrow();
      expect(l.licao.length, l.id).toBeGreaterThan(20);
    }
    expect(ids.size).toBe(58);
  });

  it("loads through the server's own reader", () => {
    expect(loadLessons()).toHaveLength(58);
  });

  it("still matches the errors it was written for", () => {
    const ids = (text: string) => matchLessons(text, 20).map((l) => l.id);
    expect(ids("tuift.mola failed on layer X")).toContain("mola-precisa-velocidade");
    expect(ids("overshoot looks wrong")).toContain("mola-precisa-velocidade");
    expect(ids("TIMEOUT after 60000 ms")).toContain("timeout-nao-reenviar");
    expect(ids("DIALOG_OPEN: a modal dialog is showing")).toContain("dialogo-modal");
    expect(ids("Trecho saiu preto: code 19969 GPU")).toContain("render-preto");
    expect(ids("motion blur nao aparece")).toContain("precomp-blur");
    expect(ids("4-Color Gradient nao segue a shape")).toContain("tocomp-4color-gradient");
    expect(ids("Bulge Center em adjustment")).toContain("efeito-ponto-em-adjustment");
    expect(ids("render lento, trecho de 1 s demorando")).toContain("render-trecho-curto");
  });
});

describe("kit/estilo-da-casa.json", () => {
  it("is valid JSON and carries the numbers the tools read", () => {
    const style = JSON.parse(readFileSync(path.join(KIT, "estilo-da-casa.json"), "utf8"));
    for (const key of [
      "mola",
      "curvas",
      "vivo",
      "stagger",
      "revisao",
      "render",
      "plano",
      "avaliacao",
    ])
      expect(style, key).toHaveProperty(key);
  });
});
