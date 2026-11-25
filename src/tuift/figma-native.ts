/** Resident AE script. The conversion plan arrives as JSON, never as executable source. */
export const FIGMA_IMPORT_JSX = String.raw`
var spec = payload, created = [], log = spec.warnings.slice(), mappings = [];
var counts = {text:0, shape:0, image:0, precomp:0, matte:0}, imageItems = {}, fontCache = {};
var assetFolder = null, main = null, W = spec.width, H = spec.height;
function warn(node, message) { log.push({id:node.id,name:node.name,message:message}); }
function property(layer, name) { return layer.property("ADBE Transform Group").property(name); }
function anchor(layer, point) {
    property(layer,"ADBE Anchor Point").setValue(point);
    property(layer,"ADBE Position").setValue(point);
}
var blends = {
    MULTIPLY:"MULTIPLY", SCREEN:"SCREEN", OVERLAY:"OVERLAY", DARKEN:"DARKEN", LIGHTEN:"LIGHTEN",
    DIFFERENCE:"DIFFERENCE", COLOR_DODGE:"COLOR_DODGE", COLOR_BURN:"COLOR_BURN", SOFT_LIGHT:"SOFT_LIGHT",
    HARD_LIGHT:"HARD_LIGHT", EXCLUSION:"EXCLUSION", HUE:"HUE", SATURATION:"SATURATION",
    COLOR:"COLOR", LUMINOSITY:"LUMINOSITY"
};
function tag(comp, layer, node, kind, opacity, preserveBlend) {
    layer.name = node.name || kind;
    layer.comment = "Figma " + node.id;
    layer.enabled = node.enabled;
    property(layer,"ADBE Opacity").setValue((opacity === null ? node.opacity : opacity) * 100);
    if (preserveBlend && blends.hasOwnProperty(node.blend) && BlendingMode[blends[node.blend]] !== undefined)
        layer.blendingMode = BlendingMode[blends[node.blend]];
    counts[kind]++;
    mappings.push({nodeId:node.id,compId:comp.id,layerId:layer.id,kind:kind});
    return layer;
}
function shape(path) {
    var value = new Shape();
    value.vertices = path.vertices;
    value.inTangents = path.inTangents;
    value.outTangents = path.outTangents;
    value.closed = path.closed;
    return value;
}
function restrict(layer, path) {
    var mask = layer.property("ADBE Mask Parade").addProperty("ADBE Mask Atom");
    mask.name = "Recorte do Figma";
    mask.maskMode = MaskMode.ADD;
    mask.property("ADBE Mask Shape").setValue(shape(path));
}
function paintGroups(layer, entries, paints, outlines, weight) {
    for (var i=0; i<paints.length; i++) for (var e=0; e<entries.length; e++) {
        var root = layer.property("ADBE Root Vectors Group");
        var group = root.addProperty("ADBE Vector Group");
        var contents = group.property("ADBE Vectors Group"), entry = entries[e], paint = paints[i];
        group.name = outlines ? "Traço" : "Forma";
        for (var p=0; p<entry.paths.length; p++) {
            var path = contents.addProperty("ADBE Vector Shape - Group");
            path.property("ADBE Vector Shape").setValue(shape(entry.paths[p]));
        }
        var style = contents.addProperty(outlines ? "ADBE Vector Graphic - Stroke" : "ADBE Vector Graphic - Fill");
        var prefix = outlines ? "ADBE Vector Stroke " : "ADBE Vector Fill ";
        style.property(prefix + "Color").setValue([paint.color[0],paint.color[1],paint.color[2],1]);
        style.property(prefix + "Opacity").setValue(paint.opacity * 100);
        if(outlines) style.property("ADBE Vector Stroke Width").setValue(weight);
        else style.property("ADBE Vector Fill Rule").setValue(entry.rule === "EVENODD" ? 2 : 1);
    }
}
function vectors(comp, node, inner) {
    var fill = node.sourcePaths.length && node.fills.length;
    var stroke = (node.sourcePaths.length || node.strokePaths.length) && node.outline.length;
    if (!fill && !stroke) return null;
    var layer = comp.layers.addShape();
    anchor(layer,node.center);
    // AE draws entries at the top of the shape stack in front of later entries.
    if (stroke) {
        if (node.strokePaths.length) paintGroups(layer,node.strokePaths,node.outline,false,0);
        else paintGroups(layer,node.sourcePaths,node.outline,true,node.strokeWeight);
    }
    if (fill) paintGroups(layer,node.sourcePaths,node.fills,false,0);
    return tag(comp,layer,node,"shape",inner ? 1 : null,!inner);
}
function font(run, node) {
    var key = run.family + "\n" + run.style, result;
    if (fontCache.hasOwnProperty(key)) {
        result = fontCache[key];
    } else {
        var fonts = app.fonts ? app.fonts.getFontsByFamilyNameAndStyleName(run.family,run.style) : [];
        result = fonts.length ? fonts[0] : null;
        fontCache[key] = result;
    }
    if (!result) warn(node, "Fonte indisponível: " + run.family + " " + run.style);
    return result;
}
function textStyle(doc, run, face, paragraph) {
    if (face) doc.fontObject = face;
    doc.fontSize = run.size;
    var fills = run.fills || [], fill = null;
    for (var i=0; i<fills.length; i++) if (fills[i].type === "SOLID" && fills[i].color) { fill = fills[i]; break; }
    doc.applyFill = !!fill;
    if (fill) doc.fillColor = fill.color;
    if (run.letter && run.letter.value !== undefined) {
        doc.tracking = run.letter.unit === "PERCENT" ? run.letter.value * 10 : 1000 * run.letter.value / run.size;
    }
    if (!paragraph) return;
    if (run.leading && run.leading.value !== undefined) {
        doc.autoLeading = false;
        doc.leading = run.leading.unit === "PERCENT" ? run.leading.value / 100 * run.size : run.leading.value;
    }
}
function textPosition(layer, node, isBox) {
    var target = node.text.renderTop;
    if (!target) return node.origin;
    var bounds = layer.sourceRectAtTime(0,false);
    if (isBox || bounds.width <= 0 || bounds.height <= 0) return node.origin;
    var angle = node.rotation * Math.PI / 180, co = Math.cos(angle), si = Math.sin(angle);
    var ox = 1e20, oy = 1e20;
    for (var j=0; j<4; j++) {
        var x = (bounds.left + (j%2 ? bounds.width : 0)) * node.scale[0];
        var y = (bounds.top + (j>=2 ? bounds.height : 0)) * node.scale[1];
        ox = Math.min(ox,co*x-si*y);
        oy = Math.min(oy,si*x+co*y);
    }
    return [target[0]-ox,target[1]-oy];
}
function textLayer(comp, node) {
    var source = node.text, ranges = source.runs, text = source.value.replace(/\r?\n/g,"\r");
    var isBox = (source.auto === "HEIGHT" || source.auto === "NONE" || source.auto === "TRUNCATE") &&
        node.size[0] > 0 && node.size[1] > 0;
    var layer = isBox ? comp.layers.addBoxText([node.size[0],node.size[1]],text) : comp.layers.addText(text);
    var prop = layer.property("ADBE Text Properties").property("ADBE Text Document");
    var doc = prop.value;
    var align = {LEFT:ParagraphJustification.LEFT_JUSTIFY,CENTER:ParagraphJustification.CENTER_JUSTIFY,
        RIGHT:ParagraphJustification.RIGHT_JUSTIFY,JUSTIFIED:ParagraphJustification.FULL_JUSTIFY_LASTLINE_LEFT};
    if (align.hasOwnProperty(source.align)) doc.justification = align[source.align];
    if (source.paragraphSpacing) doc.spaceAfter = source.paragraphSpacing;
    if (isBox) {
        doc.boxTextPos = [0,0];
        if (typeof BoxVerticalAlignment !== "undefined") {
            if(source.valign === "CENTER") doc.boxVerticalAlignment = BoxVerticalAlignment.CENTER;
            if(source.valign === "BOTTOM") doc.boxVerticalAlignment = BoxVerticalAlignment.BOTTOM;
        }
    }
    if (ranges.length) textStyle(doc,ranges[0],font(ranges[0],node),true);
    if (ranges.length > 1) {
        if (typeof doc.characterRange !== "function") warn(node,"Estilos de texto por intervalo exigem After Effects 24.3 ou superior.");
        else for (var i=0; i<ranges.length; i++) {
            var style = ranges[i];
            textStyle(doc.characterRange(style.start,style.end),style,font(style,node),false);
        }
    }
    prop.setValue(doc);
    property(layer,"ADBE Anchor Point").setValue([0,0]);
    property(layer,"ADBE Scale").setValue([node.scale[0]*100,node.scale[1]*100]);
    property(layer,"ADBE Rotate Z").setValue(node.rotation);
    property(layer,"ADBE Position").setValue(textPosition(layer,node,isBox));
    return tag(comp,layer,node,"text",null,true);
}
function assets() {
    if (!assetFolder) {
        assetFolder = app.project.items.addFolder(main.name + " - Grupos e mídia");
        created.push(assetFolder);
    }
    return assetFolder;
}
function imageLayer(comp, node, picture, inner) {
    var item = imageItems[picture.file];
    if (!item) {
        var file = new File(picture.file);
        if (!file.exists) throw new Error("Arquivo de imagem indisponível: " + node.name);
        var options = new ImportOptions(file);
        options.sequence = false;
        item = app.project.importFile(options);
        created.push(item);
        imageItems[picture.file] = item;
        item.parentFolder = assets();
    }
    var layer = comp.layers.add(item), w = item.width, h = item.height;
    if (!w || !h) throw new Error("Imagem sem dimensões: " + node.name);
    var ratio = (picture.mode === "FIT" ? Math.min : Math.max)(node.size[0]/w,node.size[1]/h);
    property(layer,"ADBE Position").setValue(node.center);
    property(layer,"ADBE Scale").setValue([ratio*node.scale[0]*100,ratio*node.scale[1]*100]);
    property(layer,"ADBE Rotate Z").setValue(node.rotation);
    var local = node.imageClip, transformed = {closed:local.closed,vertices:[],inTangents:[],outTangents:[]};
    for(var j=0; j<local.vertices.length; j++) {
        var v=local.vertices[j], a=local.inTangents[j], b=local.outTangents[j];
        transformed.vertices.push([(v[0]-node.size[0]/2)/ratio+w/2,(v[1]-node.size[1]/2)/ratio+h/2]);
        transformed.inTangents.push([a[0]/ratio,a[1]/ratio]);
        transformed.outTangents.push([b[0]/ratio,b[1]/ratio]);
    }
    restrict(layer,transformed);
    return tag(comp,layer,node,"image",picture.opacity * (inner ? 1 : node.opacity),!inner);
}
function buildChildren(comp, node) {
    var matte = null, mode = TrackMatteType.ALPHA;
    for(var i=0; i<node.children.length; i++) {
        var n=node.children[i], layers=build(comp,n);
        if(n.mask && n.enabled) {
            matte = layers.length ? layers[layers.length-1] : null;
            if(matte) { matte.enabled = false; mode = n.mask === "LUMINANCE" ? TrackMatteType.LUMA : TrackMatteType.ALPHA; counts.matte++; }
            else warn(n,"O recorte entre camadas não pôde ser criado.");
        } else if(matte) for(var j=0; j<layers.length; j++) layers[j].setTrackMatte(matte,mode);
    }
}
function paintNode(comp, node, inner) {
    if(node.text) return [textLayer(comp,node)];
    var layers=[], vector=vectors(comp,node,inner);
    if(vector) layers.push(vector);
    for(var i=0; i<node.pictures.length; i++) layers.push(imageLayer(comp,node,node.pictures[i],inner));
    return layers;
}
function build(comp, node) {
    if(!node.children.length) return paintNode(comp,node,false);
    var sub = app.project.items.addComp(node.name || "Grupo",W,H,1,spec.duration,spec.fps);
    created.push(sub);
    sub.parentFolder = assets();
    var comment = "Figma " + node.id;
    sub.comment = comment;
    paintNode(sub,node,true);
    buildChildren(sub,node);
    var layer = comp.layers.add(sub);
    anchor(layer,node.center);
    if(node.clip) restrict(layer,node.clip);
    return [tag(comp,layer,node,"precomp",null,true)];
}
function uniqueName(name) {
    var used = {};
    for(var i=1; i<=app.project.numItems; i++) used["_" + app.project.item(i).name] = true;
    var next = name, counter=2;
    while(used["_" + next]) next = name + " (" + counter++ + ")";
    return next;
}
try {
    main = app.project.items.addComp(uniqueName(spec.name),W,H,1,spec.duration,spec.fps);
    created.push(main);
    if(spec.source) main.comment = "Figma: https://www.figma.com/design/" + spec.source.file + "?node-id=" + spec.source.node.replace(/:/g,"-");
    paintNode(main,spec.tree,true);
    buildChildren(main,spec.tree);
    if (!counts.text && !counts.shape && !counts.image) throw new Error("A tela não trouxe nenhum elemento importável.");
    if (spec.strict && log.length) throw new Error("A importação exige revisão de fontes ou estilos.");
    return {ok:true,compId:main.id,name:main.name,width:W,height:H,counts:counts,mappings:mappings,warnings:log};
} catch(e) {
    for(var i=created.length-1; i>=0; i--) { try { created[i].remove(); } catch(ignore) {} }
    return {ok:false,error:AE.errText(e),warnings:log};
}
`;
