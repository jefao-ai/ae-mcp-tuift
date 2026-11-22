// ae_render_video / ae_render_status — the studio's render as a background
// job: aerender in chunks (30 s 2D · 15 s Advanced 3D · 10 s heavy) with
// multi-frame rendering on, up to 2 processes at once at BelowNormal priority
// (8 threads left free, a new aerender only when RAM is to spare, one at a
// time when a process named in TUIFT_GAME_PROCESSES is running), chunks joined without re-encoding and tagged
// BT.709, optional audio mux with a loudness read-out, then automatic checks
// (black stretches, frozen picture, frame count). A chunk that fails with MFR
// on is rendered again with it off. aerender cannot open paths with "ç": the
// project is reached through its 8.3 short path, or copied to an ASCII work folder.

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  promises as fs,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import { resolveAfterFxPath } from "../config.js";
import { errorResult } from "../errors.js";
import { defineTool } from "../tools/define-tool.js";
import { type Cena, filtrarCenas, LER_CENAS_FN } from "./cenas.js";
import { analisarQuadrosUnicos } from "./quadros.js";
import {
  FFMPEG,
  FFPROBE,
  WORK_DIR,
  houseStyle,
  run,
  runJsx,
  slug,
  stamp,
  textAndJson,
} from "./common.js";
import { lerEnv } from "./env.js";

interface Chunk {
  s: number;
  e: number;
  file: string;
  code?: number;
  seconds?: number;
  log?: string;
  /** The chunk failed with multi-frame rendering on and was rendered again with it off. */
  retriedSoftware?: boolean;
  /** Times the RAM guard killed this chunk's aerender. */
  ramKills?: number;
}
interface Job {
  id: string;
  comp: string;
  project: string;
  outDir: string;
  final: string;
  status: "running" | "done" | "failed";
  chunks: Chunk[];
  startedAt: string;
  finishedAt?: string;
  checks?: Record<string, unknown>;
  error?: string;
  current?: number;
  /** Process running the job (the detached worker, or this server when it runs in-process). */
  pid?: number;
}

export interface JobOpts {
  aer: string;
  projectArg: string;
  om: string;
  /** Render settings template as named in this AE (localized); default: the mode's English name. */
  rs?: string;
  audio?: string;
  fps: number;
  software: boolean;
  mode: Mode;
}

const JOBS = new Map<string, Job>();

// Jobs outlive the server process: the render runs in a detached worker and
// every job leaves an index entry (jobId -> outDir) here, so ae_render_status
// finds it from any later server session (a client that spawns one server per
// call, or Claude restarted mid-render).
const JOBS_DIR = path.join(WORK_DIR, "render-jobs");
const HERE = path.dirname(fileURLToPath(import.meta.url));

function indexJob(job: Job): void {
  try {
    mkdirSync(JOBS_DIR, { recursive: true });
    writeFileSync(
      path.join(JOBS_DIR, `${job.id}.json`),
      JSON.stringify({ id: job.id, outDir: job.outDir, startedAt: job.startedAt }, null, 2),
    );
  } catch {
    /* best effort */
  }
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

function alive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The freshest view of a job: its job.json on disk (written by whichever process runs it), else memory. */
export function loadJob(id: string): Job | null {
  const outDir =
    JOBS.get(id)?.outDir ?? readJson<{ outDir: string }>(path.join(JOBS_DIR, `${id}.json`))?.outDir;
  const onDisk = outDir ? readJson<Job>(path.join(outDir, "job.json")) : null;
  const job = onDisk ?? JOBS.get(id) ?? null;
  if (job && job.status === "running" && job.pid && job.pid !== process.pid && !alive(job.pid)) {
    // The worker died without writing its end (PC restarted, process killed).
    return {
      ...job,
      status: "failed",
      error:
        "o processo do render parou antes de terminar; rode ae_render_video de novo com o mesmo outDir para reaproveitar os trechos prontos",
    };
  }
  return job;
}

function recentJobIds(limit = 20): string[] {
  const ids = new Set<string>(JOBS.keys());
  try {
    const files = readdirSync(JOBS_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => ({
        id: f.slice(0, -5),
        at: readJson<{ startedAt?: string }>(path.join(JOBS_DIR, f))?.startedAt ?? "",
      }))
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, limit);
    for (const f of files) ids.add(f.id);
  } catch {
    /* no index yet */
  }
  return [...ids];
}

/**
 * Starts the job in a detached Node worker so it keeps rendering after this
 * server exits. Falls back to running in this process when the worker file is
 * missing (running from sources), TUIFT_RENDER_INPROCESS=1, or the spawn fails.
 */
function startJob(job: Job, opts: JobOpts): "worker" | "in-process" {
  const worker = path.join(HERE, "render-worker.js");
  if (existsSync(worker) && lerEnv("RENDER_INPROCESS") !== "1") {
    try {
      const spec = path.join(job.outDir, "job-spec.json");
      writeFileSync(spec, JSON.stringify({ job, opts }, null, 2));
      const p = spawn(process.execPath, [worker, spec], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env: process.env,
      });
      p.on("error", () => undefined);
      if (p.pid) {
        p.unref();
        job.pid = p.pid;
        persist(job);
        return "worker";
      }
    } catch {
      /* fall through to in-process */
    }
  }
  job.pid = process.pid;
  persist(job);
  void runJob(job, opts);
  return "in-process";
}

function persist(job: Job): void {
  try {
    writeFileSync(path.join(job.outDir, "job.json"), JSON.stringify(job, null, 2));
  } catch {
    /* best effort */
  }
}

const isAscii = (s: string) => /^[\x20-\x7e]*$/.test(s);

async function shortPath(p: string): Promise<string | null> {
  if (process.platform !== "win32") return null;
  const r = await run("cmd", ["/d", "/c", `for %I in ("${p}") do @echo %~sI`]);
  const out = r.stdout.trim().split(/\r?\n/).pop() ?? "";
  return out && isAscii(out) && existsSync(out) ? out : null;
}

type Mode = "leve" | "previa" | "turbo";

// Render modes (13/10, ver o resultado em minutos sem travar o PC; revisto em 31/10):
// leve   = padrão (Best Settings, MFR ligado, trechos de 30 s, até 2 aerender juntos, prioridade baixa,
//          8 threads livres para o resto do PC, um aerender novo só com RAM sobrando);
// previa = Draft Settings (qualidade de rascunho), um trecho só para o intervalo pedido, prioridade baixa;
// turbo  = só no render final: Best Settings, mais memória, prioridade normal, até 3 juntos, PC inteiro.
// Medido numa comp de 140 s, 1080×1920: abrir o aerender custa ~21 s antes do 1º quadro; o render
// antigo (141 trechos de 1 s… 2 s, MFR desligado, um por vez) levou 84 min; o leve novo, 3 min 55 s.
const MODES: Record<
  Mode,
  {
    rs: string;
    mem: [number, number];
    below: boolean;
    chunkMul: number;
    par: number;
    spareThreads: number;
  }
> = {
  leve: { rs: "Best Settings", mem: [20, 30], below: true, chunkMul: 1, par: 2, spareThreads: 8 },
  previa: {
    rs: "Draft Settings",
    mem: [20, 30],
    below: true,
    chunkMul: 0,
    par: 1,
    spareThreads: 8,
  },
  turbo: { rs: "Best Settings", mem: [30, 45], below: false, chunkMul: 2, par: 3, spareThreads: 0 },
};

/** Trecho mais curto que vale abrir um aerender (a abertura sozinha leva ~21 s). */
const MIN_CHUNK_SEC = 5;
/** Memória livre exigida para abrir mais um aerender quando já há outro rodando. */
const FREE_GB_FOR_EXTRA = 16;
/** Memória livre mínima para abrir qualquer aerender (espera liberar em vez de empurrar). */
const FREE_GB_MIN = 12;
/**
 * Vigia (um render pesado já travou o PC): abaixo disto, o
 * aerender mais novo é encerrado e o trecho volta para a fila; o mesmo trecho morto 2× falha o job.
 */
const FREE_GB_KILL = Number(lerEnv("RENDER_KILL_GB")) || 8;
/** Process names (comma-separated, without .exe) that make the render gentler while they run. Empty = off. */
const GAME_PROCESSES = (lerEnv("GAME_PROCESSES") ?? "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const freeGB = () => os.freemem() / 2 ** 30;

async function gameOpen(): Promise<boolean> {
  if (process.platform !== "win32" || GAME_PROCESSES.length === 0) return false;
  // Só os nomes dos processos, um por linha.
  const r = await run("powershell", ["-NoProfile", "-Command", "(Get-Process).ProcessName"]);
  return r.stdout.split(/\r?\n/).some((l) => GAME_PROCESSES.includes(l.trim().toLowerCase()));
}

/**
 * Prende este processo (o worker do render) aos primeiros núcleos e deixa `spare` threads livres; os aerender
 * filhos herdam a afinidade e a prioridade, então o PC continua respondendo enquanto renderiza.
 */
async function limitThisProcess(spare: number, below: boolean): Promise<void> {
  if (process.platform !== "win32") return;
  try {
    if (below) os.setPriority(os.constants.priority.PRIORITY_BELOW_NORMAL);
  } catch {
    /* ignore */
  }
  const n = os.cpus().length;
  if (spare <= 0 || n - spare < 4) return;
  const mask = (2n ** BigInt(n - spare) - 1n).toString();
  await run("powershell", [
    "-NoProfile",
    "-Command",
    "(Get-Process -Id " + process.pid + ").ProcessorAffinity = [IntPtr]" + mask,
  ]);
}

/** aerender em execução, para o vigia de memória. */
interface Live {
  pid: number;
  ch: Chunk;
  at: number;
  killed?: boolean;
}
const LIVE: Live[] = [];

function killTree(pid: number): void {
  if (process.platform === "win32") void run("taskkill", ["/pid", String(pid), "/T", "/F"]);
  else
    try {
      process.kill(pid);
    } catch {
      /* already gone */
    }
}

/** Every 2 s: with free RAM under FREE_GB_KILL, kill the newest aerender (one per 10 s) before the PC chokes. */
function startRamGuard(): () => void {
  let lastKill = 0;
  const t = setInterval(() => {
    if (freeGB() >= FREE_GB_KILL || Date.now() - lastKill < 10_000) return;
    const newest = LIVE.filter((l) => !l.killed).sort((a, b) => b.at - a.at)[0];
    if (!newest) return;
    newest.killed = true;
    newest.ch.ramKills = (newest.ch.ramKills ?? 0) + 1;
    lastKill = Date.now();
    killTree(newest.pid);
  }, 2000);
  return () => clearInterval(t);
}

class RamKill extends Error {}

function aerenderOnce(
  aer: string,
  args: string[],
  logFile: string,
  below = true,
  ch?: Chunk,
): Promise<number> {
  return new Promise((resolve) => {
    const p = spawn(aer, args, { windowsHide: true });
    const live: Live | null = p.pid && ch ? { pid: p.pid, ch, at: Date.now() } : null;
    if (live) LIVE.push(live);
    const chunks: Buffer[] = [];
    p.stdout.on("data", (b: Buffer) => chunks.push(b));
    p.stderr.on("data", (b: Buffer) => chunks.push(b));
    setTimeout(() => {
      try {
        if (p.pid && below) os.setPriority(p.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
      } catch {
        /* ignore */
      }
    }, 600);
    p.on("close", async (code) => {
      if (live) LIVE.splice(LIVE.indexOf(live), 1);
      await fs.writeFile(logFile, Buffer.concat(chunks)).catch(() => undefined);
      resolve(live?.killed ? -2 : (code ?? 1));
    });
    p.on("error", () => resolve(127));
  });
}

async function checks(file: string, fps: number): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  let dimensoes: { width?: number; height?: number } | undefined;
  const probe = await run(
    FFPROBE,
    [
      "-v",
      "error",
      "-count_frames",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=nb_read_frames,width,height,r_frame_rate:format=duration",
      "-of",
      "json",
      file,
    ],
    { timeoutMs: 600_000 },
  );
  try {
    const dados = JSON.parse(probe.stdout);
    out.probe = dados;
    dimensoes = dados.streams?.[0];
  } catch {
    out.probe = probe.stdout.slice(0, 400);
  }
  const det = await run(
    FFMPEG,
    [
      "-hide_banner",
      "-i",
      file,
      "-vf",
      "blackdetect=d=0.1:pix_th=0.05,freezedetect=n=0.001:d=0.6",
      "-an",
      "-f",
      "null",
      "-",
    ],
    { timeoutMs: 900_000 },
  );
  const black = [...det.stderr.matchAll(/black_start:([\d.]+) black_end:([\d.]+)/g)].map((m) => [
    Number(m[1]),
    Number(m[2]),
  ]);
  const freezes = [
    ...det.stderr.matchAll(/freeze_start: ([\d.]+)[\s\S]*?freeze_end: ([\d.]+)/g),
  ].map((m) => [Number(m[1]), Number(m[2])]);
  out.blackStretches = black;
  out.frozenStretches = freezes;
  out.quadrosUnicos = await analisarQuadrosUnicos(
    file,
    dimensoes?.width ?? 0,
    dimensoes?.height ?? 0,
    fps,
  );
  out.note =
    "Preto, congelado ou quadro isolado: confira se é intencional antes de corrigir. Imagem parada ou flash proposital é ok.";
  out.fps = fps;
  return out;
}

export async function runJob(job: Job, opts: JobOpts, worker = false): Promise<void> {
  const style = houseStyle();
  const mode = MODES[opts.mode];
  try {
    const game = await gameOpen();
    // Com jogo aberto (TUIFT_GAME_PROCESSES): um aerender por vez e metade das threads livres.
    const par = game ? 1 : mode.par;
    if (worker)
      await limitThisProcess(
        game ? Math.floor(os.cpus().length / 2) : mode.spareThreads,
        mode.below || game,
      );
    // A file can exist even after aerender was interrupted. Never reuse it
    // until its full frame count and the previous result have been checked.
    const pending: Chunk[] = [];
    for (const ch of job.chunks) {
      if (existsSync(ch.file)) {
        const erro = await erroTrecho(ch);
        if (!erro) {
          ch.code = 0;
          continue;
        }
        await guardarTrechoIncompleto(job, ch.file, ch.log);
      }
      ch.code = undefined;
      pending.push(ch);
    }
    let running = 0;
    const stopGuard = startRamGuard();
    const lane = async () => {
      for (let ch = pending.shift(); ch; ch = pending.shift()) {
        // Espera a memória sobrar antes de abrir mais um aerender, em vez de apertar o PC.
        while (freeGB() < (running > 0 ? FREE_GB_FOR_EXTRA : FREE_GB_MIN)) await sleep(3000);
        running++;
        job.current = job.chunks.indexOf(ch);
        persist(job);
        try {
          await renderChunk(job, opts, ch, style, opts.software);
        } catch (e) {
          if (!(e instanceof RamKill)) throw e;
          if ((ch.ramKills ?? 0) >= 2)
            throw new Error(
              `trecho ${ch.s}-${ch.e} encerrado 2× pelo vigia de memória (< ${FREE_GB_KILL} GB livres): ` +
                "feche programas pesados ou use chunkSec menor e rode de novo com o mesmo outDir",
            );
          pending.unshift(ch); // volta para a fila; o laço espera a memória antes de abrir de novo
        } finally {
          running--;
        }
        persist(job);
      }
    };
    const lanes = [lane()];
    for (let i = 1; i < par; i++) {
      await sleep(4000); // escalonado: a abertura dos aerender não cai toda no mesmo segundo
      lanes.push(lane());
    }
    try {
      await Promise.all(lanes);
    } finally {
      stopGuard();
      for (const l of LIVE) killTree(l.pid); // job falhou: não deixa aerender órfão segurando memória
    }
    job.current = undefined;
    const list = path.join(job.outDir, "trechos.txt");
    await fs.writeFile(
      list,
      job.chunks
        .map((c) => `file '${c.file.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`)
        .join("\n"),
    );
    await finish(job, opts, list, style);
  } catch (e) {
    job.status = "failed";
    job.error = e instanceof Error ? e.message : String(e);
  }
  job.finishedAt = new Date().toISOString();
  persist(job);
}

/** Renders one chunk; when it fails with MFR on (GPU/memory), tries once more with MFR off. */
async function renderChunk(
  job: Job,
  opts: JobOpts,
  ch: Chunk,
  style: ReturnType<typeof houseStyle>,
  software: boolean,
): Promise<void> {
  const mode = MODES[opts.mode];
  const t0 = Date.now();
  // aerender falha com "O diretório não existe" se a pasta do trecho sumiu.
  mkdirSync(path.dirname(ch.file), { recursive: true });
  const args = [
    "-project",
    opts.projectArg,
    "-comp",
    job.comp,
    "-s",
    String(ch.s),
    "-e",
    String(ch.e),
    "-RStemplate",
    opts.rs ?? mode.rs,
    "-OMtemplate",
    opts.om,
    "-output",
    ch.file,
    "-mem_usage",
    String(opts.mode === "leve" ? style.render.memUsage[0] : mode.mem[0]),
    String(opts.mode === "leve" ? style.render.memUsage[1] : mode.mem[1]),
    "-sound",
    "OFF",
    "-v",
    "ERRORS_AND_PROGRESS",
  ];
  if (software) args.push("-mfr", "OFF", "1");
  ch.log = ch.file.replace(/\.[^.]+$/, ".log");
  ch.code = await aerenderOnce(opts.aer, args, ch.log, mode.below, ch);
  ch.seconds = Math.round((Date.now() - t0) / 1000);
  if (ch.code === -2) {
    await fs.unlink(ch.file).catch(() => undefined);
    ch.code = undefined;
    throw new RamKill();
  }
  let arquivo = existsSync(ch.file) ? ch.file : undefined;
  // aerender's output module may pick its own extension (e.g. .mov→.mp4)
  if (!arquivo) {
    const dir = path.dirname(ch.file),
      stem = path.basename(ch.file, path.extname(ch.file));
    const alt = (await fs.readdir(dir)).find(
      (f) => f.startsWith(stem + ".") && !f.endsWith(".log"),
    );
    if (alt) arquivo = path.join(dir, alt);
  }
  const erro = arquivo ? await erroTrecho({ ...ch, file: arquivo }) : "arquivo ausente";
  if (!erro && arquivo) {
    ch.file = arquivo;
    return;
  }
  if (arquivo) await guardarTrechoIncompleto(job, arquivo, ch.log);
  if (!software) {
    ch.retriedSoftware = true;
    return renderChunk(job, opts, ch, style, true);
  }
  throw new Error(`trecho ${ch.s}-${ch.e} incompleto (${erro}; exit ${ch.code}); veja ${ch.log}`);
}

/** The picture sets the end: pad short audio instead of truncating video frames. */
export async function muxAudio(video: string, audio: string, output: string): Promise<void> {
  const m = await run(
    FFMPEG,
    [
      "-y",
      "-loglevel",
      "error",
      "-i",
      video,
      "-i",
      audio,
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-b:a",
      "320k",
      "-af",
      "apad",
      "-shortest",
      "-movflags",
      "+faststart",
      output,
    ],
    { timeoutMs: 900_000 },
  );
  if (m.code !== 0) throw new Error(`audio mux failed: ${m.stderr.trim()}`);
}

/** Read the MP4's frame count cheaply; decode if metadata is missing or suspect. */
async function contarQuadros(file: string, decodificar = false): Promise<number | null> {
  const r = await run(
    FFPROBE,
    [
      "-v",
      "error",
      ...(decodificar ? ["-count_frames"] : []),
      "-select_streams",
      "v:0",
      "-show_entries",
      `stream=${decodificar ? "nb_read_frames" : "nb_frames"}`,
      "-of",
      "json",
      file,
    ],
    { timeoutMs: 600_000 },
  );
  if (r.code !== 0 || (decodificar && r.stderr.trim())) return null;
  try {
    const stream = JSON.parse(r.stdout).streams?.[0];
    const valor = Number(stream?.[decodificar ? "nb_read_frames" : "nb_frames"]);
    return Number.isSafeInteger(valor) && valor > 0 ? valor : null;
  } catch {
    return null;
  }
}

/** An output is usable only when it contains the inclusive requested range. */
async function erroTrecho(ch: Chunk): Promise<string | null> {
  if (ch.code !== undefined && ch.code !== 0) return `aerender retornou ${ch.code}`;
  if (ch.log && existsSync(ch.log)) {
    const log = await fs.readFile(ch.log, "utf8");
    if (/aerender\s+ERROR/i.test(log)) return "erro do aerender no log";
  }
  const esperado = ch.e - ch.s + 1;
  // Decode the stream: container metadata can claim the correct frame count
  // even when an interrupted encoder left corrupt video packets behind.
  const obtido = await contarQuadros(ch.file, true);
  return obtido === esperado ? null : `esperados ${esperado} quadros, obtidos ${obtido ?? "?"}`;
}

/** Preserve a failed job's output without touching files outside its own folder. */
async function guardarTrechoIncompleto(job: Job, file: string, log?: string): Promise<void> {
  const rel = path.relative(path.resolve(job.outDir), path.resolve(file));
  if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`trecho incompleto fora da pasta do job: ${file}`);
  }
  const base = path.join(job.outDir, "incompletos");
  await fs.mkdir(base, { recursive: true });
  const dir = await fs.mkdtemp(path.join(base, "tentativa-"));
  await fs.rename(file, path.join(dir, path.basename(file)));
  if (log && existsSync(log)) await fs.copyFile(log, path.join(dir, path.basename(log)));
}

/** Joins the chunks, muxes the audio and runs the automatic checks. */
async function finish(
  job: Job,
  opts: JobOpts,
  list: string,
  style: ReturnType<typeof houseStyle>,
): Promise<void> {
  const joined = opts.audio ? path.join(job.outDir, "video-sem-audio.mp4") : job.final;
  const j = await run(
    FFMPEG,
    [
      "-y",
      "-loglevel",
      "error",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      list,
      "-c",
      "copy",
      "-bsf:v",
      "h264_metadata=colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1",
      "-movflags",
      "+faststart",
      joined,
    ],
    { timeoutMs: 900_000 },
  );
  if (j.code !== 0) throw new Error(`concat failed: ${j.stderr.trim()}`);
  const esperados = job.chunks.reduce((total, ch) => total + ch.e - ch.s + 1, 0);
  const unidos = await contarQuadros(joined, true);
  if (unidos !== esperados)
    throw new Error(`render incompleto: esperados ${esperados} quadros, obtidos ${unidos ?? "?"}`);
  let antesMux: number | null = null;
  if (opts.audio) {
    antesMux = await contarQuadros(joined);
    if (antesMux === null) antesMux = await contarQuadros(joined, true);
    await muxAudio(joined, opts.audio, job.final);
  }
  job.checks = await checks(job.final, opts.fps);
  job.checks.quadrosEsperados = { esperados, unidos };
  if (opts.audio) {
    const leitura = Number((job.checks.probe as any)?.streams?.[0]?.nb_read_frames);
    const depoisMux = Number.isSafeInteger(leitura) && leitura > 0 ? leitura : null;
    // If metadata disagrees, confirm by decoding the source before failing.
    if (antesMux !== null && depoisMux !== null && antesMux !== depoisMux) {
      antesMux = await contarQuadros(joined, true);
    }
    job.checks.muxQuadros = {
      antes: antesMux,
      depois: depoisMux,
      igual: antesMux !== null && antesMux === depoisMux,
    };
    if (antesMux === null || depoisMux === null)
      throw new Error("não foi possível verificar a contagem de quadros antes e depois do mux");
    if (antesMux !== depoisMux)
      throw new Error(`mux alterou a contagem de quadros: antes ${antesMux}, depois ${depoisMux}`);
  }
  if (opts.audio) {
    const l = await run(
      FFMPEG,
      ["-hide_banner", "-i", job.final, "-af", "ebur128=peak=true", "-vn", "-f", "null", "-"],
      { timeoutMs: 600_000 },
    );
    const I = l.stderr.match(/I:\s+(-?[\d.]+) LUFS/g)?.pop();
    const tp = l.stderr.match(/Peak:\s+(-?[\d.]+) dBFS/g)?.pop();
    job.checks.loudness = {
      integrated: I ?? null,
      truePeak: tp ?? null,
      target: `${style.render.lufs} LUFS (alvo de loudness do estilo)`,
    };
  }
  job.status = "done";
}

/**
 * Nomes dos modelos que a ponte pede (em inglês) nas outras línguas do AE. O aerender só aceita o
 * nome exato da instância: num AE em português, "Best Settings" falha com "No render settings
 * template was found with the given name".
 */
const TRADUCOES: Record<string, string[]> = {
  "Best Settings": ["Melhores configurações"],
  "Draft Settings": ["Configurações de rascunho"],
  "H.264 - Match Render Settings - 40 Mbps": [
    "H.264 - Corresponder configurações de renderização - 40 Mbps",
  ],
};
/** Último recurso, por palavra-chave, para as línguas sem tradução na tabela. */
const PISTAS: Record<string, RegExp> = {
  "Best Settings": /best|melhor|mejor|meilleur|beste|migliori|optim/i,
  "Draft Settings": /draft|rascunho|borrador|brouillon|entwurf|bozza/i,
};

const normalizar = (s: string) => s.normalize("NFC").trim().toLowerCase();
const semAcento = (t: string) => t.normalize("NFD").replace(/\p{M}/gu, "");
const taxaMbps = (t: string) => /(\d+)\s*mbps/i.exec(t)?.[1];
const ehH264 = (t: string) => /^h\.?264(?!\d)/i.test(t);

/** Acha na lista da instância o modelo pedido: nome exato, tradução conhecida, depois pista. */
export function acharModelo(pedido: string, lista: string[] | undefined): string | null {
  if (!lista?.length) return null;
  const achar = (nome: string) => lista.find((t) => normalizar(t) === normalizar(nome));
  const exato = achar(pedido);
  if (exato) return exato;
  for (const t of TRADUCOES[pedido] ?? []) {
    const r = achar(t);
    if (r) return r;
  }
  const pista = PISTAS[pedido];
  if (pista) return lista.find((t) => pista.test(semAcento(t))) ?? null;
  // Módulo H.264: mesmo codec e mesma taxa (o resto do nome muda com a língua).
  const taxa = taxaMbps(pedido);
  if (ehH264(pedido) && taxa) {
    const mesmos = lista.filter((t) => ehH264(t) && taxaMbps(t) === taxa);
    if (mesmos.length === 1) return mesmos[0];
  }
  return null;
}

const INFO_JSX = `
var c = AE.findCompByNameOrId(payload.comp);
if (!c) return { ok: false, error: "no comp matching " + String(payload.comp) };
if (!app.project.file) return { ok: false, error: "save the project to a file first (ae_save_project)" };
var r = ""; try { r = c.renderer; } catch (e) {}
// Nomes dos modelos desta instância (mudam com a língua do AE): item de fila temporário, removido logo
// (antes do save, para o projeto não ficar marcado como alterado).
var rsT = [], omT = [], lang = "";
try { lang = app.isoLanguage; } catch (e) {}
var tmp = null;
try {
  tmp = app.project.renderQueue.items.add(c);
  rsT = tmp.templates;
  omT = tmp.outputModule(1).templates;
} catch (e) {}
try { if (tmp) tmp.remove(); } catch (e) {}
if (payload.save && app.project.dirty) app.project.save();
return { rsTemplates: rsT, omTemplates: omT, lang: lang, name: c.name, fps: c.frameRate, duration: c.duration, waStart: c.workAreaStart, waDur: c.workAreaDuration,
  project: app.project.file.fsName.replace(/\\\\/g, "/"), renderer: r, dirty: app.project.dirty };
`;

export const renderVideoTool = defineTool({
  name: "ae_render_video",
  title: "Render video (background, chunked)",
  description:
    "Render a comp to MP4 in the BACKGROUND. mode previa = Draft Settings in one chunk to SEE a change fast; " +
    "mode turbo = final render using the whole PC; redo [a,b] = re-render only the chunks that changed (same outDir). " +
    "Default mode leve = the studio's render that keeps the PC usable: aerender in chunks (default 30 s; 15 s " +
    "for Advanced 3D; chunkSec 10 for heavy blur/video; never under 5 s, opening aerender alone costs ~21 s) with " +
    "multi-frame rendering on, up to 2 at once at BelowNormal priority with 8 threads left free and a RAM gate " +
    "(one at a time while a process named in TUIFT_GAME_PROCESSES runs), -mem_usage 20 30, chunks joined without re-encoding and tagged BT.709, optional audio mux with loudness " +
    "read-out, then checks for black and frozen stretches. Returns a job id at once — poll ae_render_status. " +
    "Saves the project first. Avoid editing the project while it renders; keep bridge calls light.",
  group: "render",
  blockedInReadOnly: false,
  effect: "write",
  inputShape: {
    comp: z.union([z.string(), z.number()]),
    outDir: z
      .string()
      .optional()
      .describe(
        "Output folder (default: new folder per job under the temp work dir). Always a NEW folder per video.",
      ),
    range: z
      .tuple([z.number().nonnegative(), z.number().positive()])
      .optional()
      .describe("[start, end] seconds; default work area."),
    chunkSec: z.number().positive().optional().describe("Chunk length in seconds."),
    outputModule: z
      .string()
      .optional()
      .describe("Output module template (default 'H.264 - Match Render Settings - 40 Mbps')."),
    audio: z.string().optional().describe("Final mix (wav) to mux into the MP4."),
    software: z
      .boolean()
      .optional()
      .describe(
        "Multi-frame rendering off for the whole job (~5x slower). Not needed for failures: a chunk that fails " +
          "is retried without MFR on its own. Use only with redo for a stretch that came out black.",
      ),
    mode: z
      .enum(["leve", "previa", "turbo"])
      .optional()
      .describe(
        "leve (default): light render that never locks the PC. previa: Draft Settings in ONE chunk for the range — " +
          "to SEE a change in minutes, not to deliver. turbo: only for the final render when nobody is using " +
          "the PC — Best Settings, more memory, normal priority, chunks 2× longer.",
      ),
    redo: z
      .tuple([z.number().nonnegative(), z.number().positive()])
      .optional()
      .describe(
        "[start, end] seconds that CHANGED. With the same outDir, range and chunkSec of the previous job, only the " +
          "chunks touching this interval are deleted and rendered again; the rest is reused and the master is rejoined.",
      ),
    redoCena: z
      .union([z.string(), z.array(z.string()).min(1)])
      .optional()
      .describe(
        "Same as redo, by scene name from tuift.cena: 'S03', 'S03_PROVA' or a list. Same outDir, range and chunkSec of the previous job.",
      ),
  },
  handler: async (args, transport) => {
    const info = await runJsx<any>(transport, INFO_JSX, "render_info", {
      payload: { comp: args.comp, save: true },
      undoGroup: false,
    });
    if (!info.ok) return info.error;
    const c = info.value;
    const trechosRedo: Array<[number, number]> = args.redo ? [args.redo] : [];
    if (args.redoCena) {
      const lidas = await runJsx<Cena[]>(
        transport,
        `${LER_CENAS_FN}
         var c = AE.findCompByNameOrId(payload.comp);
         if (!c) return { ok: false, error: "no comp matching " + String(payload.comp) };
         return TUIFT_lerCenas(c);`,
        "render_cenas",
        { payload: { comp: args.comp }, undoGroup: false },
      );
      if (!lidas.ok) return lidas.error;
      const achadas = filtrarCenas(lidas.value, args.redoCena);
      if (!achadas.length)
        return errorResult("INVALID_ARGS", "no scene marker matches redoCena", {
          details: { cenasNaComp: lidas.value.map((x) => x.nome) },
          hint: "Mark the scenes with ae_do tuift.cena, or use redo: [start, end].",
        });
      for (const x of achadas) trechosRedo.push([x.inicio, x.fim]);
    }
    const aer = path.join(
      path.dirname(resolveAfterFxPath()),
      process.platform === "win32" ? "aerender.exe" : "aerender",
    );
    if (!existsSync(aer))
      return errorResult("AE_NOT_FOUND", `aerender not found next to AfterFX: ${aer}`);

    const id = `${slug(c.name)}-${stamp()}`;
    const outDir = path.resolve(args.outDir ?? path.join(WORK_DIR, "render", id));
    if (!isAscii(outDir))
      return errorResult(
        "INVALID_ARGS",
        "outDir must be an ASCII path (aerender rejects accents such as ç)",
        { details: { outDir } },
      );
    mkdirSync(outDir, { recursive: true });

    let projectArg = c.project as string;
    let note: string | undefined;
    if (!isAscii(projectArg)) {
      const sp = await shortPath(projectArg);
      if (sp) {
        projectArg = sp;
        note = "project reached through its 8.3 short path";
      } else {
        const copy = path.join(outDir, "projeto.aep");
        await fs.copyFile(projectArg, copy);
        projectArg = copy;
        note =
          "project copied to the ASCII job folder (footage paths are resolved by AE from the absolute paths stored in the .aep)";
      }
    }
    const fps: number = c.fps;
    const [a, b] = args.range ?? [c.waStart, c.waStart + c.waDur];
    const startF = Math.round(a * fps);
    const endF = Math.round(b * fps) - 1;
    const style = houseStyle();
    const is3d = /calder|advanced/i.test(String(c.renderer));
    const mode: Mode = args.mode ?? "leve";
    const rsTemplates: string[] = c.rsTemplates ?? [];
    const omTemplates: string[] = c.omTemplates ?? [];
    const omPedido = args.outputModule ?? "H.264 - Match Render Settings - 40 Mbps";
    // Sem lista (AE antigo, erro no item temporário), segue com o nome pedido.
    const rs = rsTemplates.length ? acharModelo(MODES[mode].rs, rsTemplates) : MODES[mode].rs;
    const om = omTemplates.length ? acharModelo(omPedido, omTemplates) : omPedido;
    if (!rs || !om)
      return errorResult(
        "INVALID_ARGS",
        !rs
          ? `render settings template "${MODES[mode].rs}" not found in this After Effects (${c.lang})`
          : `output module template "${omPedido}" not found in this After Effects (${c.lang})`,
        {
          details: { renderSettings: rsTemplates, outputModules: omTemplates },
          hint: "Pass outputModule with one of the names listed (they follow the AE language).",
        },
      );
    const baseSec = args.chunkSec ?? (is3d ? style.render.trechoSec3d : style.render.trechoSec);
    // Abrir o aerender custa ~21 s: trecho menor que MIN_CHUNK_SEC gasta mais abrindo do que renderizando.
    const chunkSec =
      MODES[mode].chunkMul === 0 && !args.chunkSec
        ? (endF - startF + 1) / fps
        : Math.max(MIN_CHUNK_SEC, baseSec * (args.chunkSec ? 1 : MODES[mode].chunkMul));
    const step = Math.max(1, Math.round(chunkSec * fps));
    const chunks: Chunk[] = [];
    for (let s = startF; s <= endF; s += step) {
      const e = Math.min(s + step - 1, endF);
      chunks.push({
        s,
        e,
        file: path.join(
          outDir,
          `trecho-${String(s).padStart(5, "0")}-${String(e).padStart(5, "0")}.mp4`,
        ),
      });
    }
    let redone = 0;
    for (const [ra, rb] of trechosRedo) {
      const rs = Math.floor(ra * fps),
        re = Math.ceil(rb * fps);
      for (const ch of chunks) {
        if (ch.e >= rs && ch.s <= re && existsSync(ch.file)) {
          await fs.unlink(ch.file).catch(() => undefined);
          redone++;
        }
      }
    }
    const reused = chunks.filter((c) => existsSync(c.file)).length;
    const job: Job = {
      id,
      comp: c.name,
      project: c.project,
      outDir,
      final: path.join(outDir, `${slug(c.name)}.mp4`),
      status: "running",
      chunks,
      startedAt: new Date().toISOString(),
    };
    JOBS.set(id, job);
    persist(job);
    indexJob(job);
    const runner = startJob(job, {
      aer,
      projectArg,
      om,
      rs,
      audio: args.audio,
      fps,
      software: args.software ?? false,
      mode,
    });
    return textAndJson(
      {
        jobId: id,
        outDir: outDir.replace(/\\/g, "/"),
        chunks: chunks.length,
        chunkSec,
        frames: [startF, endF],
        renderer: c.renderer,
        mode,
        reusedChunks: reused,
        redoneChunks: redone,
        runner,
        note,
      },
      `Render ${mode} em segundo plano: ${chunks.length} trecho(s) de ${chunkSec.toFixed(1)} s` +
        (reused ? `, ${reused} reaproveitado(s)` : "") +
        `. Acompanhe com ae_render_status { jobId: "${id}" }.`,
    );
  },
});

export const renderStatusTool = defineTool({
  name: "ae_render_status",
  title: "Render job status",
  description:
    "Status of background renders started with ae_render_video: chunk progress, final file and the automatic checks (black, frozen, frames, loudness). Works across server restarts: every job is indexed on disk. Omit jobId to list recent jobs.",
  group: "render",
  blockedInReadOnly: false,
  effect: "read",
  inputShape: { jobId: z.string().optional() },
  handler: async (args) => {
    if (!args.jobId) {
      const jobs = recentJobIds()
        .map((id) => loadJob(id))
        .filter((j): j is Job => j !== null);
      return textAndJson({
        jobs: jobs.map((j) => ({
          id: j.id,
          status: j.status,
          done: j.chunks.filter((c) => c.code !== undefined).length,
          of: j.chunks.length,
          final: j.final,
        })),
      });
    }
    const job = loadJob(args.jobId);
    if (!job)
      return errorResult(
        "INVALID_ARGS",
        `unknown job ${args.jobId}: not in this session nor in the job index (${JOBS_DIR.replace(/\\/g, "/")})`,
        { hint: "Call ae_render_status without jobId to list recent jobs." },
      );
    const done = job.chunks.filter((c) => c.code !== undefined).length;
    const head =
      job.status === "running"
        ? `Renderizando: ${done}/${job.chunks.length} trechos.`
        : job.status === "done"
          ? `Pronto: ${job.final}`
          : `Falhou: ${job.error}`;
    return textAndJson({ ...job } as unknown as Record<string, unknown>, head);
  },
});
