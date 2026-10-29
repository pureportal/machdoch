import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    include: [
      "src/**/*.dom.spec.tsx",
      "src/flow/*.spec.ts",
      "src/snapshot-refresh-coordinator.spec.ts",
      "src/fleet-operation-transport.spec.ts",
    ],
  },
});
