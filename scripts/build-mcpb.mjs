#!/usr/bin/env node
// Builds build/mikrotik-mcp.mcpb, the one-click Claude Desktop extension.
// Usage: npm run build:mcpb
import { execSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MCPB_CLI = "@anthropic-ai/mcpb@2.1.2";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "build");
const stage = join(out, "mcpb");
const run = (cmd, cwd = root) => execSync(cmd, { cwd, stdio: "inherit" });

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
if (manifest.version !== pkg.version) {
  console.error(`manifest.json version ${manifest.version} does not match package.json version ${pkg.version}`);
  process.exit(1);
}

run("npm run build");
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

writeFileSync(join(stage, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
cpSync(join(root, "assets", "icon.png"), join(stage, "icon.png"));
cpSync(join(root, "dist", "src"), join(stage, "server"), { recursive: true, filter: (p) => !p.endsWith(".map") });
for (const f of ["package.json", "package-lock.json", "LICENSE", "README.md"]) cpSync(join(root, f), join(stage, f));

// Production dependencies only; scripts are skipped because the code is already compiled.
run("npm ci --omit=dev --ignore-scripts --no-audit --no-fund", stage);

const file = join(out, `${pkg.name}.mcpb`);
rmSync(file, { force: true });
run(`npx --yes ${MCPB_CLI} pack "${stage}" "${file}"`);
console.log(`\nBuilt ${file}`);
