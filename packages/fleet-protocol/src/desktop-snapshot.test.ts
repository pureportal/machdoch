import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { hostMessageSchema } from "./index.ts";

const snapshot = JSON.parse(
  readFileSync(
    new URL("../fixtures/desktop-snapshot.json", import.meta.url),
    "utf8",
  ),
);

void test("desktop snapshot includes the required composer memory", () => {
  assert.equal(hostMessageSchema.safeParse(snapshot).success, true);
  const missingMemory = structuredClone(snapshot);
  delete missingMemory.response.snapshot.shell.composer.sessionMemory;
  assert.equal(hostMessageSchema.safeParse(missingMemory).success, false);
});
