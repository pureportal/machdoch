import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hashFiles } from "./files.mjs";
import { identifyNode } from "./node.mjs";

const directory = resolve(process.argv[2]);
const manifest = JSON.parse(
  await readFile(join(directory, "manifest.json"), "utf8"),
);
const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);
for (const [file, expectedHash] of Object.entries(manifest.inputs)) {
  const actualHash = createHash("sha256")
    .update(await readFile(join(repositoryRoot, file)))
    .digest("hex");
  assert.equal(
    actualHash,
    expectedHash,
    `Release inputs changed after collecting notices: ${file}`,
  );
}
assert.ok(
  Array.isArray(manifest.packages),
  "Dependency licence inventory is missing.",
);
assert.deepEqual(
  await hashFiles(directory),
  manifest.files,
  "Licence bundle files differ from their recorded hashes.",
);
for (const file of ["LICENSE", "NOTICE", "EULA.md", "THIRD_PARTY_NOTICES.md"]) {
  assert.ok(manifest.files[file], `Missing ${file} in licence bundle.`);
}
if (process.argv[3]) {
  assert.ok(manifest.node, "Embedded Node.js licence is missing.");
  const node = await identifyNode(resolve(process.argv[3]));
  assert.equal(
    node.version,
    manifest.node.version,
    "Embedded Node.js licence version does not match the executable.",
  );
  assert.equal(
    node.sha256,
    manifest.node.sha256,
    "Embedded Node.js executable differs from the one recorded in the licence bundle.",
  );
}
console.log(
  `Verified ${manifest.profile} licence bundle (${manifest.packages.length} dependencies).`,
);
