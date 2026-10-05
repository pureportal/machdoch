import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { copyPackageLegalFiles, findLegalFiles, hashFiles } from "./files.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "machdoch-legal-files-"));
  assert.equal(dirname(root), tmpdir());
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function put(root, file, text) {
  const path = join(root, file);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
  return path;
}

test("collects nested native notices and complete grants in readmes while excluding unrelated dependencies", async (t) => {
  const root = await fixture(t);
  await put(root, "LICENSE", "Primary licence");
  await put(root, "vendor/ThirdPartyNotices.txt", "Native notice");
  await put(root, "vendor/licenses/native.txt", "Native licence");
  await put(
    root,
    "README.md",
    "Permission is hereby granted, free of charge. THE SOFTWARE IS PROVIDED AS IS.",
  );
  await put(root, "docs/README.md", "Licensed under MIT.");
  await put(root, "node_modules/other/LICENSE", "Unrelated licence");
  assert.deepEqual(await findLegalFiles(root), [
    "LICENSE",
    "README.md",
    "vendor/licenses/native.txt",
    "vendor/ThirdPartyNotices.txt",
  ]);
});

test("rejects metadata-only packages instead of producing an empty legal bundle", async (t) => {
  const root = await fixture(t);
  await put(root, "package.json", '{"license":"MIT"}');
  await assert.rejects(
    copyPackageLegalFiles(
      {
        ecosystem: "npm",
        name: "missing",
        version: "1.0.0",
        license: "MIT",
        directory: root,
      },
      join(root, "output"),
    ),
    /No licence\/notice files/u,
  );
});

test("verifies supplemental legal documents before copying them", async (t) => {
  const root = await fixture(t);
  const directory = join(root, "package");
  await put(directory, "package.json", '{"license":"MIT"}');
  const path = await put(root, "upstream/LICENSE", "Actual upstream licence");
  const metadata = {
    ecosystem: "npm",
    name: "supplemented",
    version: "1.0.0",
    license: "MIT",
    repository: "https://example.test",
    directory,
  };
  const supplement = {
    path,
    source: "https://example.test/commit/LICENSE",
    sha256: createHash("sha256")
      .update("Actual upstream licence")
      .digest("hex"),
  };
  const output = join(root, "output");
  const record = await copyPackageLegalFiles(metadata, output, [supplement]);
  assert.ok(record.files.includes("npm/supplemented@1.0.0/upstream/LICENSE"));
  assert.equal(
    await readFile(
      join(output, "npm/supplemented@1.0.0/upstream/LICENSE"),
      "utf8",
    ),
    "Actual upstream licence",
  );
  await writeFile(path, "Changed upstream licence");
  await assert.rejects(
    copyPackageLegalFiles(metadata, join(root, "changed"), [supplement]),
    /hash check/u,
  );
});

test("includes the original source of MPL-only crates alongside their legal files", async (t) => {
  const root = await fixture(t);
  const directory = join(root, "crate");
  await put(directory, "Cargo.toml", 'license = "MPL-2.0"');
  await put(directory, "LICENSE", "MPL terms");
  await put(directory, "src/lib.rs", "pub fn covered_source() {}\n");
  const output = join(root, "output");
  const record = await copyPackageLegalFiles(
    {
      ecosystem: "cargo",
      name: "covered",
      version: "1.0.0",
      license: "MPL-2.0",
      directory,
    },
    output,
  );
  assert.equal(
    await readFile(join(output, record.sourceDirectory, "src/lib.rs"), "utf8"),
    "pub fn covered_source() {}\n",
  );
});

test("hashes all delivered content and excludes the manifest itself", async (t) => {
  const root = await fixture(t);
  await put(root, "manifest.json", "{}");
  await put(root, "nested/LICENSE", "Licence text");
  const hashes = await hashFiles(root);
  assert.deepEqual(Object.keys(hashes), ["nested/LICENSE"]);
  await put(root, "nested/LICENSE", "Modified licence text");
  assert.notEqual(
    (await hashFiles(root))["nested/LICENSE"],
    hashes["nested/LICENSE"],
  );
});
