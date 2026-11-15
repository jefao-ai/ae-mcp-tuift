#!/usr/bin/env node
// Builds the archive an app ships: after-effects-mcp-<version>.tgz.
//
//   after-effects-mcp/
//     dist/                     compiled server (.js only)
//     jsx/                      ExtendScript that After Effects itself reads
//     kit/                      default house style and lessons
//     py/                       beats.py, used by ae_beats
//     package.json             (trimmed: no scripts, no dev dependencies)
//     LICENSE  NOTICE.md
//     node_modules/             production dependencies only
//     THIRD_PARTY_LICENSES.txt  licence text of every bundled dependency
//
// The server runs from the extracted folder with no install step.
// Usage: npm run bundle      (prints the file's size and SHA-256)
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const FOLDER = "after-effects-mcp";
const archiveName = `${FOLDER}-${pkg.version}.tgz`;

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} exited with ${r.status}`);
}

// 1. Fresh build (no stale files from removed sources).
rmSync(join(root, "dist"), { recursive: true, force: true });
const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
run(process.execPath, [tsc], { cwd: root });

// 2. Stage the folder.
const work = mkdtempSync(join(tmpdir(), "ae-mcp-bundle-"));
const stage = join(work, FOLDER);
mkdirSync(stage);

cpSync(join(root, "dist"), join(stage, "dist"), {
  recursive: true,
  filter: (src) => !/\.(map|d\.ts)$/.test(src),
});
for (const dir of ["jsx", "kit", "py"])
  cpSync(join(root, dir), join(stage, dir), { recursive: true });
for (const file of ["LICENSE", "NOTICE.md"]) copyFileSync(join(root, file), join(stage, file));

// 3. Production dependencies from the lockfile (scripts off: no lefthook, no hooks).
copyFileSync(join(root, "package.json"), join(stage, "package.json"));
copyFileSync(join(root, "package-lock.json"), join(stage, "package-lock.json"));
const npmCli = process.env.npm_execpath;
const npmArgs = ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"];
if (npmCli && /\.c?js$/.test(npmCli)) run(process.execPath, [npmCli, ...npmArgs], { cwd: stage });
else run(process.platform === "win32" ? "npm.cmd" : "npm", npmArgs, { cwd: stage, shell: true });
rmSync(join(stage, "package-lock.json"));
rmSync(join(stage, "node_modules", ".package-lock.json"), { force: true });

// 4. Trimmed package.json: what the server reads at run time (version, root marker).
const runtimePkg = {
  name: pkg.name,
  version: pkg.version,
  description: pkg.description,
  license: pkg.license,
  homepage: pkg.homepage,
  repository: pkg.repository,
  type: pkg.type,
  main: pkg.main,
  bin: pkg.bin,
  dependencies: pkg.dependencies,
  engines: pkg.engines,
};
writeFileSync(join(stage, "package.json"), JSON.stringify(runtimePkg, null, 2) + "\n");

// 5. Licence text of every bundled dependency.
function packageDirs(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".")) continue;
    const full = join(dir, name);
    if (name.startsWith("@")) {
      for (const sub of readdirSync(full)) out.push(...packageAt(join(full, sub)));
    } else out.push(...packageAt(full));
  }
  return out;
}
function packageAt(full) {
  if (!existsSync(join(full, "package.json"))) return [];
  return [full, ...packageDirs(join(full, "node_modules"))];
}
const LICENSE_FILE = /^(licen[cs]e|copying|notice)(\.|$|-)/i;
const sections = [];
const noText = [];
const seen = new Set();
for (const dir of packageDirs(join(stage, "node_modules")).toSorted()) {
  const meta = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const id = `${meta.name}@${meta.version}`;
  const license =
    typeof meta.license === "string"
      ? meta.license
      : (meta.license?.type ?? meta.licenses?.map((l) => l.type).join(" OR ") ?? "unknown");
  const files = readdirSync(dir).filter(
    (f) => LICENSE_FILE.test(f) && statSync(join(dir, f)).isFile(),
  );
  const text = files.map((f) => readFileSync(join(dir, f), "utf8").trim()).join("\n\n");
  if (!text) noText.push(`${id} (${license})`);
  const key = `${id}\n${text}`;
  if (seen.has(key)) continue;
  seen.add(key);
  sections.push(
    `${"=".repeat(78)}\n${id}\nLicense: ${license}\n${"=".repeat(78)}\n\n` +
      (text || `(no licence file shipped in the package; declared licence: ${license})`) +
      "\n",
  );
}
writeFileSync(
  join(stage, "THIRD_PARTY_LICENSES.txt"),
  `Third-party software bundled in node_modules/ (${sections.length} package versions).\n` +
    `The licence of ${pkg.name} itself is in LICENSE; see NOTICE.md.\n\n` +
    sections.join("\n"),
);
if (noText.length) console.log(`note: no licence file in: ${noText.join(", ")}`);

// 6. Archive. Relative paths only, so both GNU tar and bsdtar accept them on Windows.
run("tar", ["-czf", archiveName, FOLDER], { cwd: work });
const out = join(root, archiveName);
copyFileSync(join(work, archiveName), out);
rmSync(work, { recursive: true, force: true });

const bytes = statSync(out).size;
const sha256 = createHash("sha256").update(readFileSync(out)).digest("hex");
console.log(`${archiveName}: ${bytes} bytes (${(bytes / 1048576).toFixed(2)} MB)`);
console.log(`sha256 ${sha256}`);
