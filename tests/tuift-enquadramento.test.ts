import { describe, expect, it } from "vitest";

import { checarEnquadramento, type TextoMedido } from "../src/tuift/enquadramento.js";

const campo: [number, number, number, number] = [142, 1248, 1016, 1332];
function texto(
  name: string,
  rect: [number, number, number, number],
  extra: Partial<TextoMedido> = {},
): TextoMedido {
  return {
    name,
    index: 1,
    t: 55,
    inPoint: 54,
    outPoint: 57,
    text: name,
    rect,
    caixas: [{ name: "campo", rect: campo }],
    ...extra,
  };
}
const regras = (t: TextoMedido[], l: any[] = []) =>
  checarEnquadramento(t, l, 1080, 1920).map((p) => p.rule);

describe("enquadramento", () => {
  it("aceita campo com padding igual e os textos no mesmo centro", () => {
    expect(
      regras([
        texto("TRANSIÇÃO", [176, 1278, 340, 1303]),
        texto("Publicar", [860, 1277, 982, 1304]),
      ]),
    ).toEqual([]);
  });

  it("acusa o erro do Reel de 01/11: texto começa antes da borda do campo", () => {
    expect(regras([texto("Adicione", [130, 1278, 400, 1303])])).toContain("texto_vaza_da_caixa");
  });

  it("acusa texto colado na borda", () => {
    expect(regras([texto("Colado", [148, 1278, 300, 1303])])).toContain("texto_colado_na_borda");
  });

  it("acusa texto fora do centro vertical", () => {
    expect(regras([texto("Baixo", [176, 1296, 340, 1322])])).toContain("texto_fora_do_centro");
  });

  it("acusa folgas diferentes entre o texto da esquerda e o da direita", () => {
    expect(
      regras([texto("A", [176, 1278, 340, 1303]), texto("B", [860, 1278, 950, 1303])]),
    ).toContain("campo_assimetrico");
  });

  it("acusa dois textos fora da mesma linha", () => {
    expect(
      regras([texto("A", [176, 1270, 340, 1295]), texto("B", [860, 1285, 982, 1310])]),
    ).toContain("campo_desalinhado");
  });

  it("acusa texto centrado com folgas diferentes", () => {
    const r = regras([texto("Meio", [300, 1278, 500, 1303], { centrado: true })]);
    expect(r).toContain("texto_fora_do_centro");
  });

  it("acusa linha descentrada na tela", () => {
    expect(regras([], [{ name: "campo", t: 55, esq: 63, dir: 975 }])).toContain(
      "linha_descentrada",
    );
    expect(regras([], [{ name: "campo", t: 55, esq: 64, dir: 1016 }])).toEqual([]);
  });

  it("não trata fundo de tela inteira como caixa do texto", () => {
    const fundo = { name: "fundo", rect: [0, 0, 1080, 1920] as [number, number, number, number] };
    expect(regras([{ ...texto("Solto", [10, 10, 200, 40]), caixas: [fundo] }])).toEqual([]);
  });

  it("em caixa alta (card), não exige centro vertical", () => {
    const card = { name: "card", rect: [100, 100, 900, 400] as [number, number, number, number] };
    expect(regras([{ ...texto("Título", [130, 130, 400, 170]), caixas: [card] }])).toEqual([]);
  });
});
