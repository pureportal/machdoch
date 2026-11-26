import { describe, expect, it } from "vitest";
import type {
  InstructionProfileView,
  InstructionWorkspaceView,
} from "@machdoch/fleet-protocol/instruction-contract";
import {
  countInstructionFiles,
  filterInstructionFiles,
  instructionActivation,
  instructionWorkspaceName,
  instructionWorkspaceReach,
} from "./instruction-library-model";

const file = (
  id: string,
  options: Partial<InstructionProfileView> = {},
): InstructionProfileView => ({
  id,
  name: id,
  createdAt: "2026-11-20T00:00:00.000Z",
  updatedAt: "2026-11-20T00:00:00.000Z",
  byteLength: 0,
  lineCount: 0,
  digest: id,
  manualAssignmentCount: 0,
  enabled: true,
  global: false,
  tags: [],
  ...options,
});

const files = [
  file("standards", { global: true, tags: ["quality"] }),
  file("typescript", {
    description: "Strict typing",
    match: { op: "tag", tag: "typescript" },
  }),
  file("release"),
  file("legacy", { enabled: false }),
];

const workspace = (
  id: string,
  tags: string[],
  profiles: string[] = [],
  displayName?: string,
): InstructionWorkspaceView => ({
  id,
  root: `C:\\Projects\\${id}`,
  ...(displayName ? { displayName } : {}),
  tags,
  scopes: [{ path: ".", profiles }],
});

describe("instruction library model", () => {
  it("derives the activation mode from global and tag match", () => {
    expect(instructionActivation({ global: true, match: null })).toBe("global");
    expect(
      instructionActivation({ global: false, match: { op: "tag", tag: "a" } }),
    ).toBe("tag-match");
    expect(instructionActivation({ global: false, match: undefined })).toBe(
      "manual",
    );
  });

  it("counts files per filter", () => {
    expect(countInstructionFiles(files)).toEqual({
      all: 4,
      global: 1,
      "tag-match": 1,
      manual: 2,
      disabled: 1,
    });
  });

  it("filters by mode and every search term across name, description, and tags", () => {
    expect(
      filterInstructionFiles(files, "manual", "").map(({ id }) => id),
    ).toEqual(["release", "legacy"]);
    expect(
      filterInstructionFiles(files, "all", "QUALITY").map(({ id }) => id),
    ).toEqual(["standards"]);
    expect(
      filterInstructionFiles(files, "all", "strict typescript").map(
        ({ id }) => id,
      ),
    ).toEqual(["typescript"]);
    expect(filterInstructionFiles(files, "global", "typescript")).toEqual([]);
  });

  it("lists every workspace a file reaches and why", () => {
    const workspaces = [
      workspace("web", ["TypeScript"], ["release"], "Web app"),
      workspace("api", ["nestjs"]),
    ];

    expect(
      instructionWorkspaceReach(
        { id: "standards", global: true, match: null },
        workspaces,
      ).map(({ name, via }) => [name, via]),
    ).toEqual([
      ["Web app", "global"],
      ["api", "global"],
    ]);
    expect(
      instructionWorkspaceReach(
        {
          id: "typescript",
          global: false,
          match: {
            op: "or",
            rules: [
              { op: "tag", tag: "typescript" },
              { op: "tag", tag: "nestjs" },
            ],
          },
        },
        workspaces,
      ).map(({ name, via }) => [name, via]),
    ).toEqual([
      ["Web app", "tag-match"],
      ["api", "tag-match"],
    ]);
    expect(
      instructionWorkspaceReach(
        { id: "release", global: false, match: null },
        workspaces,
      ).map(({ name, via }) => [name, via]),
    ).toEqual([["Web app", "manual"]]);
  });

  it("ignores incomplete tag rules and unsaved files", () => {
    const workspaces = [workspace("web", ["typescript"])];

    expect(
      instructionWorkspaceReach(
        { id: null, global: false, match: { op: "and", rules: [] } },
        workspaces,
      ),
    ).toEqual([]);
    expect(
      instructionWorkspaceReach(
        {
          id: null,
          global: false,
          match: { op: "and", rules: [{ op: "tag", tag: "" }] },
        },
        workspaces,
      ),
    ).toEqual([]);
  });

  it("names workspaces by display name or folder", () => {
    expect(instructionWorkspaceName(workspace("api", []))).toBe("api");
    expect(instructionWorkspaceName(workspace("web", [], [], "Web app"))).toBe(
      "Web app",
    );
  });
});
