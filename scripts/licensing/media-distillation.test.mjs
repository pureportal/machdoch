import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const hashes = {
  "LICENSE-DMAD.txt":
    "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30",
  "NOTICE-DMAD.txt":
    "c64c1094a44aa33b305e42340b0bbc16a2ffd86390bd0c3f742bb2db642d51aa",
};

test("ships the complete upstream DMAD terms and notices with every adapted worker module", async () => {
  const configuration = JSON.parse(
    await readFile(
      new URL("apps/client/src-tauri/tauri.conf.json", root),
      "utf8",
    ),
  );
  const generator = await readFile(
    new URL("scripts/licensing/generate.mjs", root),
    "utf8",
  );
  const notices = await readFile(
    new URL("THIRD_PARTY_NOTICES.md", root),
    "utf8",
  );
  for (const [name, sha256] of Object.entries(hashes)) {
    const relative = `apps/client/src-tauri/python/${name}`;
    const content = await readFile(new URL(relative, root));
    assert.equal(createHash("sha256").update(content).digest("hex"), sha256);
    assert.equal(
      configuration.bundle.resources[`python/${name}`],
      `python/${name}`,
    );
    assert.ok(generator.includes(`"${relative}"`));
    assert.ok(notices.includes(relative));
  }
  for (const name of [
    "media_h3_adapters.py",
    "media_h3_geometry.py",
    "media_h3_sampling.py",
    "media_h3_distillation.py",
  ]) {
    const source = await readFile(
      new URL(`apps/client/src-tauri/python/${name}`, root),
      "utf8",
    );
    assert.ok(source.includes("Copyright 2026 the DMAD authors"));
    assert.ok(source.includes("Machdoch modifications"));
    assert.ok(source.includes("LICENSE-DMAD.txt and NOTICE-DMAD.txt"));
    assert.equal(
      configuration.bundle.resources[`python/${name}`],
      `python/${name}`,
    );
  }
});
