// kit.* — os botões do painel do Clube do Motion Kit como operações do Claude (26/10/2026).
// O painel (extensão CEP com.clubedomotion.kit) traz o motor em jsx/host.jsx: CMKit.run(acao, json).
// Aqui a operação abre a comp, seleciona as camadas como a pessoa faria e chama o mesmo motor,
// sem abrir grupo de desfazer próprio (a ponte já embrulha cada chamada num grupo).
// O motor é achado em CM_KIT_HOST ou na pasta de extensões do usuário (Windows e Mac).
import { existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { jsxCompPreamble, jsxFail, jsxVal, registerOp } from "../registry.js";
import { SERVER_ROOT } from "../tuift/common.js";
interface KitAction {
  variantes?: string[];
  selecao: string;
}
const KIT_ACOES: Record<string, KitAction> = {
  typing: { variantes: ["colorido", "aleatorio", "maquina"], selecao: "camadas de texto" },
  textReveal: { variantes: ["letras", "palavras", "linhas"], selecao: "camadas de texto" },
  exploder: { variantes: ["explodir", "montar"], selecao: "camadas de texto" },
  uiStagger: {
    variantes: ["tela", "camadas", "esquerda", "aleatorio"],
    selecao: "as camadas da interface",
  },
  bounce: {
    variantes: ["keys", "pop", "sobe", "desce", "esquerda", "direita", "saida"],
    selecao: "camadas (entrada/saída) ou, com `propriedade`, a propriedade com keyframes (mola)",
  },
  wipe: {
    variantes: ["esquerda", "direita", "baixo", "cima", "circulo"],
    selecao: "a camada revelada",
  },
  depth: {
    variantes: ["frente", "fundo"],
    selecao:
      "a imagem/vídeo (2ª camada opcional = mapa de profundidade); com `ia: true` o painel aberto gera o mapa com IA",
  },
  cursor: { variantes: ["mao", "seta"], selecao: "o botão que o cursor clica" },
  proximity: { selecao: "as camadas que reagem" },
  counter: { selecao: "uma camada de texto (# vira o número) ou nada (cria o contador)" },
  carousel: { selecao: "2 ou mais camadas" },
  glass: { selecao: "o botão/elemento que vira vidro" },
  gradient: {
    variantes: [
      "clube",
      "aurora",
      "meianoite",
      "lavanda",
      "menta",
      "porsol",
      "oceano",
      "grafite",
      "esmeralda",
      "floresta",
      "neon",
      "ametista",
      "rubi",
      "cobre",
      "dourado",
      "ceu",
      "crepusculo",
      "tempestade",
      "vinho",
      "cyber",
      "oliva",
      "nuvem",
      "pessego",
      "areia",
      "ceuclaro",
      "rosa",
      "limao",
      "gelo",
      "algodao",
      "marfim",
    ],
    selecao: "nada (cria o fundo no fim da pilha)",
  },
  attach: {
    variantes: ["tr", "tl", "br", "bl", "centro", "topo", "base", "pai"],
    selecao: "as camadas e, por ÚLTIMO, o alvo",
  },
  vivo: { selecao: "camadas que não podem ficar paradas" },
  curva: {
    variantes: ["saas", "entrada", "board", "suave"],
    selecao: "`propriedade` com keyframes (todas as keys viram a curva)",
  },
  motionBlur: { selecao: "camadas" },
  // v2.1 (27/10/2026): ferramentas do dock (jsx/dock/*.jsx). Opções finas em `opcoes`;
  // a lista completa do que cada uma aceita sai de kit.run { acao: "catalogo" }.
  // camadas
  anchored: {
    variantes: ["c", "tl", "t", "tr", "l", "r", "bl", "b", "br"],
    selecao: "camadas (âncora no ponto do conteúdo, sem mover)",
  },
  nanny: {
    variantes: ["null", "cadeia", "soltar"],
    selecao: "camadas (null comum, cadeia de pais na ordem do clique, soltar pais)",
  },
  lineup: {
    variantes: ["inverter", "nome", "aleatorio", "x", "y", "inicio"],
    selecao: "camadas a reordenar na pilha",
  },
  picky: {
    variantes: [
      "texto",
      "forma",
      "null",
      "solido",
      "precomp",
      "ajuste",
      "camera",
      "luz",
      "audio",
      "guia",
      "mesmoTipo",
      "mesmoRotulo",
      "filhos",
      "pai",
      "irmaos",
      "sempai",
      "compai",
      "inverter",
      "impares",
      "pares",
      "nesima",
      "nome",
    ],
    selecao: "muda a seleção (opcoes.n, opcoes.padrao com * e ?)",
  },
  renamer: {
    variantes: [
      "substituir",
      "prefixo",
      "sufixo",
      "numerar",
      "maiusculas",
      "minusculas",
      "titulo",
      "limpar",
    ],
    selecao:
      "camadas (ou itens do Project com opcoes.alvo='projeto'); opcoes.previa=true só mostra",
  },
  snippy: {
    variantes: ["conteudo", "comp", "leitura"],
    selecao: "camadas (conteudo/leitura) ou nada (comp)",
  },
  switched: {
    variantes: [
      "shy",
      "solo",
      "trava",
      "mb",
      "tres_d",
      "fx",
      "visivel",
      "colapsar",
      "qualidade",
      "rascunho",
      "final",
    ],
    selecao: "nada (comp inteira e pré-comps) ou camadas; opcoes.valor, opcoes.arvore",
  },
  ditto: {
    variantes: ["copiar", "ligar", "soltar"],
    selecao: "a mestre PRIMEIRO, depois as que recebem os efeitos",
  },
  copycat: { variantes: ["simples", "tudo"], selecao: "camadas de pré-comp" },
  accordion: {
    variantes: ["agrupar", "recolher", "expandir", "desagrupar", "listar"],
    selecao: "camadas do grupo (opcoes.nome)",
  },
  // projeto e fluxo
  dispatch: {
    variantes: ["fila", "limpar"],
    selecao:
      "nada (comp ativa) ou comps selecionadas no Project; opcoes.pasta/nome/modelo/intervalo",
  },
  fits: {
    variantes: ["formatos", "lote"],
    selecao: "nada (comp ativa); opcoes.formatos, opcoes.ajuste, ou ajustes do lote",
  },
  tidy: {
    variantes: ["varrer", "arrumar"],
    selecao: "nada; varrer só relata, arrumar aplica opcoes.reparos",
  },
  yoink: { variantes: ["quadro", "mp4", "gif"], selecao: "nada (comp ativa); opcoes.saida" },
  aebar: {
    variantes: ["listar", "adicionar", "remover", "rodar"],
    selecao: "nada para editar a barra; para rodar, o que o botão pede",
  },
  noted: {
    variantes: ["ler", "escrever", "acrescentar", "limpar"],
    selecao: "nada; opcoes.texto (notas guardadas no .aep)",
  },
  // animar
  bpm: {
    variantes: ["marcadores", "camadas", "keys", "distribuir", "cortar"],
    selecao: "opcoes.bpm ou opcoes.batidas; camadas/keys conforme a variante",
  },
  curvy: {
    variantes: ["camadas", "keys"],
    selecao: "camadas ou keys selecionadas; opcoes.total, opcoes.curva, opcoes.ordem",
  },
  fling: {
    variantes: ["linha", "grade", "anel", "explosao", "arco", "espiral", "onda"],
    selecao: "camadas a arranjar; opcoes.raio/espaco/colunas/animar",
  },
  slingshot: {
    variantes: ["e", "ne", "n", "no", "o", "so", "s", "se", "entrada"],
    selecao: "camadas a espalhar; opcoes.abertura/alcance/confete",
  },
  keymaster: {
    variantes: ["mover", "clonar", "espelhar", "esticar", "inverter", "ping", "ease"],
    selecao: "`propriedade` com keys (ou keys já selecionadas)",
  },
  springy: {
    variantes: ["overshoot", "bounce", "loop", "wiggle", "squash", "remover"],
    selecao: "camadas ou `propriedade`",
  },
  // design e texto
  butthead: {
    variantes: ["redonda", "quadrada", "reta", "juncao", "seta", "afinar", "tracejado", "limpar"],
    selecao: "camadas de forma com traço",
  },
  explode: {
    variantes: ["separar", "juntar", "separarPaths"],
    selecao: "camada de forma (juntar: a base primeiro)",
  },
  petals: {
    variantes: ["criar", "ligar", "trocar", "desligar", "listar"],
    selecao: "nada (criar) ou camadas a ligar; opcoes.slot/cor/harmonia",
  },
  clickety: { variantes: ["letra", "palavra", "linha", "remover"], selecao: "camadas de texto" },
  odo: {
    variantes: ["numero", "dinheiro", "porcentagem", "tempo", "compacto", "ano"],
    selecao: "texto com número ou nada (cria); opcoes.de/ate/dur",
  },
  spellbound: { variantes: ["palavras", "linhas", "letras"], selecao: "uma camada de texto" },
  catalogo: { selecao: "nada: devolve o que cada ferramenta do dock aceita em `opcoes`" },
};
function hostJsx() {
  const env = process.env.CM_KIT_HOST;
  const local = path.join(
    SERVER_ROOT,
    "node_modules",
    ".tuift-motion-kit",
    "com.clubedomotion.kit",
    "jsx",
    "host.jsx",
  );
  if (!env && existsSync(local)) return local;
  if (env && existsSync(env)) return env;
  const base =
    process.platform === "win32"
      ? path.join(
          process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"),
          "Adobe",
          "CEP",
          "extensions",
        )
      : path.join(os.homedir(), "Library", "Application Support", "Adobe", "CEP", "extensions");
  const cand = path.join(base, "com.clubedomotion.kit", "jsx", "host.jsx");
  return existsSync(cand) ? cand : null;
}
const resumo = Object.entries(KIT_ACOES)
  .map(([k, v]) => `${k}${v.variantes ? ` (${v.variantes.join("|")})` : ""}: ${v.selecao}`)
  .join("; ");
if (hostJsx())
  registerOp({
    name: "kit.run",
    category: "kit",
    description:
      "Roda um botão do painel do Clube do Motion Kit, igual ao clique da pessoa: seleciona `layer` na comp, põe o playhead em `at` e aplica. " +
      "Tudo nasce com controles 'CM …' no Effect Controls (ajuste depois com property.set). Ações: " +
      resumo +
      ". Depois: ae_see no meio do movimento.",
    params: [
      {
        name: "comp",
        type: "any",
        description:
          "Comp name or id (opcional nas ferramentas de projeto: dispatch, tidy, noted, aebar, catalogo)",
        required: false,
      },
      {
        name: "acao",
        type: "string",
        description: "Uma das ações listadas na descrição",
        required: true,
      },
      {
        name: "variante",
        type: "string",
        description: "Variação da ação (a 1ª da lista é o padrão)",
        required: false,
      },
      {
        name: "layer",
        type: "any",
        description:
          "Camadas selecionadas antes do clique: índice, nome, { id }, 'all' ou uma lista na ORDEM do clique (em attach, o alvo vai por último)",
        required: false,
      },
      {
        name: "at",
        type: "number",
        description: "Playhead em segundos (a animação começa aqui)",
        required: false,
      },
      {
        name: "propriedade",
        type: "string",
        description:
          "Para bounce 'keys', curva, keymaster, springy, curvy 'keys' e bpm 'keys': Position | Scale | Rotation | Opacity (seleciona essa propriedade e as keys dela)",
        required: false,
      },
      {
        name: "ia",
        type: "boolean",
        description: "depth: gera o mapa com IA no painel aberto (assíncrono)",
        required: false,
      },
      {
        name: "cor",
        type: "string",
        description: "Cor de destaque #RRGGBB (typing, depth)",
        required: false,
      },
      {
        name: "opcoes",
        type: "object",
        description:
          "Opções da ferramenta do dock (ex.: { bpm: 120 }, { raio: 300 }, { de: 'Card', para: 'Item' }); veja kit.run { acao: 'catalogo' }",
        required: false,
      },
    ],
    toJsx(args) {
      const acao = String(args.acao ?? "");
      if (!Object.hasOwn(KIT_ACOES, acao))
        throw new Error(`ação desconhecida: ${acao}. Ações: ${Object.keys(KIT_ACOES).join(", ")}`);
      const host = hostJsx();
      if (!host)
        throw new Error(
          "painel do Clube do Motion Kit não instalado (com.clubedomotion.kit). Rode o instalador do kit.",
        );
      if (acao === "depth" && args.ia && process.env.CM_KIT_USE_PANEL !== "1")
        return jsxFail(
          "O mapa de profundidade com IA requer o painel do Clube aberto e conectado. Use o modo local ou configure o painel.",
        );
      const kitArgs: Record<string, unknown> = {};
      if (args.variante) kitArgs.variante = args.variante;
      if (args.cor) kitArgs.cor = args.cor;
      if (args.opcoes && typeof args.opcoes === "object") kitArgs.opcoes = args.opcoes;
      const tipo = args.propriedade ?? null;
      return `
      ${args.comp === undefined || args.comp === null ? "var _comp = app.project.activeItem instanceof CompItem ? app.project.activeItem : null;" : jsxCompPreamble(args)}
      if (_comp) _comp.openInViewer();
      var _at = ${jsxVal(args.at ?? null)};
      if (_at !== null && _comp) _comp.time = _at;
      var _sel = ${jsxVal(args.layer ?? null)};
      if (_sel !== null && !_comp) return { ok: false, error: "passe comp para selecionar camadas" };
      var _layers = _sel === null ? [] : AE.resolveLayers(_comp, _sel);
      if (_comp) {
        for (var i = 1; i <= _comp.numLayers; i++) if (_comp.layer(i).selected) _comp.layer(i).selected = false;
        for (var j = 0; j < _layers.length; j++) _layers[j].selected = true;
      }
      var _prop = ${jsxVal(tipo)};
      if (_prop) {
        var _map = { "Position": "ADBE Position", "Scale": "ADBE Scale", "Rotation": "ADBE Rotate Z", "Opacity": "ADBE Opacity" };
        for (var k = 0; k < _layers.length; k++) {
          var _p = _layers[k].property("ADBE Transform Group").property(_map[_prop] || _prop);
          if (!_p) continue;
          _p.selected = true;
          for (var n = 1; n <= _p.numKeys; n++) _p.setSelectedAtKey(n, true);
        }
      }
      if (typeof CMKit === "undefined" || !CMKit.registrar) $.evalFile(new File(${jsxVal(host)}));
      if (${jsxVal(!!args.ia)} && ${jsxVal(acao)} === "depth") {
        try { new ExternalObject("lib:PlugPlugExternalObject"); } catch (e0) {}
        var _ev = new CSXSEvent();
        _ev.type = "com.clubedomotion.kit.pedido";
        _ev.data = CMKit.str({ acao: "depth", variante: ${jsxVal(args.variante ?? "frente")} });
        _ev.dispatch();
        return { ok: true, pedidoAoPainel: true, msg: "Pedido enviado ao painel aberto: a IA gera o mapa (imagem ~8 s, vídeo ~1 s por segundo). Confira depois a camada 'CM Depth' com ae_comp_info; sem o painel aberto, nada acontece: rode sem ia." };
      }
      var _semGrupoAnterior = CMKit.semGrupo;
      CMKit.semGrupo = true;
      var _r;
      try { _r = eval("(" + CMKit.run(${jsxVal(acao)}, ${jsxVal(JSON.stringify(kitArgs))}) + ")"); }
      finally { CMKit.semGrupo = _semGrupoAnterior; }
      if (!_r.ok) return { ok: false, error: _r.msg };
      if (${jsxVal(acao)} === "catalogo") return { ok: true, catalogo: eval("(" + _r.msg + ")") };
      return { ok: true, msg: _r.msg, acao: ${jsxVal(acao)}, seeTimes: _at !== null ? [_at + 0.3, _at + 0.7, _at + 1.5] : null };
    `;
    },
  });
