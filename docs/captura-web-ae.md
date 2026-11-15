# Captura 2D de página web para uma camada do After Effects

> Data: 2026-11-02 · Tipo: guia · Status: testando

**Resumo:** captura uma animação CSS/WAAPI de um elemento por quadros, mede os quatro cantos reais no Chromium, converte posição, pivô, escala, rotação e opacidade e prepara um lote para a ponte. Testada numa mascote de uma página local em um AEP isolado. A v1 cobre uma camada de footage 2D e precisa de avaliação visual; ainda não reconstrói a página inteira.

## Usar pelo terminal

Pré-requisitos: Node 24, `npm run build` na ponte e a biblioteca Playwright com um Chromium, Chrome ou Edge instalados por você (o servidor não os traz). Se não estiverem na árvore da ponte, `playwrightRoot` (ou `TUIFT_PLAYWRIGHT_ROOT`) aponta para a pasta que contém `node_modules/playwright`.

Arquivo `opcoes.json`:

```json
{
  "url": "file:///caminho/para/a/pagina/index.html",
  "selector": ".m1",
  "viewport": [1024, 720],
  "fps": 30,
  "duration": 3.3,
  "playwrightRoot": "/caminho/para/o/projeto/com/playwright"
}
```

```powershell
node scripts/captura-web.mjs capturar opcoes.json captura.json
```

Prepare no AE uma comp de 1024 × 720 a 30 qps e uma camada de footage **nova**, 2D e sem parent, com a imagem correspondente. Para a mascote do exemplo, o arquivo tem 610 × 738 px. `alvo.json`:

```json
{ "sourceSize": [610, 738], "comp": "Teste Web Motion", "layer": "Mascote", "timeOffset": 0 }
```

```powershell
node scripts/captura-web.mjs converter captura.json alvo.json lote.json
```

As saídas nunca sobrescrevem arquivos existentes. `lote.json` contém `conversion` e `batch`: passe o objeto `batch` para `ae_do` (`operation` e `args`), com a instância AE desejada. O servidor precisa permitir `eval.run`, usado pela pré-checagem. O lote faz uma verificação antes de cinco `keyframe.apply` com interpolação e trajetórias lineares. Exige comp com viewport/fps idênticos, camada desbloqueada, sem parent, 2D, tamanho de footage correto, duração suficiente e sem keys, expressões ativas ou dimensões separadas. Nomes de comp e camada precisam ser únicos. **O lote não é transacional:** confira cada resultado e faça checkpoint do projeto antes de alterações.

Também pode ser usado em código depois do build: `capturarMovimentoWeb(opcoes)`, `converterCapturaAE(captura, sourceSize)` e `prepararLoteAE(conversao, alvo)`, exportados por `dist/tuift/captura-web.js`.

## Ferramentas MCP

As duas ferramentas abaixo são independentes de instância AE (`ae_capturar_movimento_web` só existe com `AE_MCP_TOOLS=all`; `ae_preparar_movimento_web` também está em `core`): não abrem nem alteram o projeto. Seus caminhos de saída são absolutos, exigem pasta existente e arquivo novo, e não podem apontar para a caixa IPC da ponte, inclusive por junção.

1. `ae_capturar_movimento_web`: `{url, selector, viewport:[largura,altura], fps, duration, outPath, playwrightRoot?, browserExecutable?, timeoutMs?}`. Devolve `{writtenTo, bytes, frames, fps, animations, warnings, durationMs}` e grava a captura.
2. `ae_preparar_movimento_web`: `{capturePath, outPath, sourceSize:[largura,altura], comp, layer, timeOffset?}`. Devolve `{writtenTo, bytes, frames, maxCornerError, warnings, operations, next, durationMs}` e grava `{conversion,batch}`. A entrada precisa ser um arquivo de até 20 MB fora da caixa IPC.

O programa que usa a ponte lê o `batch` do arquivo e chama `ae_do` com `operation`, `args` e o `instance` da cópia de AE escolhida. A verificação `eval.run` e a execução dos keyframes continuam sujeitas à política/permissões do `ae_do`; nenhuma ferramenta nova contorna o modo somente leitura ou as categorias habilitadas.

## Alcance e precisão

- O relógio controla as animações CSS/WAAPI existentes após o carregamento. Os cantos do elemento incluem rotação, escala e as transformações dos pais; o ponto de origem é convertido para as dimensões nativas do footage. A opacidade é multiplicada pela dos pais.
- O código recusa perspectiva/3D, cisalhamento, escala zero, rolagem da página e movimento que permaneça alterando o alvo durante uma checagem curta com o relógio CSS parado. Uma peça que não passe deve seguir outro método; não se gera uma curva aproximada como se fosse exata.
- Ainda não controla animações por JavaScript, canvas, WebGL, vídeo, ações interativas ou rolagem; a checagem curta de movimento não detecta todos os casos. Filtros, sombras, máscaras, recortes, tipografia e conteúdo não são recriados pelo lote. A captura reporta avisos para efeitos e recortes encontrados. Usar um asset visual correspondente e revisar a cena no AE.
- A comp deve ter o mesmo viewport e a mesma taxa da captura nesta versão. Os cantos do footage precisam corresponder aos cantos da caixa CSS capturada. Ajustes de aspecto, composição, câmera e outros enquadramentos exigem uma transformação adicional, ainda não implementada.
- A captura contém as amostras reais e o adaptador não troca a curva por um easing aproximado. Preservar também as evidências e verificar as propriedades quadro a quadro; aprovação global de pixels não basta.

## Prova de 02/11/2026

- Página local de teste: 3,3 s, 100 amostras a 30 qps; captura de 1,80 s e conversão de aproximadamente 0,02 s nesta máquina. Repetição da captura: diferença máxima zero nos quads e na opacidade para os 100 tempos, nesse caso.
- AEP separado de teste, comp `Teste Web Motion`, footage `mascote.png`. Aplicação de cinco propriedades com 100 chaves cada: 0,759 s na ponte (2,14 s na chamada observada).
- Leitura no AE dos 100 tempos: maior diferença na posição 0,000031 px, rotação 0,000000058°, escala 0,000001 ponto percentual e opacidade 0,000004 ponto percentual contra os valores enviados. Em 3,1 s a rotação lida foi 1,5997958°; o extrator original retornava zero para a propriedade CSS `rotate` independente. A folha de contato foi aberta e vista.
- A segunda tentativa de aplicar o lote à mesma camada foi bloqueada na pré-checagem, sem rodar os cinco filhos. Não houve benchmark do tempo de um vídeo inteiro nem comparação visual pixel a pixel entre a página e o AE; efeitos e máscara da página não foram transferidos.

## Verificar alterações

```powershell
$env:TUIFT_PLAYWRIGHT_ROOT='C:/caminho/para/o/projeto/com/playwright'
npx vitest run tests/captura-web.test.ts tests/captura-web-browser.test.ts tests/captura-web-mcp.test.ts tests/tools-instance.test.ts tests/mcp-server.test.ts
```

Os testes de captura real no Chromium são pulados se `TUIFT_PLAYWRIGHT_ROOT` não estiver definido. A suíte verifica animação CSS conhecida, movimento JavaScript ativo, pivô, rotação, espelhamento, perspectiva, cisalhamento, proteção do lote e as ferramentas pelo servidor MCP stdio. O servidor bloqueia saída dentro da caixa IPC, inclusive por junção, e não sobrescreve artefatos.
