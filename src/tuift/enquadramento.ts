// Enquadramento: mede a caixa real de cada texto contra o campo, botão ou pílula que o contém Números no estilo-da-casa.json.
// O JSX do ae_review_motion coleta os retângulos em coordenadas da comp; aqui só há conta.

export type Ret = [number, number, number, number]; // esquerda, topo, direita, base

export interface TextoMedido {
  name: string;
  index: number;
  t: number;
  inPoint: number;
  outPoint: number;
  text?: string;
  centrado?: boolean;
  rect: Ret;
  caixas: { name: string; rect: Ret }[];
}

export interface LinhaMedida {
  name: string;
  t: number;
  esq: number;
  dir: number;
}

export interface LimitesEnquadramento {
  padMinPx: number;
  padMinRel: number;
  centroPx: number;
  centroRel: number;
  assimetriaPx: number;
  linhaMargemPx: number;
  umaLinhaRel: number;
  caixaMaxFrame: number;
}

export const LIMITES_PADRAO: LimitesEnquadramento = {
  padMinPx: 12,
  padMinRel: 0.25,
  centroPx: 4,
  centroRel: 0.1,
  assimetriaPx: 8,
  linhaMargemPx: 12,
  umaLinhaRel: 3.8,
  caixaMaxFrame: 0.35,
};

export interface ProblemaEnquadramento {
  sev: "erro" | "aviso";
  rule: string;
  layer: string;
  index: number;
  at: number;
  msg: string;
  fix: string;
}

const larg = (r: Ret) => r[2] - r[0];
const alt = (r: Ret) => r[3] - r[1];
const area = (r: Ret) => Math.max(0, larg(r)) * Math.max(0, alt(r));
function intersecao(a: Ret, b: Ret): number {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  return w > 0 && h > 0 ? w * h : 0;
}

/** A menor caixa que contém o centro do texto ou cobre boa parte dele; fundo de tela inteira não conta. */
export function caixaDoTexto(t: TextoMedido, wComp: number, hComp: number, lim = LIMITES_PADRAO) {
  const cx = (t.rect[0] + t.rect[2]) / 2;
  const cy = (t.rect[1] + t.rect[3]) / 2;
  const validas = t.caixas.filter((c) => {
    if (area(c.rect) > lim.caixaMaxFrame * wComp * hComp) return false;
    const dentro = cx >= c.rect[0] && cx <= c.rect[2] && cy >= c.rect[1] && cy <= c.rect[3];
    return dentro || intersecao(t.rect, c.rect) >= 0.3 * Math.max(1, area(t.rect));
  });
  validas.sort((a, b) => area(a.rect) - area(b.rect));
  return validas[0] ?? null;
}

const n = (v: number) => Math.round(v);

export function checarEnquadramento(
  textos: TextoMedido[],
  linhas: LinhaMedida[],
  wComp: number,
  hComp: number,
  lim: LimitesEnquadramento = LIMITES_PADRAO,
): ProblemaEnquadramento[] {
  const saida: ProblemaEnquadramento[] = [];
  const porCaixa = new Map<string, { t: TextoMedido; rect: Ret }[]>();

  for (const t of textos) {
    if (larg(t.rect) <= 0) continue;
    const c = caixaDoTexto(t, wComp, hComp, lim);
    if (!c) continue;
    const e = t.rect[0] - c.rect[0];
    const d = c.rect[2] - t.rect[2];
    const cima = t.rect[1] - c.rect[1];
    const baixo = c.rect[3] - t.rect[3];
    const base = { layer: t.name, index: t.index, at: t.t };
    const rot = `"${t.text ?? t.name}" em "${c.name}"`;

    if (e < 0 || d < 0 || cima < 0 || baixo < 0) {
      saida.push({
        ...base,
        sev: "erro",
        rule: "texto_vaza_da_caixa",
        msg: `${rot} sai da caixa (folga esq ${n(e)}, dir ${n(d)}, cima ${n(cima)}, baixo ${n(baixo)} px)`,
        fix: "posicione o texto pela caixa medida: x = esquerda da caixa + padding",
      });
      continue;
    }
    // caixa de uma linha só (campo, botão, pílula); texto com "topo" ou "rotulo" no nome é alinhado em cima de propósito (clipe com onda)
    const umaLinha = alt(c.rect) <= lim.umaLinhaRel * alt(t.rect) && !/topo|rotulo/i.test(t.name);
    if (umaLinha) {
      const padMin = Math.max(lim.padMinPx, lim.padMinRel * alt(c.rect));
      if (Math.min(e, d) < padMin) {
        saida.push({
          ...base,
          sev: "erro",
          rule: "texto_colado_na_borda",
          msg: `${rot} tem só ${n(Math.min(e, d))} px até a borda; mínimo ${n(padMin)} px (25% da altura da caixa)`,
          fix: "aumente a caixa ou o padding",
        });
      }
      const tol = Math.max(lim.centroPx, lim.centroRel * alt(c.rect));
      if (Math.abs(cima - baixo) > tol) {
        saida.push({
          ...base,
          sev: "erro",
          rule: "texto_fora_do_centro",
          msg: `${rot} descentrado na vertical: ${n(cima)} px em cima e ${n(baixo)} px embaixo (tolerância ${n(tol)})`,
          fix: "alinhe pelo centro: linha de base = centro da caixa + 0,35 × corpo da fonte",
        });
      }
      if (t.centrado && Math.abs(e - d) > lim.assimetriaPx) {
        saida.push({
          ...base,
          sev: "erro",
          rule: "texto_fora_do_centro",
          msg: `${rot} centrado, mas com ${n(e)} px à esquerda e ${n(d)} px à direita`,
          fix: "centre o texto no meio da caixa medida",
        });
      }
      const k = c.name;
      if (!porCaixa.has(k)) porCaixa.set(k, []);
      porCaixa.get(k)!.push({ t, rect: c.rect });
    }
  }

  // dois textos no mesmo campo (ex.: campo + "Publicar"): mesma folga dos dois lados e mesmo centro vertical
  for (const [nome, lista] of porCaixa) {
    for (let i = 0; i < lista.length; i++) {
      for (let j = i + 1; j < lista.length; j++) {
        const a = lista[i],
          b = lista[j];
        if (Math.min(a.t.outPoint, b.t.outPoint) <= Math.max(a.t.inPoint, b.t.inPoint)) continue;
        const [esq, dir] = a.t.rect[0] <= b.t.rect[0] ? [a, b] : [b, a];
        if (esq.t.rect[2] > dir.t.rect[0]) continue; // um em cima do outro: outra checagem
        const pe = esq.t.rect[0] - esq.rect[0];
        const pd = dir.rect[2] - dir.t.rect[2];
        if (Math.abs(pe - pd) > lim.assimetriaPx) {
          saida.push({
            sev: "erro",
            rule: "campo_assimetrico",
            layer: dir.t.name,
            index: dir.t.index,
            at: dir.t.t,
            msg: `"${nome}": ${n(pe)} px à esquerda de "${esq.t.text ?? esq.t.name}" e ${n(pd)} px à direita de "${dir.t.text ?? dir.t.name}"`,
            fix: "use o mesmo padding nos dois lados; texto da direita alinhado à direita",
          });
        }
        const dy = (a.t.rect[1] + a.t.rect[3]) / 2 - (b.t.rect[1] + b.t.rect[3]) / 2;
        if (Math.abs(dy) > Math.max(lim.centroPx, lim.centroRel * alt(a.rect))) {
          saida.push({
            sev: "erro",
            rule: "campo_desalinhado",
            layer: dir.t.name,
            index: dir.t.index,
            at: dir.t.t,
            msg: `"${nome}": os textos estão ${n(Math.abs(dy))} px fora da mesma linha`,
            fix: "mesma linha de base para os dois",
          });
        }
      }
    }
  }

  // linha de componentes que ocupa a largura da tela: margens iguais
  for (const l of linhas) {
    if (l.dir - l.esq < 0.6 * wComp) continue;
    const me = l.esq;
    const md = wComp - l.dir;
    if (Math.abs(me - md) > lim.linhaMargemPx) {
      saida.push({
        sev: "erro",
        rule: "linha_descentrada",
        layer: l.name,
        index: 0,
        at: l.t,
        msg: `a linha de "${l.name}" tem margens de ${n(me)} px e ${n(md)} px`,
        fix: "centre o grupo inteiro na tela, não só o maior elemento",
      });
    }
  }
  return saida;
}
