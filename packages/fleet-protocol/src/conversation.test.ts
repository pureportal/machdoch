import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  hostResponseSchema,
  productMessageSchema,
  productSnapshotSchema,
} from "./index.ts";

const cases: Array<{
  name: string;
  accepted: boolean;
  message: Record<string, unknown>;
}> = JSON.parse(
  await readFile(
    new URL("../fixtures/conversation-conformance.json", import.meta.url),
    "utf8",
  ),
);
const { baseSnapshot } = JSON.parse(
  await readFile(
    new URL("../fixtures/composer-conformance.json", import.meta.url),
    "utf8",
  ),
);
for (const entry of cases) {
  await test(entry.name, () => {
    assert.equal(
      productMessageSchema.safeParse(entry.message).success,
      entry.accepted,
    );
    const snapshot = {
      ...baseSnapshot,
      shell: { ...baseSnapshot.shell, visibleMessages: [entry.message] },
    };
    assert.equal(
      productSnapshotSchema.safeParse(snapshot).success,
      entry.accepted,
    );
    const parsed = hostResponseSchema.safeParse({
      type: "productSnapshot",
      snapshot,
    });
    assert.equal(parsed.success, entry.accepted);
    if (parsed.success)
      assert.deepEqual(parsed.data, { type: "productSnapshot", snapshot });
  });
}
await test("conversation prompt projections preserve UTF-16 bounds", () => {
  for (const field of ["rawContent", "originalPrompt"]) {
    assert.equal(
      productMessageSchema.safeParse({
        ...cases[0]!.message,
        [field]: "🌿".repeat(6000),
      }).success,
      true,
    );
    assert.equal(
      productMessageSchema.safeParse({
        ...cases[0]!.message,
        [field]: "🌿".repeat(6000) + "x",
      }).success,
      false,
    );
  }
});
