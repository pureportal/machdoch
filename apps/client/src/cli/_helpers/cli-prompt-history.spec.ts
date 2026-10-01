import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPromptHistory, savePromptHistory } from "./cli-prompt-history.js";
import { PromptComposer } from "./cli-composer.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "machdoch-prompt-history-"));
  vi.stubEnv("MACHDOCH_USER_CONFIG_DIR", root);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe("persistent prompt history", () => {
  it("merges concurrent saves without losing prompts", async () => {
    await Promise.all([
      savePromptHistory("first"),
      savePromptHistory("second"),
    ]);
    expect(await loadPromptHistory()).toEqual(
      expect.arrayContaining(["first", "second"]),
    );
    await savePromptHistory("first");
    expect(await loadPromptHistory()).toEqual(["first", "second"]);
  });

  it("preserves a slash-prefixed task as task text after restarting", async () => {
    await savePromptHistory("/exit");
    const composer = new PromptComposer(await loadPromptHistory());
    composer.recall(-1);
    expect(composer.submit()).toMatchObject({ text: "/exit", pasted: true });
    expect(
      JSON.parse(await readFile(join(root, "cli-prompt-history.json"), "utf8")),
    ).toEqual(["/exit"]);
  });
});
