// Server instructions sent to the MCP client. They only mention tools that are
// actually registered (profile, optional docs folder, read-only mode).

export function buildInstructions(tools: ReadonlySet<string>): string {
  const has = (n: string) => tools.has(n);
  const parts: string[] = [
    "After Effects bridge ae-mcp-tuift (MCP for After Effects + TUIFT Media studio tools).",
    "Flow: ae_plano_check on the scene plan → ae_context → build (ae_catalog/ae_do; batch.run or one eval.run for a whole scene; tuift.cena names the scenes) →",
    "LOOK with ae_see (contact sheet image; check mid-movement frames; cenas: true shows each scene) → ae_review_motion (humano ou robotizado? also checks identidade.json when the project has one) →",
    "ae_expressions_check after writing expressions → ae_sound_cues" +
      (has("ae_place_sfx") ? "/ae_place_sfx" : "") +
      " → ae_render_video (background) + ae_render_status" +
      (has("ae_avaliar_render")
        ? " → ae_avaliar_render on the final file (measured score + review packet for an external video reviewer)."
        : "."),
    "Moving a project to another machine: project.collect, or footage.relink to swap path prefixes in bulk.",
    "Ready-made animations by name: tuift.morph {de, para, mola} turns one layer (shape, PNG, text) into another with a",
    'spring ("make the AE icon turn into the Spotify one"); import images with project.import_file + layer.create_footage first.',
    "House moves are ae_do operations in category tuift: tuift.mola (entrance of card/button/bubble/badge, UI morph),",
    "tuift.entrada/tuift.saida, tuift.stagger, tuift.vivo (holds never dead), tuift.camera_viva, tuift.curva (saas/board).",
    "Safety: ae_checkpoint create before structural changes; a batch is not transactional; after a TIMEOUT read state",
    "before retrying; DIALOG_OPEN → ae_do instance.dismiss_dialog. Scripts are ES3 (eval.run)" +
      (has("ae_docs") ? " — check ae_docs when unsure." : "."),
    "Failed calls carry matching lessons from the journal; add new ones with ae_lessons.",
    "Never claim done from a tool result alone: a rendered frame you looked at is the proof.",
  ];
  return parts.join(" ");
}
