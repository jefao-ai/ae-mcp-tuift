import { existsSync, readFileSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import * as path from "node:path";

import { jsxCompPreamble, jsxFail, jsxVal, registerOp } from "../registry.js";
import { lerEnv } from "../tuift/env.js";

interface Asset {
  id: string;
  nome: string;
  tipo: "cena" | "animacao";
  categoria: string;
  tags: string[];
  descricao: string;
  comp: string;
  orientacao: string;
  portavel: boolean | null;
  arquivo: string;
}

function normalize(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().trim();
}

function metadataFiles(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(folder, entry.name);
    if (entry.isDirectory()) return metadataFiles(fullPath);
    return entry.isFile() && entry.name === "metadata.json" ? [fullPath] : [];
  });
}

function libraryRoot(): string {
  const root = lerEnv("CORTEX_LIBRARY")?.trim();
  if (!root || !existsSync(root))
    throw new Error("A biblioteca do Cortex precisa de TUIFT_CORTEX_LIBRARY.");
  return root;
}

function parseAsset(file: string, text: string, tipo: Asset["tipo"]): Asset | null {
  try {
    const record = JSON.parse(text);
    const id = record.assetId ?? record.id;
    const nome = record.name ?? record.nome;
    if (typeof id !== "string" || typeof nome !== "string") return null;
    const packageName = record.package?.project ?? record.package?.sceneFile;
    const baseName =
      typeof packageName === "string" &&
      path.basename(packageName) === packageName &&
      /\.(aep|aepx)$/i.test(packageName)
        ? packageName
        : tipo === "cena"
          ? "scene.aep"
          : "animation.aep";
    const width = Number(record.composition?.width ?? record.largura);
    const height = Number(record.composition?.height ?? record.altura);
    return {
      id,
      nome,
      tipo,
      categoria: String(record.category ?? record.categoria ?? record.group ?? ""),
      tags: Array.isArray(record.tags)
        ? record.tags.filter((tag: unknown) => typeof tag === "string")
        : [],
      descricao: String(record.description ?? record.descricao ?? ""),
      comp: String(record.package?.comp ?? record.comp ?? nome),
      orientacao:
        width > height ? "horizontal" : height > width ? "vertical" : width > 0 ? "quadrado" : "",
      portavel: record.package?.portable === true,
      arquivo: path.join(path.dirname(file), baseName),
    };
  } catch {
    return null;
  }
}

function sceneById(root: string, key: string): Asset | undefined {
  if (!/^[0-9a-f]{16}$/.test(key)) return;
  const file = path.join(root, "Scenes", key, "metadata.json");
  if (existsSync(file)) return parseAsset(file, readFileSync(file, "utf8"), "cena") ?? undefined;
}

function catalogFromMarkdown(root: string): Asset[] {
  const index = path.join(root, "..", "inventario.md");
  if (!existsSync(index)) return [];
  const assets: Asset[] = [];
  let tipo: Asset["tipo"] = "cena";
  let categoria = "";
  for (const line of readFileSync(index, "utf8").split(/\r?\n/)) {
    const heading = /^## (cena|animacao) · (.+) \(\d+\)$/.exec(line);
    if (heading) {
      tipo = heading[1] === "cena" ? "cena" : "animacao";
      categoria = heading[2]!;
    }
    const row =
      /^\| \x60([^\x60]+)\x60 \| (.+?) \| (\d+)[×x](\d+) \| [^|]* \| [^|]* \| (.*) \|$/.exec(line);
    if (!row) continue;
    const width = Number(row[3]),
      height = Number(row[4]);
    assets.push({
      id: row[1]!,
      nome: row[2]!,
      tipo,
      categoria,
      tags: [],
      descricao: row[5]!,
      comp: row[2]!,
      portavel: null,
      arquivo: "",
      orientacao: width > height ? "horizontal" : height > width ? "vertical" : "quadrado",
    });
  }
  return assets;
}

function materialize(root: string, asset: Asset): Asset | undefined {
  if (asset.arquivo) return asset;
  if (asset.tipo === "cena") return sceneById(root, normalize(asset.id));
  const name = normalize(asset.nome);
  const folder = path.join(root, "Animations");
  if (!existsSync(folder)) return;
  for (const file of metadataFiles(folder)) {
    if (normalize(path.basename(path.dirname(file))) !== name) continue;
    const candidate = parseAsset(file, readFileSync(file, "utf8"), "animacao");
    if (candidate?.id === asset.id) return candidate;
  }
}

let cachedLibrary: { root: string; assets: Asset[]; expires: number } | undefined;

async function library(root: string): Promise<Asset[]> {
  if (cachedLibrary?.root === root && cachedLibrary.expires > Date.now())
    return cachedLibrary.assets;

  const index = catalogFromMarkdown(root);
  if (index.length) {
    cachedLibrary = { root, assets: index, expires: Date.now() + 60_000 };
    return index;
  }

  const assets: Asset[] = [];
  for (const [collection, tipo] of [
    ["Scenes", "cena"],
    ["Animations", "animacao"],
  ] as const) {
    const folder = path.join(root, collection);
    if (!existsSync(folder)) continue;
    const files = metadataFiles(folder);
    for (let i = 0; i < files.length; i += 24) {
      const chunk = await Promise.all(
        files.slice(i, i + 24).map(async (file) => {
          const text = await readFile(file, "utf8").catch(() => "");
          return parseAsset(file, text, tipo);
        }),
      );
      assets.push(...chunk.filter((asset): asset is Asset => asset !== null));
    }
  }
  if (!assets.length) throw new Error("Nenhum pacote de cena ou animação encontrado no Cortex.");
  cachedLibrary = { root, assets, expires: Date.now() + 60_000 };
  return assets;
}

const SCAN = `
function _cxScan(comp, limit) {
    var visited = {}, textos = [], midias = [];
    function scan(c) {
        if (visited[c.id]) return;
        visited[c.id] = true;
        for (var i = 1; i <= c.numLayers; i++) {
            var l = c.layer(i);
            var locator = { comp: c.name, compId: c.id, layer: l.name, layerIndex: i };
            if (l instanceof TextLayer && textos.length < limit) {
                locator.texto = l.property("ADBE Text Properties").property("ADBE Text Document").value.text;
                textos.push(locator);
            } else if (l.source instanceof CompItem) {
                scan(l.source);
            } else if (l.source instanceof FootageItem && l.source.mainSource instanceof FileSource && midias.length < limit) {
                locator.footageId = l.source.id;
                locator.midia = l.source.name;
                locator.ausente = l.source.footageMissing;
                midias.push(locator);
            }
        }
    }
    scan(comp);
    return { textos: textos, midias: midias };
}`;
function cortexInsertCode(args: Record<string, unknown>, asset: Asset, fit: string): string {
  const destination = args.comp === undefined ? "var _comp = null;" : jsxCompPreamble(args);
  const assetPath = asset.arquivo.replace(/\\/g, "/");
  return `
    ${SCAN}
    ${destination}
    var marker = ${jsxVal("TUIFT Cortex " + asset.id)};
    var sourceName = ${jsxVal(asset.comp)};
    var imported = null, source = null, added = null;
    if (!${jsxVal(!!args.nova_copia)}) {
        for (var i = 1; i <= app.project.numItems; i++) {
            var item = app.project.item(i);
            if (item instanceof CompItem && item.comment.substring(item.comment.lastIndexOf("\\n") + 1) === marker) {
                source = item;
                break;
            }
        }
    }
    try {
        if (!source) {
            var options = new ImportOptions(new File(${jsxVal(assetPath)}));
            if (!options.canImportAs(ImportAsType.PROJECT)) return { ok: false, error: "O pacote não pôde ser importado como projeto." };
            options.importAs = ImportAsType.PROJECT;
            imported = app.project.importFile(options);
            var matches = [], all = [];
            function collect(item) {
                if (item instanceof CompItem) {
                    all.push(item);
                    if (item.name === sourceName) matches.push(item);
                } else if (item instanceof FolderItem) {
                    for (var j = 1; j <= item.numItems; j++) collect(item.item(j));
                }
            }
            collect(imported);
            source = matches.length === 1 ? matches[0] : (all.length === 1 ? all[0] : null);
            if (!source) throw new Error("Não foi possível identificar a composição original: " + sourceName);
            source.comment += "\\n" + marker;
        }
        var scale = 100;
        if (_comp && _comp.id !== source.id) {
            added = _comp.layers.add(source);
            added.startTime = ${jsxVal(args.at ?? 0)};
            var fit = ${jsxVal(fit)};
            if (fit !== "nenhum") {
                var sx = _comp.width / source.width, sy = _comp.height / source.height;
                scale = 100 * (fit === "preencher" ? Math.max(sx, sy) : Math.min(sx, sy));
                added.property("ADBE Transform Group").property("ADBE Scale").setValue([scale, scale]);
            }
        }
        var contents = _cxScan(source, 200);
        return { ok: true, peca: ${jsxVal(asset.nome)}, tipo: ${jsxVal(asset.tipo)},
                 comp: _comp ? _comp.name : source.name, compId: _comp ? _comp.id : source.id,
                 precomp: source.name, precompId: source.id, camada: added ? added.name : null,
                 camadaIndice: added ? added.index : null, escala: scale, textos: contents.textos, midias: contents.midias };
    } catch (err) {
        if (added) added.remove();
        if (imported) imported.remove();
        return { ok: false, error: AE.errText(err) };
    }
  `;
}

registerOp({
  name: "cortex.buscar",
  category: "cortex",
  description:
    "Busca cenas e animações na biblioteca local do Cortex. O ID retornado pode ser usado em cortex.inserir.",
  readOnly: true,
  params: [
    { name: "consulta", type: "string", description: "Assunto, nome, categoria ou tags." },
    { name: "tipo", type: "string", description: "cena ou animacao." },
    { name: "categoria", type: "string", description: "Categoria a filtrar." },
    { name: "orientacao", type: "string", description: "vertical, horizontal ou quadrado." },
    { name: "limite", type: "number", description: "Máximo de resultados, até 100." },
    {
      name: "so_fieis",
      type: "boolean",
      description: "Prioriza portabilidade: retorna pacotes marcados como portáveis.",
    },
  ],
  toJsx: () => jsxFail("cortex.buscar não pode rodar dentro de batch.run."),
  async run(args) {
    try {
      const terms = normalize(String(args.consulta ?? ""))
        .split(/\s+/)
        .filter(Boolean);
      const limit = Math.min(100, Math.max(1, Math.trunc(Number(args.limite ?? 15))));
      const root = libraryRoot();
      const exact = terms.length === 1 ? sceneById(root, terms[0]!) : undefined;
      const assets = (exact ? [exact] : await library(root)).filter((asset) => {
        if (args.tipo && asset.tipo !== normalize(String(args.tipo))) return false;
        if (
          args.categoria &&
          !normalize(asset.categoria).includes(normalize(String(args.categoria)))
        )
          return false;
        if (args.orientacao && asset.orientacao !== normalize(String(args.orientacao)))
          return false;
        const searchable = normalize(
          [asset.id, asset.nome, asset.categoria, asset.descricao, ...asset.tags].join(" "),
        );
        return terms.every((term) => searchable.includes(term));
      });
      const matches = args.so_fieis
        ? assets.flatMap((asset) => {
            const complete = materialize(root, asset);
            return complete?.portavel === true ? [complete] : [];
          })
        : assets;
      const pieces = matches
        .slice(0, limit)
        .map(({ id, nome, tipo, categoria, tags, descricao, orientacao, portavel }) => ({
          id,
          nome,
          tipo,
          categoria,
          tags,
          descricao,
          orientacao,
          portavel,
        }));
      return { ok: true, total: matches.length, pecas: pieces };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
});

registerOp({
  name: "cortex.inserir",
  category: "cortex",
  description:
    "Importa a composição original editável de um pacote local do Cortex. Com destino, insere como pré-composição.",
  params: [
    {
      name: "id",
      type: "string",
      description: "ID retornado por cortex.buscar ou nome exato.",
      required: true,
    },
    {
      name: "comp",
      type: "any",
      description: "Composição de destino, por nome ou ID. Sem destino, importa para o projeto.",
    },
    { name: "at", type: "number", description: "Início na composição de destino em segundos." },
    { name: "encaixe", type: "string", description: "caber, preencher ou nenhum. Padrão: caber." },
    {
      name: "nova_copia",
      type: "boolean",
      description: "Importa uma cópia mesmo quando a peça já está no projeto.",
    },
  ],
  toJsx: () => jsxFail("cortex.inserir deve ser chamada diretamente, fora de batch.run."),
  async run(args, transport) {
    const key = normalize(String(args.id));
    const root = libraryRoot();
    const exact = sceneById(root, key);
    const assets = exact ? [exact] : await library(root);
    const byId = assets.find((asset) => normalize(asset.id) === key);
    const named = assets.filter((asset) => normalize(asset.nome) === key);
    const selected = byId ?? (named.length === 1 ? named[0] : undefined);
    if (!selected)
      return {
        ok: false,
        error:
          named.length > 1
            ? "Há mais de uma peça com esse nome. Use o ID."
            : "Peça do Cortex não encontrada.",
      };
    const asset = materialize(root, selected);
    if (!asset || !existsSync(asset.arquivo))
      return { ok: false, error: "O arquivo editável da peça está ausente no pacote." };
    const fit = String(args.encaixe ?? "caber");
    if (!["caber", "preencher", "nenhum"].includes(fit))
      return { ok: false, error: "Encaixe inválido: use caber, preencher ou nenhum." };
    const result = await transport.execute({
      label: "cortex.inserir",
      code: cortexInsertCode(args, asset, fit),
    });
    if (!result.ok)
      return {
        ok: false,
        error: result.error ?? "Falha ao importar o pacote.",
        errorCode: result.errorCode,
      };
    return result.result;
  },
});

registerOp({
  name: "cortex.textos",
  category: "cortex",
  description:
    "Lista textos editáveis e mídias em uma composição do Cortex, incluindo suas pré-composições.",
  readOnly: true,
  params: [
    { name: "comp", type: "any", description: "Composição a inspecionar.", required: true },
    { name: "max", type: "number", description: "Limite por tipo de item, padrão 200." },
  ],
  toJsx(args) {
    const limit = Math.min(500, Math.max(1, Math.trunc(Number(args.max ?? 200))));
    return SCAN + jsxCompPreamble(args) + "return _cxScan(_comp," + limit + ");";
  },
});
