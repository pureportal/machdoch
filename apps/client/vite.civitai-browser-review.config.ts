import path from "node:path";
import { fileURLToPath } from "node:url";
import { mergeConfig } from "vite";
import config from "./vite.ui.config";

const directory = path.dirname(fileURLToPath(import.meta.url));
export default mergeConfig(config, {
  root: path.join(directory, "src/tauri/ui/__test__/civitai-browser"),
  server: { port: 4176, strictPort: true },
});
