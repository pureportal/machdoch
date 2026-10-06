import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);

test("packages RefMod workers with complete upstream licences and attribution", async () => {
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
  const hashes = {
    "LICENSE-RefMod-MIT.txt":
      "ebcb7e4282e799ab880126d4d7523dfe7b3fa1ec6f457156a2e8ad6fbeea7113",
    "LICENSE-H3-PromptBuilder-MIT.txt":
      "19cb889133b1980bcd71089c0caebbe453602b145ff3bcd3e8cbe623ff1ab0ad",
  };
  for (const [name, hash] of Object.entries(hashes)) {
    const relative = `apps/client/src-tauri/python/${name}`;
    const content = await readFile(new URL(relative, root));
    assert.equal(createHash("sha256").update(content).digest("hex"), hash);
    assert.equal(
      configuration.bundle.resources[`python/${name}`],
      `python/${name}`,
    );
    assert.ok(generator.includes(`"${relative}"`));
    assert.ok(notices.includes(relative));
  }
  for (const name of [
    "media_refmods.py",
    "media_refmod_creation.py",
    "media_refmod_conditioning.py",
    "media_refmod_preview.py",
    "NOTICE-RefMod.txt",
  ])
    assert.equal(
      configuration.bundle.resources[`python/${name}`],
      `python/${name}`,
    );
  assert.ok(
    generator.includes('"apps/client/src-tauri/python/NOTICE-RefMod.txt"'),
  );
  const attribution = await readFile(
    new URL("apps/client/src-tauri/python/NOTICE-RefMod.txt", root),
    "utf8",
  );
  assert.ok(attribution.includes("Luisacaotica/ComfyUI-MiniMaxH3Mod"));
  assert.ok(
    attribution.includes(
      "Adudeguyman/ComfyUI-Fantastic-MiniMaxH3-PromptBuilder",
    ),
  );
  assert.ok(attribution.includes("2026-10-06"));
});

test("retains the full H3 model agreement and required notice", async () => {
  const content = await readFile(
    new URL("legal/third-party/MiniMax-H3/LICENSE", root),
  );
  assert.equal(
    createHash("sha256").update(content).digest("hex"),
    "59b99642b95ea21630e311198ddbfffbfe05aadba0c2f5d884cbdf4efcc90f44",
  );
  const notice = await readFile(
    new URL("legal/third-party/MiniMax-H3/NOTICE", root),
    "utf8",
  );
  assert.equal(
    notice.trim(),
    "MiniMax H3 is licensed under the MiniMax H3 Community License Agreement, Copyright © 2026 MiniMax. All Rights Reserved.",
  );
});
