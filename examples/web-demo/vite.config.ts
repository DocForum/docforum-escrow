import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The demo consumes the SDK and hooks packages from this repo, not from npm
// (the hooks package is new and the SDK release is not published yet). Alias
// the built outputs so `npm run dev` exercises exactly what the packages
// compile to; `predev`/`prebuild` rebuild both first.
const fromRepo = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      {
        find: "@docforum/escrow-sdk/signers/wallets-kit",
        replacement: fromRepo("../../sdk/dist/signers/wallets-kit.js"),
      },
      { find: "@docforum/escrow-sdk", replacement: fromRepo("../../sdk/dist/index.js") },
      {
        find: "@docforum/escrow-react",
        replacement: fromRepo("../../packages/escrow-react/dist/index.js"),
      },
    ],
  },
});
