/** Read-only Plugin API script for the already authenticated Figma connector. */
export function captureFigmaFrame(nodeId: string, fileKey?: string): string {
  return `
const root = await figma.getNodeByIdAsync(${JSON.stringify(nodeId)});
if (!root || !['FRAME','COMPONENT','INSTANCE','GROUP','SECTION'].includes(root.type))
  throw new Error('Selecione um frame ou grupo de uma tela do Figma.');
const round = n => Math.round(n * 100000) / 100000;
const read = (node, key, fallback) => {
  try { return key in node && node[key] !== figma.mixed ? node[key] : fallback; }
  catch { return fallback; }
};
const paints = items => (Array.isArray(items) ? items : []).filter(p => p.visible !== false).map(p => ({
  type: p.type, opacity: typeof p.opacity === 'number' ? p.opacity : 1,
  ...(p.color ? {color:[p.color.r,p.color.g,p.color.b]} : {}),
  ...(p.imageHash ? {image:p.imageHash, mode:p.scaleMode} : {})
}));
const geometry = items => (Array.isArray(items) ? items : []).map(p => ({
  path: p.data, rule: p.windingRule
}));
const nodes = [], pending = [{node:root, parent:null, order:0}];
for (let i=0; i<pending.length; i++) {
  if (i >= 1500) throw new Error('O frame tem mais de 1.500 nós. Capture uma seção por vez.');
  const {node, parent, order} = pending[i];
  const n = {
    id:node.id, name:node.name, type:node.type, parent, order,
    size:[round(node.width),round(node.height)],
    matrix:node.absoluteTransform.flat().map(round),
    visible:node.visible !== false,
    opacity:read(node,'opacity',1),
    blend:read(node,'blendMode','NORMAL'),
    clip:read(node,'clipsContent',false),
    mask:read(node,'isMask',false) ? read(node,'maskType','ALPHA') : null,
    fills:paints(read(node,'fills',[])),
    strokes:paints(read(node,'strokes',[])),
    strokeWeight:read(node,'strokeWeight',1),
    strokeAlign:read(node,'strokeAlign','CENTER'),
    dash:read(node,'dashPattern',[]),
    corners:['topLeftRadius','topRightRadius','bottomRightRadius','bottomLeftRadius'].map(k => read(node,k,read(node,'cornerRadius',0))),
    effects:read(node,'effects',[]).filter(e=>e.visible!==false).map(e=>e.type)
  };
  if (node.type === 'TEXT') {
    const b = read(node,'absoluteRenderBounds',null);
    n.text = {
      value:node.characters, align:node.textAlignHorizontal, valign:node.textAlignVertical,
      auto:node.textAutoResize, paragraphSpacing:read(node,'paragraphSpacing',0),
      bounds:b ? [b.x,b.y,b.width,b.height].map(round) : null,
      runs:node.getStyledTextSegments(['fontName','fontSize','fills','letterSpacing','lineHeight','textCase','textDecoration'])
        .map(r=>({start:r.start,end:r.end,family:r.fontName.family,style:r.fontName.style,
          size:r.fontSize,fills:paints(r.fills),letter:r.letterSpacing,leading:r.lineHeight,
          casing:r.textCase, decoration:r.textDecoration}))
    };
  } else {
    n.paths = geometry(read(node,'fillGeometry',[]));
    n.strokePaths = geometry(read(node,'strokeGeometry',[]));
    if (!n.paths.length && !n.strokePaths.length &&
        ['VECTOR','BOOLEAN_OPERATION','POLYGON','STAR','LINE'].includes(n.type))
      n.paths = geometry(read(node,'vectorPaths',[]));
  }
  nodes.push(n);
  // Boolean geometry already represents the evaluated shape. Its construction
  // children must not paint over it.
  if (node.type !== 'BOOLEAN_OPERATION' && 'children' in node)
    node.children.forEach((child, index) => pending.push({node:child,parent:node.id,order:index}));
}
const capture = {schema:'tuift.figma-frame/v1',fileKey:${JSON.stringify(fileKey ?? null)},rootId:root.id,nodes};
if (JSON.stringify(capture).length > 900000)
  throw new Error('A captura é muito grande. Transfira uma seção da tela por vez.');
return capture;`.trim();
}
