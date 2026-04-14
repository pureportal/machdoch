import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const previewRoot = path.resolve(currentDirectory, "./src/tauri/ui/preview");
const tauriDebug = process.env.TAURI_ENV_DEBUG === "true";
const tauriDevHost = process.env.TAURI_DEV_HOST;
const tauriPlatform = process.env.TAURI_ENV_PLATFORM;
const tauriBuildTarget =
  tauriPlatform === "windows"
    ? "chrome105"
    : tauriPlatform === "macos"
      ? "safari13"
      : "es2022";

export default defineConfig({
  clearScreen: false,
  root: previewRoot,
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(currentDirectory, "./src"),
    },
  },
  server: {
    host: tauriDevHost ?? "127.0.0.1",
    port: 4173,
    strictPort: true,
    hmr: tauriDevHost
      ? {
          protocol: "ws",
          host: tauriDevHost,
          port: 4174,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  preview: {
    host: "127.0.0.1",
    port: 4173,
  },
  build: {
    outDir: path.resolve(currentDirectory, "dist/ui-preview"),
    emptyOutDir: true,
    minify: tauriDebug ? false : "esbuild",
    sourcemap: tauriDebug,
    target: tauriBuildTarget,
  },
});