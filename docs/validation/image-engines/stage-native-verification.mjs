import { readFile, mkdir, cp, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const destination = path.resolve(root, ".cache/rust/debug");
const configuration = JSON.parse(await readFile("apps/client/src-tauri/tauri.conf.json", "utf8"));
let copied = 0;
for (const [source, target] of Object.entries(configuration.bundle.resources)) {
  if (!source.startsWith("python/")) continue;
  const resolved = path.resolve(destination, target);
  if (!resolved.startsWith(destination + path.sep)) throw new Error("Resource is outside the verification directory");
  await mkdir(path.dirname(resolved), { recursive: true });
  await cp(path.resolve(root, "apps/client/src-tauri", source), resolved, { recursive: true });
  copied += 1;
}
const appData = path.resolve(root, ".cache/image-engine-native/app-data/com.machdoch.image-engine-verification");
await mkdir(appData, { recursive: true });
await writeFile(path.join(appData, "media-storage.json"), JSON.stringify({ root: "D:/Models/machdoch", identity: null, migration: null }));
console.log(JSON.stringify({ copied, destination, appData }));
