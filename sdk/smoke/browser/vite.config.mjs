import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const esmEntry = fileURLToPath(new URL("../../dist/esm/index.js", import.meta.url));

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  resolve: {
    alias: [{ find: "@docforum/escrow-sdk", replacement: esmEntry }],
  },
  build: {
    outDir: "/tmp/docforum-escrow-sdk-browser-smoke",
    emptyOutDir: true,
    reportCompressedSize: true,
  },
});
