import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const root = "docs/validation/image-engines/research-2026-10-13";
const metadata = JSON.parse(await readFile(`${root}/stabilityai--sd-turbo.json`, "utf8"));
const files = metadata.files.map(file => file.rfilename).filter(file => file === "model_index.json" || file === "scheduler/scheduler_config.json" || /^(unet|text_encoder|vae)\/config.json$/u.test(file) || file.startsWith("tokenizer/"));
const manifest = [];
for (const path of files) {
  const url = `https://huggingface.co/${metadata.repository}/resolve/${metadata.revision}/${path}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  manifest.push({ path, url, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
}
await writeFile("apps/client/src-tauri/src/media/sd_turbo_components.json", JSON.stringify(manifest, null, 2) + "\n");
console.log(JSON.stringify({ files: manifest.length, bytes: manifest.reduce((total, file) => total + file.bytes, 0), revision: metadata.revision }));
