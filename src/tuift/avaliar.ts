// ae_avaliar_render — duas camadas: 55 pontos medidos aqui (técnico, áudio, ritmo, abertura) e a revisão editorial de um
// modelo externo (por exemplo o Gemini). A revisão é uma LISTA DE PROBLEMAS (tempo, regra, correção) com o veredito previsto
// do diretor, presa às regras e aos casos do arquivo opcional de regras de revisão (TUIFT_REVIEW_RULES); a nota 0–45 antiga
// ainda é aceita para revisões antigas. Pacote pronto para o revisor. Cada conteúdo de arquivo tem um ID, então render
// sobrescrito nunca herda nota antiga, e o histórico compara v1, v2 e v3. As faixas da nota ficam em estilo-da-casa.json.
// Não fala com o AE.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, promises as fs, readFileSync } from "node:fs";
import * as path from "node:path";
import { z } from "zod";

import { errorResult } from "../errors.js";
import { defineTool } from "../tools/define-tool.js";
import {
  FFMPEG,
  FFPROBE,
  houseStyle,
  programFailure,
  REVIEW_PATH,
  run,
  slug,
  textAndJson,
} from "./common.js";
import { analisarQuadrosUnicos } from "./quadros.js";

const SINAL_FPS = 12;
const SINAL_W = 90;

export const CATEGORIAS_EDITORIAIS = { gancho: 10, clareza: 15, acabamento: 10, identidade: 10 };
export const TRAVAS = ["tudo_citado_aparece", "texto_sem_erro", "sem_cara_de_ia"];
/** Veredito previsto da revisão por problemas → veredito do pacote. */
export const VEREDITOS: Record<string, string> = {
  aprovaria: "pronto",
  "aprovaria com ajustes": "revisar",
  "pediria refação": "refazer",
};

// ------------------------------------------------------------- sinal de movimento

/** Picos com proeminência e distância mínima, como o scipy.signal.find_peaks de densidade.py. */
export function acharPicos(s: number[], proeminencia: number, distancia: number): number[] {
  const candidatos: Array<{ i: number; p: number }> = [];
  for (let i = 1; i < s.length - 1; i++) {
    if (!(s[i] > s[i - 1] && s[i] >= s[i + 1])) continue;
    let minE = s[i];
    for (let k = i - 1; k >= 0 && s[k] <= s[i]; k--) minE = Math.min(minE, s[k]);
    let minD = s[i];
    for (let k = i + 1; k < s.length && s[k] <= s[i]; k++) minD = Math.min(minD, s[k]);
    const p = s[i] - Math.max(minE, minD);
    if (p >= proeminencia) candidatos.push({ i, p: s[i] });
  }
  candidatos.sort((a, b) => b.p - a.p);
  const escolhidos: number[] = [];
  for (const c of candidatos) {
    if (escolhidos.every((e) => Math.abs(e - c.i) >= distancia)) escolhidos.push(c.i);
  }
  return escolhidos.sort((a, b) => a - b);
}

export interface Movimento {
  duracao: number;
  eventosPor10s: number;
  tempoParadoPct: number;
  maiorRepousoSec: number;
  primeiraMudancaSec: number | null;
  cortes: number;
  cortesPorMinuto: number;
  eventos: number[];
}

/** s = diferença média por quadro (cinza 0–255, 12 qps). Parado e picos com os limites de densidade.py. */
export function medirMovimento(s: number[], fps = SINAL_FPS): Movimento {
  const duracao = (s.length + 1) / fps;
  const picos = acharPicos(s, 3, 3);
  let parados = 0;
  let corrida = 0;
  let maior = 0;
  for (const v of s) {
    if (v < 0.4) {
      parados++;
      corrida++;
      maior = Math.max(maior, corrida);
    } else corrida = 0;
  }
  const primeira = s.findIndex((v) => v >= 0.4);
  // Corte: salto grande e muito acima do que acontece em volta (mesma lógica adaptativa do PR, sem OpenCV).
  const cortes: number[] = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] < 12) continue;
    let soma = 0;
    let n = 0;
    for (let k = Math.max(0, i - 6); k <= Math.min(s.length - 1, i + 6); k++) {
      if (Math.abs(k - i) <= 1) continue;
      soma += s[k];
      n++;
    }
    const media = n ? soma / n : 0;
    if (s[i] >= 3.2 * Math.max(media, 1) && (!cortes.length || i - cortes[cortes.length - 1] >= 3))
      cortes.push(i);
  }
  return {
    duracao: Number(duracao.toFixed(2)),
    eventosPor10s: duracao ? Number(((10 * picos.length) / duracao).toFixed(2)) : 0,
    tempoParadoPct: s.length ? Math.round((100 * parados) / s.length) : 0,
    maiorRepousoSec: Number((maior / fps).toFixed(2)),
    primeiraMudancaSec: primeira < 0 ? null : Number(((primeira + 1) / fps).toFixed(2)),
    cortes: cortes.length,
    cortesPorMinuto: duracao ? Number(((60 * cortes.length) / duracao).toFixed(2)) : 0,
    eventos: picos.map((i) => Number(((i + 1) / fps).toFixed(2))),
  };
}

// ------------------------------------------------------------- leitura do arquivo

function lerSinal(video: string, w: number, h: number): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      FFMPEG,
      [
        "-v",
        "error",
        "-threads",
        "4",
        "-i",
        video,
        "-vf",
        `fps=${SINAL_FPS},scale=${w}:${h}:flags=area,format=gray`,
        "-f",
        "rawvideo",
        "-",
      ],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    const tamanho = w * h;
    let anterior: Buffer | null = null;
    let sobra: Buffer = Buffer.alloc(0);
    let erro = "";
    const s: number[] = [];
    proc.stdout.on("data", (d: Buffer) => {
      sobra = sobra.length ? Buffer.concat([sobra, d]) : d;
      while (sobra.length >= tamanho) {
        const q = Buffer.from(sobra.subarray(0, tamanho));
        sobra = sobra.subarray(tamanho);
        if (anterior) {
          let soma = 0;
          for (let i = 0; i < tamanho; i++) soma += Math.abs(q[i] - anterior[i]);
          s.push(soma / tamanho);
        }
        anterior = q;
      }
    });
    proc.stderr.on("data", (d) => (erro += String(d)));
    proc.on("error", (e) => reject(new Error(programFailure(FFMPEG, e))));
    proc.on("close", (code) =>
      code === 0 ? resolve(s) : reject(new Error(`ffmpeg: ${erro.trim().slice(0, 300)}`)),
    );
  });
}

export function lerAudioScan(texto: string): {
  lufs: number | null;
  picoDb: number | null;
  silencios: Array<{ ini: number; fim: number; dur: number }>;
} {
  const lufs = [...texto.matchAll(/\bI:\s*(-?[\d.]+)\s+LUFS/g)].pop();
  const pico = [...texto.matchAll(/\bPeak:\s*(-?[\d.]+|-?inf)\s+dBFS/gi)].pop();
  const inicios = [...texto.matchAll(/silence_start:\s*(-?[\d.]+)/g)].map((m) => Number(m[1]));
  const fins = [...texto.matchAll(/silence_end:\s*([\d.]+)\s*\|\s*silence_duration:\s*([\d.]+)/g)];
  const silencios = fins.map((m, i) => {
    const fim = Number(m[1]);
    const dur = Number(m[2]);
    return { ini: Math.max(0, inicios[i] ?? fim - dur), fim, dur };
  });
  return {
    lufs: lufs ? Number(lufs[1]) : null,
    picoDb: pico && !/inf/i.test(pico[1]) ? Number(pico[1]) : null,
    silencios,
  };
}

export function lerVideoScan(texto: string): {
  pretos: Array<{ ini: number; fim: number }>;
  congelados: Array<{ ini: number; dur: number }>;
} {
  const pretos = [...texto.matchAll(/black_start:([\d.]+)\s+black_end:([\d.]+)/g)].map((m) => ({
    ini: Number(m[1]),
    fim: Number(m[2]),
  }));
  const inicios = [...texto.matchAll(/freeze_start:\s*([\d.]+)/g)].map((m) => Number(m[1]));
  const durs = [...texto.matchAll(/freeze_duration:\s*([\d.]+)/g)].map((m) => Number(m[1]));
  return { pretos, congelados: durs.map((dur, i) => ({ ini: inicios[i] ?? 0, dur })) };
}

// ------------------------------------------------------------- pontuação

export interface Stream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  sample_rate?: string;
  color_primaries?: string;
  color_transfer?: string;
}

function faixa(valor: number, [a, b]: number[]): number {
  if (valor < a) return a - valor;
  if (valor > b) return valor - b;
  return 0;
}

export function notaTecnica(streams: Stream[], formato: string) {
  const v = streams.find((s) => s.codec_type === "video");
  const a = streams.find((s) => s.codec_type === "audio");
  const notas: string[] = [];
  let p = 0;
  if (v) p += 1;
  if (a) p += 1;
  else notas.push("sem trilha de áudio");
  if (v?.width && v.height) {
    const menor = Math.min(v.width, v.height);
    p += menor >= 1080 ? 3 : menor >= 720 ? 2 : 0;
    const proporcao = v.width / v.height;
    const padrao = [9 / 16, 16 / 9, 1, 4 / 5].some((r) => Math.abs(proporcao - r) <= 0.02);
    p += padrao ? 2 : 1;
    if (menor < 1080) notas.push(`resolução baixa: ${v.width}x${v.height}`);
    if (!padrao) notas.push(`proporção fora do padrão: ${v.width}x${v.height}`);
    const [n, d] = String(v.avg_frame_rate ?? "0/1")
      .split("/")
      .map(Number);
    const fps = d ? n / d : 0;
    if (fps >= 23.5 && fps <= 60.1) p += 2;
    else notas.push(`quadros por segundo incomuns: ${fps.toFixed(2)}`);
    p += v.codec_name === "h264" ? 2 : v.codec_name === "hevc" ? 1 : 0;
    if (v.codec_name !== "h264") notas.push(`codec ${v.codec_name}, a entrega da casa é H.264`);
    if (v.color_primaries === "bt709" && v.color_transfer === "bt709") p += 2;
    else notas.push("sem etiqueta BT.709: etiquetar na junção");
  }
  if (/mp4/.test(formato)) p += 1;
  if (a) {
    const hz = Number(a.sample_rate ?? 0);
    if (hz === 48000) p += 1;
    else notas.push(`áudio a ${hz} Hz, a entrega da casa é 48 kHz`);
  }
  return { nota: Math.min(15, p), maximo: 15, notas };
}

export function notaAudio(
  scan: ReturnType<typeof lerAudioScan>,
  duracao: number,
  lufsAlvo: number,
  A: any,
) {
  const notas: string[] = [];
  let p = 0;
  if (scan.lufs === null) return { nota: 0, maximo: 15, notas: ["sem medida de loudness"] };
  const desvio = Math.abs(scan.lufs - lufsAlvo);
  p += desvio <= 1 ? 6 : desvio <= 2 ? 4 : desvio <= 4 ? 2 : 0;
  notas.push(`${scan.lufs} LUFS (alvo ${lufsAlvo})`);
  if (scan.picoDb !== null) {
    p += scan.picoDb <= A.picoMaxDb ? 4 : scan.picoDb <= -0.1 ? 2 : 0;
    notas.push(`pico ${scan.picoDb} dBFS`);
  }
  const total = scan.silencios.reduce((x, s) => x + s.dur, 0);
  const razao = duracao ? total / duracao : 1;
  p += razao <= 0.05 ? 3 : razao <= 0.1 ? 2 : razao <= 0.2 ? 1 : 0;
  const longos = scan.silencios.filter((s) => s.dur >= A.silencioLongoSec);
  p += !longos.length ? 2 : longos.length === 1 ? 1 : 0;
  notas.push(`silêncio ${Math.round(razao * 100)}% do tempo, ${longos.length} trecho(s) longo(s)`);
  return { nota: p, maximo: 15, notas };
}

export function notaRitmo(m: Movimento, perfil: any) {
  const notas: string[] = [];
  let p = 0;
  const d1 = faixa(m.eventosPor10s, perfil.eventosPor10s);
  p += d1 === 0 ? 6 : d1 <= 1 ? 4 : d1 <= 2 ? 2 : 0;
  notas.push(`${m.eventosPor10s} eventos por 10 s (faixa ${perfil.eventosPor10s.join("–")})`);
  const d2 = faixa(m.tempoParadoPct, perfil.paradoPct);
  p += d2 === 0 ? 5 : d2 <= 10 ? 3 : d2 <= 20 ? 1 : 0;
  notas.push(`parado ${m.tempoParadoPct}% do tempo (faixa ${perfil.paradoPct.join("–")}%)`);
  const r = perfil.repousoMaxSec;
  p += m.maiorRepousoSec <= r ? 4 : m.maiorRepousoSec <= r * 2 ? 2 : 0;
  notas.push(`maior trecho parado ${m.maiorRepousoSec} s (até ${r} s)`);
  return { nota: p, maximo: 15, notas };
}

export function notaAbertura(
  m: Movimento,
  audio: ReturnType<typeof lerAudioScan>,
  video: ReturnType<typeof lerVideoScan>,
) {
  const notas: string[] = [];
  let p = 0;
  const q = m.primeiraMudancaSec;
  p += q !== null && q <= 0.5 ? 4 : q !== null && q <= 1 ? 2 : 0;
  notas.push(`primeira mudança na tela em ${q ?? "nunca"} s`);
  const silencioInicial = audio.silencios.find((s) => s.ini <= 0.05);
  const primeiroSom = silencioInicial ? silencioInicial.fim : 0;
  p += primeiroSom <= 0.5 ? 3 : primeiroSom <= 2 ? 2 : primeiroSom <= 5 ? 1 : 0;
  notas.push(`primeiro som em ${primeiroSom.toFixed(2)} s`);
  const defeito =
    video.pretos.some((x) => x.ini < 3) || video.congelados.some((x) => x.ini < 3 && x.dur >= 1);
  p += defeito ? 0 : 3;
  if (defeito) notas.push("preto ou imagem congelada nos 3 primeiros segundos");
  return { nota: p, maximo: 10, notas };
}

export function vereditoFinal(
  medida: number,
  editorial: number | null,
  travasFalhas: string[],
  A: any,
) {
  if (travasFalhas.length) return "travado";
  if (editorial === null) return "falta_revisao_editorial";
  const total = medida + editorial;
  return total >= A.pronto ? "pronto" : total >= A.revisar ? "revisar" : "refazer";
}

// ------------------------------------------------------------- pacote para o Gemini

async function folha(
  video: string,
  destino: string,
  tempos: number[],
  fps: number,
  colunas: number,
) {
  const quadros = [...new Set(tempos.map((t) => Math.max(0, Math.round(t * fps))))];
  return folhaIndices(video, destino, quadros, colunas);
}

async function folhaIndices(video: string, destino: string, quadros: number[], colunas: number) {
  quadros = [...new Set(quadros)].sort((a, b) => a - b);
  if (!quadros.length) return false;
  const selecao = quadros.map((n) => `eq(n\\,${n})`).join("+");
  const linhas = Math.ceil(quadros.length / colunas);
  const r = await run(FFMPEG, [
    "-y",
    "-loglevel",
    "error",
    "-threads",
    "4",
    "-i",
    video,
    "-vf",
    `select='${selecao}',scale=360:-2,tile=${colunas}x${linhas}:padding=4`,
    "-fps_mode",
    "vfr",
    "-frames:v",
    "1",
    "-q:v",
    "4",
    destino,
  ]);
  return r.code === 0;
}

function modeloRevisao() {
  return {
    problemas: [
      {
        t: "0:03-0:05",
        regra: "R1",
        visto: "",
        correcao: "",
        gravidade: "alta|media|baixa",
        incerto: false,
      },
    ],
    veredito_previsto: "aprovaria|aprovaria com ajustes|pediria refação",
    razao: "",
  };
}

interface CasaRevisao {
  regras: { id: string; nome: string; texto: string }[];
  casos: { projeto: string; veredito: string; texto: string }[];
}

export function lerCasaRevisao(arquivo = REVIEW_PATH): CasaRevisao {
  try {
    const d = JSON.parse(readFileSync(arquivo, "utf8"));
    return { regras: d.regras ?? [], casos: d.casos ?? [] };
  } catch {
    return { regras: [], casos: [] };
  }
}

/** Fatos medidos que o revisor não pode contradizer (não entram como nota: a nota ancorava a revisão). */
function fatosMedidos(medido: any): string[] {
  const f: string[] = [];
  const au = medido.audio ?? {};
  f.push(
    `- duração ${Number(medido.duracao).toFixed(1)} s; áudio ${au.lufs ?? "?"} LUFS, pico ${au.picoDb ?? "?"} dB`,
  );
  const sil = (au.silencios ?? []).filter((x: any) => x.dur >= 0.8);
  f.push(
    sil.length
      ? `- silêncio de verdade: ${sil.map((x: any) => `${x.ini.toFixed(1)}–${x.fim.toFixed(1)} s`).join(", ")}`
      : "- nenhum trecho de silêncio de 0,8 s ou mais: não afirme que falta som",
  );
  const d = medido.defeitos ?? {};
  if (d.pretos?.length)
    f.push(`- tela preta: ${d.pretos.map((x: any) => `${x.ini}–${x.fim} s`).join(", ")}`);
  if (d.congelados?.length)
    f.push(
      `- imagem parada ≥ 0,6 s: ${d.congelados.map((x: any) => `${x.ini} s (${x.dur} s)`).join(", ")}`,
    );
  if (d.quadrosUnicos?.estado === "ok" && d.quadrosUnicos.total)
    f.push(
      `- ${d.quadrosUnicos.total} quadro(s) isolado(s): ${d.quadrosUnicos.alertas.map((x: any) => `${x.segundo} s`).join(", ")}`,
    );
  return f;
}

export function textoRevisao(
  video: string,
  medido: any,
  folhas: string[],
  tipo: string,
  contexto = "",
  casa: CasaRevisao = lerCasaRevisao(),
): string {
  const alvo = video.replace(/\\/g, "/");
  const casos = casa.casos.filter((c) => !alvo.includes(c.projeto));
  const linhas = [
    `# Revisão editorial: ${path.basename(video)}`,
    "",
    "> Tipo: dados · Gerado por ae_avaliar_render · regras e casos no arquivo de regras de revisão (TUIFT_REVIEW_RULES)",
    "",
    "Você é o revisor de vídeos de um estúdio. Quem aprova é o diretor. Seu trabalho é prever o que ELE vai reprovar, não dar nota de gosto genérico.",
    "",
    `Vídeo: ${tipo}. ${contexto}`.trim(),
    "",
    ...(casa.regras.length
      ? [
          "## Regras da casa (cada uma já foi cobrada pelo diretor)",
          "",
          ...casa.regras.map((r) => `- **${r.id} ${r.nome}:** ${r.texto}`),
          "",
        ]
      : []),
    ...(casos.length
      ? [
          "## Casos já decididos pelo diretor (calibração)",
          "",
          ...casos.map((c) => `- ${c.veredito}: ${c.texto}`),
          "",
        ]
      : []),
    "## Fatos medidos no arquivo (não contradiga)",
    "",
    ...fatosMedidos(medido),
    "",
    "## Instruções",
    "",
    '- Assista ao vídeo inteiro com áudio. Liste SÓ problemas que dá para apontar num tempo exato. Para cada um: tempo, regra violada, o que se vê/ouve e a correção concreta (o que fazer, não "melhorar").',
    '- Não elogie. Não repita uma regra sem um tempo. Se não tiver certeza, marque "incerto": true.',
    '- Gravidade "alta" só para o que repete um padrão de caso REPROVADO acima (vídeo simples/amador, teleprompter, peças prontas, painel genérico). Detalhe de acabamento é "media" ou "baixa".',
    '- No fim, preveja o veredito dele: "aprovaria" (nenhum alta), "aprovaria com ajustes" (só médias/baixas, corrigíveis sem refazer cenas) ou "pediria refação" (algum alta), e a principal razão em uma frase.',
    "",
    "## Arquivos",
    "",
    `- vídeo: ${alvo}`,
    ...folhas.map((f) => `- folha: ${f.replace(/\\/g, "/")}`),
    "",
    "## Responda só com este JSON",
    "",
    "```json",
    JSON.stringify(modeloRevisao(), null, 2),
    "```",
    "",
    'Depois: `ae_avaliar_render { video, revisao: "revisao.json" }` dá o veredito.',
    "",
  ];
  return linhas.join("\n");
}

/** Revisão por problemas (08/11/2026): valida e traduz o veredito previsto. */
export function lerProblemas(revisao: any): {
  veredito: string | null;
  problemas: any[];
  erro?: string;
} {
  const v = String(revisao?.veredito_previsto ?? "")
    .trim()
    .toLowerCase();
  if (!(v in VEREDITOS))
    return {
      veredito: null,
      problemas: [],
      erro: `veredito_previsto precisa ser ${Object.keys(VEREDITOS).join(" | ")}`,
    };
  const problemas = Array.isArray(revisao.problemas) ? revisao.problemas : [];
  // "aprovaria" com problema alto é contradição: vale o problema.
  const alta = problemas.some((p: any) => /alta/i.test(String(p?.gravidade)) && !p?.incerto);
  return { veredito: alta && v !== "pediria refação" ? "refazer" : VEREDITOS[v], problemas };
}

export function somarRevisao(revisao: any): {
  editorial: number | null;
  falhas: string[];
  pendentes: string[];
  erro?: string;
} {
  let total = 0;
  for (const [k, max] of Object.entries(CATEGORIAS_EDITORIAIS)) {
    const bruta = revisao?.categorias?.[k]?.nota;
    const n = Number(bruta);
    // null e texto vazio viram 0 no Number(): nota em branco é revisão por fazer, não nota zero.
    if (
      bruta === null ||
      bruta === undefined ||
      bruta === "" ||
      !Number.isFinite(n) ||
      n < 0 ||
      n > max
    )
      return {
        editorial: null,
        falhas: [],
        pendentes: [],
        erro: `nota de ${k} precisa ir de 0 a ${max}`,
      };
    total += n;
  }
  const falhas = TRAVAS.filter((t) =>
    /falh|reprov|fail/i.test(String(revisao?.travas?.[t]?.status)),
  );
  const pendentes = TRAVAS.filter(
    (t) =>
      !/^(ok|passou|aprovad[oa]|pass)/i.test(String(revisao?.travas?.[t]?.status)) &&
      !falhas.includes(t),
  );
  return { editorial: total, falhas, pendentes };
}

// ------------------------------------------------------------- ferramenta

async function idDoArquivo(video: string): Promise<string> {
  const st = await fs.stat(video);
  const h = createHash("sha1");
  h.update(String(st.size));
  const fd = await fs.open(video, "r");
  try {
    const tam = Math.min(1048576, st.size);
    const a = Buffer.alloc(tam);
    await fd.read(a, 0, tam, 0);
    h.update(a);
    const b = Buffer.alloc(tam);
    await fd.read(b, 0, tam, Math.max(0, st.size - tam));
    h.update(b);
  } finally {
    await fd.close();
  }
  return `${slug(path.basename(video, path.extname(video)))}-${h.digest("hex").slice(0, 10)}`;
}

export const avaliarRenderTool = defineTool({
  name: "ae_avaliar_render",
  title: "Review a rendered video (measured + list of problems)",
  description:
    "Review a RENDERED video in two layers. First call: measures 55 points from the file (technical, audio, rhythm, opening) and writes a review packet for Gemini " +
    "(contact sheets, REVISAO.md with the house rules and the director's decided cases, a JSON to fill in). Second call with `revisao`: a LIST OF PROBLEMS " +
    "(time, rule, what is seen, concrete fix, severity) plus the predicted verdict of the director → pronto (aprovaria), revisar (aprovaria com ajustes) or " +
    "refazer (pediria refação); a high-severity problem forces refazer. Old 0-45 reviews (categorias + travas) are still accepted. Pass `contexto` (what the video is) " +
    "for a better packet. Each file content gets its own id, and `evolucao` compares the versions in the folder. Does not need After Effects.",
  group: "render",
  blockedInReadOnly: false,
  effect: "write",
  inputShape: {
    video: z.string().describe("The rendered file."),
    tipo: z
      .enum(["narrado", "cinetico", "musica", "livre"])
      .optional()
      .describe("Rhythm profile (default narrado)."),
    lufsAlvo: z.number().optional().describe("Loudness target (default the house value, -14)."),
    outDir: z
      .string()
      .optional()
      .describe("Where evaluations live (default <video folder>/_avaliacoes)."),
    revisao: z
      .union([z.string(), z.record(z.string(), z.unknown())])
      .optional()
      .describe("The filled review: path to the JSON or the object. Adds the editorial layer."),
    contexto: z
      .string()
      .optional()
      .describe(
        "What the video is (format, subject, story), written into REVISAO.md for the reviewer.",
      ),
    forcar: z.boolean().optional().describe("Measure again even if this content was measured."),
  },
  handler: async (args) => {
    const video = path.resolve(args.video);
    if (!existsSync(video)) return errorResult("IO", `video not found: ${video}`);
    const style = houseStyle();
    const A = style.avaliacao;
    const tipo = args.tipo ?? "narrado";
    const perfil = A.perfis[tipo];
    const raiz = path.resolve(args.outDir ?? path.join(path.dirname(video), "_avaliacoes"));
    const id = await idDoArquivo(video);
    const pasta = path.join(raiz, id);
    await fs.mkdir(pasta, { recursive: true });
    const arquivoMedido = path.join(pasta, "medido.json");

    let medido: any = null;
    if (!args.forcar && existsSync(arquivoMedido)) {
      try {
        medido = JSON.parse(readFileSync(arquivoMedido, "utf8"));
      } catch {
        medido = null;
      }
    }
    if (
      medido &&
      (medido.tipo !== tipo || (args.lufsAlvo !== undefined && medido.lufsAlvo !== args.lufsAlvo))
    )
      medido = null;
    // Older cached reports did not inspect every frame. A failed scan must be retried too.
    if (medido && medido.defeitos?.quadrosUnicos?.estado !== "ok") medido = null;

    if (!medido) {
      const probe = await run(FFPROBE, [
        "-v",
        "error",
        "-show_streams",
        "-show_format",
        "-of",
        "json",
        video,
      ]);
      if (probe.code !== 0)
        return errorResult("IO", `ffprobe: ${probe.stderr.trim().slice(0, 300)}`);
      const info = JSON.parse(probe.stdout);
      const streams: Stream[] = info.streams ?? [];
      const v = streams.find((s) => s.codec_type === "video");
      if (!v?.width || !v.height) return errorResult("IO", "the file has no video stream");
      const temAudio = streams.some((s) => s.codec_type === "audio");
      const lufsAlvo = args.lufsAlvo ?? style.render.lufs;

      let scanAudio = lerAudioScan("");
      if (temAudio) {
        const r = await run(
          FFMPEG,
          [
            "-hide_banner",
            "-nostats",
            "-threads",
            "4",
            "-i",
            video,
            "-vn",
            "-af",
            `ebur128=peak=true,silencedetect=noise=${A.silencioDb}dB:d=${A.silencioMinSec}`,
            "-f",
            "null",
            "-",
          ],
          { timeoutMs: 600_000 },
        );
        scanAudio = lerAudioScan(r.stderr);
      }
      const rVideo = await run(
        FFMPEG,
        [
          "-hide_banner",
          "-nostats",
          "-threads",
          "4",
          "-i",
          video,
          "-an",
          "-vf",
          "blackdetect=d=0.1:pix_th=0.05,freezedetect=n=0.001:d=0.6",
          "-f",
          "null",
          "-",
        ],
        { timeoutMs: 600_000 },
      );
      const scanVideo = lerVideoScan(rVideo.stderr);
      const altura = Math.round((v.height * SINAL_W) / v.width / 2) * 2;
      const sinal = await lerSinal(video, SINAL_W, altura);
      const movimento = medirMovimento(sinal);
      const duracao = Number(info.format?.duration ?? movimento.duracao);

      const partes = {
        tecnico: notaTecnica(streams, String(info.format?.format_name ?? "")),
        audio: notaAudio(scanAudio, duracao, lufsAlvo, A),
        ritmo: notaRitmo(movimento, perfil),
        abertura: notaAbertura(movimento, scanAudio, scanVideo),
      };
      const [n, d] = String(v.avg_frame_rate ?? "30/1")
        .split("/")
        .map(Number);
      const fps = n > 0 && d > 0 ? n / d : 30;
      const quadrosUnicos = await analisarQuadrosUnicos(video, v.width, v.height, fps);
      const folhas: string[] = [];
      const fAbertura = path.join(pasta, "folha-abertura.jpg");
      if (
        await folha(
          video,
          fAbertura,
          [0, 0.5, 1, 1.5, 2, 3, 4, 5].filter((t) => t < duracao),
          fps,
          4,
        )
      )
        folhas.push(fAbertura);
      const fGeral = path.join(pasta, "folha-geral.jpg");
      const tempos = Array.from({ length: 12 }, (_, i) => ((i + 0.5) * duracao) / 12);
      if (await folha(video, fGeral, tempos, fps, 4)) folhas.push(fGeral);
      if (quadrosUnicos.alertas.length) {
        const fQuadros = path.join(pasta, "folha-quadros-isolados.jpg");
        const indices = [
          ...new Set(
            quadrosUnicos.alertas
              .slice(0, 8)
              .flatMap((x) => [x.quadro - 1, x.quadro, x.quadro + 1]),
          ),
        ].sort((a, b) => a - b);
        if (await folhaIndices(video, fQuadros, indices, 3)) {
          folhas.push(fQuadros);
          quadrosUnicos.contexto = { folha: fQuadros.replace(/\\/g, "/"), quadros: indices };
        }
      }

      medido = {
        id,
        video: video.replace(/\\/g, "/"),
        medidoEm: new Date().toISOString(),
        tipo,
        lufsAlvo,
        duracao,
        tamanho: [v.width, v.height],
        fps: Number(fps.toFixed(3)),
        partes,
        medida: Object.values(partes).reduce((s, p) => s + p.nota, 0),
        movimento: { ...movimento, eventos: movimento.eventos.slice(0, 200) },
        audio: {
          lufs: scanAudio.lufs,
          picoDb: scanAudio.picoDb,
          silencios: scanAudio.silencios.slice(0, 50),
        },
        defeitos: { ...scanVideo, quadrosUnicos },
        folhas: folhas.map((f) => f.replace(/\\/g, "/")),
      };
      await fs.writeFile(arquivoMedido, JSON.stringify(medido, null, 2));
      // Medir de novo o mesmo arquivo não pode apagar uma revisão já preenchida.
      if (!existsSync(path.join(pasta, "revisao.json")))
        await fs.writeFile(
          path.join(pasta, "revisao.json"),
          JSON.stringify(modeloRevisao(), null, 2),
        );
    }
    // O pacote sai sempre de novo: regras e casos mudam a cada retorno do diretor.
    await fs.writeFile(
      path.join(pasta, "REVISAO.md"),
      textoRevisao(video, medido, medido.folhas ?? [], tipo, args.contexto ?? ""),
    );

    let editorial: number | null = null;
    let falhas: string[] = [];
    let pendentes: string[] = [];
    let revisao: any = null;
    let problemas: any[] | null = null;
    let porProblemas: string | null = null;
    if (args.revisao) {
      try {
        revisao =
          typeof args.revisao === "string"
            ? JSON.parse(readFileSync(path.resolve(pasta, args.revisao), "utf8"))
            : args.revisao;
      } catch (e) {
        return errorResult("IO", `não consegui ler a revisão: ${(e as Error).message}`);
      }
      if (revisao?.categorias) {
        // revisão antiga (nota 0–45 + travas)
        const soma = somarRevisao(revisao);
        if (soma.erro) return errorResult("INVALID_ARGS", soma.erro);
        editorial = soma.editorial;
        falhas = soma.falhas;
        pendentes = soma.pendentes;
      } else {
        const lida = lerProblemas(revisao);
        if (lida.erro) return errorResult("INVALID_ARGS", lida.erro);
        porProblemas = lida.veredito;
        problemas = lida.problemas;
      }
      await fs.writeFile(path.join(pasta, "revisao-final.json"), JSON.stringify(revisao, null, 2));
    }
    const calculado = porProblemas ?? vereditoFinal(medido.medida, editorial, falhas, A);
    // Sem as três travas respondidas, o melhor que sai é "revisar" (revisão antiga).
    const veredito = calculado === "pronto" && pendentes.length ? "revisar" : calculado;
    const total = editorial === null ? null : medido.medida + editorial;
    const altas = problemas?.filter((p) => /alta/i.test(String(p?.gravidade))).length ?? null;

    const arquivoHistorico = path.join(raiz, "historico.jsonl");
    await fs.appendFile(
      arquivoHistorico,
      `${JSON.stringify({ id, quando: new Date().toISOString(), arquivo: path.basename(video), tipo, medida: medido.medida, editorial, total, problemas: problemas?.length ?? null, altas, veredito })}\n`,
    );
    const porId = new Map<string, any>();
    for (const linha of readFileSync(arquivoHistorico, "utf8").split("\n").filter(Boolean)) {
      try {
        const r = JSON.parse(linha);
        porId.set(r.id, r);
      } catch {
        // linha quebrada não derruba a avaliação
      }
    }
    const evolucao = [...porId.values()].map((r) => ({
      arquivo: r.arquivo,
      medida: r.medida,
      total: r.total,
      problemas: r.problemas ?? null,
      veredito: r.veredito,
    }));
    const semRevisao = editorial === null && problemas === null;
    const revisor = "um modelo de vídeo (por exemplo o Gemini) com o vídeo e o texto de REVISAO.md";

    return textAndJson(
      {
        id,
        pasta: pasta.replace(/\\/g, "/"),
        tipo,
        medida: medido.medida,
        medidaMaximo: 55,
        editorial,
        total,
        veredito,
        partes: medido.partes,
        movimento: { ...medido.movimento, eventos: undefined },
        defeitos: medido.defeitos,
        travasFalharam: falhas,
        travasPendentes: pendentes,
        problemas,
        razao: revisao?.razao ?? null,
        evolucao,
        folhas: medido.folhas,
        proximo: semRevisao
          ? `peça a revisão: ${revisor}. Depois chame de novo com revisao: "revisao.json"`
          : veredito === "pronto"
            ? "assista antes de entregar: a revisão não substitui olhar"
            : "corrija cada problema no tempo indicado, renderize de novo e avalie o novo arquivo",
      },
      semRevisao
        ? `Medido: ${medido.medida}/55 (${tipo}). ${medido.defeitos.quadrosUnicos?.estado === "ok" ? `${medido.defeitos.quadrosUnicos.total} alerta(s) de quadro isolado; confira se são intencionais` : "análise de quadros isolados indisponível"}. Falta a revisão editorial.`
        : problemas !== null
          ? `Revisão: ${problemas.length} problema(s), ${altas} alto(s). Veredito previsto: ${veredito}. ${revisao?.razao ?? ""}`.trim()
          : `Nota: ${total}/100 (${medido.medida} medidos + ${editorial} editoriais). Veredito: ${veredito}.`,
    );
  },
});
