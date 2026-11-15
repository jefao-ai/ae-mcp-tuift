# Notice

**ae-mcp-tuift** is a fork of [kumoproductions/mcp-aftereffects](https://github.com/kumoproductions/mcp-aftereffects) at tag `v0.3.1`, released under the MIT licence.

- The upstream code (the server core, the transport, the ExtendScript under `jsx/`, the generic operations, the tests and docs that came with v0.3.1) is Copyright (c) 2026 kumo.productions, Inc.
- Everything added in this fork is Copyright (c) 2026 TUIFT Media, under the same MIT licence. Both copyright lines are kept in [LICENSE](./LICENSE), and that licence text must travel with every copy or substantial portion of this software.

## What this fork adds

- **House tools** (`src/tuift`): `ae_see`, `ae_review_motion`, `ae_plano_check`, `ae_expressions_check`, `ae_sound_cues`, `ae_place_sfx`, `ae_beats`, `ae_checkpoint`, `ae_render_video` / `ae_render_status`, `ae_avaliar_render`, `ae_lessons`, `ae_capturar_movimento_web` / `ae_preparar_movimento_web`, `ae_docs`.
- **House operations** (`src/operations`): `tuift.*` (spring, entrances and exits, stagger, living drift and camera, curves, named scenes, morph), `project.collect`, `footage.relink`.
- **Default style and lessons** (`kit/`): `estilo-da-casa.json` and `licoes.jsonl`.
- **Tool profiles** (`AE_MCP_TOOLS=core|all`), readable errors when an outside program is missing, and `npm run bundle`, which builds the archive that apps ship.
- `py/beats.py`, a small beat-tracking helper that uses the [beat_this](https://github.com/CPJKU/beat_this) package (MIT), which you install yourself.

## What is not included

- Adobe's documentation is not redistributed. `ae_docs` only works when you point `TUIFT_DOCS_DIR` at your own clones of the community guides at [docsforadobe](https://github.com/docsforadobe).
- No commercial plug-in, panel, animation library or third-party skill pack is bundled or driven by this project.
- No fonts, sounds or footage are bundled.

## Trademarks

Adobe and Adobe After Effects are trademarks of Adobe Inc. This project is an independent tool and is **not affiliated with or endorsed by Adobe**. TUIFT Media and TUIFT Code are names of their respective owners; using them here only says who maintains this fork.

## Third-party licences

The bundle built by `npm run bundle` carries the production dependencies in `node_modules/` and lists the licence text of each one in `THIRD_PARTY_LICENSES.txt`.
