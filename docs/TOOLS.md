# Tool reference

Generated from `src/tools/**` via `npm run docs:tools` — do not edit by hand. For a grouped summary and example prompts, see the main [README](../README.md).

`ae_do`'s operation registry (`layer.*`, `keyframe.*`, …) is discoverable at runtime via `ae_catalog` and is **not** listed in this file.

28 tools across 4 groups. The **Profile** column says which `AE_MCP_TOOLS` profile registers the tool (`core` is the lean list, `all` is the default). `ae_docs` is registered only when `TUIFT_DOCS_DIR` points at a folder.

## Inspect

Read-only project/comp/layer introspection.

| Tool                        | Profile   | Description                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ae_project_info`           | core, all | Project-level info: file path, dirty flag, all items with type/summary, active item.                                                                                                                                                                                                                                                                                                                            |
| `ae_comp_info`              | core, all | Detailed comp info: size, fps, duration, work area, motion blur, layer summaries.                                                                                                                                                                                                                                                                                                                               |
| `ae_layer_info`             | core, all | Full layer info: transform, effects, masks, text, shape contents, keyframes (incl.                                                                                                                                                                                                                                                                                                                              |
| `ae_version_info`           | core, all | AE version, build, capabilities (saveFrameToPng, app.effects, Socket).                                                                                                                                                                                                                                                                                                                                          |
| `ae_context`                | core, all | Ambient context: project state, active comp, selected layers, item list, AE.\* helpers, ES3 rules, and the undo contract (every call = one auto undo group).                                                                                                                                                                                                                                                    |
| `ae_get_skill`              | all       | List installed Higgsfield workflows or read a named workflow and its references.                                                                                                                                                                                                                                                                                                                                |
| `ae_get_skill_asset`        | all       | Resolve an asset listed in an installed Higgsfield workflow to a local file path for import.                                                                                                                                                                                                                                                                                                                    |
| `ae_review_motion`          | core, all | Rule-based motion review of a comp without rendering, using the studio house style: camera/rig that stops dead, holds that freeze and restart (robotizado), linear moves with no spring, several layers starting on the same frame (needs stagger), layers that pop in/out with no entrance/exit, keys off the frame grid, motion blur off, text too small, layers touching the safe margin, expression errors. |
| `ae_expressions_check`      | core, all | Find broken expressions: walks every expression in a comp (or the whole project), forces evaluation at the layer's in/mid/out times and reports `expressionError`, plus expressions AE has switched off.                                                                                                                                                                                                        |
| `ae_sound_cues`             | core, all | Read the comp's keyframes and list where sound effects belong — entrances (pop/whoosh), exits, scale pops, taps/clicks (layers named cursor/toque/tap), whooshes at the peak speed of fast moves, arrivals (light thud), typing — merged within 40 ms and ranked by weight.                                                                                                                                     |
| `ae_capturar_movimento_web` | all       | Captura quadros de um elemento 2D de página CSS/WAAPI sem abrir o AE.                                                                                                                                                                                                                                                                                                                                           |
| `ae_preparar_movimento_web` | core, all | Lê uma captura JSON e grava um arquivo novo com conversão 2D e lote batch.run para ae_do.                                                                                                                                                                                                                                                                                                                       |
| `ae_plano_check`            | core, all | Check a video's PLAN before touching After Effects: empty stretches between scenes, overlaps, scene length, too much text on screen, too many elements, elements that live too short, narration without a scene, scene changes away from a sentence start, things the narration cites with no image.                                                                                                            |
| `ae_docs`                   | all       | Search the After Effects Scripting Guide and Expression Reference offline (your own docsforadobe clones, TUIFT_DOCS_DIR).                                                                                                                                                                                                                                                                                       |
| `ae_lessons`                | core, all | The journal of After Effects lessons (gotchas that cost real effort).                                                                                                                                                                                                                                                                                                                                           |

## Document

Save, JSON export, and JSON import of the whole project.

| Tool                     | Profile   | Description                                                                                                                        |
| ------------------------ | --------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `ae_save_project`        | core, all | Save the project.                                                                                                                  |
| `ae_project_export_json` | core, all | Serialize the entire project to JSON (folders, comps, layers, keyframes, effects, shapes, markers, time remap, solids, file refs). |
| `ae_project_import_json` | core, all | Rebuild the project from JSON (produced by ae_project_export_json).                                                                |
| `ae_checkpoint`          | core, all | Save points for the open .aep.                                                                                                     |

## Render

Single-frame rendering for visual verification.

| Tool                | Profile   | Description                                                                                                                                       |
| ------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ae_render_frame`   | core, all | Render one or more frames to PNG.                                                                                                                 |
| `ae_see`            | core, all | LOOK at the comp: renders several frames and returns ONE labelled contact sheet as an IMAGE you can see (plus the file paths).                    |
| `ae_render_video`   | core, all | Render a comp to MP4 in the BACKGROUND.                                                                                                           |
| `ae_render_status`  | core, all | Status of background renders started with ae_render_video: chunk progress, final file and the automatic checks (black, frozen, frames, loudness). |
| `ae_avaliar_render` | all       | Review a RENDERED video in two layers.                                                                                                            |

## Operations

Atomic operation dispatch — discover with `ae_catalog`, execute with `ae_do`.

| Tool           | Profile   | Description                                                                                                                                                                                             |
| -------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ae_catalog`   | core, all | Discover available atomic operations for ae_do.                                                                                                                                                         |
| `ae_do`        | core, all | Execute an atomic operation by name (from ae_catalog).                                                                                                                                                  |
| `ae_place_sfx` | all       | Place sound-effect files in a comp so that each file's LOUDEST sample (measured with ffmpeg) lands exactly on its event time (start = at − peak).                                                       |
| `ae_beats`     | all       | Measure beats and downbeats of a music file with beat_this (runs locally) and optionally write them as comp markers ('BAR n' on downbeats, 'beat' on the rest), offset by where the music layer starts. |
