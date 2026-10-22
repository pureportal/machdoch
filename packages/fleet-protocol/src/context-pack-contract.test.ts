import assert from "node:assert/strict";
import test from "node:test";
import {
  contextPackCommandSchema,
  contextPackExportSchema,
} from "./context-pack-contract.ts";

const content = {
  name: "Long prompt",
  instructions: "Instructions\n" + "Grüß 🌿\n".repeat(40_000) + "End",
  prompt: "Prompt\n" + "日本語\n".repeat(40_000) + "End",
  contextAttachments: [],
  variables: [{ name: "target", defaultValue: "x".repeat(200_000) }],
};
const command = {
  kind: "save-context-pack",
  sessionId: "session-1",
  contextPack: {
    ...content,
    scope: "global",
    triggerPhrases: [],
    triggerPathPatterns: [],
  },
};
const archive = {
  kind: "machdoch.context-packs",
  version: 1,
  exportedAt: 1,
  contextPacks: [{
    ...content,
    id: "pack-1",
    workspace: null,
    trigger: { phrases: [], pathPatterns: [] },
    createdAt: 1,
    updatedAt: 1,
    useCount: 0,
  }],
};

void test("preserves long context-pack text in save commands and archives", () => {
  assert.deepEqual(contextPackCommandSchema.parse(command), command);
  assert.deepEqual(contextPackExportSchema.parse(archive), archive);
});

void test("rejects invalid context-pack text without a length cap", () => {
  for (const field of ["prompt", "instructions"] as const) {
    for (const invalid of [null, 12, "text\0text"]) {
      assert.equal(contextPackCommandSchema.safeParse({
        ...command,
        contextPack: { ...command.contextPack, [field]: invalid },
      }).success, false);
      assert.equal(contextPackExportSchema.safeParse({
        ...archive,
        contextPacks: [{ ...archive.contextPacks[0], [field]: invalid }],
      }).success, false);
    }
  }
});
