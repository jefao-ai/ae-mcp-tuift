// ae_plano_check — confere o plano do vídeo ANTES de montar no AE: buracos, sobreposição, duração de cena, texto
// longo, densidade, elemento que vive pouco, fala sem cena, troca de cena fora da frase e citado sem asset. O
// ae_review_motion só avisa depois de montado; aqui o erro custa uma linha de JSON.
// Não fala com o AE.

import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { z } from "zod";

import { errorResult } from "../errors.js";
import { defineTool } from "../tools/define-tool.js";
import { type Cena, normalizarNomeCena } from "./cenas.js";
import { houseStyle, textAndJson } from "./common.js";

type Sev = "erro" | "aviso" | "info";

export interface ProblemaPlano {
  sev: Sev;
  rule: string;
  cena?: string;
  at?: number;
  msg: string;
  fix?: string;
}

interface Palavra {
  w: string;
  ini: number;
  fim: number;
}

/** Aceita [{w,ini,fim}], [{word,start,end}], [{text,start,end}] ou { words: [...] }. */
export function normalizarPalavras(bruto: unknown): Palavra[] {
  const lista = Array.isArray(bruto) ? bruto : ((bruto as any)?.words ?? (bruto as any)?.palavras);
  if (!Array.isArray(lista)) return [];
  const out: Palavra[] = [];
  for (const p of lista) {
    const ini = Number(p?.ini ?? p?.start);
    const fim = Number(p?.fim ?? p?.end);
    if (!Number.isFinite(ini) || !Number.isFinite(fim)) continue;
    out.push({ w: String(p?.w ?? p?.word ?? p?.text ?? "").trim(), ini, fim });
  }
  return out.sort((a, b) => a.ini - b.ini);
}

/** Início de frase ou oração: pausa maior que 0,12 s ou palavra anterior com pontuação (medir_cadencia.py). */
export function iniciosDeFrase(palavras: Palavra[]): number[] {
  if (!palavras.length) return [];
  const out = [palavras[0].ini];
  for (let i = 1; i < palavras.length; i++) {
    const ant = palavras[i - 1];
    if (palavras[i].ini - ant.fim > 0.12 || /[.,?!;:…]$/.test(ant.w)) out.push(palavras[i].ini);
  }
  return out;
}

function contaPalavras(t: unknown): number {
  return String(t ?? "")
    .split(/\s+/)
    .filter(Boolean).length;
}

export function checarPlano(
  plano: any,
  style: any,
  opcoes: {
    palavras?: Palavra[];
    existe?: (asset: string) => boolean;
  } = {},
): { problemas: ProblemaPlano[]; cenas: Cena[]; perfil: string } {
  const P = style.plano;
  const problemas: ProblemaPlano[] = [];
  const perfil: string = P.perfis[plano?.tipo] ? plano.tipo : "narrado";
  const R = P.perfis[perfil];
  const add = (p: ProblemaPlano) => problemas.push(p);
  const entrada: any[] = Array.isArray(plano?.cenas) ? plano.cenas : [];
  if (!entrada.length) {
    add({
      sev: "erro",
      rule: "plano_sem_cenas",
      msg: "o plano não tem `cenas`",
      fix: "cenas: [{ nome, inicio, fim, fala, texto, elementos, citados }]",
    });
    return { problemas, cenas: [], perfil };
  }

  const cenas: Cena[] = [];
  const vistos = new Set<string>();
  for (const [i, c] of entrada.entries()) {
    const nome = normalizarNomeCena(i, c?.nome);
    const inicio = Number(c?.inicio);
    const fim = Number(c?.fim);
    if (vistos.has(nome))
      add({
        sev: "erro",
        rule: "cena_repetida",
        cena: nome,
        msg: `nome de cena repetido: ${nome}`,
      });
    vistos.add(nome);
    if (!Number.isFinite(inicio) || !Number.isFinite(fim) || fim <= inicio) {
      add({
        sev: "erro",
        rule: "cena_invertida",
        cena: nome,
        msg: `${nome}: inicio e fim precisam ser números, com fim maior que inicio`,
      });
      continue;
    }
    cenas.push({ nome, inicio, fim });
  }
  cenas.sort((a, b) => a.inicio - b.inicio);

  const duracao = Number(plano?.duracao);
  const temDuracao = Number.isFinite(duracao) && duracao > 0;
  if (cenas.length) {
    if (cenas[0].inicio > P.buracoSec)
      add({
        sev: "erro",
        rule: "buraco_entre_cenas",
        at: 0,
        msg: `nada na tela de 0 a ${cenas[0].inicio.toFixed(2)} s`,
      });
    if (temDuracao && cenas[cenas.length - 1].fim < duracao - P.buracoSec)
      add({
        sev: "erro",
        rule: "buraco_entre_cenas",
        at: cenas[cenas.length - 1].fim,
        msg: `o vídeo tem ${duracao} s e a última cena acaba em ${cenas[cenas.length - 1].fim.toFixed(2)} s`,
      });
    if (temDuracao && cenas[cenas.length - 1].fim > duracao + P.buracoSec)
      add({
        sev: "aviso",
        rule: "cena_passa_do_fim",
        cena: cenas[cenas.length - 1].nome,
        msg: `a última cena acaba em ${cenas[cenas.length - 1].fim.toFixed(2)} s, depois do fim do vídeo (${duracao} s)`,
      });
  }
  for (let i = 1; i < cenas.length; i++) {
    const a = cenas[i - 1];
    const b = cenas[i];
    const folga = b.inicio - a.fim;
    if (folga > P.buracoSec)
      add({
        sev: "erro",
        rule: "buraco_entre_cenas",
        cena: b.nome,
        at: a.fim,
        msg: `${(folga * 1000).toFixed(0)} ms vazios entre ${a.nome} e ${b.nome}`,
        fix: "emendar as cenas; entre elas o normal é sobrepor ~0,23 s",
      });
    else if (-folga > P.sobreposicaoMaxSec)
      add({
        sev: "aviso",
        rule: "sobreposicao_grande",
        cena: b.nome,
        at: b.inicio,
        msg: `${a.nome} e ${b.nome} se sobrepõem ${(-folga).toFixed(2)} s (normal até ${P.sobreposicaoMaxSec} s)`,
      });
  }

  for (const c of cenas) {
    const dur = c.fim - c.inicio;
    if (R.cenaMinSec && dur < R.cenaMinSec)
      add({
        sev: "aviso",
        rule: "cena_curta",
        cena: c.nome,
        at: c.inicio,
        msg: `${c.nome} tem ${dur.toFixed(2)} s (mínimo ${R.cenaMinSec} s no perfil ${perfil})`,
      });
    if (R.cenaMaxSec && dur > R.cenaMaxSec)
      add({
        sev: "aviso",
        rule: "cena_longa",
        cena: c.nome,
        at: c.inicio,
        msg: `${c.nome} tem ${dur.toFixed(2)} s (até ${R.cenaMaxSec} s no perfil ${perfil})`,
        fix: "dividir por frase: uma composição por frase",
      });
  }
  const total = temDuracao
    ? duracao
    : cenas.length
      ? cenas[cenas.length - 1].fim - cenas[0].inicio
      : 0;
  if (R.cenasPorMinutoMax && total > 0) {
    const porMinuto = (cenas.length / total) * 60;
    if (porMinuto > R.cenasPorMinutoMax)
      add({
        sev: "aviso",
        rule: "cenas_demais",
        msg: `${porMinuto.toFixed(1)} cenas por minuto (até ${R.cenasPorMinutoMax} no perfil ${perfil})`,
      });
  }

  // Elementos, textos e o que a fala cita, cena a cena
  const eventos: number[] = cenas.map((c) => c.inicio);
  const entradas: Array<{ t: number; cena: string }> = [];
  const vivos: Array<{ ini: number; fim: number; cena: string; nome: string }> = [];
  for (const [i, c] of entrada.entries()) {
    const nome = normalizarNomeCena(i, c?.nome);
    for (const t of Array.isArray(c?.texto) ? c.texto : c?.texto ? [c.texto] : []) {
      const n = contaPalavras(t);
      if (n > P.textoMaxPalavras)
        add({
          sev: "aviso",
          rule: "texto_longo",
          cena: nome,
          msg: `${nome}: "${String(t).slice(0, 50)}" tem ${n} palavras na tela (até ${P.textoMaxPalavras})`,
          fix: "deixar a palavra-chave na tela e o resto na fala",
        });
    }
    for (const q of Array.isArray(c?.citados) ? c.citados : []) {
      const rotulo = typeof q === "string" ? q : q?.nome;
      const asset = typeof q === "string" ? null : q?.asset;
      if (!asset) {
        add({
          sev: "erro",
          rule: "citado_sem_asset",
          cena: nome,
          msg: `${nome}: "${rotulo}" é citado e não tem imagem, logo ou print`,
          fix: "tudo que tem imagem real entra com imagem real (etapa 5 do vídeo do zero)",
        });
      } else if (opcoes.existe && !opcoes.existe(String(asset))) {
        add({
          sev: "aviso",
          rule: "asset_nao_existe",
          cena: nome,
          msg: `${nome}: o arquivo de "${rotulo}" não existe: ${asset}`,
        });
      }
    }
    const inicioCena = Number(c?.inicio);
    const fimCena = Number(c?.fim);
    for (const e of Array.isArray(c?.elementos) ? c.elementos : []) {
      const ini = Number(e?.entra);
      if (!Number.isFinite(ini)) continue;
      const fim = Number.isFinite(Number(e?.sai)) ? Number(e.sai) : fimCena;
      const rotulo = String(e?.nome ?? "elemento");
      entradas.push({ t: ini, cena: nome });
      eventos.push(ini);
      if (Number.isFinite(Number(e?.sai))) eventos.push(fim);
      if (e?.papel !== "legenda") vivos.push({ ini, fim, cena: nome, nome: rotulo });
      if (ini < inicioCena - P.buracoSec || ini >= fimCena)
        add({
          sev: "aviso",
          rule: "elemento_fora_da_cena",
          cena: nome,
          at: ini,
          msg: `${rotulo} entra em ${ini.toFixed(2)} s, fora de ${nome}`,
        });
      const vidaMin = e?.papel === "principal" ? R.vidaPrincipalMinSec : R.vidaApoioMinSec;
      if (vidaMin && e?.papel !== "legenda" && fim - ini < vidaMin)
        add({
          sev: "aviso",
          rule: "elemento_vive_pouco",
          cena: nome,
          at: ini,
          msg: `${rotulo} fica ${(fim - ini).toFixed(2)} s na tela (mínimo ${vidaMin} s para ${e?.papel === "principal" ? "principal" : "apoio"})`,
        });
    }
  }

  if (entradas.length) {
    const ts = entradas.map((e) => e.t).sort((a, b) => a - b);
    let pior = 0;
    let piorEm = 0;
    let i0 = 0;
    for (let i = 0; i < ts.length; i++) {
      while (ts[i] - ts[i0] > 10) i0++;
      if (i - i0 + 1 > pior) {
        pior = i - i0 + 1;
        piorEm = ts[i0];
      }
    }
    if (R.elementosPor10sMax && pior > R.elementosPor10sMax)
      add({
        sev: "aviso",
        rule: "elementos_demais",
        at: piorEm,
        msg: `${pior} elementos entram em 10 s a partir de ${piorEm.toFixed(1)} s (até ${R.elementosPor10sMax})`,
      });
    if (R.elementosPor10sMin && total >= 10 && (ts.length / total) * 10 < R.elementosPor10sMin)
      add({
        sev: "aviso",
        rule: "elementos_de_menos",
        msg: `${((ts.length / total) * 10).toFixed(1)} elementos por 10 s (o perfil ${perfil} pede ${R.elementosPor10sMin} ou mais)`,
      });
  }
  if (R.elementosJuntosMax) {
    for (const v of vivos) {
      const juntos = vivos.filter((o) => o.ini <= v.ini && o.fim > v.ini);
      if (juntos.length > R.elementosJuntosMax) {
        add({
          sev: "aviso",
          rule: "elementos_juntos",
          cena: v.cena,
          at: v.ini,
          msg: `${juntos.length} elementos ao mesmo tempo em ${v.ini.toFixed(2)} s (até ${R.elementosJuntosMax} além da legenda): ${juntos.map((o) => o.nome).join(", ")}`,
        });
        break;
      }
    }
  }
  if (R.semMudarMaxSec && cenas.length) {
    const fimTotal = temDuracao ? duracao : cenas[cenas.length - 1].fim;
    const ordem = [...eventos, fimTotal].sort((a, b) => a - b);
    for (let i = 1; i < ordem.length; i++) {
      const vazio = ordem[i] - ordem[i - 1];
      if (vazio > R.semMudarMaxSec) {
        add({
          sev: "aviso",
          rule: "tempo_sem_mudar",
          at: ordem[i - 1],
          msg: `${vazio.toFixed(2)} s sem nada mudar a partir de ${ordem[i - 1].toFixed(2)} s (até ${R.semMudarMaxSec} s no perfil ${perfil})`,
        });
      }
    }
  }

  // Fala contra cenas
  const palavras = opcoes.palavras ?? [];
  if (palavras.length && cenas.length) {
    const descobertas = palavras.filter(
      (p) => !cenas.some((c) => (p.ini + p.fim) / 2 >= c.inicio && (p.ini + p.fim) / 2 < c.fim),
    );
    if (descobertas.length)
      add({
        sev: "erro",
        rule: "fala_sem_cena",
        at: descobertas[0].ini,
        msg: `${descobertas.length} palavra(s) sem cena, a primeira em ${descobertas[0].ini.toFixed(2)} s ("${descobertas[0].w}")`,
      });
    if (perfil === "narrado") {
      const frases = iniciosDeFrase(palavras);
      for (const c of cenas.slice(1)) {
        const dist = Math.min(...frases.map((f) => Math.abs(f - c.inicio)));
        if (dist > P.trocaNaFalaSec)
          add({
            sev: "aviso",
            rule: "troca_fora_da_frase",
            cena: c.nome,
            at: c.inicio,
            msg: `${c.nome} começa a ${dist.toFixed(2)} s do início de frase mais próximo`,
            fix: "trocar de cena na primeira palavra da frase",
          });
      }
    }
  }
  return { problemas, cenas, perfil };
}

export const planoCheckTool = defineTool({
  name: "ae_plano_check",
  title: "Check the video plan before building",
  description:
    "Check a video's PLAN before touching After Effects: empty stretches between scenes, overlaps, scene length, too much text on screen, " +
    "too many elements, elements that live too short, narration without a scene, scene changes away from a sentence start, things the " +
    "narration cites with no image. Numbers come from the house style (perfil `narrado`, `cinetico` or `livre` in `tipo`). Returns a score, the issues " +
    "and the scene list ready for ae_do tuift.cena. Plan format: { tipo, duracao, audio: { palavras: 'palavras.json' }, cenas: [{ nome, inicio, fim, fala, " +
    "texto: ['...'], elementos: [{ nome, papel: 'principal|apoio|legenda', entra, sai }], citados: [{ nome, asset }] }] }. Times in seconds on the video's timeline. " +
    "Does not need After Effects.",
  group: "inspect",
  blockedInReadOnly: false,
  effect: "read",
  inputShape: {
    arquivo: z
      .string()
      .optional()
      .describe(
        "Path to the plan JSON (relative assets and palavras are resolved from its folder).",
      ),
    plano: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("The plan itself, instead of a file."),
    palavras: z
      .string()
      .optional()
      .describe(
        "Word timings JSON, overrides plano.audio.palavras: [{w,ini,fim}] or [{word,start,end}].",
      ),
  },
  handler: async (args) => {
    let plano: any = args.plano;
    let pasta = process.cwd();
    if (args.arquivo) {
      try {
        plano = JSON.parse(readFileSync(args.arquivo, "utf8"));
        pasta = path.dirname(path.resolve(args.arquivo));
      } catch (e) {
        return errorResult("IO", `não consegui ler o plano: ${(e as Error).message}`);
      }
    }
    if (!plano) return errorResult("INVALID_ARGS", "give `arquivo` or `plano`");

    const fonte = args.palavras ?? plano?.audio?.palavras;
    let palavras: Palavra[] | undefined;
    if (fonte) {
      try {
        palavras = normalizarPalavras(JSON.parse(readFileSync(path.resolve(pasta, fonte), "utf8")));
      } catch (e) {
        return errorResult("IO", `não consegui ler as palavras: ${(e as Error).message}`);
      }
    }
    const { problemas, cenas, perfil } = checarPlano(plano, houseStyle(), {
      palavras,
      existe: (a) => existsSync(path.resolve(pasta, a)),
    });
    const conta = (s: Sev) => problemas.filter((p) => p.sev === s).length;
    const nota = Math.max(0, 100 - 10 * conta("erro") - 3 * conta("aviso") - conta("info"));
    const ordem = { erro: 0, aviso: 1, info: 2 } as const;
    problemas.sort((a, b) => ordem[a.sev] - ordem[b.sev] || (a.at ?? 0) - (b.at ?? 0));
    const pode = conta("erro") === 0;
    return textAndJson(
      {
        nota,
        perfil,
        podeMontar: pode,
        contagem: { erro: conta("erro"), aviso: conta("aviso"), info: conta("info") },
        problemas: problemas.slice(0, 120),
        cenas,
        proximo: pode
          ? "monte a comp e marque as cenas: ae_do tuift.cena { comp, cenas } com a lista acima"
          : "corrija os erros do plano e rode de novo",
      },
      `Plano ${perfil}: nota ${nota}, ${conta("erro")} erro(s), ${conta("aviso")} aviso(s), ${cenas.length} cena(s).`,
    );
  },
});
