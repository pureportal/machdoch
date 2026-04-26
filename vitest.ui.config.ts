import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@tauri-apps/api/core": fileURLToPath(
        new URL("./src/tauri/ui/test/tauri-test-mocks.ts", import.meta.url),
      ),
      "@tauri-apps/api/event": fileURLToPath(
        new URL("./src/tauri/ui/test/tauri-test-mocks.ts", import.meta.url),
      ),
      "@tauri-apps/api/window": fileURLToPath(
        new URL("./src/tauri/ui/test/tauri-test-mocks.ts", import.meta.url),
      ),
      "@tauri-apps/plugin-dialog": fileURLToPath(
        new URL("./src/tauri/ui/test/tauri-test-mocks.ts", import.meta.url),
      ),
      "@tauri-apps/plugin-opener": fileURLToPath(
        new URL("./src/tauri/ui/test/tauri-test-mocks.ts", import.meta.url),
      ),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    include: ["src/tauri/ui/**/*.test.ts", "src/tauri/ui/**/*.test.tsx"],
    fileParallelism: false,
    passWithNoTests: true,
    restoreMocks: true,
    coverage: {
      provider: "v8",
      reporter: ["text"],
      include: ["src/tauri/ui/**/*.ts", "src/tauri/ui/**/*.tsx"],
      exclude: [
        "src/tauri/ui/**/*.test.ts",
        "src/tauri/ui/**/*.test.tsx"
      ]
    }
  }
});