import { describe, expect, it } from "vitest";
import { acharModelo } from "../src/tuift/render.js";

// Listas lidas do After Effects 2026 em português (app.isoLanguage = pt_BR), 22/11/2026.
const RS_PT = [
  "Configurações atuais",
  "Configurações de DV",
  "Configurações de rascunho",
  "Configurações de vários computadores",
  "Melhores configurações",
  "_HIDDEN X-Factor",
];
const OM_PT = [
  "AIFF 48kHz",
  "Alta qualidade com alfa",
  "H.264 - Corresponder configurações de renderização - 15 Mbps",
  "H.264 - Corresponder configurações de renderização - 40 Mbps",
  "H.264 - Corresponder configurações de renderização - 5 Mbps",
  "Photoshop",
  "Qualidade superior",
  "Sem perdas",
  "Sem perdas com alfa",
];

describe("acharModelo", () => {
  it("usa o nome exato quando o AE está em inglês", () => {
    expect(acharModelo("Best Settings", ["Best Settings", "Draft Settings"])).toBe("Best Settings");
  });

  it("traduz para o AE em português", () => {
    expect(acharModelo("Best Settings", RS_PT)).toBe("Melhores configurações");
    expect(acharModelo("Draft Settings", RS_PT)).toBe("Configurações de rascunho");
    expect(acharModelo("H.264 - Match Render Settings - 40 Mbps", OM_PT)).toBe(
      "H.264 - Corresponder configurações de renderização - 40 Mbps",
    );
  });

  it("acha o H.264 pela taxa numa língua sem tradução na tabela", () => {
    const es = [
      "H.264 - Coincidir con la configuración de procesamiento - 15 Mbps",
      "H.264 - Coincidir con la configuración de procesamiento - 40 Mbps",
    ];
    expect(acharModelo("H.264 - Match Render Settings - 40 Mbps", es)).toBe(es[1]);
    expect(acharModelo("Best Settings", ["Configuración óptima"])).toBe("Configuración óptima");
  });

  it("aceita um nome já localizado passado pela pessoa", () => {
    expect(acharModelo("Sem perdas", OM_PT)).toBe("Sem perdas");
  });

  it("devolve null quando não há como achar", () => {
    expect(acharModelo("Meu modelo", OM_PT)).toBeNull();
    expect(acharModelo("Best Settings", [])).toBeNull();
  });
});
