import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const modelPath = resolve(
  import.meta.dirname,
  "../src-tauri/resources/whisper/ggml-large-v3-q5_0.bin",
);
const modelUrl =
  "https://huggingface.co/ggerganov/whisper.cpp/resolve/c521a4b02f422512d734391fdf08bb08c0862f68/ggml-large-v3-q5_0.bin";
const expectedSize = 1_081_140_203;
const expectedSha256 =
  "d75795ecff3f83b5faa89d1900604ad8c780abd5739fae406de19f23ecd98ad1";

const sha256File = async (path) => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
};

const existing = await stat(modelPath).catch(() => null);
if (
  existing?.size === expectedSize &&
  (await sha256File(modelPath)) === expectedSha256
) {
  process.exit(0);
}

await mkdir(dirname(modelPath), { recursive: true });
const temporaryPath = `${modelPath}.download-${process.pid}`;
try {
  const response = await fetch(modelUrl);
  if (!response.ok || !response.body) {
    throw new Error(`Whisper model download failed: HTTP ${response.status}`);
  }
  await pipeline(
    Readable.fromWeb(response.body),
    createWriteStream(temporaryPath),
  );
  const downloaded = await stat(temporaryPath);
  if (
    downloaded.size !== expectedSize ||
    (await sha256File(temporaryPath)) !== expectedSha256
  ) {
    throw new Error("Whisper model download failed its integrity check.");
  }
  await rename(temporaryPath, modelPath);
} finally {
  await rm(temporaryPath, { force: true });
}
