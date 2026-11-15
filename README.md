# ae-mcp-tuift

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D24-informational)](package.json)
[![After Effects](https://img.shields.io/badge/After%20Effects-2024%E2%80%932026-informational)](https://www.adobe.com/products/aftereffects.html)

English | [Português (BR)](./README.pt-BR.md)

An MCP server that lets an AI agent drive Adobe After Effects: inspect a project, edit layers and keyframes, look at the result, review the motion, render. It is the TUIFT Media fork of [kumoproductions/mcp-aftereffects](https://github.com/kumoproductions/mcp-aftereffects) v0.3.1 (see [NOTICE.md](./NOTICE.md)) plus house tools for motion work: contact sheets, motion review, scene plan check, chunked background render, spring/entrance/stagger moves, a lessons journal.

**Windows / macOS · After Effects 2024–2026 · Node.js 24+** (the house render and dialog helpers are Windows-first).

> [!CAUTION]
> The agent can read and modify compositions, layers, effects, keyframes and expressions. What it reads (names, expressions, footage paths) may be sent to the AI service you use. Try it on a backup or a test `.aep` first, and check your AI service's data policy before using it on projects under NDA.

## Requirements

- After Effects 2024, 2025 or 2026, **already open with a project**. The server does not start After Effects (it can start extra instances, see `instance.start`).
- After Effects preference **Scripting & Expressions → "Allow Scripts to Write Files and Access Network"** turned ON. The server cannot check it; with it OFF, calls time out.
- Node.js 24 or newer.
- Optional outside programs, only for the tools that need them. A missing one is a readable tool error, never a crash:
  - **ffmpeg + ffprobe** on `PATH` (or `TUIFT_FFMPEG` / `TUIFT_FFPROBE`): `ae_render_video`, `ae_place_sfx`, `ae_avaliar_render`, and `ae_see` with a reference video.
  - **Python 3 + `torch` + [`beat_this`](https://github.com/CPJKU/beat_this)** (`TUIFT_PYTHON`): `ae_beats`.
  - **Playwright + Chromium, Chrome or Edge** (`TUIFT_PLAYWRIGHT_ROOT`): `ae_capturar_movimento_web`.

## Run it

Get `after-effects-mcp-<version>.tgz` from a [release](https://github.com/iamjeffia/ae-mcp-tuift/releases) (or build it, below), extract it anywhere (spaces in the path are fine) and point your MCP client at `dist/index.js`. There is no install step: production `node_modules` are inside.

```bash
tar -xzf after-effects-mcp-0.4.0.tgz
claude mcp add after-effects -- node "/path/to/after-effects-mcp/dist/index.js"
```

Any stdio MCP client works the same way:

```json
{
  "mcpServers": {
    "after-effects": {
      "command": "node",
      "args": ["/path/to/after-effects-mcp/dist/index.js"],
      "env": { "AE_MCP_TOOLS": "core" }
    }
  }
}
```

From a checkout: `npm ci && npm run build`, then use `dist/index.js` of the checkout. `npm run bundle` rebuilds the archive (it prints its size and SHA-256).

## Tool profiles (`AE_MCP_TOOLS`)

Some agent programs resend the whole tool list on every request. `AE_MCP_TOOLS` picks how much of it you pay for. The operations behind `ae_do` are not part of the list: `ae_catalog` returns them on demand, so they cost nothing until used.

| Profile         | Tools | Tool list size                                   | What it registers                                                                                                                                                                                                                                                                                                                                            |
| --------------- | ----- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `all` (default) | 25    | 39,898 characters, about 10,000 to 11,400 tokens | Everything below, plus `ae_place_sfx`, `ae_beats`, `ae_capturar_movimento_web`, `ae_avaliar_render`. `ae_docs` joins them when `TUIFT_DOCS_DIR` is set.                                                                                                                                                                                                      |
| `core`          | 21    | 33,443 characters, about 8,400 to 9,600 tokens   | Only tools that need After Effects alone, or nothing: project/comp/layer info, save, JSON export/import, `ae_render_frame`, `ae_do`, `ae_catalog`, `ae_context`, `ae_see`, `ae_review_motion`, `ae_expressions_check`, `ae_sound_cues`, `ae_render_video`, `ae_render_status`, `ae_plano_check`, `ae_checkpoint`, `ae_lessons`, `ae_preparar_movimento_web`. |

Sizes are the JSON of the `tools/list` answer, tokens at 3.5 to 4 characters each; `node scripts/measure-tools.mjs --per-tool` measures them on your build. [docs/TOOLS.md](./docs/TOOLS.md) lists every tool and its profile.

## Safety switches

- `AE_MCP_READONLY=1`: inspection only. Tools that change the project are not registered and `ae_do` accepts only read-only operations.
- `AE_MCP_ALLOW_CATEGORIES=keyframe,layer`: only those operation categories run.
- `AE_MCP_ENABLE_EVAL=1`: adds `eval.run` (arbitrary ExtendScript, with file and process access). Off by default; turn it on only when you need it.
- Every `ae_do` call is one undo group. Run `ae_checkpoint` before structural changes: a batch is not transactional.
- `npm test` never touches a running After Effects; the live suites need `AE_MCP_E2E=1` (see [CONTRIBUTING.md](./CONTRIBUTING.md)).

## Environment variables

| Variable                                                           | Meaning                                                                                                                                 |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `AE_MCP_TOOLS`                                                     | `core` or `all` (default). An unknown value falls back to `all` and says so on stderr.                                                  |
| `AE_MCP_EXE`                                                       | Full path of `AfterFX.exe` (Windows) or the `.app` (macOS). Default: the newest of 2026, 2025, 2024 in the standard location.           |
| `AE_MCP_READONLY`, `AE_MCP_ALLOW_CATEGORIES`, `AE_MCP_ENABLE_EVAL` | Safety switches above.                                                                                                                  |
| `AE_MCP_INSTANCE`                                                  | Default instance when several After Effects run (`AfterFX.exe -m`); needs the resident agent (`node dist/index.js install-agent`).      |
| `AE_MCP_RUNTIME_DIR`                                               | Moves the IPC mailbox (default `<temp>/mcp-aftereffects/runtime`). Re-run `install-agent` after changing it.                            |
| `TUIFT_HOUSE_STYLE`                                                | Your own house-style JSON instead of `kit/estilo-da-casa.json` (springs, curves, drift, stagger, review and render numbers).            |
| `TUIFT_LESSONS`                                                    | Your own lessons file instead of `kit/licoes.jsonl`. `ae_lessons add` writes to it, so point it somewhere writable and durable.         |
| `TUIFT_REVIEW_RULES`                                               | Optional JSON with your review rules and decided cases for `ae_avaliar_render` (default: none).                                         |
| `TUIFT_DOCS_DIR`                                                   | Folder holding your clones of the docsforadobe After Effects scripting and expression guides. Without it `ae_docs` is not registered.   |
| `TUIFT_FFMPEG`, `TUIFT_FFPROBE`, `TUIFT_PYTHON`                    | Full paths of the outside programs when they are not on `PATH`.                                                                         |
| `TUIFT_PLAYWRIGHT_ROOT`                                            | Folder containing `node_modules/playwright`, for `ae_capturar_movimento_web`.                                                           |
| `TUIFT_WORK_DIR`                                                   | Where checkpoints, contact sheets and render jobs go (default `<temp>/ae-mcp-tuift`).                                                   |
| `TUIFT_GAME_PROCESSES`                                             | Comma-separated process names (without `.exe`); while one runs, the render uses one chunk at a time and half the threads. Default: off. |
| `TUIFT_RENDER_INPROCESS`, `TUIFT_RENDER_KILL_GB`                   | Render inside the server process instead of a detached worker; free-RAM floor (GB) under which the newest `aerender` is stopped.        |

## What is in the box

- **Upstream tools:** `ae_project_info`, `ae_comp_info`, `ae_layer_info`, `ae_version_info`, `ae_render_frame`, `ae_save_project`, `ae_project_export_json`, `ae_project_import_json`, `ae_catalog`, `ae_do` (229 operations, 230 with `eval.run`, across layers, keyframes, effects, masks, shapes, text, comps, project, rendering, instances), `ae_context`.
- **House tools:** `ae_see` (contact sheet you can look at), `ae_review_motion` (human or robotic motion), `ae_plano_check` (check the scene plan before building), `ae_expressions_check`, `ae_sound_cues` and `ae_place_sfx`, `ae_beats`, `ae_checkpoint`, `ae_render_video` and `ae_render_status` (chunked background render), `ae_avaliar_render`, `ae_lessons`, the two web-capture tools, `ae_docs`.
- **House operations** in `ae_do`: `tuift.mola`, `tuift.entrada`, `tuift.saida`, `tuift.stagger`, `tuift.vivo`, `tuift.camera_viva`, `tuift.curva`, `tuift.cena`, `tuift.morph`, plus `project.collect` and `footage.relink`. Their numbers come from `kit/estilo-da-casa.json`.
- **Lessons:** `kit/licoes.jsonl` holds 58 After Effects gotchas. When a tool call fails, the lessons whose pattern matches the error are appended to it.

Details of the transport, the ExtendScript rules and how to add an operation are in [CONTRIBUTING.md](./CONTRIBUTING.md). The Portuguese guide to the house tools is [README.pt-BR.md](./README.pt-BR.md).

## Troubleshooting

- **Calls time out:** is After Effects running with a project open, and is "Allow Scripts to Write Files and Access Network" ON? On macOS also allow your client under System Settings → Privacy & Security → Automation.
- **`NO_INSTANCE`:** no After Effects could take the call. Instances started with `-m` need the resident agent; with several live and none named, set `AE_MCP_INSTANCE`.
- **`DIALOG_OPEN`:** After Effects is showing a modal dialog (often hidden). `instance.dialogs` lists them and `instance.dismiss_dialog { id }` cancels one.
- **"X was not found on this computer":** an outside program is missing; the message names the variable to set.
- **After Effects in a non-standard place:** set `AE_MCP_EXE`.

## Credits and licence

MIT. Copyright (c) 2026 kumo.productions, Inc. (the upstream server) and (c) 2026 TUIFT Media (the additions). Built on [kumoproductions/mcp-aftereffects](https://github.com/kumoproductions/mcp-aftereffects). Third-party licences of the bundled dependencies are in `THIRD_PARTY_LICENSES.txt` inside the bundle.

Adobe and After Effects are trademarks of Adobe Inc. This project is independent and **not affiliated with or endorsed by Adobe**.
