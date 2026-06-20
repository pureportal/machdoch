import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const previewRoot = path.resolve(currentDirectory, "./src/tauri/ui/preview");
const rootNodeModules = path.resolve(currentDirectory, "./node_modules");
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
    dedupe: ["react", "react-dom"],
    alias: {
      "@": path.resolve(currentDirectory, "./src"),
      react: path.resolve(rootNodeModules, "react"),
      "react-dom": path.resolve(rootNodeModules, "react-dom"),
      "react-dom/client": path.resolve(rootNodeModules, "react-dom/client"),
      "react/jsx-dev-runtime": path.resolve(
        rootNodeModules,
        "react/jsx-dev-runtime",
      ),
      "react/jsx-runtime": path.resolve(rootNodeModules, "react/jsx-runtime"),
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
    chunkSizeWarningLimit: 700,
  },
});
