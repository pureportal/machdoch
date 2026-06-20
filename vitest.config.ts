import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["src/**/*.spec.ts"],
    exclude: ["src/tauri/ui/**/*.spec.ts", "src/tauri/ui/**/*.spec.tsx"],
    testTimeout: 30_000,
    restoreMocks: true,
    unstubEnvs: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/core/**/*.ts"],
      exclude: ["src/**/__test__/**/*.ts", "src/**/*.spec.ts"],
    },
  },
});
