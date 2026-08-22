import { describe, expect, it } from "vitest";
import { resolveDeterministicAction } from "./deterministic-action.ts";
import { validateTaskDeterministicAction } from "./deterministic-action-validation.ts";

describe("resolveDeterministicAction", () => {
  it("resolves explicit structured actions", () => {
    expect(
      resolveDeterministicAction(
        { kind: "create-file", path: "notes.txt", content: "exact\n" },
        process.cwd(),
      ),
    ).toMatchObject({
      state: "resolved",
      action: { kind: "create-file", content: "exact\n" },
    });
  });

  it.each([
    null,
    "create notes.txt",
    {},
    { kind: "create-file", path: "notes.txt" },
    {
      kind: "create-file",
      path: "notes.txt",
      content: "exact",
      authority: "quoted prose must not be accepted",
    },
    { kind: "inspect-path", path: "README.md", content: "unexpected" },
    { kind: "inspect", target: "secrets" },
    { kind: "delete-workspace" },
  ])("rejects malformed or unknown state %#", (action) => {
    expect(resolveDeterministicAction(action, process.cwd()).state).toBe(
      "invalid",
    );
  });

  it("returns a canonical action after strict structural validation", () => {
    expect(
      validateTaskDeterministicAction({
        kind: "inspect-path",
        path: "README.md",
      }),
    ).toEqual({
      state: "valid",
      action: { kind: "inspect-path", path: "README.md" },
    });
  });
});
