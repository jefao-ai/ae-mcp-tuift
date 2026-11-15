#!/usr/bin/env node
// Interface de arquivo para app/ponte. Rode `npm run build` antes.
import { readFile, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import {
  capturarMovimentoWeb,
  converterCapturaAE,
  prepararLoteAE,
} from "../dist/tuift/captura-web.js";

const [command, input, third, fourth] = process.argv.slice(2);
const configPath = command === "converter" ? third : undefined;
const output = command === "capturar" ? third : fourth;
if (
  !command ||
  !input ||
  !output ||
  (command === "converter" && !configPath) ||
  !["capturar", "converter"].includes(command)
) {
  console.error(
    "Uso: node scripts/captura-web.mjs capturar OPÇÕES.json SAÍDA.json\n" +
      "     node scripts/captura-web.mjs converter CAPTURA.json ALVO.json SAÍDA.json\n" +
      "ALVO.json: {sourceSize:[largura,altura],comp:'nome',layer:'nome',timeOffset:0}",
  );
  process.exit(2);
}
const begin = performance.now();
try {
  const payload = JSON.parse(await readFile(input, "utf8"));
  let result;
  if (command === "capturar") {
    result = await capturarMovimentoWeb(payload);
  } else {
    const target = JSON.parse(await readFile(configPath, "utf8"));
    const conversion = converterCapturaAE(payload, target.sourceSize);
    result = { conversion, batch: prepararLoteAE(conversion, target) };
  }
  // Nunca sobrescreve captura, AEP ou outra evidência existente.
  await writeFile(output, JSON.stringify(result, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
  console.log(
    JSON.stringify(
      { ok: true, output, elapsedSeconds: (performance.now() - begin) / 1000 },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
