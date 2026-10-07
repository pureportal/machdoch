import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildUpdateManifest,
  updateTargets,
  validateUpdateAssetNames,
} from "./update-manifest.mjs";

await test("generates a complete manifest with release-pinned URLs, checksums, and installer-specific targets", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "machdoch-update-manifest-test-"),
  );
  try {
    for (const name of Object.keys(updateTargets)) {
      await writeFile(join(directory, name), `artifact: ${name}`);
      await writeFile(
        join(directory, `${name}.sig`),
        Buffer.from(
          `untrusted comment: test\npacket\ntrusted comment: timestamp:1\tfile:${name}\tversion:2.0.0\nglobal\n`,
        ).toString("base64"),
      );
    }
    const manifest = await buildUpdateManifest(
      directory,
      "2.0.0",
      "Release notes",
    );
    assert.equal(manifest.version, "2.0.0");
    assert.equal(manifest.notes, "Release notes");
    assert.equal(Object.keys(manifest.platforms).length, 7);
    for (const [name, target] of Object.entries(updateTargets)) {
      assert.equal(
        manifest.platforms[target].url,
        `https://github.com/pureportal/machdoch/releases/download/v2.0.0/${name}`,
      );
      assert.equal(
        manifest.platforms[target].size,
        (await readFile(join(directory, name))).length,
      );
      assert.match(manifest.platforms[target].sha256, /^[a-f0-9]{64}$/);
    }
    await writeFile(
      join(directory, "machdoch-headless.tar.gz.sig"),
      Buffer.from(
        "untrusted comment: test\npacket\ntrusted comment: timestamp:1\tversion:1.0.0\nglobal\n",
      ).toString("base64"),
    );
    await assert.rejects(buildUpdateManifest(directory, "2.0.0"), /not bound/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

await test("requires every update package, signature, and manifest before publication", () => {
  const names = Object.keys(updateTargets).flatMap((name) => [
    name,
    `${name}.sig`,
  ]);
  assert.throws(() => validateUpdateAssetNames(names), /latest.json/);
  names.push("latest.json");
  assert.doesNotThrow(() => validateUpdateAssetNames(names));
  assert.throws(
    () => validateUpdateAssetNames([...names, names[0]]),
    /duplicated/,
  );
  assert.throws(
    () =>
      validateUpdateAssetNames(names.filter((name) => !name.endsWith(".sig"))),
    /Missing/,
  );
});
