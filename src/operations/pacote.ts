// Mudar o projeto de lugar (01/11/2026): footage.relink troca prefixos de caminho em massa e project.collect
// junta projeto e mídia numa pasta, como o Collect Files do AE, mas sem diálogo e com a cópia fora do AE (mídia
// grande não trava a janela). Serve para mover projeto para o Drive ou para um PC na nuvem.

import { promises as fs } from "node:fs";
import * as path from "node:path";

import { registerOp, jsxFail, jsxVal } from "../registry.js";
import { runJsx } from "../tuift/common.js";

const TROCAS_DESC =
  "List of { de, para } path prefixes, tried in order. Slashes and letter case do not matter; a prefix only matches a whole folder name.";

registerOp({
  name: "footage.relink",
  category: "footage",
  description:
    "Relink footage IN BULK by swapping path prefixes (E:/Drive/x → D:/media/x). Works on missing and present files; " +
    "a target that does not exist is reported in naoAchados and the item stays as it was. Layers keep their keyframes and effects. " +
    "Use dryRun first to see what would change. Image sequences stay sequences.",
  params: [
    {
      name: "trocas",
      type: "array",
      description: TROCAS_DESC,
      required: true,
    },
    {
      name: "soFaltando",
      type: "boolean",
      description: "Touch only items whose file is missing (default false)",
      required: false,
      default: false,
    },
    {
      name: "dryRun",
      type: "boolean",
      description: "Only report what would change (default false)",
      required: false,
      default: false,
    },
  ],
  toJsx(args) {
    const trocas = args.trocas as Array<{ de?: unknown; para?: unknown }>;
    if (!Array.isArray(trocas) || !trocas.length)
      return jsxFail("trocas must be a non-empty array");
    for (const t of trocas) {
      if (typeof t?.de !== "string" || typeof t?.para !== "string" || !t.de || !t.para)
        return jsxFail("each troca needs `de` and `para` as non-empty strings");
    }
    return `
      var _trocas = ${jsxVal(trocas)};
      var _soFaltando = ${jsxVal(args.soFaltando === true)};
      var _dry = ${jsxVal(args.dryRun === true)};
      function _barra(s) { return String(s).split(String.fromCharCode(92)).join("/").replace(/[\\/]+$/, ""); }
      function _novo(p) {
        var n = _barra(p), nl = n.toLowerCase();
        for (var t = 0; t < _trocas.length; t++) {
          var d = _barra(_trocas[t].de), dl = d.toLowerCase();
          if (nl === dl || nl.indexOf(dl + "/") === 0) return _barra(_trocas[t].para) + n.substr(d.length);
        }
        return null;
      }
      var _seqExt = { png: 1, jpg: 1, jpeg: 1, tif: 1, tiff: 1, exr: 1, tga: 1, dpx: 1, psd: 1, bmp: 1, hdr: 1, cin: 1, webp: 1 };
      var _feitos = [], _nao = [], _erros = [], _iguais = 0;
      for (var _i = 1; _i <= app.project.numItems; _i++) {
        var _it = app.project.item(_i);
        if (!(_it instanceof FootageItem) || !(_it.mainSource instanceof FileSource)) continue;
        var _falta = AE.safeGet(function () { return _it.footageMissing; }, false);
        if (_soFaltando && !_falta) continue;
        var _p = _falta ? AE.safeGet(function () { return _it.mainSource.missingFootagePath; }, null)
                        : AE.safeGet(function () { return _it.file.fsName; }, null);
        if (!_p) continue;
        var _n = _novo(_p);
        if (_n === null) { _iguais++; continue; }
        var _f = new File(_n);
        if (!_f.exists) { _nao.push({ id: _it.id, nome: _it.name, de: _barra(_p), para: _n }); continue; }
        if (!_dry) {
          var _seq = !_it.mainSource.isStill && _seqExt[_n.split(".").pop().toLowerCase()] === 1;
          var _nome = _it.name;
          try {
            if (_seq) _it.replaceWithSequence(_f, false); else _it.replace(_f);
            if (_it.name !== _nome) _it.name = _nome;
          } catch (eR) { _erros.push({ id: _it.id, nome: _nome, erro: AE.errText(eR) }); continue; }
        }
        _feitos.push({ id: _it.id, nome: _it.name, para: _n });
      }
      return { ok: _erros.length === 0, dryRun: _dry, trocados: _feitos.length, naoAchados: _nao.length,
               semTroca: _iguais, itens: _feitos.slice(0, 200), faltaram: _nao.slice(0, 200), erros: _erros,
               error: _erros.length ? _erros.length + " item(s) could not be relinked" : undefined };
    `;
  },
});

// ---------------------------------------------------------------------------------------------------------------

/** Nome livre na pasta: foto.png, foto__2.png… sem depender de maiúscula (o Windows não diferencia). */
export function nomeLivre(usados: Set<string>, nome: string): string {
  const ext = path.extname(nome);
  const base = nome.slice(0, nome.length - ext.length);
  let tentativa = nome;
  for (let n = 2; usados.has(tentativa.toLowerCase()); n++) tentativa = `${base}__${n}${ext}`;
  usados.add(tentativa.toLowerCase());
  return tentativa;
}

/** Arquivos da mesma sequência de imagens: mesmo prefixo, mesma extensão, número no fim. */
export function quadrosDaSequencia(primeiro: string, arquivos: string[]): string[] {
  const ext = path.extname(primeiro);
  const base = path.basename(primeiro, ext);
  const m = base.match(/^(.*?)(\d+)$/);
  if (!m) return [path.basename(primeiro)];
  const prefixo = m[1].toLowerCase();
  return arquivos.filter((a) => {
    if (path.extname(a).toLowerCase() !== ext.toLowerCase()) return false;
    const b = path.basename(a, path.extname(a));
    const mb = b.match(/^(.*?)(\d+)$/);
    return !!mb && mb[1].toLowerCase() === prefixo;
  });
}

const LISTAR_JSX = `
var seqExt = { png: 1, jpg: 1, jpeg: 1, tif: 1, tiff: 1, exr: 1, tga: 1, dpx: 1, psd: 1, bmp: 1, hdr: 1, cin: 1, webp: 1 };
if (!app.project.file) return { ok: false, error: "save the project first: project.collect needs a project file" };
var itens = [];
for (var i = 1; i <= app.project.numItems; i++) {
  var it = app.project.item(i);
  if (!(it instanceof FootageItem) || !(it.mainSource instanceof FileSource)) continue;
  var falta = AE.safeGet(function () { return it.footageMissing; }, false);
  var p = falta ? AE.safeGet(function () { return it.mainSource.missingFootagePath; }, null)
                : AE.safeGet(function () { return it.file.fsName; }, null);
  if (!p) continue;
  itens.push({ id: it.id, nome: it.name, caminho: String(p), falta: !!falta,
               usado: AE.safeGet(function () { return it.usedIn.length > 0; }, true),
               seq: !it.mainSource.isStill && seqExt[String(p).split(".").pop().toLowerCase()] === 1 });
}
var fontes = [];
try {
  var uf = app.project.usedFonts;
  for (var f = 0; uf && f < uf.length; f++) fontes.push({ postScript: uf[f].font.postScriptName, familia: uf[f].font.familyName, substituta: uf[f].font.isSubstitute });
} catch (eF) {}
var efeitos = {};
for (var c = 1; c <= app.project.numItems; c++) {
  var comp = app.project.item(c);
  if (!(comp instanceof CompItem)) continue;
  for (var l = 1; l <= comp.numLayers; l++) {
    var fx = null;
    try { fx = comp.layer(l).property("ADBE Effect Parade"); } catch (eFx) {}
    if (!fx) continue;
    for (var e = 1; e <= fx.numProperties; e++) {
      var mn = String(fx.property(e).matchName);
      if (mn.indexOf("ADBE ") !== 0) efeitos[mn] = fx.property(e).name;
    }
  }
}
var lista = [];
for (var k in efeitos) if (efeitos.hasOwnProperty(k)) lista.push({ matchName: k, nome: efeitos[k] });
return { projeto: app.project.file.fsName, sujo: app.project.dirty, itens: itens, fontes: fontes, efeitosDeTerceiros: lista };
`;

const RELIGAR_JSX = `
var erros = [], feitos = 0;
for (var i = 0; i < payload.trocas.length; i++) {
  var t = payload.trocas[i];
  var it = AE.findItemById(t.id);
  if (!it) { erros.push({ id: t.id, erro: "item sumiu" }); continue; }
  var nome = it.name, f = new File(t.para);
  try {
    if (t.seq) it.replaceWithSequence(f, false); else it.replace(f);
    if (it.name !== nome) it.name = nome;
    feitos++;
  } catch (e) { erros.push({ id: t.id, nome: nome, erro: AE.errText(e) }); }
}
if (erros.length === 0) app.project.save(new File(payload.salvarEm));
return { feitos: feitos, erros: erros, salvoEm: erros.length === 0 ? app.project.file.fsName : null };
`;

interface ItemLista {
  id: number;
  nome: string;
  caminho: string;
  falta: boolean;
  usado: boolean;
  seq: boolean;
}

registerOp({
  name: "project.collect",
  category: "project",
  description:
    "Collect the open project and its media into ONE folder, like File > Dependencies > Collect Files but with no dialog: copies footage " +
    "to <destino>/footage (whole image sequences included), relinks it and saves the project there. The OPEN project becomes the collected " +
    "copy; the original .aep on disk is not touched. Writes pacote.json with the missing files, the fonts and the third-party effects the " +
    "other machine will need. Runs in Node, so big media does not freeze After Effects. Use dryRun first.",
  params: [
    {
      name: "destino",
      type: "string",
      description:
        "Target folder (created if needed). A folder already holding this project needs sobrescrever.",
      required: true,
    },
    {
      name: "soUsados",
      type: "boolean",
      description: "Copy only footage used by some comp (default true)",
      required: false,
      default: true,
    },
    {
      name: "dryRun",
      type: "boolean",
      description: "Only report files, sizes and what is missing (default false)",
      required: false,
      default: false,
    },
    {
      name: "sobrescrever",
      type: "boolean",
      description: "Allow replacing a project already saved in destino (default false)",
      required: false,
      default: false,
    },
  ],
  toJsx: () =>
    jsxFail(
      "project.collect runs on the Node side (it copies files outside After Effects) — call it as its own ae_do, not inside batch.run",
    ),
  async run(args, transport) {
    const destino = path.resolve(String(args.destino));
    const lista = await runJsx<{
      projeto: string;
      sujo: boolean;
      itens: ItemLista[];
      fontes: unknown[];
      efeitosDeTerceiros: unknown[];
    }>(transport, LISTAR_JSX, "collect_lista", { undoGroup: false, timeoutMs: 120_000 });
    if (!lista.ok)
      return {
        ok: false,
        error:
          lista.error.content[0]?.type === "text"
            ? lista.error.content[0].text
            : "could not list the project",
      };
    const { projeto, sujo, itens, fontes, efeitosDeTerceiros } = lista.value;

    const salvarEm = path.join(destino, path.basename(projeto));
    if (path.resolve(projeto).toLowerCase() === salvarEm.toLowerCase())
      return { ok: false, error: "destino is the project's own folder" };
    const jaExiste = await fs.stat(salvarEm).then(
      () => true,
      () => false,
    );
    if (jaExiste && args.sobrescrever !== true && args.dryRun !== true)
      return {
        ok: false,
        error: `${salvarEm} already exists`,
        hint: "Pass sobrescrever: true or another destino.",
      };

    const pastaFootage = path.join(destino, "footage");
    const usados = new Set<string>();
    const faltando = itens
      .filter((i) => i.falta)
      .map((i) => ({ nome: i.nome, caminho: i.caminho }));
    const copias: Array<{ de: string; para: string }> = [];
    const trocas: Array<{ id: number; para: string; seq: boolean }> = [];
    const foraDoPacote: string[] = [];

    for (const it of itens) {
      if (it.falta) continue;
      if (args.soUsados !== false && !it.usado) {
        foraDoPacote.push(it.nome);
        continue;
      }
      if (it.seq) {
        const pastaOrigem = path.dirname(it.caminho);
        const arquivos = await fs.readdir(pastaOrigem);
        const quadros = quadrosDaSequencia(it.caminho, arquivos);
        const sub = nomeLivre(usados, path.basename(it.caminho, path.extname(it.caminho)));
        for (const q of quadros)
          copias.push({ de: path.join(pastaOrigem, q), para: path.join(pastaFootage, sub, q) });
        trocas.push({
          id: it.id,
          para: path.join(pastaFootage, sub, path.basename(it.caminho)).replace(/\\/g, "/"),
          seq: true,
        });
      } else {
        const nome = nomeLivre(usados, path.basename(it.caminho));
        copias.push({ de: it.caminho, para: path.join(pastaFootage, nome) });
        trocas.push({
          id: it.id,
          para: path.join(pastaFootage, nome).replace(/\\/g, "/"),
          seq: false,
        });
      }
    }

    let bytes = 0;
    const naoLidos: string[] = [];
    const tamanhos = new Map<string, number>();
    for (const c of copias) {
      try {
        const st = await fs.stat(c.de);
        bytes += st.size;
        tamanhos.set(c.de, st.size);
      } catch {
        naoLidos.push(c.de);
      }
    }
    const relatorio = {
      projetoOriginal: projeto.replace(/\\/g, "/"),
      arquivos: copias.length,
      megabytes: Math.round(bytes / 1048576),
      faltando,
      foraDoPacote,
      fontes,
      efeitosDeTerceiros,
    };
    if (args.dryRun === true)
      return {
        ok: naoLidos.length === 0,
        dryRun: true,
        destino: destino.replace(/\\/g, "/"),
        naoLidos,
        ...relatorio,
      };
    if (naoLidos.length)
      return { ok: false, error: `${naoLidos.length} file(s) could not be read`, naoLidos };

    await fs.mkdir(pastaFootage, { recursive: true });
    const livre = await fs.statfs(destino).then(
      (s) => Number(s.bavail) * Number(s.bsize),
      () => Number.POSITIVE_INFINITY,
    );
    if (bytes * 1.05 > livre)
      return {
        ok: false,
        error: `not enough disk: ${Math.round(bytes / 1048576)} MB needed, ${Math.round(livre / 1048576)} MB free`,
      };

    let copiados = 0;
    let reaproveitados = 0;
    const fila = [...copias];
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        for (let c = fila.shift(); c; c = fila.shift()) {
          const noDestino = await fs.stat(c.para).catch(() => null);
          if (noDestino && noDestino.size === tamanhos.get(c.de)) {
            reaproveitados++;
            continue;
          }
          await fs.mkdir(path.dirname(c.para), { recursive: true });
          await fs.copyFile(c.de, c.para);
          copiados++;
        }
      }),
    );

    const religar = await runJsx<{ feitos: number; erros: unknown[]; salvoEm: string | null }>(
      transport,
      RELIGAR_JSX,
      "collect_religar",
      { payload: { trocas, salvarEm: salvarEm.replace(/\\/g, "/") }, timeoutMs: 600_000 },
    );
    if (!religar.ok)
      return { ok: false, error: "files were copied but the relink failed", copiados };
    const { feitos, erros, salvoEm } = religar.value;
    await fs.writeFile(
      path.join(destino, "pacote.json"),
      JSON.stringify({ criadoEm: new Date().toISOString(), ...relatorio }, null, 2),
    );
    return {
      ok: erros.length === 0,
      error: erros.length
        ? `${erros.length} item(s) could not be relinked; the project was NOT saved`
        : undefined,
      destino: destino.replace(/\\/g, "/"),
      projeto: salvoEm ? salvoEm.replace(/\\/g, "/") : null,
      copiados,
      reaproveitados,
      religados: feitos,
      erros,
      ...(sujo
        ? {
            aviso:
              "o projeto tinha mudanças não salvas: elas foram para a cópia, não para o original",
          }
        : {}),
      ...relatorio,
    };
  },
});
