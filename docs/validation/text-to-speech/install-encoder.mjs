import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile, readdir, access } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";

if (process.platform !== "win32") throw new Error("This verified encoder package targets Windows x64.");
const root = "D:/Models/machdoch/speech/encoder";
await mkdir(root, { recursive: true });
const source = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip";
const checksumResponse = await fetch(`${source}.sha256`, { signal: AbortSignal.timeout(60000) });
if (!checksumResponse.ok) throw new Error(`Encoder checksum request failed: ${checksumResponse.status}`);
const expected = (await checksumResponse.text()).trim().split(/\s/u)[0].toLowerCase();
if (!/^[a-f0-9]{64}$/u.test(expected)) throw new Error("The encoder publisher returned an invalid digest.");
const archive = path.join(root, `ffmpeg-${expected}.zip`);
let existing = false;
try { await access(archive); existing = true; } catch {}
if (!existing) {
  const response = await fetch(source, { signal: AbortSignal.timeout(600000) });
  if (!response.ok || !response.body) throw new Error(`Encoder download failed: ${response.status}`);
  let size = 0;
  await pipeline(Readable.fromWeb(response.body), new Transform({ transform(chunk, _encoding, callback) { size += chunk.length; callback(size > 256 * 1024 * 1024 ? new Error("Encoder download exceeds the size guard.") : null, chunk); } }), createWriteStream(archive, { flags: "wx" }));
}
const digest = createHash("sha256").update(await readFile(archive)).digest("hex");
if (digest !== expected) throw new Error("Encoder archive integrity failed.");
const destination = path.join(root, expected);
try { await access(destination); } catch {
  execFileSync("C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe", ["-NoProfile", "-NonInteractive", "-File", new URL("./install-encoder.ps1", import.meta.url).pathname.replace(/^\/([A-Z]:)/u, "$1"), "-Archive", archive, "-Destination", destination], { stdio: "inherit", windowsHide: true });
}
const folders = await readdir(destination, { withFileTypes: true });
const distribution = path.join(destination, folders.find(entry => entry.isDirectory())?.name ?? "");
const binary = path.join(distribution, "bin", "ffmpeg.exe");
const ffprobe = path.join(distribution, "bin", "ffprobe.exe");
const version = execFileSync(binary, ["-version"], { encoding: "utf8", windowsHide: true }).split(/\r?\n/u)[0];
const manifest = { schema: "machdoch-speech-encoder", version: 1, platform: "windows-x64", source, archiveSha256: expected, binary: path.relative(root, binary).replaceAll("\\", "/"), binarySha256: createHash("sha256").update(await readFile(binary)).digest("hex"), ffprobe: path.relative(root, ffprobe).replaceAll("\\", "/"), ffprobeSha256: createHash("sha256").update(await readFile(ffprobe)).digest("hex"), encoderVersion: version, license: "GPL-3.0", licensePath: path.relative(root, path.join(distribution, "LICENSE")).replaceAll("\\", "/"), installedAt: new Date().toISOString() };
await writeFile(path.join(root, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
await writeFile(new URL("./encoder-2026-10-18.json", import.meta.url), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify(manifest, null, 2));
