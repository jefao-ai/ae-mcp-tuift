// Identidade do vídeo no revisor (01/11/2026): um identidade.json por projeto declara fontes, paleta, margem e
// raios, e o ae_review_motion acusa o que sair disso. Todo vídeo da casa tem identidade própria; até aqui ninguém
// conferia. As regras medem o projeto de verdade, não o plano. O JSX só coleta; as regras rodam em TypeScript.

import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";

export interface Identidade {
  /** Nomes PostScript ou de família; aceita * (ex.: "SF Pro*", "Roboto-Medium"). */
  fontes?: string[];
  /** Cores permitidas em #RRGGBB. */
  paleta?: string[];
  /** Distância máxima em RGB 0–255 para contar como a mesma cor (padrão 18). */
  toleranciaCor?: number;
  /** Branco, preto e cinzas passam sem estar na paleta (padrão true). */
  neutrosLivres?: boolean;
  margemPx?: number;
  /** Raios de canto permitidos; canto reto sempre passa. */
  raiosPx?: number[];
  /** Regex de camadas e comps fora da conferência (peças de terceiros, por exemplo). */
  ignorar?: string[];
  /** Entra nas pré-comps (padrão true). */
  profundo?: boolean;
}

export interface ColetaIdentidade {
  textos: Array<{ comp: string; layer: string; fonte: string; familia: string }>;
  cores: Array<{ comp: string; layer: string; tipo: string; rgb: number[] }>;
  raios: Array<{ comp: string; layer: string; raio: number }>;
  truncado?: boolean;
}

export interface ProblemaIdentidade {
  sev: "erro" | "aviso" | "info";
  rule: string;
  msg: string;
  fix?: string;
}

export const COLETA_IDENTIDADE_JSX = `
var raiz = AE.findCompByNameOrId(payload.comp);
if (!raiz) return { ok: false, error: "no comp matching " + String(payload.comp) };
var saida = { textos: [], cores: [], raios: [], truncado: false };
var vistas = {}, contadas = 0, MAX = payload.maxCamadas, T0 = new Date().getTime(), LIMITE = payload.limiteMs;
function cor(arr) { return [Math.round(arr[0] * 255), Math.round(arr[1] * 255), Math.round(arr[2] * 255)]; }
function grupo(g, comp, L, prof) {
  if (!g || prof > 10) return;
  var n = 0; try { n = g.numProperties; } catch (e0) { return; }
  for (var i = 1; i <= n; i++) {
    var p = g.property(i), mn = "";
    try { mn = p.matchName; } catch (e1) { continue; }
    try { if (p.enabled === false) continue; } catch (e2) {}
    if (mn === "ADBE Vector Graphic - Fill" || mn === "ADBE Vector Graphic - Stroke") {
      var ehFill = mn === "ADBE Vector Graphic - Fill";
      try {
        var op = p.property(ehFill ? "ADBE Vector Fill Opacity" : "ADBE Vector Stroke Opacity").value;
        if (op > 0) saida.cores.push({ comp: comp.name, layer: L.name, tipo: ehFill ? "preenchimento" : "contorno",
          rgb: cor(p.property(ehFill ? "ADBE Vector Fill Color" : "ADBE Vector Stroke Color").value) });
      } catch (e3) {}
    } else if (mn === "ADBE Vector Shape - Rect") {
      try { var r = p.property("ADBE Vector Rect Roundness").value; if (r > 0) saida.raios.push({ comp: comp.name, layer: L.name, raio: r }); } catch (e4) {}
    } else if (p.propertyType !== PropertyType.PROPERTY) {
      grupo(p, comp, L, prof + 1);
    }
  }
}
function varrer(comp) {
  if (vistas[comp.id]) return;
  vistas[comp.id] = true;
  for (var i = 1; i <= comp.numLayers; i++) {
    if (contadas >= MAX || new Date().getTime() - T0 > LIMITE) { saida.truncado = true; return; }
    var L = comp.layer(i);
    if (!L.enabled || AE.safeGet(function () { return L.guideLayer; }, false)) continue;
    contadas++;
    if (L instanceof TextLayer) {
      try {
        var td = L.property("ADBE Text Properties").property("ADBE Text Document").value;
        saida.textos.push({ comp: comp.name, layer: L.name, fonte: String(td.font), familia: String(td.fontFamily) });
        if (td.applyFill) saida.cores.push({ comp: comp.name, layer: L.name, tipo: "texto", rgb: cor(td.fillColor) });
        if (td.applyStroke) saida.cores.push({ comp: comp.name, layer: L.name, tipo: "contorno do texto", rgb: cor(td.strokeColor) });
      } catch (eT) {}
    } else if (L instanceof ShapeLayer) {
      grupo(L.property("ADBE Root Vectors Group"), comp, L, 0);
    } else if (L.source && L.source.mainSource instanceof SolidSource && !L.adjustmentLayer && !L.nullLayer) {
      saida.cores.push({ comp: comp.name, layer: L.name, tipo: "sólido", rgb: cor(L.source.mainSource.color) });
    } else if (payload.profundo && L.source instanceof CompItem) {
      varrer(L.source);
    }
  }
}
varrer(raiz);
return saida;
`;

/** identidade.json na pasta do .aep ou até 3 pastas acima (projetos guardam o .aep em ae/). */
export function acharIdentidade(projeto: string | null | undefined): string | null {
  if (!projeto) return null;
  let pasta = path.dirname(projeto);
  for (let i = 0; i < 4; i++) {
    const candidato = path.join(pasta, "identidade.json");
    if (existsSync(candidato)) return candidato;
    const acima = path.dirname(pasta);
    if (acima === pasta) break;
    pasta = acima;
  }
  return null;
}

export function lerIdentidade(entrada: string | Identidade): {
  identidade?: Identidade;
  arquivo?: string;
  erro?: string;
} {
  let bruto: unknown = entrada;
  let arquivo: string | undefined;
  if (typeof entrada === "string") {
    arquivo = entrada;
    try {
      bruto = JSON.parse(readFileSync(entrada, "utf8"));
    } catch (e) {
      return { arquivo, erro: `não consegui ler ${entrada}: ${(e as Error).message}` };
    }
  }
  if (!bruto || typeof bruto !== "object" || Array.isArray(bruto))
    return { arquivo, erro: "identidade precisa ser um objeto JSON" };
  const id = bruto as Identidade;
  for (const c of id.paleta ?? []) {
    if (!/^#[0-9a-f]{6}$/i.test(String(c)))
      return { arquivo, erro: `cor inválida na paleta: ${c} (use #RRGGBB)` };
  }
  for (const r of id.ignorar ?? []) {
    try {
      new RegExp(r);
    } catch {
      return { arquivo, erro: `regex inválida em ignorar: ${r}` };
    }
  }
  return { arquivo, identidade: id };
}

function casaFonte(padrao: string, fonte: string, familia: string): boolean {
  const re = new RegExp(
    `^${padrao
      .split("*")
      .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")}$`,
    "i",
  );
  return re.test(fonte) || re.test(familia);
}

function hex(rgb: number[]): string {
  return `#${rgb
    .map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase()}`;
}

function deHex(h: string): number[] {
  return [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
}

function juntaCamadas(lista: Array<{ comp: string; layer: string }>): string {
  const nomes = [...new Set(lista.map((x) => `${x.layer} (${x.comp})`))];
  return nomes.slice(0, 4).join(", ") + (nomes.length > 4 ? ` e mais ${nomes.length - 4}` : "");
}

export function checarIdentidade(coleta: ColetaIdentidade, id: Identidade): ProblemaIdentidade[] {
  const problemas: ProblemaIdentidade[] = [];
  const ignorar = (id.ignorar ?? []).map((r) => new RegExp(r, "i"));
  const vale = (x: { comp: string; layer: string }) =>
    !ignorar.some((r) => r.test(x.layer) || r.test(x.comp));

  if (id.fontes?.length) {
    const fora = new Map<string, Array<{ comp: string; layer: string }>>();
    for (const t of coleta.textos.filter(vale)) {
      if (id.fontes.some((p) => casaFonte(p, t.fonte, t.familia))) continue;
      fora.set(t.fonte, [...(fora.get(t.fonte) ?? []), t]);
    }
    for (const [fonte, onde] of fora) {
      problemas.push({
        sev: "aviso",
        rule: "fonte_fora_da_identidade",
        msg: `fonte ${fonte} fora da identidade (${id.fontes.join(", ")}): ${juntaCamadas(onde)}`,
        fix: "text.set_style na fonte da identidade, ou acrescentar a fonte ao identidade.json se ela for de propósito",
      });
    }
  }

  if (id.paleta?.length) {
    const tol = id.toleranciaCor ?? 18;
    const paleta = id.paleta.map(deHex);
    const livres = id.neutrosLivres !== false;
    const fora = new Map<string, Array<{ comp: string; layer: string }>>();
    for (const c of coleta.cores.filter(vale)) {
      if (livres && Math.max(...c.rgb) - Math.min(...c.rgb) <= 14) continue;
      const perto = paleta.some(
        (p) => Math.hypot(p[0] - c.rgb[0], p[1] - c.rgb[1], p[2] - c.rgb[2]) <= tol,
      );
      if (perto) continue;
      const chave = hex(c.rgb);
      fora.set(chave, [...(fora.get(chave) ?? []), c]);
    }
    const ordenadas = [...fora.entries()].sort((a, b) => b[1].length - a[1].length);
    for (const [cor, onde] of ordenadas.slice(0, 8)) {
      problemas.push({
        sev: "aviso",
        rule: "cor_fora_da_identidade",
        msg: `cor ${cor} fora da paleta: ${juntaCamadas(onde)}`,
        fix: "shape.recolor ou text.set_style para uma cor da paleta",
      });
    }
    if (ordenadas.length > 8) {
      problemas.push({
        sev: "aviso",
        rule: "cor_fora_da_identidade",
        msg: `mais ${ordenadas.length - 8} cores fora da paleta`,
      });
    }
  }

  if (id.raiosPx?.length) {
    const fora = new Map<number, Array<{ comp: string; layer: string }>>();
    for (const r of coleta.raios.filter(vale)) {
      if (id.raiosPx.some((p) => Math.abs(p - r.raio) <= 1)) continue;
      const chave = Math.round(r.raio);
      fora.set(chave, [...(fora.get(chave) ?? []), r]);
    }
    for (const [raio, onde] of fora) {
      problemas.push({
        sev: "info",
        rule: "raio_fora_da_identidade",
        msg: `raio de ${raio} px fora da identidade (${id.raiosPx.join(", ")}): ${juntaCamadas(onde)}`,
      });
    }
  }

  if (coleta.truncado) {
    problemas.push({
      sev: "info",
      rule: "identidade_parcial",
      msg: "comp grande demais: a conferência de identidade não varreu todas as camadas",
    });
  }
  return problemas;
}
