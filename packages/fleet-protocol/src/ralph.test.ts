import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { managerMessageSchema, productRalphSchema } from "./index.ts";
import { ralphRequestSchema } from "./ralph.ts";

const fixtures: Array<{ name: string; accepted: boolean; request: unknown }> =
  JSON.parse(
    readFileSync(
      new URL("../fixtures/ralph-editor-conformance.json", import.meta.url),
      "utf8",
    ),
  );
for (const fixture of fixtures) {
  void test(`RALPH editor: ${fixture.name}`, () => {
    assert.equal(
      ralphRequestSchema.safeParse(fixture.request).success,
      fixture.accepted,
    );
    assert.equal(
      managerMessageSchema.safeParse({
        type: "request",
        requestId: "request-1",
        request: { type: "ralph", request: fixture.request },
      }).success,
      fixture.accepted,
    );
  });
}

void test("bounds RALPH payloads and optional editor availability", () => {
  const request = fixtures[0]!.request as {
    args: { request: { arguments: string[] } };
  };
  assert.equal(
    ralphRequestSchema.safeParse({
      ...request,
      args: {
        request: {
          workspaceRoot: "/projects/demo",
          arguments: ["save", "flow", "--flow-json", "x".repeat(1_800_001)],
        },
      },
    }).success,
    false,
  );
  const snapshot = { loading: false, flows: [], runs: [], updatedAt: 0 };
  assert.equal(productRalphSchema.safeParse(snapshot).success, true);
  assert.equal(
    productRalphSchema.safeParse({ ...snapshot, editorAvailable: true })
      .success,
    true,
  );
  assert.equal(
    productRalphSchema.safeParse({ ...snapshot, editorAvailable: "true" })
      .success,
    false,
  );
});
