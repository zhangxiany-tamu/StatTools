import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/search/searchEngine.test.ts"],
    testTimeout: 120_000,
    pool: "vmThreads",
  },
});
