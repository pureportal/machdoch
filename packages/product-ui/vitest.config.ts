import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["src/**/*.dom.spec.tsx", "src/snapshot-refresh-coordinator.spec.ts"],
  },
});
