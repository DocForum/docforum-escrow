import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { resolveConfig } from "vite";

const demoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repoRoot = resolve(demoRoot, "../..");
const expected = new Map([
  ["@docforum/escrow-sdk", resolve(repoRoot, "sdk/dist/esm/index")],
  [
    "@docforum/escrow-sdk/signers/wallets-kit",
    resolve(repoRoot, "sdk/dist/esm/signers/wallets-kit"),
  ],
  ["@docforum/escrow-react", resolve(repoRoot, "packages/escrow-react/dist/index")],
]);
const sourceFiles = new Map([
  ["@docforum/escrow-sdk", "src/main.tsx"],
  ["@docforum/escrow-sdk/signers/wallets-kit", "src/wallet.ts"],
  ["@docforum/escrow-react", "src/main.tsx"],
]);

const tsConfigPath = resolve(demoRoot, "tsconfig.json");
const tsConfigRead = ts.readConfigFile(tsConfigPath, ts.sys.readFile);
assert.equal(tsConfigRead.error, undefined, "could not read the web-demo tsconfig");
const tsConfig = ts.parseJsonConfigFileContent(tsConfigRead.config, ts.sys, demoRoot, undefined, tsConfigPath);

for (const [specifier, expectedBase] of expected) {
  const resolution = ts.resolveModuleName(
    specifier,
    resolve(demoRoot, sourceFiles.get(specifier)),
    tsConfig.options,
    ts.sys,
  ).resolvedModule;
  assert.ok(resolution, `TypeScript could not resolve ${specifier}`);
  const expectedDeclaration = realpathSync(`${expectedBase}.d.ts`);
  const actualDeclaration = realpathSync(resolution.resolvedFileName);
  assert.equal(actualDeclaration, expectedDeclaration, `TypeScript resolved ${specifier} outside its local build`);
  console.log(`TypeScript ${specifier} -> ${actualDeclaration}`);
}

const viteConfig = await resolveConfig(
  { root: demoRoot, configFile: resolve(demoRoot, "vite.config.ts") },
  "build",
);
for (const [specifier, expectedBase] of expected) {
  const alias = viteConfig.resolve.alias.find((item) => item.find === specifier);
  assert.ok(alias, `Vite has no alias for ${specifier}`);
  const expectedModule = realpathSync(`${expectedBase}.js`);
  const actualModule = realpathSync(alias.replacement);
  assert.equal(actualModule, expectedModule, `Vite resolved ${specifier} outside its local build`);
  console.log(`Vite ${specifier} -> ${actualModule}`);
}
