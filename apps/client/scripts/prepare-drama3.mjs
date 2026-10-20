import { spawn } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { x as extractTar } from "tar";
import { downloadVerifiedAsset, sha256File } from "./download-verified-asset.mjs";

const manifest = JSON.parse(await readFile(new URL("drama3-assets.json", import.meta.url), "utf8"));
const platform = `${process.platform}-${process.arch}`;
const asset = manifest.platforms[platform];
const resources = resolve(import.meta.dirname, "../src-tauri/resources/speech");
const destination = join(resources, "drama3");
await mkdir(resources, { recursive: true });
if (!asset) {
  await mkdir(destination, { recursive: true });
  await writeFile(join(destination, "runtime.json"), JSON.stringify({ version: manifest.version, platform, supported: false, files: {} }, null, 2));
  console.log(`Local Drama 3 is unavailable for ${platform}.`);
  process.exit(0);
}
const archive = join(resources, process.platform === "win32" ? "drama3.zip" : "drama3.tar.gz");
await downloadVerifiedAsset(asset, archive);
const staging = await mkdtemp(join(resources, "drama3-extract-"));
try {
  if (process.platform === "win32") {
    await new Promise((done, reject) => {
      const command = spawn("tar.exe", ["-xf", archive, "-C", staging], { stdio: "inherit", windowsHide: true });
      command.once("error", reject);
      command.once("exit", code => code === 0 ? done() : reject(new Error(`Drama 3 extraction exited with ${code}.`)));
    });
  } else await extractTar.asyncFile({ file: archive, cwd: staging, strict: true }, []);
  const executable = process.platform === "win32" ? "audiocpp_cli.exe" : "audiocpp_cli";
  const files = await readdir(staging);
  if (!files.includes(executable) || !files.includes("LICENSE")) throw new Error("The Drama 3 runtime archive is incomplete.");
  const selected = files.filter(name => name === executable || name === "LICENSE" || /\.(dll|so(?:\.\d+)*)$/u.test(name));
  const assembled = join(staging, "bundle");
  await mkdir(assembled);
  const hashes = {};
  for (const name of selected) {
    await copyFile(join(staging, name), join(assembled, name));
    hashes[name] = await sha256File(join(assembled, name));
  }
  if (process.platform !== "win32") await chmod(join(assembled, executable), 0o755);
  await writeFile(join(assembled, "runtime.json"), JSON.stringify({ version: manifest.version, platform, files: hashes }, null, 2));
  await rm(destination, { recursive: true, force: true });
  await rename(assembled, destination);
  console.log(`Bundled Drama 3 ${manifest.version} (${platform}).`);
} finally {
  await rm(staging, { recursive: true, force: true });
}
