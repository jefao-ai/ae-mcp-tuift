import { stat } from "node:fs/promises";
import { extname, isAbsolute } from "node:path";
import { z } from "zod";
import { jsxFail, registerOp } from "../registry.js";
import type { AeTransport } from "../transport/AeTransport.js";
import { captureFigmaFrame } from "../tuift/figma-capture.js";
import { FIGMA_IMPORT_JSX } from "../tuift/figma-native.js";
import {
  applyAffine,
  inverseAffine,
  mapBezier,
  multiplyAffine,
  parseFigmaPath,
  roundedRect,
  type XY,
} from "../tuift/figma-path.js";

const n = z.number().finite();
const opacity = n.min(0).max(1);
const xy = z.tuple([n, n]);
const box = z.tuple([n, n, n, n]);
const color = z.tuple([opacity, opacity, opacity]);
const transform = z.tuple([n, n, n, n, n, n]);
const paint = z.object({
  type: z.string(),
  color: color.optional(),
  opacity: opacity.default(1),
  image: z.string().optional(),
  mode: z.string().optional(),
});
const path = z.object({ path: z.string().max(300_000), rule: z.string() });
const metrics = z.object({ unit: z.string(), value: n.optional() });
const run = z.object({
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
  family: z.string(),
  style: z.string(),
  size: n.positive(),
  fills: z.array(paint),
  letter: metrics.optional(),
  leading: metrics.optional(),
  casing: z.string().optional(),
  decoration: z.string().optional(),
});
const capturedNode = z.object({
  id: z.string().min(1).max(256),
  name: z.string().max(1000),
  type: z.string(),
  parent: z.string().nullable(),
  order: z.number().int().min(0).max(1499),
  size: xy,
  matrix: transform,
  visible: z.boolean(),
  opacity,
  blend: z.string().default("NORMAL"),
  clip: z.boolean(),
  mask: z.string().nullable(),
  fills: z.array(paint),
  strokes: z.array(paint),
  strokeWeight: n.nonnegative().default(1),
  strokeAlign: z.string().default("CENTER"),
  dash: z.array(n).default([]),
  corners: box.default([0, 0, 0, 0]),
  effects: z.array(z.string()).default([]),
  paths: z.array(path).default([]),
  strokePaths: z.array(path).default([]),
  text: z
    .object({
      value: z.string().max(30000),
      auto: z.string(),
      align: z.string(),
      valign: z.string(),
      paragraphSpacing: n.default(0),
      bounds: box.nullable(),
      runs: z.array(run),
    })
    .optional(),
});
const snapshot = z.object({
  schema: z.literal("tuift.figma-frame/v1"),
  fileKey: z
    .string()
    .regex(/^[a-zA-Z0-9]+$/)
    .nullable()
    .optional(),
  rootId: z.string(),
  nodes: z.array(capturedNode).min(1).max(1500),
});
type Capture = z.infer<typeof snapshot>;
type CapturedNode = z.infer<typeof capturedNode>;

const CONTAINERS = new Set(["FRAME", "COMPONENT", "INSTANCE", "GROUP", "SECTION"]);
const FIGMA_ID = /^(?:I)?\d+:\d+(?:;\d+:\d+)*$/;
const PAINTABLE = new Set([
  "RECTANGLE",
  "ELLIPSE",
  "LINE",
  "VECTOR",
  "POLYGON",
  "STAR",
  "BOOLEAN_OPERATION",
]);

function prepareFrame(
  capture: Capture,
  args: Record<string, unknown>,
  images: Map<string, string>,
) {
  const nodes = new Map<string, CapturedNode>();
  const children = new Map<string, CapturedNode[]>();
  for (const node of capture.nodes) {
    if (nodes.has(node.id)) throw new Error("ID de nó duplicado: " + node.id);
    nodes.set(node.id, node);
    if (node.parent !== null) {
      const siblings = children.get(node.parent) ?? [];
      if (siblings[node.order]) throw new Error("Ordem de camadas duplicada: " + node.name);
      siblings[node.order] = node;
      children.set(node.parent, siblings);
    }
  }
  const root = nodes.get(capture.rootId);
  if (!root || root.parent !== null || !CONTAINERS.has(root.type))
    throw new Error("O nó principal da captura deve ser um frame ou grupo.");
  const [width, height] = root.size.map((v) => Math.ceil(v - 1e-5));
  if (width < 4 || height < 4 || width > 30000 || height > 30000)
    throw new Error("As dimensões da tela precisam ficar entre 4 e 30.000 pixels.");
  const toLocal = inverseAffine(root.matrix);
  const rootFolder =
    typeof args.name === "string" && args.name.trim() ? args.name.trim() : root.name;
  const visited = new Set<string>();
  const warnings: Array<{ id: string; name: string; message: string }> = [];

  function convert(node: CapturedNode, depth: number): unknown {
    if (depth > 24 || visited.has(node.id))
      throw new Error("Hierarquia do Figma inválida ou muito profunda.");
    visited.add(node.id);
    const warn = (message: string) => warnings.push({ id: node.id, name: node.name, message });
    const matrix = multiplyAffine(toLocal, node.matrix);
    const [w, h] = node.size;
    const origin: XY = [matrix[2], matrix[5]];
    const sx = Math.hypot(matrix[0], matrix[3]);
    const sy = sx ? (matrix[0] * matrix[4] - matrix[1] * matrix[3]) / sx : 0;
    const angle = (Math.atan2(matrix[3], matrix[0]) * 180) / Math.PI;
    const center = applyAffine(matrix, [w / 2, h / 2]);
    // Outlined geometry is transformed in the path, including shear and flips.
    if (node.effects.length) warn("Efeitos sem conversão: " + node.effects.join(", "));
    if (
      ![
        "NORMAL",
        "PASS_THROUGH",
        "MULTIPLY",
        "SCREEN",
        "OVERLAY",
        "DARKEN",
        "LIGHTEN",
        "DIFFERENCE",
        "COLOR_DODGE",
        "COLOR_BURN",
        "SOFT_LIGHT",
        "HARD_LIGHT",
        "EXCLUSION",
        "HUE",
        "SATURATION",
        "COLOR",
        "LUMINOSITY",
      ].includes(node.blend)
    )
      warn("Modo de mesclagem sem conversão: " + node.blend);
    if (node === root && node.opacity !== 1)
      warn("A opacidade do frame principal precisa ser ajustada na composição.");
    if (node === root && node.clip && node.corners.some((radius) => radius > 0))
      warn("O recorte arredondado da composição principal precisa de ajuste.");
    if (
      node.text &&
      (node.strokes.length ||
        node.text.runs.some(
          (r) => (r.casing && r.casing !== "ORIGINAL") || (r.decoration && r.decoration !== "NONE"),
        ))
    )
      warn("Traços, capitalização de estilo e decoração de texto exigem ajuste.");
    if (
      node.text?.runs.some(
        (r) => r.fills.length !== 1 || r.fills[0].type !== "SOLID" || r.fills[0].opacity < 0.999,
      )
    )
      warn("Alguns preenchimentos de texto foram simplificados.");
    if (
      node.text &&
      node.text.runs.some((r) => r.end > node.text!.value.length || r.start >= r.end)
    )
      throw new Error("Intervalo de estilo inválido no texto " + node.name);

    const localRect = w > 0 && h > 0 ? roundedRect(w, h, node.corners) : null;
    const bounds = node.text?.bounds;
    // Figma render bounds are in page coordinates. The bounding corners are
    // exact for an unrotated root, which is the usual design frame.
    const renderTop =
      bounds && Math.abs(toLocal[1]) < 0.0001 && Math.abs(toLocal[3]) < 0.0001
        ? applyAffine(toLocal, [bounds[0], bounds[1]])
        : null;
    function paths(inputs: CapturedNode["paths"]) {
      return inputs
        .flatMap((p) => {
          try {
            return [
              {
                rule: p.rule,
                paths: parseFigmaPath(p.path).map((bezier) => mapBezier(bezier, matrix)),
              },
            ];
          } catch (err) {
            warn(err instanceof Error ? err.message : String(err));
            return [];
          }
        })
        .filter((g) => g.paths.length);
    }
    let fills = node.text ? [] : node.fills.filter((p) => p.type === "SOLID" && p.color);
    const outline = node.strokes.filter((p) => p.type === "SOLID" && p.color);
    const sourcePaths = paths(node.paths);
    const strokePaths = paths(node.strokePaths);
    if (!node.text && node.fills.some((p) => p.type !== "SOLID" && p.type !== "IMAGE"))
      warn(
        "Preenchimento sem conversão: " +
          node.fills
            .filter((p) => p.type !== "SOLID" && p.type !== "IMAGE")
            .map((p) => p.type)
            .join(", "),
      );
    if (outline.length !== node.strokes.length && !node.text)
      warn("Alguns tipos de traço não têm conversão.");
    if (
      !sourcePaths.length &&
      localRect &&
      (node.type === "RECTANGLE" || CONTAINERS.has(node.type))
    )
      sourcePaths.push({ rule: "NONZERO", paths: [mapBezier(localRect, matrix)] });
    if (!sourcePaths.length && w > 0 && h > 0 && node.type === "ELLIPSE")
      sourcePaths.push({
        rule: "NONZERO",
        paths: [
          mapBezier(
            roundedRect(2, 2, [1, 1, 1, 1]),
            multiplyAffine(matrix, [w / 2, 0, 0, 0, h / 2, 0]),
          ),
        ],
      });
    if (!sourcePaths.length && w > 0 && node.type === "LINE")
      sourcePaths.push({
        rule: "NONE",
        paths: parseFigmaPath(`M0 0L${w} 0`).map((p) => mapBezier(p, matrix)),
      });
    if (fills.length && !sourcePaths.length) {
      warn("O nó não trouxe uma geometria de preenchimento editável.");
      fills = [];
    }
    if (
      outline.length &&
      !strokePaths.length &&
      (!sourcePaths.length || node.strokeAlign !== "CENTER" || node.dash.length)
    )
      warn("O traço foi simplificado porque o contorno original não pôde ser lido.");
    const imagePaints = node.fills.filter((p) => p.type === "IMAGE");
    const pictures = imagePaints.flatMap((p) => {
      const file = p.image ? images.get(p.image) : undefined;
      if (
        !file ||
        !localRect ||
        !["FILL", "FIT"].includes(p.mode ?? "FILL") ||
        !["RECTANGLE", "FRAME", "COMPONENT", "INSTANCE"].includes(node.type) ||
        sx < 1e-6 ||
        Math.abs(sy) < 1e-6
      ) {
        warn(
          !file
            ? "Arquivo original de imagem não fornecido: " + (p.image ?? "(sem ID)")
            : "A forma ou recorte da imagem precisa de ajuste.",
        );
        return [];
      }
      return [{ file, mode: p.mode ?? "FILL", opacity: p.opacity }];
    });
    if (pictures.length && node.fills.length > 1)
      warn("A ordem de misturas entre imagens e outros preenchimentos pode exigir ajuste.");
    if (!node.text && !CONTAINERS.has(node.type) && !PAINTABLE.has(node.type))
      warn("Tipo de nó sem conversão nativa: " + node.type);
    if (
      (pictures.length || node.text) &&
      Math.abs(matrix[0] * matrix[1] + matrix[3] * matrix[4]) > 0.001
    )
      warn("Inclinação de texto ou imagem foi aproximada pela rotação e escala.");

    return {
      id: node.id,
      name: node.name,
      enabled: node.visible,
      opacity: node.opacity,
      blend: node.blend,
      clip: node.clip && localRect ? mapBezier(localRect, matrix) : null,
      mask: node.mask,
      center,
      origin,
      scale: [sx, sy],
      rotation: angle,
      size: node.size,
      text: node.text ? { ...node.text, renderTop } : null,
      sourcePaths,
      fills,
      strokePaths,
      outline,
      strokeWeight: node.strokeWeight * sx,
      pictures,
      imageClip: pictures.length ? localRect : null,
      children: (children.get(node.id) ?? []).filter(Boolean).map((p) => convert(p, depth + 1)),
    };
  }
  const tree = convert(root, 0);
  if (visited.size !== nodes.size)
    throw new Error("A captura contém nós fora da tela selecionada.");
  return { tree, width, height, name: rootFolder, warnings };
}

registerOp({
  name: "figma.capture_frame",
  category: "figma",
  readOnly: true,
  description:
    "Return a read-only export script for the connected Figma use_figma tool. Run it on the chosen frame, then pass its returned object to figma.import_frame.",
  params: [
    {
      name: "nodeId",
      type: "string",
      required: true,
      description: "Frame ID from the Figma URL (e.g. 12-34 or 12:34).",
    },
    { name: "fileKey", type: "string", description: "Design file key for source attribution." },
  ],
  toJsx: () => jsxFail("Use ae_do diretamente para obter o script do Figma."),
  async run(args) {
    const nodeId = String(args.nodeId).replace(/-/g, ":");
    const fileKey = args.fileKey === undefined ? undefined : String(args.fileKey);
    if (!FIGMA_ID.test(nodeId) || (fileKey && !/^[a-zA-Z0-9]+$/.test(fileKey)))
      return {
        ok: false,
        error: "Use o identificador de um frame e uma chave válida de arquivo do Figma.",
      };
    return { ok: true, nodeId, code: captureFigmaFrame(nodeId, fileKey) };
  },
});

async function importFrame(args: Record<string, unknown>, transport: AeTransport) {
  if (JSON.stringify(args.capture).length > 2_000_000)
    return { ok: false, error: "A captura é muito grande. Importe uma seção da tela por vez." };
  const parsed = snapshot.safeParse(args.capture);
  if (!parsed.success)
    return {
      ok: false,
      error: "Captura inválida. Use o resultado de figma.capture_frame.",
      issues: parsed.error.issues.slice(0, 12),
    };
  const fps = Number(args.fps ?? 30);
  const duration = Number(args.duration ?? 5);
  if (fps < 1 || fps > 99 || duration < 1 / fps || duration > 10800)
    return { ok: false, error: "Use FPS entre 1 e 99 e duração entre um quadro e três horas." };
  const files = new Map<string, string>();
  const entries = Object.entries(args.imageFiles ?? {});
  if (entries.length > 1500)
    return { ok: false, error: "A lista de arquivos de imagem é muito grande." };
  for (const [hash, file] of entries) {
    if (
      typeof file !== "string" ||
      !isAbsolute(file) ||
      !/^(?:\.png|\.jpe?g|\.webp|\.gif)$/i.test(extname(file))
    )
      return {
        ok: false,
        error: "Use caminhos absolutos para imagens PNG, JPG, WebP ou GIF: " + hash,
      };
    const entry = await stat(file).catch(() => null);
    if (!entry?.isFile()) return { ok: false, error: "Arquivo de imagem indisponível: " + hash };
    files.set(hash, file);
  }
  const planned = prepareFrame(parsed.data, args, files);
  if (args.strict && planned.warnings.length)
    return {
      ok: false,
      error: "Alguns elementos exigem ajuste antes da importação.",
      warnings: planned.warnings,
    };
  const target = await transport.describeTarget?.();
  if (target?.mode !== "pull")
    return {
      ok: false,
      error: "A importação precisa de uma instância ativa com o agente residente.",
    };
  const r = await transport.execute({
    code: FIGMA_IMPORT_JSX,
    instance: target.instance.id,
    label: "Importar camadas do Figma",
    timeoutMs: 60_000,
    payload: {
      ...planned,
      fps,
      duration,
      strict: args.strict === true,
      source: parsed.data.fileKey ? { file: parsed.data.fileKey, node: parsed.data.rootId } : null,
    },
  });
  return r.ok
    ? r.result
    : { ok: false, error: r.error ?? "O After Effects não confirmou a importação." };
}

registerOp({
  name: "figma.import_frame",
  category: "figma",
  description:
    "Append a composition from an exported Figma frame with editable native text and vector layers, nested comps, masks and linked original images. Accepts the object returned by the capture script. Reports unsupported styles.",
  params: [
    {
      name: "capture",
      type: "object",
      required: true,
      description:
        "Structured result from the Figma connector running the figma.capture_frame script.",
    },
    {
      name: "name",
      type: "string",
      description: "Composition name. Defaults to the Figma frame name.",
    },
    { name: "fps", type: "number", description: "Composition frame rate, default 30." },
    {
      name: "duration",
      type: "number",
      description: "Composition duration in seconds, default 5.",
    },
    {
      name: "imageFiles",
      type: "object",
      description: "Map of Figma IMAGE hashes to absolute paths of the original image files.",
    },
    {
      name: "strict",
      type: "boolean",
      description: "Abort if unsupported styles or unavailable fonts would affect the import.",
    },
  ],
  toJsx: () => jsxFail("Importe a captura diretamente pelo ae_do."),
  run: importFrame,
});
