import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    maxWorkers: 4,
    globals: true,
    include: ["src/**/*.spec.ts"],
    restoreMocks: true,
    testTimeout: 30_000,
  },
});
