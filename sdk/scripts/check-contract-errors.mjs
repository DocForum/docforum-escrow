import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const contractSource = readFileSync(resolve(root, "contracts/escrow/src/lib.rs"), "utf8");
const enumMatch = contractSource.match(/pub enum Error\s*\{([\s\S]*?)\n\}/);
if (!enumMatch) throw new Error("Could not find `pub enum Error` in the contract source");

const entries = [...enumMatch[1].matchAll(/^\s*([A-Z][A-Za-z0-9_]*)\s*=\s*(\d+)\s*,/gm)]
  .map(([, name, code]) => [Number(code), name]);
if (entries.length === 0) throw new Error("No explicitly numbered contract errors found");
const codes = entries.map(([code]) => code);
if (new Set(codes).size !== codes.length) throw new Error("Duplicate contract error code found");

const generated = `// Generated from contracts/escrow/src/lib.rs by sdk/scripts/check-contract-errors.mjs. Do not edit.\n` +
  `export const CONTRACT_ERROR_NAMES = {\n${entries.map(([code, name]) => `  ${code}: "${name}",`).join("\n")}\n` +
  `} as const;\n`;
const output = resolve(root, "sdk/src/contract-errors.generated.ts");
const checkOnly = process.argv.includes("--check");
let current = "";
try { current = readFileSync(output, "utf8"); } catch { /* generated on first run */ }

if (current === generated) {
  console.log("Contract error mapping is up to date.");
} else if (checkOnly) {
  console.error("Contract error mapping drift detected. Run `node sdk/scripts/check-contract-errors.mjs` to regenerate it.");
  process.exitCode = 1;
} else {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(output, generated);
  console.log("Generated sdk/src/contract-errors.generated.ts from the contract error enum.");
}
