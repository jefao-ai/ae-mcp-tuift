// Analyze decoded footage in a hidden process, then write native AE keys in one undo group.
import { existsSync } from "node:fs";
import { mkdtemp, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { freemem, homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  jsxCompLayerPreamble,
  jsxFail,
  jsxVal,
  registerOp,
  type OperationParam,
} from "../registry.js";
import type { AeTransport } from "../transport/AeTransport.js";
import { run, SERVER_ROOT } from "../tuift/common.js";
import { lerEnv } from "../tuift/env.js";

type Kind = "point" | "mask" | "camera";
type Pair = [number, number];
type Shot = {
  ok: true;
  revision: number;
  comp: number;
  layer: number;
  file: string;
  width: number;
  height: number;
  duration: number;
  startTime: number;
  stretch: number;
  frameDuration: number;
  inPoint: number;
  outPoint: number;
  tracker: number | null;
  point: number | null;
  center: Pair | null;
  mask: number | null;
  polygon: Pair[] | null;
};

const PARAMETERS: OperationParam[] = [
  { name: "comp", type: "any", required: true, description: "Composition name or ID." },
  { name: "layer", type: "any", required: true, description: "Footage layer index, name or {id}." },
  {
    name: "start",
    type: "number",
    description: "First composition time in seconds. Defaults to the layer in-point.",
  },
  {
    name: "end",
    type: "number",
    description: "Last composition time in seconds. Defaults to the last frame of the layer.",
  },
];

const READ_SHOT = `
    var file = _layer.source && _layer.source.file;
    if (!(_layer instanceof AVLayer) || !(_layer.source instanceof FootageItem) ||
        !_layer.hasVideo || !file || !_layer.source.mainSource || _layer.source.mainSource.isStill ||
        _layer.source.footageMissing || _layer.source.useProxy)
        return {ok:false, error:"Use uma camada com vídeo original disponível em disco e proxy desligado."};
    if (_layer.timeRemapEnabled || _layer.stretch <= 0 || _layer.source.mainSource.conformFrameRate > 0 ||
        _layer.source.pixelAspect !== 1)
        return {ok:false, error:"Use vídeo com pixels quadrados, sem conformação de FPS, remapeamento ou inversão de tempo."};
    if (_layer.locked) return {ok:false, error:"A camada está bloqueada."};
    var _first = Math.max(0, _layer.inPoint, _layer.startTime);
    var _limit = Math.min(_comp.duration, _layer.outPoint, _layer.startTime + _layer.source.duration * _layer.stretch / 100);
`;

const TRACKER = `
function nativePoint(layer, tracker, point) {
    var root = layer.property("ADBE MTrackers");
    var group = root ? AE.safeGet(function () { return root.property(tracker); }, null) : null;
    return group ? AE.safeGet(function () { return group.property(point); }, null) : null;
}
`;

function shotCode(args: Record<string, unknown>, kind: Kind) {
  return `
    ${jsxCompLayerPreamble(args)}
    ${READ_SHOT}
    ${TRACKER}
    var kind = ${jsxVal(kind)}, at = ${jsxVal(args.start ?? null)};
    if (at === null) at = _first;
    at = Math.ceil(at / _comp.frameDuration - 0.00001) * _comp.frameDuration;
    if (at < _first - 0.00001 || at >= _limit - 0.00001)
        return {ok:false, error:"O primeiro quadro precisa estar dentro da parte visível do vídeo."};
    var tracker = null, point = null, center = ${jsxVal(args.center ?? null)}, mask = null, polygon = null;
    if (kind === "point") {
        var trackNode = nativePoint(_layer, ${jsxVal(args.tracker ?? 1)}, ${jsxVal(args.point ?? 1)});
        if (!trackNode && ${jsxVal(args.tracker !== undefined || args.point !== undefined)})
            return {ok:false, error:"Ponto ou tracker nativo inexistente."};
        if (trackNode) {
            tracker = trackNode.parentProperty.propertyIndex;
            point = trackNode.propertyIndex;
            if (center === null) center = trackNode.property("ADBE MTracker Pt Feature Center").valueAtTime(at, true);
        }
    }
    if (kind === "mask") {
        var group = _layer.property("ADBE Mask Parade");
        var item = AE.safeGet(function () { return group.property(${jsxVal(args.mask)}); }, null);
        if (!item) return {ok:false, error:"Máscara inexistente."};
        mask = item.propertyIndex;
        var shape = item.property("ADBE Mask Shape").valueAtTime(at, true);
        if (!shape.closed || shape.vertices.length < 3) return {ok:false, error:"Use uma máscara fechada."};
        polygon = [];
        for (var i = 0; i < shape.vertices.length; i++) {
            var j = (i + 1) % shape.vertices.length;
            var a = shape.vertices[i], d = shape.vertices[j];
            var b = shape.outTangents[i], c = shape.inTangents[j];
            for (var step = 0; step < 8; step++) {
                var t = step / 8, s = 1 - t;
                polygon.push([
                    s*s*s*a[0] + 3*s*s*t*(a[0]+b[0]) + 3*s*t*t*(d[0]+c[0]) + t*t*t*d[0],
                    s*s*s*a[1] + 3*s*s*t*(a[1]+b[1]) + 3*s*t*t*(d[1]+c[1]) + t*t*t*d[1]
                ]);
            }
        }
    }
    if (kind === "camera") {
        if (_layer.threeDLayer || _layer.parent || _layer.width !== _comp.width ||
            _layer.height !== _comp.height || _comp.pixelAspect !== 1)
            return {ok:false, error:"A câmera requer camada 2D sem pai, com as dimensões e a proporção da composição."};
        var xform = _layer.property("ADBE Transform Group");
        var checks = [["ADBE Anchor Point", [_comp.width/2, _comp.height/2]],
                      ["ADBE Position", [_comp.width/2, _comp.height/2]],
                      ["ADBE Scale", [100, 100]], ["ADBE Rotate Z", 0]];
        for (var k = 0; k < checks.length; k++) {
            var p = xform.property(checks[k][0]), expected = checks[k][1], value = p.value;
            if (p.numKeys || p.expressionEnabled || p.dimensionsSeparated ||
                (expected instanceof Array ? (Math.abs(value[0]-expected[0])>0.01 || Math.abs(value[1]-expected[1])>0.01) :
                 Math.abs(value-expected)>0.01))
                return {ok:false, error:"Redefina as transformações da camada de vídeo para criar a câmera."};
        }
    }
    return {ok:true, revision:app.project.revision, comp:_comp.id, layer:_layer.id, file:file.fsName,
            width:_layer.width, height:_layer.height, duration:_layer.source.duration,
            startTime:_layer.startTime, stretch:_layer.stretch, frameDuration:_comp.frameDuration,
            inPoint:_first, outPoint:_limit, tracker:tracker, point:point, center:center, mask:mask, polygon:polygon};
  `;
}

function sampleTimes(args: Record<string, unknown>, shot: Shot, kind: Kind): number[] {
  const duration = shot.frameDuration;
  const first = Math.ceil(Number(args.start ?? shot.inPoint) / duration - 1e-5);
  const lastAvailable = Math.ceil(shot.outPoint / duration - 1e-5) - 1;
  const last = Math.floor(Number(args.end ?? lastAvailable * duration) / duration + 1e-5);
  if (last > lastAvailable) throw new Error("O fim está fora da parte visível do vídeo.");
  const step = Number(args.step ?? 1);
  const length = Math.floor((last - first) / step) + 1;
  const firstAllowed = kind === "camera" ? 8 : 2;
  if (length < firstAllowed)
    throw new Error(`O intervalo precisa de pelo menos ${firstAllowed} amostras.`);
  if (length > 720)
    throw new Error("O intervalo passa de 720 amostras. Use start/end ou aumente step na câmera.");
  const times = Array.from({ length }, (_, i) => (first + i * step) * duration);
  if (kind === "camera" && last * duration - times.at(-1)! > duration / 2)
    times.push(last * duration);
  return times;
}

const WRITE_KEYS = `
var undo = [], created = null;
function saveKeys(property, times, values) {
    var backup = {property:property, existing:[], added:[], original:property.numKeys ? null : property.value};
    for (var i = 0; i < times.length; i++) {
        var nearest = property.numKeys ? property.nearestKeyIndex(times[i]) : 0;
        if (nearest && Math.abs(property.keyTime(nearest) - times[i]) < 0.00001)
            backup.existing.push([times[i], property.keyValue(nearest)]);
        else backup.added.push(times[i]);
    }
    undo.push(backup);
    property.setValuesAtTimes(times, values);
}
function rollback() {
    if (created) { try { created.remove(); } catch (ignore) {} }
    for (var i = undo.length - 1; i >= 0; i--) {
        try {
            var row = undo[i], p = row.property;
            for (var j = row.added.length - 1; j >= 0 && p.numKeys; j--) {
                var index = p.nearestKeyIndex(row.added[j]);
                if (Math.abs(p.keyTime(index) - row.added[j]) < 0.00001) p.removeKey(index);
            }
            for (var k = 0; k < row.existing.length; k++)
                p.setValueAtTime(row.existing[k][0], row.existing[k][1]);
            if (!p.numKeys && row.original !== null) p.setValue(row.original);
        } catch (ignore2) {}
    }
}
`;

function writeCode(shot: Shot, kind: Kind, args: Record<string, unknown>) {
  return `
    ${jsxCompLayerPreamble({ comp: shot.comp, layer: { id: shot.layer } })}
    if (app.project.revision !== ${jsxVal(shot.revision)} || _layer.locked || !_layer.source ||
        !_layer.source.file || _layer.source.file.fsName !== ${jsxVal(shot.file)})
        return {ok:false, error:"O projeto mudou durante a análise. Rode a operação novamente."};
    ${TRACKER}
    ${WRITE_KEYS}
    var kind = ${jsxVal(kind)}, times = payload.times, data = payload.analysis, count = times.length;
    var result = {ok:true, compId:_comp.id, layerId:_layer.id, keyframes:count, start:times[0], end:times[count-1]};
    try {
        if (kind === "point") {
            var node = ${shot.point === null ? "null" : `nativePoint(_layer, ${jsxVal(shot.tracker)}, ${jsxVal(shot.point)})`};
            if (node) {
                var feature = node.property("ADBE MTracker Pt Feature Center"),
                    attach = node.property("ADBE MTracker Pt Attach Pt");
                var prior = feature.valueAtTime(times[0], true), origin = attach.valueAtTime(times[0], true);
                var attached = [];
                for (var a = 0; a < count; a++)
                    attached.push([data.positions[a][0]+origin[0]-prior[0], data.positions[a][1]+origin[1]-prior[1]]);
                saveKeys(feature, times, data.positions);
                saveKeys(attach, times, attached);
                result.tracker = ${jsxVal(shot.tracker)};
                result.point = ${jsxVal(shot.point)};
            } else {
                var effects = _layer.property("ADBE Effect Parade");
                if (!effects || !effects.canAddProperty("ADBE Point Control"))
                    return {ok:false, error:"Esta camada não aceita um controle de ponto."};
                created = effects.addProperty("ADBE Point Control");
                created.name = ${jsxVal(args.name ?? "Ponto rastreado")};
                created.property("ADBE Point Control-0001").setValuesAtTimes(times, data.positions);
                result.effectIndex = created.propertyIndex;
                result.effectName = created.name;
            }
            result.minimumConfidence = Math.min.apply(Math, data.confidence);
        } else if (kind === "mask") {
            var prop = _layer.property("ADBE Mask Parade").property(${jsxVal(shot.mask)}).property("ADBE Mask Shape");
            if (prop.expressionEnabled) return {ok:false,error:"Desative a expressão do caminho da máscara antes de rastrear."};
            var shapes = [];
            for (var n = 0; n < count; n++) {
                var shape = prop.valueAtTime(times[0], true), matrix = data.matrices[n];
                function transform(points, translate) {
                    var out = [];
                    for (var p = 0; p < points.length; p++) {
                        var pt = points[p];
                        out.push([
                            matrix[0][0]*pt[0] + matrix[0][1]*pt[1] + (translate ? matrix[0][2] : 0),
                            matrix[1][0]*pt[0] + matrix[1][1]*pt[1] + (translate ? matrix[1][2] : 0)
                        ]);
                    }
                    return out;
                }
                shape.vertices = transform(shape.vertices, true);
                shape.inTangents = transform(shape.inTangents, false);
                shape.outTangents = transform(shape.outTangents, false);
                shapes.push(shape);
            }
            saveKeys(prop, times, shapes);
            result.mask = ${jsxVal(shot.mask)};
            result.minimumInliers = data.minimumInliers;
        } else {
            created = _comp.layers.addCamera(${jsxVal(args.name ?? "Câmera rastreada")}, [_comp.width/2, _comp.height/2]);
            created.autoOrient = AutoOrientType.CAMERA_OR_POINT_OF_INTEREST;
            var transform = created.property("ADBE Transform Group"), positions = [], targets = [], rolls = [];
            for (var j = 0; j < count; j++) {
                var pose = data.poses[j];
                positions.push(pose.position);
                targets.push(pose.target);
                rolls.push(pose.roll);
            }
            transform.property("ADBE Position").setValuesAtTimes(times, positions);
            transform.property("ADBE Anchor Point").setValuesAtTimes(times, targets);
            transform.property("ADBE Rotate Z").setValuesAtTimes(times, rolls);
            var zoom = created.property("ADBE Camera Options Group").property("ADBE Camera Zoom");
            zoom.setValue(data.zoom);
            if (Math.abs(zoom.value - data.zoom) > 0.01) throw new Error("O zoom calculado ultrapassa o limite do After Effects.");
            created.inPoint = times[0];
            created.outPoint = Math.min(_comp.duration, times[count-1] + _comp.frameDuration);
            result.camera = {name:created.name, index:created.index, id:created.id, zoom:zoom.value};
            result.layerId = _layer.id;
            result.medianReprojectionErrorPx = data.medianReprojectionErrorPx;
            result.minimumInliers = data.minimumInliers;
        }
        return result;
    } catch (e) {
        rollback();
        return {ok:false, error:AE.errText(e)};
    }
  `;
}

function validSelector(value: unknown): boolean {
  return (
    (typeof value === "string" && value.trim().length > 0) ||
    (typeof value === "number" && Number.isInteger(value) && value > 0)
  );
}

async function analyze(args: Record<string, unknown>, transport: AeTransport, kind: Kind) {
  for (const name of ["mask", "tracker", "point"]) {
    if (args[name] !== undefined && !validSelector(args[name]))
      return { ok: false, error: `${name} precisa ser nome ou índice inteiro positivo.` };
  }
  if (
    args.center !== undefined &&
    (!Array.isArray(args.center) ||
      args.center.length !== 2 ||
      !args.center.every((v) => typeof v === "number" && Number.isFinite(v)))
  )
    return { ok: false, error: "center precisa de duas coordenadas de vídeo [x, y]." };
  if (["start", "end"].some((k) => args[k] !== undefined && Number(args[k]) < 0))
    return { ok: false, error: "start e end precisam ser maiores ou iguais a zero." };
  const fov = Number(args.horizontalFov ?? 54);
  const step = Number(args.step ?? 1);
  if (fov < 10 || fov > 150)
    return { ok: false, error: "horizontalFov precisa estar entre 10 e 150 graus." };
  if (!Number.isInteger(step) || step < 1 || step > 8)
    return { ok: false, error: "step precisa ser inteiro de 1 a 8." };
  const target = await transport.describeTarget?.();
  if (target?.mode !== "pull")
    return {
      ok: false,
      error: "A análise precisa de uma instância ativa com o agente residente do After Effects.",
    };
  const instance = target.instance.id;
  if (freemem() < 17 * 1024 ** 3)
    return {
      ok: false,
      error: "Libere pelo menos 17 GB de RAM para iniciar a análise com 16 GB de folga.",
    };

  const read = await transport.execute({
    code: shotCode(args, kind),
    label: "Ler vídeo de tracking",
    instance,
    undoGroup: false,
  });
  if (!read.ok) return { ok: false, error: read.error ?? "Falha ao ler camada." };
  const shot = read.result as Shot | { ok: false; error: string };
  if (!shot.ok) return shot;
  let times: number[];
  try {
    times = sampleTimes(args, shot, kind);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const input = await stat(shot.file).catch(() => null);
  if (!input?.isFile()) return { ok: false, error: "Vídeo de origem indisponível em disco." };
  const localPython = join(homedir(), ".venvs", "midia", "Scripts", "python.exe");
  const python =
    lerEnv("PYTHON") ||
    (process.platform === "win32" && existsSync(localPython) ? localPython : "python");
  const folder = await mkdtemp(join(tmpdir(), "tuift-tracking-"));
  const spec = join(folder, "analysis.json");
  let worker: Awaited<ReturnType<typeof run>>;
  try {
    await writeFile(
      spec,
      JSON.stringify({
        kind,
        file: shot.file,
        width: shot.width,
        height: shot.height,
        duration: shot.duration,
        times: times.map((time) => Math.max(0, ((time - shot.startTime) * 100) / shot.stretch)),
        center: shot.center,
        polygon: shot.polygon,
        fov,
      }),
      { mode: 0o600 },
    );
    worker = await run(python, ["-I", join(SERVER_ROOT, "py", "tracking.py"), spec], {
      timeoutMs: 150_000,
    });
  } finally {
    await rm(spec, { force: true });
    await rmdir(folder);
  }
  if (worker.code !== 0)
    return {
      ok: false,
      error: worker.stderr.trim() || "A análise excedeu o tempo disponível. Use um trecho menor.",
    };
  const analysis = JSON.parse(worker.stdout);
  if (!analysis.ok) return analysis;
  const current = await stat(shot.file).catch(() => null);
  if (!current || current.mtimeMs !== input.mtimeMs || current.size !== input.size)
    return { ok: false, error: "O vídeo mudou durante a análise. Rode a operação novamente." };
  const write = await transport.execute({
    code: writeCode(shot, kind, args),
    payload: { times, analysis },
    label: "Gravar tracking",
    timeoutMs: 30_000,
    instance,
  });
  return write.ok ? write.result : { ok: false, error: write.error ?? "Falha ao gravar tracking." };
}

const SELECTOR = { type: "any" as const, description: "Positive index or exact name." };

for (const [kind, operation, description, extra] of [
  [
    "point",
    "analyze_points",
    "Analyze a point through a video range and write editable point keys. Uses the selected native track by index, or creates a Point Control if none exists.",
    [
      { ...SELECTOR, name: "tracker" },
      { ...SELECTOR, name: "point" },
      {
        name: "center",
        type: "array",
        description:
          "Optional seed [x,y] in source pixels. Otherwise uses the native point or detects a feature.",
      },
      {
        name: "name",
        type: "string",
        description: "Name for the Point Control if no native track exists.",
      },
    ],
  ],
  [
    "mask",
    "analyze_mask",
    "Follow an existing closed mask through a video range and write animated Mask Path keys. Estimates translation, scale and rotation.",
    [{ ...SELECTOR, name: "mask", required: true }],
  ],
  [
    "camera",
    "create_camera",
    "Solve scene motion from a continuous video shot with parallax and create an animated AE camera without opening a panel.",
    [
      {
        name: "horizontalFov",
        type: "number",
        description: "Horizontal field of view in degrees, from 10 to 150. Default 54.",
      },
      {
        name: "step",
        type: "number",
        description: "Sample every N composition frames. Default 1, maximum 8.",
      },
      { name: "name", type: "string", description: "Name of the new animated camera." },
    ],
  ],
] as const) {
  registerOp({
    name: "tracking." + operation,
    category: "tracking",
    description,
    params: [...PARAMETERS, ...extra],
    toJsx: () => jsxFail("A análise de vídeo precisa rodar individualmente pelo ae_do."),
    run: (args, transport) => analyze(args, transport, kind),
  });
}
