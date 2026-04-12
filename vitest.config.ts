import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/search/searchEngine.test.ts", "test/**/*.live.test.ts"],
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});
