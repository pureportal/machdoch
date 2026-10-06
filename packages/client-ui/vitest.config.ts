import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["src/**/*.spec.ts", "src/**/*.spec.tsx"],
    maxWorkers: 1,
    testTimeout: 30_000,
    pool: "threads",
  },
});
