import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { downloadVerifiedAsset } from "./download-verified-asset.mjs";

const content = Buffer.from("verified model");
const asset = {
  url: "https://example.test/model.bin",
  size: content.length,
  sha256: createHash("sha256").update(content).digest("hex"),
};
const originalFetch = globalThis.fetch;
let directory;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "machdoch-speech-asset-"));
});
afterEach(async () => {
  globalThis.fetch = originalFetch;
  if (dirname(resolve(directory)) !== resolve(tmpdir()))
    throw new Error("Invalid asset test directory.");
  await rm(directory, { recursive: true, force: true });
});

await test("uses an intact cached model without network access", async () => {
  const path = join(directory, "model.bin");
  await writeFile(path, content);
  globalThis.fetch = () => {
    throw new Error("Unexpected network access");
  };
  await downloadVerifiedAsset(asset, path);
});

await test("replaces a corrupt cached model only after verifying its replacement", async () => {
  const path = join(directory, "model.bin");
  await writeFile(path, Buffer.from("corrupt"));
  globalThis.fetch = async () => new Response(content);
  await downloadVerifiedAsset(asset, path);
  assert.deepEqual(await readFile(path), content);
  assert.deepEqual(await readdir(directory), ["model.bin"]);
});

await test("rejects incorrect digests without overwriting the cached file", async () => {
  const path = join(directory, "model.bin");
  const previous = Buffer.alloc(content.length, 7);
  await writeFile(path, previous);
  globalThis.fetch = async () => new Response(previous);
  await assert.rejects(
    downloadVerifiedAsset(asset, path),
    /integrity check failed/,
  );
  assert.deepEqual(await readFile(path), previous);
  assert.deepEqual(await readdir(directory), ["model.bin"]);
});

await test("cleans incomplete downloads and rejects HTTP errors", async () => {
  const path = join(directory, "model.bin");
  globalThis.fetch = async () => new Response(null, { status: 404 });
  await assert.rejects(downloadVerifiedAsset(asset, path), /HTTP 404/);
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(content.subarray(0, 3));
          controller.error(new Error("interrupted"));
        },
      }),
    );
  await assert.rejects(downloadVerifiedAsset(asset, path), /interrupted/);
  assert.deepEqual(await readdir(directory), []);
});
