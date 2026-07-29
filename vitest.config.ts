import { defineConfig } from "vitest/config";

const businessLogicSpecFiles = ["src/**/*.spec.ts"] as const;
const businessLogicCoverageFiles = [
  "src/core/**/*.ts",
  "src/tauri/ui/**/*.ts",
] as const;
const nonSourceCoverageFiles = [
  "src/**/__test__/**/*.ts",
  "src/**/*.spec.ts",
  "src/**/*.d.ts",
  "src/**/*.generated.ts",
  "src/tauri/ui/**/main.tsx",
  "src/tauri/ui/**/*.tsx",
] as const;

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
      include: [...businessLogicCoverageFiles],
      exclude: [...nonSourceCoverageFiles],
      thresholds: {
        lines: 54,
        functions: 54,
        branches: 46,
        statements: 54,
        "src/core/**/*.ts": {
          lines: 77,
          functions: 79,
          branches: 62,
          statements: 77,
        },
        "src/tauri/ui/**/*.ts": {
          lines: 18,
          functions: 14,
          branches: 14,
          statements: 18,
        },
      },
    },
  },
});
