import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const packageManifestPath = path.resolve(currentDirectory, "package.json");
const previewRoot = path.resolve(currentDirectory, "./src/tauri/ui/preview");
const workspaceNodeModules = path.resolve(
  currentDirectory,
  "../../node_modules",
);
const tauriDebug = process.env.TAURI_ENV_DEBUG === "true";
const tauriDevHost = process.env.TAURI_DEV_HOST;
const tauriPlatform = process.env.TAURI_ENV_PLATFORM;
const tauriBuildTarget =
  tauriPlatform === "windows"
    ? "chrome105"
    : tauriPlatform === "macos"
      ? "safari13"
      : "es2022";
const packageManifest = JSON.parse(
  readFileSync(packageManifestPath, "utf8"),
) as { version?: unknown };
const appVersion =
  typeof packageManifest.version === "string" &&
  packageManifest.version.trim().length > 0
    ? packageManifest.version.trim()
    : "0.0.0";

export default defineConfig({
  clearScreen: false,
  root: previewRoot,
  define: {
    __MACHDOCH_DEVELOPMENT__: JSON.stringify(tauriDebug),
    __MACHDOCH_VERSION__: JSON.stringify(appVersion),
  },
  plugins: [react(), tailwindcss()],
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: {
      "@": path.resolve(currentDirectory, "./src"),
      react: path.resolve(workspaceNodeModules, "react"),
      "react-dom": path.resolve(workspaceNodeModules, "react-dom"),
      "react-dom/client": path.resolve(
        workspaceNodeModules,
        "react-dom/client",
      ),
      "react/jsx-dev-runtime": path.resolve(
        workspaceNodeModules,
        "react/jsx-dev-runtime",
      ),
      "react/jsx-runtime": path.resolve(
        workspaceNodeModules,
        "react/jsx-runtime",
      ),
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
    minify: tauriDebug ? false : "oxc",
    sourcemap: tauriDebug,
    target: tauriBuildTarget,
    chunkSizeWarningLimit: 700,
  },
});
