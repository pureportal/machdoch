import { defineConfig } from "vitest/config";

const businessLogicSpecFiles = ["src/**/*.spec.ts"] as const;
const coreCoverageFiles = ["src/core/**/*.ts"] as const;
const nonSourceTestFiles = ["src/**/__test__/**/*.ts", "src/**/*.spec.ts"] as const;

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    setupFiles: ["./src/core/__test__/vitest-node-setup.ts"],
    include: [...businessLogicSpecFiles],
    testTimeout: 30_000,
    restoreMocks: true,
    unstubEnvs: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: [...coreCoverageFiles],
      exclude: [...nonSourceTestFiles],
    },
  },
});
