import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { hostRequestSchema } from "./index.ts";
import {
  instructionArgumentsSchema,
  instructionReferencedWorkspaces,
} from "./instructions.ts";

await test("Instruction requests match Rust conformance", () => {
  const cases = JSON.parse(
    readFileSync(
      new URL(
        "../fixtures/instruction-editor-conformance.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as Array<{ name: string; request: unknown; accepted: boolean }>;
  for (const entry of cases)
    assert.equal(
      hostRequestSchema.safeParse({
        type: "instructions",
        request: entry.request,
      }).success,
      entry.accepted,
      entry.name,
    );
});

await test("rejects oversized instruction arguments and request lists", () => {
  assert.equal(
    instructionArgumentsSchema.safeParse([
      "profiles",
      "create",
      "--prompt",
      "x".repeat(1_800_001),
    ]).success,
    false,
  );
  assert.equal(
    instructionArgumentsSchema.safeParse([
      "profiles",
      "create",
      "--name",
      "x".repeat(1_000_000),
      "--prompt",
      "x".repeat(1_000_000),
    ]).success,
    false,
  );
});

await test("checks additional workspace roots even when options precede the target", () => {
  assert.deepEqual(
    instructionReferencedWorkspaces([
      "workspaces",
      "configure",
      "--name",
      "Demo",
      "/projects/demo",
    ]),
    ["/projects/demo"],
  );
  assert.deepEqual(
    instructionReferencedWorkspaces([
      "workspaces",
      "relink",
      "id",
      "--path",
      "/projects/demo",
    ]),
    ["/projects/demo"],
  );
  assert.deepEqual(
    instructionReferencedWorkspaces([
      "profiles",
      "create",
      "--prompt",
      "/projects/demo",
    ]),
    [],
  );
});
