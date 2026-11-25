export type XY = [number, number];
export type Affine = [number, number, number, number, number, number];

export function applyAffine(m: Affine, [x, y]: XY): XY {
  return [m[0] * x + m[1] * y + m[2], m[3] * x + m[4] * y + m[5]];
}

export function multiplyAffine(a: Affine, b: Affine): Affine {
  const [tX, tY] = applyAffine(a, [b[2], b[5]]);
  return [
    a[0] * b[0] + a[1] * b[3],
    a[0] * b[1] + a[1] * b[4],
    tX,
    a[3] * b[0] + a[4] * b[3],
    a[3] * b[1] + a[4] * b[4],
    tY,
  ];
}

export function inverseAffine([a, b, x, c, d, y]: Affine): Affine {
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-9) throw new Error("O frame do Figma tem uma transformação inválida.");
  return [d / det, -b / det, (b * y - d * x) / det, -c / det, a / det, (c * x - a * y) / det];
}

export type Bezier = {
  vertices: XY[];
  inTangents: XY[];
  outTangents: XY[];
  closed: boolean;
};

const add = (a: XY, b: XY): XY => [a[0] + b[0], a[1] + b[1]];
const sub = (a: XY, b: XY): XY => [a[0] - b[0], a[1] - b[1]];
const scale = (a: XY, n: number): XY => [a[0] * n, a[1] * n];

export function mapBezier(path: Bezier, m: Affine): Bezier {
  const delta: Affine = [m[0], m[1], 0, m[3], m[4], 0];
  return {
    vertices: path.vertices.map((p) => applyAffine(m, p)),
    inTangents: path.inTangents.map((p) => applyAffine(delta, p)),
    outTangents: path.outTangents.map((p) => applyAffine(delta, p)),
    closed: path.closed,
  };
}

/** Unpack the line, quadratic and cubic contour data produced by Figma. */
export function parseFigmaPath(data: string): Bezier[] {
  const tokens = data.match(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?/g) ?? [];
  if (data.replace(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?|[\s,]/g, ""))
    throw new Error("Contorno do Figma contém caracteres inválidos.");
  const paths: Bezier[] = [];
  let point: XY = [0, 0];
  let path: Bezier | undefined;
  let cursor = 0;
  let cmd = "";
  let cubic: XY | undefined;
  let quadratic: XY | undefined;

  function number(): number {
    const n = Number(tokens[cursor++]);
    if (!Number.isFinite(n)) throw new Error("Contorno do Figma incompleto.");
    return n;
  }
  function push(p: XY, incoming: XY = [0, 0]) {
    if (!path) throw new Error("Contorno sem ponto inicial.");
    path.vertices.push(p);
    path.inTangents.push(incoming);
    path.outTangents.push([0, 0]);
    point = p;
  }
  while (cursor < tokens.length) {
    if (/^[a-z]$/i.test(tokens[cursor])) cmd = tokens[cursor++];
    const op = cmd.toUpperCase();
    const relative = cmd !== op;
    const pair = (): XY => {
      const xy: XY = [number(), number()];
      return relative ? add(point, xy) : xy;
    };
    let nextCubic: XY | undefined;
    let nextQuadratic: XY | undefined;
    if (op === "M") {
      path = { vertices: [], inTangents: [], outTangents: [], closed: false };
      paths.push(path);
      push(pair());
      cmd = relative ? "l" : "L";
    } else if (op === "Z") {
      if (!path) throw new Error("Fechamento de contorno sem ponto inicial.");
      const last = path.vertices.length - 1;
      const first = path.vertices[0];
      if (last > 0 && Math.hypot(...sub(point, first)) < 1e-6) {
        path.vertices.pop();
        path.outTangents.pop();
        path.inTangents[0] = path.inTangents.pop()!;
      }
      path.closed = true;
      point = first;
      cmd = "";
    } else if (op === "L") push(pair());
    else if (op === "H") push([number() + (relative ? point[0] : 0), point[1]]);
    else if (op === "V") push([point[0], number() + (relative ? point[1] : 0)]);
    else if (op === "C" || op === "S" || op === "Q" || op === "T") {
      if (!path) throw new Error("Curva sem ponto inicial.");
      let a: XY, b: XY, end: XY;
      if (op === "C" || op === "S") {
        a = op === "C" ? pair() : cubic ? add(point, sub(point, cubic)) : point;
        b = pair();
        end = pair();
        nextCubic = b;
      } else {
        const q = op === "Q" ? pair() : quadratic ? add(point, sub(point, quadratic)) : point;
        end = pair();
        a = add(point, scale(sub(q, point), 2 / 3));
        b = add(end, scale(sub(q, end), 2 / 3));
        nextQuadratic = q;
      }
      path.outTangents[path.vertices.length - 1] = sub(a, point);
      push(end, sub(b, end));
    } else throw new Error("Comando de contorno não compatível: " + (cmd || "(vazio)"));
    cubic = nextCubic;
    quadratic = nextQuadratic;
  }
  return paths.filter((p) => p.vertices.length > 1);
}

export function roundedRect(w: number, h: number, radii: number[]): Bezier {
  const [a, b, c, d] = radii.map((r) => Math.min(Math.max(0, r), w / 2, h / 2));
  if (!(a || b || c || d)) return parseFigmaPath(`M0,0 H${w} V${h} H0 Z`)[0];
  const k = 0.5522847498;
  const path = `M${a},0 H${w - b} C${w - b + k * b},0 ${w},${b - k * b} ${w},${b}
    V${h - c} C${w},${h - c + k * c} ${w - c + k * c},${h} ${w - c},${h}
    H${d} C${d - k * d},${h} 0,${h - d + k * d} 0,${h - d}
    V${a} C0,${a - k * a} ${a - k * a},0 ${a},0 Z`;
  return parseFigmaPath(path)[0];
}
