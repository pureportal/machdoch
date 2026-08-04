import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  configureInstructionWorkspace,
  createInstructionProfile,
  loadInstructionLibrary,
  resolveInstructionSet,
} from "./index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("automatic instruction selection", () => {
  it("persists tags and rules and rejects manual assignment of tag-matched files", async () => {
    const root = await mkdtemp(join(tmpdir(), "machdoch-auto-instructions-"));
    roots.push(root);
    const workspaceRoot = join(root, "workspace");
    const libraryPath = join(root, "instruction-library.json");
    await mkdir(workspaceRoot);

    const automatic = await createInstructionProfile(
      {
        name: "Nest backend",
        body: "Use Nest backend conventions.",
        tags: ["Backend"],
        match: {
          op: "and",
          rules: [
            { op: "tag", tag: "NestJS" },
            {
              op: "or",
              rules: [
                { op: "tag", tag: "Node.js" },
                { op: "tag", tag: "Deno" },
              ],
            },
          ],
        },
      },
      { path: libraryPath },
    );
    const disabled = await createInstructionProfile(
      {
        name: "Disabled Node",
        body: "This must not reach the prompt.",
        enabled: false,
        match: { op: "tag", tag: "Node.js" },
      },
      { path: libraryPath, expectedRevision: 1 },
    );
    const global = await createInstructionProfile(
      {
        name: "Global",
        body: "Always apply this instruction.",
        enabled: false,
        global: true,
      },
      { path: libraryPath, expectedRevision: 2 },
    );
    await configureInstructionWorkspace(
      workspaceRoot,
      {
        tags: ["NestJS", "Node.js"],
      },
      { path: libraryPath, expectedRevision: 3 },
    );

    const matched = await resolveInstructionSet(
      {
        workspaceRoot,
        providerId: "openai",
        surface: "api",
        model: "gpt-5.4",
      },
      { libraryPath },
    );
    expect(matched.selectedSources).toEqual([
      expect.objectContaining({
        kind: "profile-global",
        profileId: global.profile.id,
      }),
      expect.objectContaining({
        kind: "profile-auto",
        profileId: automatic.profile.id,
      }),
    ]);
    expect(matched.allProfiles).toContainEqual(
      expect.objectContaining({
        profileId: disabled.profile.id,
        status: "skipped",
        reason: "PROFILE_DISABLED",
      }),
    );
    expect(matched.renderedEnvelope).toContain(
      "Always apply this instruction.",
    );
    expect(matched.renderedEnvelope).toContain("Use Nest backend conventions.");
    expect(matched.renderedEnvelope).not.toContain(
      "This must not reach the prompt.",
    );
    expect(
      (await loadInstructionLibrary(libraryPath)).profiles.find(
        (profile) => profile.id === global.profile.id,
      ),
    ).toMatchObject({ enabled: true, global: true });

    await expect(
      configureInstructionWorkspace(
        workspaceRoot,
        {
          tags: ["NestJS", "Node.js"],
          profileIds: [automatic.profile.id],
        },
        { path: libraryPath, expectedRevision: 4 },
      ),
    ).rejects.toMatchObject({ code: "AUTOMATIC_PROFILE_ASSIGNMENT" });

    await configureInstructionWorkspace(
      workspaceRoot,
      {
        displayName: "Backend",
        tags: ["Angular", "Node.js"],
      },
      { path: libraryPath, expectedRevision: 4 },
    );
    const unmatched = await resolveInstructionSet(
      {
        workspaceRoot,
        providerId: "anthropic",
        surface: "api",
        model: "claude-sonnet-4-6",
      },
      { libraryPath },
    );
    expect(unmatched.selectedSources).not.toContainEqual(
      expect.objectContaining({ profileId: automatic.profile.id }),
    );
    expect(unmatched.allProfiles).toContainEqual(
      expect.objectContaining({
        kind: "profile-auto",
        reason: "TAG_RULE_NOT_MATCHED",
      }),
    );

    const persisted = await loadInstructionLibrary(libraryPath);
    expect(persisted.workspaces[0]).toMatchObject({
      displayName: "Backend",
      tags: ["Angular", "Node.js"],
    });
    expect(
      persisted.profiles.find((profile) => profile.id === automatic.profile.id),
    ).toMatchObject({
      enabled: true,
      global: false,
      tags: ["Backend"],
      match: { op: "and" },
    });
  });
});
