import { defineConfig } from "vitest/config";

const nodeSpecFiles = ["src/**/*.spec.ts"] as const;
const uiSpecFiles = [
  "src/tauri/ui/**/*.spec.ts",
  "src/tauri/ui/**/*.spec.tsx",
] as const;
const coreCoverageFiles = ["src/core/**/*.ts"] as const;
const nonSourceTestFiles = ["src/**/__test__/**/*.ts", "src/**/*.spec.ts"] as const;

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: [...nodeSpecFiles],
    exclude: [...uiSpecFiles],
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
