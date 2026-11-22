import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 60_000,
    hookTimeout: 60_000,
    projects: [
      {
        extends: true,
        test: {
          name: "offline",
          include: ["tests/**/*.test.ts"],
          exclude: ["tests/**/*-integration.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "live",
          include: ["tests/**/*-integration.test.ts"],
        },
      },
    ],
  },
});
