import path from "node:path";
import { fileURLToPath } from "node:url";
import { mergeConfig } from "vite";
import config from "./vite.ui.config";

const directory = path.dirname(fileURLToPath(import.meta.url));
export default mergeConfig(config, {
  base: "./",
  root: path.join(directory, "src/tauri/ui/__test__/image-sampling"),
  build: { outDir: path.join(directory, "dist/image-sampling-verification") },
});
