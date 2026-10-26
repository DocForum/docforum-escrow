import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "vite";

const server = await createServer({
  configFile: false,
  root: process.cwd(),
  logLevel: "error",
  server: { host: "127.0.0.1", port: 4173, strictPort: true },
});

let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto("http://127.0.0.1:4173/tests/browser/");
  await page.waitForFunction(() => document.querySelector("#result")?.textContent !== "loading");
  const result = JSON.parse(await page.locator("#result").textContent());
  assert.deepEqual(result, { keypairCreated: true, clientCreated: true });
} finally {
  await browser?.close();
  await server.close();
}

console.log("SDK browser smoke test passed (no network requests or secrets needed).");
