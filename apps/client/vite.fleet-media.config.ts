import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const directory = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: path.resolve(directory, "src/tauri/fleet-media"),
  base: "/media-studio/",
  plugins: [react(), tailwindcss()],
  resolve: { dedupe: ["react", "react-dom"] },
  build: {
    outDir: path.resolve(directory, "../fleet-manager/public/media-studio"),
    emptyOutDir: true,
    target: "es2022",
    chunkSizeWarningLimit: 1500,
  },
});
