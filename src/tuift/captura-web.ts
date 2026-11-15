/**
 * Captura de movimento 2D de uma página viva para camadas de footage no AE.
 * A leitura é por geometria do Chromium (quad dos quatro cantos), em vez de
 * adivinhar rotação a partir de um retângulo envolvente. Esta primeira versão
 * controla CSS/WAAPI; não promete reproduzir animação JavaScript ou WebGL.
 */
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export type Point = [number, number];
export type Quad = [Point, Point, Point, Point];

export interface WebSample {
  time: number;
  quad: Quad;
  cssSize: Point;
  cssOrigin: Point;
  opacity: number;
  individualRotate: string;
  individualTranslate: string;
  individualScale: string;
}

export interface WebCapture {
  version: 1;
  source: { url: string; selector: string; viewport: Point; fps: number; duration: number };
  clock: "css-waapi";
  animations: { count: number; names: string[] };
  warnings: string[];
  samples: WebSample[];
}

export interface CaptureWebOptions {
  url: string;
  selector: string;
  viewport: Point;
  fps: number;
  duration: number;
  /** Pasta que contém node_modules/playwright (instalada por você). */
  playwrightRoot?: string;
  browserExecutable?: string;
  timeoutMs?: number;
}

export interface AeSample {
  time: number;
  anchor: Point;
  position: Point;
  scale: Point;
  rotation: number;
  opacity: number;
  cornerError: number;
}

export interface AeConversion {
  viewport: Point;
  sourceSize: Point;
  fps: number;
  samples: AeSample[];
  maxCornerError: number;
  warnings: string[];
}

type AeTarget = {
  comp: string | number;
  layer: string | number;
  sourceSize: Point;
  timeOffset?: number;
};

function jsxJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function finiteNumber(value: number, label: string, min: number, max: number): void {
  if (!Number.isFinite(value) || value < min || value > max)
    throw new Error(`${label} fora do intervalo ${min}–${max}`);
}

function assertPoint(value: Point, label: string, min = -1e7, max = 1e7): void {
  if (!Array.isArray(value) || value.length !== 2)
    throw new Error(`${label} precisa de dois números`);
  finiteNumber(value[0], `${label}.x`, min, max);
  finiteNumber(value[1], `${label}.y`, min, max);
}

function assertCaptureOptions(o: CaptureWebOptions): void {
  let url: URL;
  try {
    url = new URL(o.url);
  } catch {
    throw new Error("url inválida; use http, https ou file");
  }
  if (!["https:", "http:", "file:"].includes(url.protocol))
    throw new Error("protocolo de URL não suportado");
  if (url.username || url.password) throw new Error("não coloque credenciais na URL de captura");
  if (typeof o.selector !== "string" || !o.selector.trim() || o.selector.length > 1024)
    throw new Error("seletor CSS inválido");
  assertPoint(o.viewport, "viewport", 1, 8192);
  if (!o.viewport.every(Number.isInteger))
    throw new Error("viewport precisa ter dimensões inteiras");
  finiteNumber(o.fps, "fps", 1, 120);
  finiteNumber(o.duration, "duração", 0, 120);
  if (Math.floor(o.fps * o.duration + 1e-9) + 1 > 6000)
    throw new Error("captura limitada a 6.000 quadros");
}

function playwrightEntry(root?: string): string {
  const require = createRequire(import.meta.url);
  const roots = [root, process.env.TUIFT_PLAYWRIGHT_ROOT, process.cwd()].filter(
    (v): v is string => !!v,
  );
  try {
    return require.resolve("playwright", { paths: roots });
  } catch {
    throw new Error(
      "Playwright não encontrado: informe playwrightRoot (ou TUIFT_PLAYWRIGHT_ROOT) apontando à pasta que o contém",
    );
  }
}

const startClock = `(() => {
  const all = document.getAnimations();
  const starts = all.map(a => a.startTime).filter(v => typeof v === 'number' && Number.isFinite(v));
  const origin = starts.length ? Math.min(...starts) : 0;
  const entries = all.map(a => ({a, start: typeof a.startTime === 'number' ? a.startTime : origin, rate: a.playbackRate || 1}));
  for (const x of entries) { x.a.pause(); x.a.currentTime = (origin-x.start)*x.rate; }
  window.__tuiftWebMotion = { entries, origin };
  return { count: entries.length, names: entries.map(x => x.a.animationName || x.a.id || x.a.constructor.name) };
})()`;

const setClock = (ms: number) => `(() => {
  const x = window.__tuiftWebMotion;
  for (const e of x.entries) e.a.currentTime = (${ms}+x.origin-e.start)*e.rate;
})()`;

const readStyle = (selector: string) => `(() => {
  const el=document.querySelector(${JSON.stringify(selector)}); if(!el) throw new Error('elemento desapareceu');
  const cs=getComputedStyle(el), rect=el.getBoundingClientRect();
  let opacity=1, clipped=false, visualEffects=false, visibility='visible', transform3d=false;
  for(let n=el;n;n=n.parentElement){
    const c=getComputedStyle(n); opacity*=Number(c.opacity);
    if(c.clipPath!=='none'||/(hidden|clip|scroll)/.test(c.overflow+' '+c.overflowX+' '+c.overflowY)) clipped=true;
    if(c.filter!=='none'||c.maskImage!=='none'||c.mixBlendMode!=='normal') visualEffects=true;
    if(c.visibility!=='visible') visibility=c.visibility;
    if(c.transform.startsWith('matrix3d(')||c.perspective!=='none') transform3d=true;
  }
  const n=v=>Number.parseFloat(v)||0;
  const borderX=n(cs.borderLeftWidth)+n(cs.borderRightWidth), borderY=n(cs.borderTopWidth)+n(cs.borderBottomWidth);
  const paddingX=n(cs.paddingLeft)+n(cs.paddingRight), paddingY=n(cs.paddingTop)+n(cs.paddingBottom);
  const w=n(cs.width)+(cs.boxSizing==='border-box'?0:borderX+paddingX);
  const h=n(cs.height)+(cs.boxSizing==='border-box'?0:borderY+paddingY);
  const org=cs.transformOrigin.split(/\\s+/).map(n);
  return {w,h,origin:[org[0],org[1]],opacity,rotate:cs.rotate,translate:cs.translate,scale:cs.scale,
    clipped,visualEffects,visibility,transform3d,scroll:[window.scrollX,window.scrollY],rect:[rect.x,rect.y,rect.width,rect.height]};
})()`;

function quadFromRaw(raw: number[]): Quad {
  if (!Array.isArray(raw) || raw.length !== 8 || raw.some((n) => !Number.isFinite(n)))
    throw new Error("quad inválido retornado pelo navegador");
  return [
    [raw[0], raw[1]],
    [raw[2], raw[3]],
    [raw[4], raw[5]],
    [raw[6], raw[7]],
  ];
}

/** Captura CSS/WAAPI em instantes exatos sem gravar ou renderizar vídeo. */
export async function capturarMovimentoWeb(options: CaptureWebOptions): Promise<WebCapture> {
  assertCaptureOptions(options);
  const entry = playwrightEntry(options.playwrightRoot);
  const runtime = await import(pathToFileURL(entry).href);
  const chromium = runtime.chromium ?? runtime.default?.chromium;
  if (!chromium) throw new Error("a instalação de Playwright encontrada não expõe Chromium");
  // O servidor não traz navegador.
  // Se o Chromium do Playwright não estiver no cache, usa o Chrome/Edge instalado, sempre headless.
  const bundled: string = chromium.executablePath();
  const candidates =
    process.platform === "win32"
      ? [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA]
          .filter((v): v is string => !!v)
          .flatMap((base) => [
            path.join(base, "Google", "Chrome", "Application", "chrome.exe"),
            path.join(base, "Microsoft", "Edge", "Application", "msedge.exe"),
          ])
      : process.platform === "darwin"
        ? [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
          ]
        : [
            "/usr/bin/google-chrome",
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
            "/usr/bin/microsoft-edge",
          ];
  const executable =
    options.browserExecutable ??
    (existsSync(bundled) ? undefined : candidates.find((f) => existsSync(f)));
  if (!options.browserExecutable && !existsSync(bundled) && !executable)
    throw new Error("nenhum Chromium, Chrome ou Edge disponível para capturar o movimento");
  const browser = await chromium.launch({
    headless: true,
    ...(executable ? { executablePath: executable } : {}),
  });
  try {
    const context = await browser.newContext({
      viewport: { width: options.viewport[0], height: options.viewport[1] },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    await page.goto(options.url, { waitUntil: "load", timeout: options.timeoutMs ?? 60000 });
    await page.waitForSelector(options.selector, { timeout: options.timeoutMs ?? 60000 });
    await page.evaluate("document.fonts.ready");
    const animationInfo = (await page.evaluate(startClock)) as { count: number; names: string[] };
    const cdp = await context.newCDPSession(page);
    const documentNode = await cdp.send("DOM.getDocument", { depth: 0 });
    const target = await cdp.send("DOM.querySelector", {
      nodeId: documentNode.root.nodeId,
      selector: options.selector,
    });
    if (!target.nodeId) throw new Error("seletor não encontrado pelo protocolo DOM");
    const warnings = new Set<string>();
    warnings.add(
      "O relógio controla CSS/WAAPI; scripts, canvas e vídeo não são controlados e precisam de verificação própria.",
    );
    if (!animationInfo.count)
      warnings.add(
        "Nenhuma animação CSS/WAAPI encontrada; scripts, vídeo e WebGL não são controlados.",
      );
    const sampleAt = async (time: number): Promise<WebSample> => {
      await page.evaluate(setClock(time * 1000));
      const style = await page.evaluate(readStyle(options.selector));
      if (style.scroll[0] !== 0 || style.scroll[1] !== 0)
        throw new Error("v1 só captura com a página no início da rolagem");
      if (style.transform3d)
        throw new Error("transformação 3D/perspectiva não suportada nesta versão");
      if (style.visibility !== "visible") throw new Error("elemento ou ancestral não está visível");
      if (style.clipped)
        warnings.add("Máscaras e cortes da página não são reproduzidos automaticamente no AE.");
      if (style.visualEffects)
        warnings.add("Filtros, máscaras e modos de mistura precisam ser refeitos no AE.");
      const model = await cdp.send("DOM.getBoxModel", { nodeId: target.nodeId });
      const sample: WebSample = {
        time,
        quad: quadFromRaw(model.model.border),
        cssSize: [style.w, style.h],
        cssOrigin: style.origin,
        opacity: style.opacity,
        individualRotate: style.rotate,
        individualTranslate: style.translate,
        individualScale: style.scale,
      };
      assertPoint(sample.cssSize, "tamanho CSS", 0.001, 1e7);
      assertPoint(sample.cssOrigin, "origem CSS");
      finiteNumber(sample.opacity, "opacidade", 0, 1);
      return sample;
    };
    const first = await sampleAt(0);
    await page.waitForTimeout(35);
    const repeated = await sampleAt(0);
    const drift = Math.max(
      ...first.quad.flatMap((p, i) => [
        Math.abs(p[0] - repeated.quad[i][0]),
        Math.abs(p[1] - repeated.quad[i][1]),
      ]),
    );
    if (drift > 0.1 || Math.abs(first.opacity - repeated.opacity) > 0.001)
      throw new Error(
        "a página mudou com o relógio CSS parado; movimento por script não é determinístico neste modo",
      );
    const count = Math.floor(options.duration * options.fps + 1e-9);
    const samples: WebSample[] = [repeated];
    for (let i = 1; i <= count; i++) samples.push(await sampleAt(i / options.fps));
    const sourceUrl = new URL(options.url);
    const queryKeys = Array.from(sourceUrl.searchParams.keys());
    for (const key of queryKeys) {
      if (/token|secret|password|passwd|api.?key|auth|code/i.test(key))
        sourceUrl.searchParams.set(key, "[redigido]");
    }
    return {
      version: 1,
      source: {
        url: sourceUrl.toString(),
        selector: options.selector,
        viewport: options.viewport,
        fps: options.fps,
        duration: options.duration,
      },
      clock: "css-waapi",
      animations: animationInfo,
      warnings: [...warnings],
      samples,
    };
  } finally {
    await browser.close();
  }
}

/** Decompõe um quadrilátero afim ortogonal em posição, rotação e escala AE. */
export function converterQuadroAE(
  sample: WebSample,
  sourceSize: Point,
  previousRotation?: number,
): AeSample {
  assertPoint(sourceSize, "tamanho da camada", 0.001, 1e7);
  assertPoint(sample.cssSize, "tamanho CSS", 0.001, 1e7);
  assertPoint(sample.cssOrigin, "origem CSS");
  finiteNumber(sample.time, "tempo", 0, 1e7);
  finiteNumber(sample.opacity, "opacidade", 0, 1);
  const q = sample.quad;
  if (!Array.isArray(q) || q.length !== 4) throw new Error("quad precisa de quatro cantos");
  q.forEach((p, i) => assertPoint(p, `canto ${i}`));
  const [p0, p1, p2, p3] = q;
  const perspectiveError = Math.hypot(p2[0] - p1[0] - p3[0] + p0[0], p2[1] - p1[1] - p3[1] + p0[1]);
  if (perspectiveError > 0.25)
    throw new Error(
      `perspectiva não suportada: erro do quarto canto ${perspectiveError.toFixed(3)} px`,
    );
  const a = (p1[0] - p0[0]) / sourceSize[0],
    b = (p1[1] - p0[1]) / sourceSize[0];
  const c = (p3[0] - p0[0]) / sourceSize[1],
    d = (p3[1] - p0[1]) / sourceSize[1];
  const sx = Math.hypot(a, b),
    sy = Math.hypot(c, d);
  if (sx < 1e-7 || sy < 1e-7) throw new Error("escala zero não permite decompor o quadro");
  const shear = Math.abs((a * c + b * d) / (sx * sy));
  if (shear > 0.001)
    throw new Error(`cisalhamento não suportado em camada 2D: ${shear.toFixed(5)}`);
  const determinant = a * d - b * c;
  let rotation = (Math.atan2(b, a) * 180) / Math.PI;
  if (previousRotation !== undefined) {
    while (rotation - previousRotation > 180) rotation -= 360;
    while (rotation - previousRotation < -180) rotation += 360;
  }
  const anchor: Point = [
    (sample.cssOrigin[0] * sourceSize[0]) / sample.cssSize[0],
    (sample.cssOrigin[1] * sourceSize[1]) / sample.cssSize[1],
  ];
  const position: Point = [
    p0[0] + a * anchor[0] + c * anchor[1],
    p0[1] + b * anchor[0] + d * anchor[1],
  ];
  const scale: Point = [sx * 100, (determinant < 0 ? -sy : sy) * 100];
  const rr = (rotation * Math.PI) / 180,
    co = Math.cos(rr),
    si = Math.sin(rr);
  const reconstruct = (x: number, y: number): Point => [
    position[0] +
      ((co * scale[0]) / 100) * (x - anchor[0]) -
      ((si * scale[1]) / 100) * (y - anchor[1]),
    position[1] +
      ((si * scale[0]) / 100) * (x - anchor[0]) +
      ((co * scale[1]) / 100) * (y - anchor[1]),
  ];
  const actual = [
    reconstruct(0, 0),
    reconstruct(sourceSize[0], 0),
    reconstruct(sourceSize[0], sourceSize[1]),
    reconstruct(0, sourceSize[1]),
  ];
  const cornerError = Math.max(
    ...q.map((p, i) => Math.hypot(p[0] - actual[i][0], p[1] - actual[i][1])),
  );
  if (cornerError > 0.25)
    throw new Error(`erro de reconstrução dos cantos: ${cornerError.toFixed(3)} px`);
  return {
    time: sample.time,
    anchor,
    position,
    scale,
    rotation,
    opacity: sample.opacity * 100,
    cornerError,
  };
}

export function converterCapturaAE(capture: WebCapture, sourceSize: Point): AeConversion {
  if (capture.version !== 1 || capture.clock !== "css-waapi" || !capture.samples.length)
    throw new Error("formato de captura inválido");
  assertPoint(capture.source.viewport, "viewport", 1, 8192);
  finiteNumber(capture.source.fps, "fps", 1, 120);
  let previous: number | undefined;
  let previousTime = -1;
  const samples = capture.samples.map((sample) => {
    if (sample.time <= previousTime) throw new Error("tempos de amostra precisam ser crescentes");
    previousTime = sample.time;
    const out = converterQuadroAE(sample, sourceSize, previous);
    previous = out.rotation;
    return out;
  });
  return {
    viewport: capture.source.viewport,
    sourceSize,
    fps: capture.source.fps,
    samples,
    maxCornerError: Math.max(...samples.map((s) => s.cornerError)),
    warnings: capture.warnings,
  };
}

/**
 * Gera lote já compatível com ae_do/batch.run. Pré-checagem impede sobrescrever
 * animações existentes. batch.run não é transacional: confira cada resultado.
 */
export function prepararLoteAE(
  data: AeConversion,
  target: AeTarget,
): { operation: "batch.run"; args: { stopOnError: true; ops: unknown[] } } {
  if (!data.samples.length) throw new Error("sem amostras");
  assertPoint(target.sourceSize, "tamanho do footage", 1, 1e7);
  if (target.sourceSize[0] !== data.sourceSize[0] || target.sourceSize[1] !== data.sourceSize[1])
    throw new Error("tamanho da camada não corresponde à conversão");
  if (
    !(typeof target.comp === "string" || typeof target.comp === "number") ||
    !(typeof target.layer === "string" || typeof target.layer === "number")
  )
    throw new Error("comp e layer devem ser nome ou índice");
  const offset = target.timeOffset ?? 0;
  finiteNumber(offset, "deslocamento de tempo", 0, 1e7);
  const times = data.samples.map((s) => s.time + offset);
  const check = `var c=AE.findCompByNameOrId(${jsxJson(target.comp)}); if(!c) return {ok:false,error:'comp não encontrada'};
var compArg=${jsxJson(target.comp)}, layerArg=${jsxJson(target.layer)}, matches=0;
if(typeof compArg==='string'){for(var k=1;k<=app.project.numItems;k++){var item=app.project.item(k);if(item instanceof CompItem&&item.name===compArg) matches++;}if(matches!==1) return {ok:false,error:'nome da comp não é único'};}
matches=0; if(typeof layerArg==='string'){for(var j=1;j<=c.numLayers;j++){if(c.layer(j).name===layerArg)matches++;}if(matches!==1)return {ok:false,error:'nome da camada não é único'};}
var l=AE.findLayerInComp(c,${jsxJson(target.layer)}); if(!l) return {ok:false,error:'camada não encontrada'};
if(c.width!==${data.viewport[0]}||c.height!==${data.viewport[1]}||Math.abs(c.frameRate-${data.fps})>0.001) return {ok:false,error:'comp precisa ter viewport e fps da captura'};
if(l.locked||l.threeDLayer||l.parent) return {ok:false,error:'camada deve estar desbloqueada, 2D e sem parent'};
if(!l.source||l.source.width!==${data.sourceSize[0]}||l.source.height!==${data.sourceSize[1]}) return {ok:false,error:'dimensões do footage não conferem'};
if(l.inPoint>${times[0]}||l.outPoint<=${times[times.length - 1]}) return {ok:false,error:'camada não cobre o intervalo'};
var tr=l.property('ADBE Transform Group'), names=['ADBE Anchor Point','ADBE Position','ADBE Scale','ADBE Rotate Z','ADBE Opacity'];
for(var i=0;i<names.length;i++){var p=tr.property(names[i]); if(!p||p.numKeys||p.expressionEnabled||p.dimensionsSeparated) return {ok:false,error:'propriedade ocupada, separada ou indisponível: '+names[i]};}
return {ok:true,verificado:true};`;
  const specs: Array<[string, (s: AeSample) => number | Point]> = [
    ["ADBE Anchor Point", (s) => s.anchor],
    ["ADBE Position", (s) => s.position],
    ["ADBE Scale", (s) => s.scale],
    ["ADBE Rotate Z", (s) => s.rotation],
    ["ADBE Opacity", (s) => s.opacity],
  ];
  const ops: unknown[] = [{ operation: "eval.run", args: { code: check } }];
  for (const [name, get] of specs)
    ops.push({
      operation: "keyframe.apply",
      args: {
        comp: target.comp,
        layer: target.layer,
        property: ["ADBE Transform Group", name],
        keys: data.samples.map((s, i) => ({ time: times[i], value: get(s) })),
        interp: "linear",
        spatialTangents: "linear",
        replace: false,
      },
    });
  return { operation: "batch.run", args: { stopOnError: true, ops } };
}
