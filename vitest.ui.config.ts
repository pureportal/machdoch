import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

const jsdomSpecFiles = [
  "src/tauri/ui/**/*.spec.tsx",
  "src/tauri/ui/chat-session/_helpers/ai-context-window.spec.ts",
  "src/tauri/ui/chat-session/_helpers/session-window-controls.spec.ts",
  "src/tauri/ui/assistant-surface.spec.ts",
  "src/tauri/ui/chat-session.model.spec.ts",
  "src/tauri/ui/runtime.spec.ts",
] as const;

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
    globals: true,
    testTimeout: 30_000,
    passWithNoTests: true,
    restoreMocks: true,
    isolate: false,
    projects: [
      {
        extends: true,
        test: {
          name: "ui-node",
          environment: "node",
          include: ["src/tauri/ui/**/*.spec.ts"],
          exclude: [...jsdomSpecFiles],
        },
      },
      {
        extends: true,
        test: {
          name: "ui-jsdom",
          environment: "jsdom",
          include: [...jsdomSpecFiles],
        },
      },
    ],
    coverage: {
      provider: "v8",
      reporter: ["text"],
      include: ["src/tauri/ui/**/*.ts", "src/tauri/ui/**/*.tsx"],
      exclude: [
        "src/tauri/ui/**/*.spec.ts",
        "src/tauri/ui/**/*.spec.tsx",
      ],
    },
  },
});
