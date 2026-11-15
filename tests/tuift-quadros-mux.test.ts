import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { analisarQuadrosUnicos } from "../src/tuift/quadros.js";
import { muxAudio, runJob } from "../src/tuift/render.js";

const fakeAerender = vi.hoisted(() => ({
  parcial: "",
  completo: "",
  tentativas: 0,
  logErro: false,
}));
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");
  const { copyFileSync: copiar } = await import("node:fs");
  return {
    ...original,
    spawn: (cmd: string, args: string[], opts: unknown) => {
      if (cmd !== "aerender-falso") return original.spawn(cmd, args, opts as any);
      const child: any = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      fakeAerender.tentativas++;
      const primeira = fakeAerender.tentativas === 1;
      setImmediate(() => {
        copiar(
          primeira ? fakeAerender.parcial : fakeAerender.completo,
          args[args.indexOf("-output") + 1],
        );
        child.stdout.end(
          primeira && fakeAerender.logErro ? "aerender ERROR conexão encerrada" : "PROGRESS",
        );
        child.stderr.end();
        child.emit("close", 0);
      });
      return child;
    },
  };
});

const raiz = mkdtempSync(path.join(os.tmpdir(), "tuift-quadros-mux-"));
const ffmpeg = (args: string[]) =>
  execFileSync("ffmpeg", ["-v", "error", "-y", ...args], { stdio: "pipe", windowsHide: true });
const video = path.join(raiz, "base.mp4");
const preto = path.join(raiz, "quadro-preto.mp4");
const corte = path.join(raiz, "corte.mp4");
const variavel = path.join(raiz, "vfr.mp4");
const incompleto = path.join(raiz, "incompleto.mp4");
const audioCurto = path.join(raiz, "curto.wav");
const audioLongo = path.join(raiz, "longo.wav");

function probe(file: string) {
  return JSON.parse(
    execFileSync(
      "ffprobe",
      [
        "-v",
        "error",
        "-count_frames",
        "-show_entries",
        "stream=codec_type,nb_read_frames,duration",
        "-of",
        "json",
        file,
      ],
      { encoding: "utf8", windowsHide: true },
    ),
  );
}
function hashVideo(file: string) {
  return execFileSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      file,
      "-map",
      "0:v:0",
      "-c:v",
      "copy",
      "-f",
      "hash",
      "-hash",
      "sha256",
      "-",
    ],
    { encoding: "utf8", windowsHide: true },
  ).trim();
}

beforeAll(() => {
  // White background with an isolated black frame, and a lasting hard cut.
  const base = ["-f", "lavfi", "-i", "color=white:s=160x90:r=30:d=2"];
  const encode = ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "ultrafast"];
  ffmpeg([...base, ...encode, video]);
  ffmpeg([...base, "-frames:v", "23", ...encode, incompleto]);
  ffmpeg([
    ...base,
    "-vf",
    "drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill:enable='eq(n,30)'",
    ...encode,
    preto,
  ]);
  ffmpeg([
    ...base,
    "-vf",
    "drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill:enable='gte(n,30)'",
    ...encode,
    corte,
  ]);
  ffmpeg([
    ...base,
    "-vf",
    "drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill:enable='eq(n,30)',setpts=PTS+if(gte(N\\,30)\\,1/TB\\,0)",
    "-fps_mode",
    "passthrough",
    ...encode,
    variavel,
  ]);
  ffmpeg(["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=0.7", audioCurto]);
  ffmpeg(["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=3", audioLongo]);
}, 30_000);

afterAll(() => {
  // The target is the exact temporary folder created above, never a user path.
  if (path.dirname(path.resolve(raiz)) === path.resolve(os.tmpdir()))
    rmSync(raiz, { recursive: true, force: true });
});

describe("mux mantém a duração do vídeo", () => {
  for (const [tipo, audio] of [
    ["curto", audioCurto],
    ["longo", audioLongo],
  ] as const) {
    it(`preserva todos os quadros e o bitstream com áudio ${tipo}`, async () => {
      const saida = path.join(raiz, `mux-${tipo}.mp4`);
      await muxAudio(video, audio, saida);
      const original = probe(video).streams.find((s: any) => s.codec_type === "video");
      const streams = probe(saida).streams;
      const imagem = streams.find((s: any) => s.codec_type === "video");
      const som = streams.find((s: any) => s.codec_type === "audio");
      expect(imagem.nb_read_frames).toBe(original.nb_read_frames);
      expect(hashVideo(saida)).toBe(hashVideo(video));
      expect(Number(som.duration)).toBeLessThanOrEqual(Number(imagem.duration) + 0.05);
      if (tipo === "curto") expect(Number(som.duration)).toBeGreaterThan(1.8);
    }, 30_000);
  }
  it("o job real valida os quadros do mux e expõe o detector", async () => {
    const dir = path.join(raiz, "job");
    mkdirSync(dir);
    const job: any = {
      id: "teste-mux",
      comp: "FINAL",
      project: video,
      outDir: dir,
      final: path.join(dir, "final.mp4"),
      status: "running",
      startedAt: new Date().toISOString(),
      chunks: [{ s: 0, e: 59, file: video }],
    };
    await runJob(job, {
      aer: "",
      projectArg: "",
      om: "",
      audio: audioCurto,
      fps: 30,
      software: false,
      mode: "previa",
    });
    expect(job.error).toBeUndefined();
    expect(job.status).toBe("done");
    expect(job.checks.muxQuadros).toEqual({ antes: 60, depois: 60, igual: true });
    expect(job.checks.quadrosEsperados).toEqual({ esperados: 60, unidos: 60 });
    expect(job.checks.quadrosUnicos.estado).toBe("ok");
  }, 30_000);
  for (const [tipo, entrada, logErro] of [
    ["arquivo parcial", incompleto, false],
    ["erro no log apesar de arquivo completo", video, true],
  ] as const) {
    it(`não aceita ${tipo} como render concluído`, async () => {
      const dir = path.join(raiz, `job-invalido-${logErro}`);
      mkdirSync(dir);
      const trecho = path.join(dir, "trecho.mp4");
      const log = path.join(dir, "trecho.log");
      copyFileSync(entrada, trecho);
      if (logErro) writeFileSync(log, "aerender ERROR conexão encerrada");
      const job: any = {
        id: `teste-invalido-${logErro}`,
        comp: "FINAL",
        project: video,
        outDir: dir,
        final: path.join(dir, "final.mp4"),
        status: "running",
        startedAt: new Date().toISOString(),
        chunks: [{ s: 0, e: 59, file: trecho, code: 0, log }],
      };
      // No renderer is available in this test: a failed retry must stay failed.
      await runJob(job, {
        aer: "",
        projectArg: "",
        om: "",
        fps: 30,
        software: false,
        mode: "previa",
      });
      expect(job.status).toBe("failed");
      expect(existsSync(job.final)).toBe(false);
      const salvos = readdirSync(path.join(dir, "incompletos"));
      expect(salvos).toHaveLength(1);
      expect(existsSync(path.join(dir, "incompletos", salvos[0], "trecho.mp4"))).toBe(true);
      if (logErro)
        expect(existsSync(path.join(dir, "incompletos", salvos[0], "trecho.log"))).toBe(true);
    }, 30_000);
  }
  for (const logErro of [false, true]) {
    it(`refaz um trecho parcial da primeira tentativa${logErro ? " com erro no log" : " sem erro no log"}`, async () => {
      const dir = path.join(raiz, `job-retry-${logErro}`);
      mkdirSync(dir);
      const job: any = {
        id: `teste-retry-${logErro}`,
        comp: "FINAL",
        project: video,
        outDir: dir,
        final: path.join(dir, "final.mp4"),
        status: "running",
        startedAt: new Date().toISOString(),
        chunks: [{ s: 0, e: 59, file: path.join(dir, "trecho.mp4") }],
      };
      Object.assign(fakeAerender, { parcial: incompleto, completo: video, tentativas: 0, logErro });
      await runJob(job, {
        aer: "aerender-falso",
        projectArg: "",
        om: "",
        fps: 30,
        software: false,
        mode: "previa",
      });
      expect(job.error).toBeUndefined();
      expect(job.status).toBe("done");
      expect(fakeAerender.tentativas).toBe(2);
      expect(job.chunks[0].retriedSoftware).toBe(true);
      expect(job.checks.quadrosEsperados).toEqual({ esperados: 60, unidos: 60 });
      expect(readdirSync(path.join(dir, "incompletos"))).toHaveLength(1);
    }, 30_000);
  }
});

describe("detector de quadro isolado", () => {
  it("distingue um quadro preto de um corte persistente e da cena original", async () => {
    const [normal, falha, transicao] = await Promise.all([
      analisarQuadrosUnicos(video, 160, 90, 30),
      analisarQuadrosUnicos(preto, 160, 90, 30),
      analisarQuadrosUnicos(corte, 160, 90, 30),
    ]);
    expect(normal.estado).toBe("ok");
    expect(normal.total).toBe(0);
    expect(falha.estado).toBe("ok");
    expect(falha.tempoReal).toBe(true);
    expect(falha.alertas).toContainEqual(expect.objectContaining({ quadro: 30, segundo: 1 }));
    expect(transicao.total).toBe(0);
  }, 30_000);
  it("usa o timestamp do quadro em vídeo de taxa variável", async () => {
    const r = await analisarQuadrosUnicos(variavel, 160, 90, 20);
    expect(r.estado).toBe("ok");
    expect(r.tempoReal).toBe(true);
    expect(r.alertas).toContainEqual(expect.objectContaining({ quadro: 30, segundo: 2 }));
  }, 30_000);
});
