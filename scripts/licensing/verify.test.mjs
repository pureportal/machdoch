import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { hashFiles } from "./files.mjs";
import { identifyNode } from "./node.mjs";

const run = promisify(execFile);
const verifier = fileURLToPath(new URL("./verify.mjs", import.meta.url));

async function fixture(t) {
  const directory = await mkdtemp(
    join(tmpdir(), "machdoch-legal-verification-"),
  );
  assert.equal(dirname(directory), tmpdir());
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const name of [
    "LICENSE",
    "NOTICE",
    "EULA.md",
    "THIRD_PARTY_NOTICES.md",
  ]) {
    await writeFile(join(directory, name), "Fixture legal document\n");
  }
  const manifest = {
    profile: "desktop",
    inputs: {},
    packages: [{ name: "fixture", version: "1.0.0" }],
    node: await identifyNode(process.execPath),
    files: await hashFiles(directory),
  };
  await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest));
  return { directory, manifest };
}

test("accepts intact notices for the exact embedded Node executable", async (t) => {
  const { directory } = await fixture(t);
  const result = await run(
    process.execPath,
    [verifier, directory, process.execPath],
    { windowsHide: true },
  );
  assert.match(result.stdout, /Verified desktop licence bundle/u);
});

test("rejects an embedded executable whose hash differs from the collected licence identity", async (t) => {
  const { directory, manifest } = await fixture(t);
  manifest.node.sha256 = "0".repeat(64);
  await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest));
  await assert.rejects(
    run(process.execPath, [verifier, directory, process.execPath], {
      windowsHide: true,
    }),
    (error) =>
      error.code === 1 &&
      error.stderr.includes("Embedded Node.js executable differs"),
  );
});

test("rejects altered notice text before validating the executable", async (t) => {
  const { directory } = await fixture(t);
  await writeFile(join(directory, "LICENSE"), "Changed fixture document\n");
  await assert.rejects(
    run(process.execPath, [verifier, directory, process.execPath], {
      windowsHide: true,
    }),
    (error) =>
      error.code === 1 && error.stderr.includes("Licence bundle files differ"),
  );
});
