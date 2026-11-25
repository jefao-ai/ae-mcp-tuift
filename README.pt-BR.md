# ae-mcp-tuift — guia das ferramentas da casa (pt-BR)

> Tipo: guia · Status: vigente · O README principal, em inglês, é o [README.md](./README.md)

**Resumo:** `ae-mcp-tuift` é o servidor MCP do After Effects da TUIFT Media. É um fork da [Kumo mcp-aftereffects](https://github.com/kumoproductions/mcp-aftereffects) v0.3.1 (MIT; veja o [NOTICE.md](./NOTICE.md)). Por cima dela entram as ferramentas da casa (`src/tuift/`) e as operações `tuift.*` (`src/operations/tuift.ts`).

## O que tem a mais que a Kumo

- `ae_see`: folha de contato **devolvida como imagem**, com N quadros espaçados ou tempos exatos. Com `reference` (vídeo ou imagens) monta REF | NOSSO | DIF e precisa do ffmpeg; sem `reference` e sem ffmpeg devolve PNG no lugar de JPEG.
- `ae_review_motion`: revisor por regras ("humano ou robotizado?"). Acusa câmera parada, parada morta, linear sem mola, início simultâneo, entra/sai cortando, key fora da grade, blur, texto pequeno, margem e expressões com erro; devolve nota e correção sugerida.
- `ae_expressions_check`: força a avaliação e lista `expressionError` (pula sourceRectAtTime, toComp e sampleImage).
- `ae_sound_cues` e `ae_place_sfx`: pistas de efeito sonoro a partir das keys; o `ae_place_sfx` posiciona o arquivo com o **pico** no evento (precisa do ffmpeg; os arquivos de som são seus).
- `ae_beats`: beat_this → BPM, batidas e marcadores `BAR n`/`beat` na comp. Precisa de Python com `torch` e `beat_this` (`TUIFT_PYTHON`).
- `ae_render_video` e `ae_render_status`: **render rápido sem travar o PC.** aerender com MFR ligado, trechos de 30 s (15 s em 3D, 10 s pesado; piso de 5 s, porque abrir o aerender custa ~21 s), até 2 juntos em BelowNormal com 8 threads livres e trava de RAM (o vigia encerra o aerender mais novo abaixo de 8 GB livres e devolve o trecho à fila), trecho que falha refeito sem MFR, `-mem_usage 20 30`. Junção sem reencode com BT.709, áudio + LUFS, checagem de preto e de imagem congelada. Chamadas para cópias diferentes do AE (`instance`) correm em paralelo. Modos: `mode: "previa"` (Draft Settings, um trecho só), `mode: "turbo"` (só no final: Best, mais memória, prioridade normal, até 3 juntos) e `redo: [a, b]` com o mesmo `outDir`, que refaz só os trechos que tocam o intervalo. Precisa do ffmpeg e do ffprobe.
- `ae_checkpoint`: cria, lista e reverte cópias do `.aep` em `_checkpoints/`.
- `ae_docs`: busca offline no Scripting Guide e no Expression Reference **da pasta que você apontar** em `TUIFT_DOCS_DIR` (clones de `docsforadobe`). Sem a variável a ferramenta nem é registrada: a documentação da Adobe não é redistribuída.
- `ae_get_skill` e `ae_get_skill_asset`: consultam os guias e arquivos instalados no pacote local da Higgsfield. Use `TUIFT_FNF_SKILLS` para apontar à pasta `skills` do pacote. A distribuição do MCP não inclui esses guias.
- `ae_lessons`: diário de lições; as que casam com o erro são **anexadas** a toda falha.
- `ae_plano_check`: confere o plano em JSON antes de montar (buracos, sobreposição, duração de cena, texto longo, densidade, fala sem cena, troca fora da frase, citado sem imagem) e devolve a lista pronta para o `tuift.cena`. Não precisa do AE.
- `ae_avaliar_render`: nota do arquivo final, com 55 pontos medidos e um pacote para um revisor externo (por exemplo o Gemini) dar os outros 45. ID por conteúdo do arquivo e histórico entre versões. Precisa do ffmpeg; não precisa do AE.
- `tuift.mola`, `tuift.entrada`, `tuift.saida`, `tuift.stagger`, `tuift.vivo`, `tuift.camera_viva`, `tuift.curva`: movimentos da casa como operações do `ae_do`, com os números do `estilo-da-casa.json`.
- `tuift.cena`: marca as cenas como marcadores `S01_GANCHO` com duração. Com isso funcionam `ae_see { cenas: true }`, `ae_review_motion { cena }` e `ae_render_video { redoCena }`.
- `tuift.morph`: morph pronto por nome. `estilo: "voo"` (padrão) reproduz o movimento medido quadro a quadro de um anúncio público de plugin: a origem voa numa curva e o destino pousa com o pulo 92→121→96→100%. `estilo: "forma"` traça os contornos e deforma no lugar.
- `footage.relink` e `project.collect`: troca prefixos de caminho em massa; juntam projeto e mídia numa pasta, religam e salvam a cópia. `pacote.json` lista o que falta, as fontes e os efeitos de terceiros.
- `footage.inventory`: devolve IDs, arquivos, taxa de quadros, proxies e mídia ausente para integração com ferramentas externas.
- `cortex.buscar`, `cortex.inserir` e `cortex.textos`: buscam pacotes editáveis, importam a composição e listam textos e mídias. Aponte `TUIFT_CORTEX_LIBRARY` à pasta local `Cortex Library`.
- `kit.run`: executa ações do Clube do Motion Kit quando o motor do painel está instalado. Aponte `CM_KIT_HOST` para o `jsx/host.jsx` ou coloque o pacote local em `node_modules/.tuift-motion-kit/com.clubedomotion.kit`. A geração de mapa de profundidade por IA exige o painel aberto e `CM_KIT_USE_PANEL=1`.
- `identidade.json` (na pasta do `.aep` ou até 3 acima): fontes, paleta, margem e raios do vídeo. O `ae_review_motion` acusa o que sair disso, inclusive dentro de pré-comps.

Os números dos movimentos, da revisão, do plano e da avaliação ficam em `kit/estilo-da-casa.json`; `kit/licoes.jsonl` guarda as lições anexadas às falhas.

## Figma para camadas editáveis

Envie ao agente o link de uma tela que sua conta pode editar no Figma. Ele usa o conector Figma já conectado e as operações do `ae_do`:

1. `figma.capture_frame` fornece o script de leitura do frame selecionado.
2. O agente executa o script no conector do Figma e passa o resultado para `figma.import_frame`.
3. O MCP cria uma composição nas dimensões do frame, com textos, formas vetoriais e grupos separados. `ae_render_frame` permite conferir o resultado sem abrir a interface.

Os grupos e componentes ficam em pré-composições. Para imagens, passe em `imageFiles` os caminhos locais dos originais, associados aos IDs capturados. São tratados os modos Preencher e Ajustar. O MCP aponta diferenças em fontes, gradientes e efeitos sem conversão. Use `strict: true` para exigir uma importação sem avisos. O fluxo usa a sessão atual do conector do Figma, sem pedir token novo.

## Tracking e estabilização

Use `ae_catalog` com `category: "tracking"` para ver as operações disponíveis no `ae_do`.

- `tracking.start` prepara o rastreamento de pontos, máscaras ou propriedades.
- `tracking.get_data` lê pontos, confiança e quadros-chave, além de consultar efeitos de tracking e dados faciais já existentes.
- `tracking.set_point` ajusta os pontos. Com `time`, grava quadro-chave nos controles que aceitam animação.
- `tracking.warp_stabilizer` aplica e configura o estabilizador nativo. Passe `result: "no_motion"` para remover o movimento ou `result: "smooth_motion"` para suavizá-lo.
- `tracking.camera_tracker` aplica e configura o rastreador de câmera 3D. `renderTrackPoints: true` inclui os pontos no render para conferência.
- `tracking.analyze_points` analisa um ponto e grava os quadros-chave no rastreador existente. Sem um rastreador, cria um controle de ponto editável. Use `center: [x, y]` para indicar o ponto ou deixe o MCP localizar uma região com textura.
- `tracking.analyze_mask` rastreia a posição, rotação e escala de uma máscara fechada e grava os quadros-chave no caminho existente. Informe `mask` pelo nome ou índice.
- `tracking.create_camera` calcula o movimento a partir do vídeo e cria uma câmera 3D animada com escala de cena relativa. Use uma cena contínua com objetos em profundidades diferentes. Passe `horizontalFov` em graus se souber o ângulo da lente. O padrão é 54°.

O Warp Stabilizer e o efeito 3D Camera Tracker são analisados pelo After Effects. Ao aplicar um deles pela primeira vez, o MCP ativa a composição dentro da instância. Use vídeo ou pré-composição com as mesmas dimensões da composição. [Implementação de referência do Creative MCP](https://github.com/zachshallbetter/adobe-mcp/blob/main/packages/aftereffects/src/tools/tracking.js)

As três operações de análise automática usam o arquivo original de vídeo, o agente residente e o Python de mídia com OpenCV, NumPy e PyAV. Funcionam sem abrir painéis. `start` e `end` definem o trecho em segundos na composição. Para a câmera, mantenha a camada 2D com as dimensões da composição e as transformações padrão. O MCP informa quando o movimento perde referências suficientes para gravar um resultado confiável.

## Perfis de ferramentas

`AE_MCP_TOOLS=core` registra só o que precisa apenas do After Effects, ou de nada: leitura, salvar, exportar e importar JSON, `ae_render_frame`, `ae_do`, `ae_catalog`, `ae_context`, `ae_see`, `ae_review_motion`, `ae_expressions_check`, `ae_sound_cues`, `ae_render_video`, `ae_render_status`, `ae_plano_check`, `ae_checkpoint`, `ae_lessons`, `ae_preparar_movimento_web`. Ficam de fora `ae_place_sfx`, `ae_beats`, `ae_capturar_movimento_web`, `ae_avaliar_render` e `ae_docs`. O padrão é `all`. Os tamanhos da lista estão no README principal.

## Variáveis de ambiente da casa

- `TUIFT_HOUSE_STYLE`: seu JSON de estilo no lugar do `kit/estilo-da-casa.json`.
- `TUIFT_LESSONS`: seu arquivo de lições; o `ae_lessons add` grava nele.
- `TUIFT_REVIEW_RULES`: regras e casos de revisão para o `ae_avaliar_render` (opcional).
- `TUIFT_DOCS_DIR`, `TUIFT_FFMPEG`, `TUIFT_FFPROBE`, `TUIFT_PYTHON`, `TUIFT_PLAYWRIGHT_ROOT`: pasta ou programas de fora.
- `TUIFT_WORK_DIR`: padrão `<temp>/ae-mcp-tuift`.
- `TUIFT_GAME_PROCESSES`: nomes de processo, separados por vírgula; com um deles aberto o render roda um trecho por vez e com metade das threads.
- `TUIFT_RENDER_INPROCESS` (1 renderiza dentro do servidor, sem processo separado) e `TUIFT_RENDER_KILL_GB` (GB livres abaixo dos quais o render para; padrão 8).

Programa que falta (ffmpeg, Python) vira erro legível da ferramenta, com o nome da variável a ajustar; nunca derruba o servidor.

## Instalar e registrar

```bash
npm ci && npm run build        # ou: npm run bundle gera after-effects-mcp-<versão>.tgz
claude mcp add after-effects -s user -e AE_MCP_TOOLS=core -- node /caminho/para/dist/index.js
```

Requisitos: Node 24+, After Effects 2024–2026 aberto com um projeto e "Allow Scripts to Write Files and Access Network" ligado. `AE_MCP_EXE` aponta para o `AfterFX.exe` fora do lugar padrão; `AE_MCP_ENABLE_EVAL=1` liga o `eval.run` (só se for preciso).

## Testar

- `npm test` roda tudo que não precisa do After Effects. As suítes que falam com o AE só rodam com `AE_MCP_E2E=1` e o AE aberto.
- `node scripts/tuift-call.mjs <ferramenta> '<json>'` (ou `@arquivo.json`) chama uma ferramenta direto, para depurar. Fala com o AE aberto.
- `node scripts/measure-tools.mjs --per-tool` mede o tamanho da lista de ferramentas nos dois perfis.

## Atualizar a partir da Kumo

As mudanças da casa ficam em `src/tuift/`, `src/operations/` (`tuift.ts`, `morph.ts`, `pacote.ts`), `src/tools/profile.ts`, `src/instructions.ts`, `kit/`, `py/`, `scripts/tuift-*.mjs`, nas letras extras de `src/color/sheet.ts`, nas listas de ferramentas dos testes e em poucas linhas de `src/index.ts`, `src/tools/index.ts` e `src/operations/index.ts`. Para trazer o que a Kumo mudar:

```bash
git fetch https://github.com/kumoproductions/mcp-aftereffects main && git merge FETCH_HEAD
npm run build && npm test
```
