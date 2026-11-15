// Detect isolated one-frame changes in a rendered video. This is a visual
// warning, not a verdict: a designer may have put that frame there on purpose.
// Inspired by win4r/video-director qa_video.py (MIT), adapted for streaming.
import { spawn } from "node:child_process";
import { FFMPEG, programFailure } from "./common.js";

export interface QuadroUnico {
  quadro: number;
  segundo: number;
  intensidade: number;
}

export interface AnaliseQuadros {
  estado: "ok" | "indisponivel";
  quadros: number;
  alertas: QuadroUnico[];
  total: number;
  /** Timestamps came from decoded frames, rather than an assumed constant fps. */
  tempoReal: boolean;
  contexto?: { folha: string; quadros: number[] };
  erro?: string;
}

/** Mean pixel difference between two small greyscale frames. */
function diferenca(a: Buffer, b: Buffer): number {
  let soma = 0;
  for (let i = 0; i < a.length; i++) soma += Math.abs(a[i] - b[i]);
  return soma / a.length;
}

/** Analyze per-frame differences; indices are zero-based. */
export function acharQuadrosUnicos(
  mudancas: number[],
  pulando: number[],
  tempos: Array<number | undefined>,
  fps: number,
): AnaliseQuadros {
  const ordenado = mudancas
    .slice(1)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const meio = Math.floor(ordenado.length / 2);
  const mediana = !ordenado.length
    ? 0
    : ordenado.length % 2
      ? ordenado[meio]
      : (ordenado[meio - 1] + ordenado[meio]) / 2;
  const limite = Math.max(2, 4 * mediana);
  const alertas: QuadroUnico[] = [];
  let total = 0;
  let tempoReal = mudancas.every((_, i) => Number.isFinite(tempos[i]));
  for (let i = 1; i + 1 < mudancas.length; i++) {
    const antes = mudancas[i],
      depois = mudancas[i + 1],
      sem = pulando[i];
    if (!(antes > limite && depois > limite && sem < 0.35 * Math.min(antes, depois))) continue;
    const registrado = tempos[i];
    if (!Number.isFinite(registrado)) tempoReal = false;
    const segundo = Number.isFinite(registrado) ? registrado! : i / fps;
    total++;
    if (alertas.length < 200)
      alertas.push({
        quadro: i,
        segundo: Number(segundo.toFixed(3)),
        intensidade: Number(Math.min(antes, depois).toFixed(2)),
      });
  }
  return { estado: "ok", quadros: mudancas.length, alertas, total, tempoReal };
}

/** Decode once in the background; keep only three frames and scalar statistics. */
export function analisarQuadrosUnicos(
  video: string,
  larguraOriginal: number,
  alturaOriginal: number,
  fps: number,
): Promise<AnaliseQuadros> {
  return new Promise((resolve) => {
    if (!(larguraOriginal > 0 && alturaOriginal > 0 && fps > 0)) {
      resolve({
        estado: "indisponivel",
        quadros: 0,
        alertas: [],
        total: 0,
        tempoReal: false,
        erro: "dimensões ou fps inválidos",
      });
      return;
    }
    let w = 192;
    let h = Math.max(2, Math.round((w * alturaOriginal) / larguraOriginal / 2) * 2);
    if (h > 1024) {
      h = 1024;
      w = Math.max(2, Math.round((h * larguraOriginal) / alturaOriginal / 2) * 2);
    }
    const tamanho = w * h;
    const proc = spawn(
      FFMPEG,
      [
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "info",
        "-threads",
        "4",
        "-i",
        video,
        "-an",
        "-vf",
        `scale=${w}:${h}:flags=area,format=gray,showinfo`,
        "-fps_mode",
        "passthrough",
        "-f",
        "rawvideo",
        "-",
      ],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    let sobra: Buffer = Buffer.alloc(0);
    let anterior: Buffer | null = null;
    let anterior2: Buffer | null = null;
    let linhas = "",
      fimErro = "";
    const mudancas: number[] = [];
    const pulando: number[] = [];
    const tempos: Array<number | undefined> = [];
    let finalizado = false;
    const finish = (result: AnaliseQuadros) => {
      if (finalizado) return;
      finalizado = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      proc.kill();
      finish({
        estado: "indisponivel",
        quadros: mudancas.length,
        alertas: [],
        total: 0,
        tempoReal: false,
        erro: "tempo de análise esgotado",
      });
    }, 600_000);
    proc.stdout.on("data", (d: Buffer) => {
      sobra = sobra.length ? Buffer.concat([sobra, d]) : d;
      while (sobra.length >= tamanho) {
        const quadro = Buffer.from(sobra.subarray(0, tamanho));
        sobra = sobra.subarray(tamanho);
        const i = mudancas.length;
        mudancas.push(anterior ? diferenca(quadro, anterior) : 0);
        if (anterior2) pulando[i - 1] = diferenca(quadro, anterior2);
        anterior2 = anterior;
        anterior = quadro;
      }
    });
    proc.stderr.on("data", (d: Buffer) => {
      const texto = String(d);
      fimErro = (fimErro + texto).slice(-600);
      linhas += texto;
      const partes = linhas.split(/\r?\n/);
      linhas = partes.pop() ?? "";
      for (const linha of partes) {
        const m = linha.match(/\bn:\s*(\d+)\s+pts:\s*-?\d+\s+pts_time:\s*(-?[\d.]+)/);
        if (m) tempos[Number(m[1])] = Number(m[2]);
      }
    });
    proc.on("error", (e) =>
      finish({
        estado: "indisponivel",
        quadros: 0,
        alertas: [],
        total: 0,
        tempoReal: false,
        erro: programFailure(FFMPEG, e),
      }),
    );
    proc.on("close", (code) => {
      if (code !== 0 || !mudancas.length || sobra.length) {
        finish({
          estado: "indisponivel",
          quadros: mudancas.length,
          alertas: [],
          total: 0,
          tempoReal: false,
          erro: `ffmpeg ${code}: ${fimErro.trim().slice(-250)}`,
        });
      } else finish(acharQuadrosUnicos(mudancas, pulando, tempos, fps));
    });
  });
}
