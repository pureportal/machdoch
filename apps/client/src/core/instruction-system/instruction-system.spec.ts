import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertInstructionDeliveryReceiptCertain,
  createInstructionDeliveryPlan,
  createInstructionDeliveryReceipt,
  createInstructionProfile,
  deleteInstructionProfile,
  duplicateInstructionProfile,
  explainInstructionResolution,
  exportInstructionLibrary,
  exportInstructionLibraryRecoveryBackup,
  importInstructionLibrary,
  inspectInstructionLibraryRecovery,
  INSTRUCTION_LIBRARY_SCHEMA_VERSION,
  inventoryNativeInstructions,
  loadInstructionLibrary,
  mutateInstructionLibrary,
  parseInstructionLibrary,
  profileNameKey,
  recoverInstructionLibraryFromBackup,
  removeInstructionWorkspaceConfiguration,
  relinkInstructionWorkspace,
  resetCorruptInstructionLibrary,
  configureInstructionWorkspace,
  resolveInstructionSet,
  setWorkspaceInstructionScope,
  sha256,
  updateInstructionProfile,
} from "./index.js";

const roots: string[] = [];

const createTestRoot = async (): Promise<{
  root: string;
  workspace: string;
  libraryPath: string;
}> => {
  const root = await mkdtemp(join(tmpdir(), "machdoch-instruction-system-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  roots.push(root);
  return {
    root,
    workspace,
    libraryPath: join(root, "instruction-library.json"),
  };
};

const resolve = (
  workspaceRoot: string,
  libraryPath: string,
  input: {
    providerId?: "openai" | "codex-cli" | "claude-cli" | "copilot-cli";
    surface?: "api" | "cli";
    model?: string;
    flow?: { id: string; guidance?: string };
  } = {},
) =>
  resolveInstructionSet(
    {
      workspaceRoot,
      providerId: input.providerId ?? "openai",
      surface: input.surface ?? "api",
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.flow === undefined ? {} : { flow: input.flow }),
    },
    {
      libraryPath,
      now: new Date("2026-01-01T00:00:00.000Z"),
    },
  );

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("instruction profiles and assignments", () => {
  it("stores one stable profile body while assigning references to multiple workspaces", async () => {
    const first = await createTestRoot();
    const secondWorkspace = join(first.root, "second-workspace");
    await mkdir(secondWorkspace);
    const created = await createInstructionProfile(
      {
        name: "TypeScript conventions",
        description: "Shared across repositories",
        body: "Use strict TypeScript.",
      },
      { path: first.libraryPath },
    );
    const firstBinding = await configureInstructionWorkspace(
      first.workspace,
      {},
      { path: first.libraryPath, expectedRevision: 1 },
    );
    const secondBinding = await configureInstructionWorkspace(
      secondWorkspace,
      {},
      { path: first.libraryPath, expectedRevision: 2 },
    );
    await setWorkspaceInstructionScope(
      firstBinding.workspace.id,
      ".",
      [created.profile.id],
      { path: first.libraryPath, expectedRevision: 3 },
    );
    await setWorkspaceInstructionScope(
      secondBinding.workspace.id,
      ".",
      [created.profile.id],
      { path: first.libraryPath, expectedRevision: 4 },
    );

    const library = await loadInstructionLibrary(first.libraryPath);
    expect(library.profiles).toEqual([
      expect.objectContaining({
        id: created.profile.id,
        body: "Use strict TypeScript.",
      }),
    ]);
    expect(
      library.workspaces.flatMap((workspace) =>
        workspace.scopes.flatMap((scope) => scope.profiles),
      ),
    ).toEqual([created.profile.id, created.profile.id]);
    await expect(
      stat(join(first.workspace, "AGENTS.md")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      stat(join(secondWorkspace, "AGENTS.md")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("always applies global files without workspace configuration", async () => {
    const fixture = await createTestRoot();
    const created = await createInstructionProfile(
      { name: "Global", body: "Apply everywhere.", global: true },
      { path: fixture.libraryPath },
    );

    const resolution = await resolve(fixture.workspace, fixture.libraryPath);
    expect(resolution.selectedSources).toEqual([
      expect.objectContaining({
        kind: "profile-global",
        profileId: created.profile.id,
        scopePath: ".",
        body: "Apply everywhere.",
      }),
    ]);
    expect(resolution.diagnostics).not.toContainEqual(
      expect.objectContaining({ code: "WORKSPACE_NOT_CONFIGURED" }),
    );
  });

  it("rejects legacy library catalogs and missing required settings", () => {
    expect(() =>
      parseInstructionLibrary({
        schemaVersion: 1,
        revision: 0,
        profiles: [],
        defaults: { profiles: [] },
        workspaces: [],
      }),
    ).toThrowError(/schema version 2/u);

    expect(() =>
      parseInstructionLibrary({
        schemaVersion: INSTRUCTION_LIBRARY_SCHEMA_VERSION,
        revision: 0,
        profiles: [],
        defaults: { profiles: [] },
        workspaces: [],
      }),
    ).toThrowError(/unsupported fields: defaults/u);

    expect(() =>
      parseInstructionLibrary({
        schemaVersion: INSTRUCTION_LIBRARY_SCHEMA_VERSION,
        revision: 0,
        profiles: [
          {
            id: "00000000-0000-4000-8000-000000000001",
            name: "Incomplete",
            body: "Missing tags.",
            enabled: true,
            global: false,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        workspaces: [],
      }),
    ).toThrowError(/tags is required/u);

    expect(() =>
      parseInstructionLibrary({
        schemaVersion: INSTRUCTION_LIBRARY_SCHEMA_VERSION,
        revision: 0,
        profiles: [],
        workspaces: [
          {
            id: "00000000-0000-4000-8000-000000000002",
            root: join(tmpdir(), "machdoch-legacy-identity-hints"),
            identityHints: { repositoryId: "legacy" },
            tags: [],
            scopes: [],
          },
        ],
      }),
    ).toThrowError(/unsupported fields: identityHints/u);
  });

  it("loads schema 1 stores and persists schema 2 on the next mutation", async () => {
    const fixture = await createTestRoot();
    const globalId = "00000000-0000-4000-8000-000000000011";
    const manualId = "00000000-0000-4000-8000-000000000012";
    const workspaceId = "00000000-0000-4000-8000-000000000013";
    await writeFile(
      fixture.libraryPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          revision: 3,
          profiles: [
            {
              id: globalId,
              name: "Global",
              body: "Apply everywhere.",
              global: true,
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
            {
              id: manualId,
              name: "Manual",
              body: "Apply in this workspace.",
              enabled: true,
              global: false,
              tags: [],
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
          defaults: { profiles: [globalId] },
          workspaces: [
            {
              id: workspaceId,
              root: fixture.workspace,
              displayName: " Legacy workspace ",
              identityHints: { repositoryId: "removed-in-schema-2" },
              scopes: [
                { path: ".", profiles: [globalId, manualId] },
                { path: "src", profiles: [manualId] },
                { path: "empty", profiles: [] },
              ],
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const loaded = await loadInstructionLibrary(fixture.libraryPath);
    expect(loaded).toMatchObject({
      schemaVersion: INSTRUCTION_LIBRARY_SCHEMA_VERSION,
      revision: 3,
      profiles: [
        { id: globalId, enabled: true, global: true, tags: [] },
        { id: manualId, enabled: true, global: false, tags: [] },
      ],
      workspaces: [
        {
          id: workspaceId,
          displayName: "Legacy workspace",
          tags: [],
          scopes: [{ path: ".", profiles: [manualId] }],
        },
      ],
    });
    await expect(
      readFile(fixture.libraryPath, "utf8").then(
        (content) => JSON.parse(content) as { schemaVersion: number },
      ),
    ).resolves.toMatchObject({ schemaVersion: 1 });

    await updateInstructionProfile(
      globalId,
      { body: "Apply everywhere after the edit." },
      {
        path: fixture.libraryPath,
        expectedRevision: 3,
      },
    );
    const [persisted, backup] = await Promise.all([
      readFile(fixture.libraryPath, "utf8").then(
        (content) => JSON.parse(content) as Record<string, unknown>,
      ),
      readFile(`${fixture.libraryPath}.bak`, "utf8").then(
        (content) => JSON.parse(content) as Record<string, unknown>,
      ),
    ]);
    expect(persisted).toMatchObject({
      schemaVersion: INSTRUCTION_LIBRARY_SCHEMA_VERSION,
      revision: 4,
    });
    expect(persisted).not.toHaveProperty("defaults");
    expect(backup).toMatchObject({
      schemaVersion: INSTRUCTION_LIBRARY_SCHEMA_VERSION,
      revision: 3,
    });
    expect(backup).not.toHaveProperty("defaults");
  });

  it("rejects instruction text that cannot be transported as exact UTF-8", async () => {
    const fixture = await createTestRoot();

    await expect(
      createInstructionProfile(
        { name: "Invalid Unicode", body: "invalid\ud800body" },
        { path: fixture.libraryPath },
      ),
    ).rejects.toMatchObject({ code: "INSTRUCTION_INVALID_UNICODE" });
  });

  it("rejects persisted automatic or overlapping manual assignments", () => {
    const profile = {
      id: "00000000-0000-4000-8000-000000000001",
      name: "Automatic",
      body: "Matched by tag.",
      enabled: true,
      global: false,
      tags: [],
      match: { op: "tag", tag: "TypeScript" },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    } as const;
    const workspace = {
      id: "00000000-0000-4000-8000-000000000002",
      root: join(tmpdir(), "machdoch-strict-workspace"),
      tags: ["TypeScript"],
      scopes: [{ path: ".", profiles: [profile.id] }],
    };

    expect(() =>
      parseInstructionLibrary({
        schemaVersion: INSTRUCTION_LIBRARY_SCHEMA_VERSION,
        revision: 0,
        profiles: [profile],
        workspaces: [workspace],
      }),
    ).toThrowError(/tag-matched profile/u);

    expect(() =>
      parseInstructionLibrary({
        schemaVersion: INSTRUCTION_LIBRARY_SCHEMA_VERSION,
        revision: 0,
        profiles: [{ ...profile, match: undefined }],
        workspaces: [
          {
            ...workspace,
            scopes: [
              { path: ".", profiles: [profile.id] },
              { path: "apps/web", profiles: [profile.id] },
            ],
          },
        ],
      }),
    ).toThrowError(/overlapping scopes/u);

    expect(() =>
      parseInstructionLibrary({
        schemaVersion: INSTRUCTION_LIBRARY_SCHEMA_VERSION,
        revision: 0,
        profiles: [{ ...profile, match: undefined }],
        workspaces: [{ ...workspace, scopes: [{ path: ".", profiles: [] }] }],
      }),
    ).toThrowError(/Remove the empty scope/u);
  });

  it("blocks redundant new references, stale edits, and deletion of assigned profiles", async () => {
    const fixture = await createTestRoot();
    await mkdir(join(fixture.workspace, "apps", "web"), { recursive: true });
    const created = await createInstructionProfile(
      { name: "Shared", body: "Shared policy." },
      { path: fixture.libraryPath },
    );
    const registered = await configureInstructionWorkspace(
      fixture.workspace,
      {},
      { path: fixture.libraryPath, expectedRevision: 1 },
    );
    await setWorkspaceInstructionScope(
      registered.workspace.id,
      ".",
      [created.profile.id],
      { path: fixture.libraryPath, expectedRevision: 2 },
    );

    await expect(
      setWorkspaceInstructionScope(
        registered.workspace.id,
        "apps/web",
        [created.profile.id],
        { path: fixture.libraryPath, expectedRevision: 3 },
      ),
    ).rejects.toMatchObject({ code: "REDUNDANT_PROFILE_ASSIGNMENT" });
    await expect(
      updateInstructionProfile(
        created.profile.id,
        { body: "Stale overwrite." },
        { path: fixture.libraryPath, expectedRevision: 2 },
      ),
    ).rejects.toMatchObject({ code: "INSTRUCTION_LIBRARY_REVISION_CONFLICT" });
    await expect(
      updateInstructionProfile(
        created.profile.id,
        { global: true },
        { path: fixture.libraryPath, expectedRevision: 3 },
      ),
    ).rejects.toMatchObject({ code: "REDUNDANT_PROFILE_ASSIGNMENT" });
    await expect(
      deleteInstructionProfile(created.profile.id, {
        path: fixture.libraryPath,
        expectedRevision: 3,
      }),
    ).rejects.toMatchObject({ code: "PROFILE_IS_ASSIGNED" });
  });

  it("removes saved workspace configuration only after assigned files are confirmed", async () => {
    const fixture = await createTestRoot();
    const created = await createInstructionProfile(
      { name: "Workspace file", body: "Apply manually." },
      { path: fixture.libraryPath },
    );
    const configured = await configureInstructionWorkspace(
      fixture.workspace,
      { tags: ["TypeScript"], profileIds: [created.profile.id] },
      { path: fixture.libraryPath, expectedRevision: 1 },
    );

    await expect(
      removeInstructionWorkspaceConfiguration(configured.workspace.id, {
        path: fixture.libraryPath,
        expectedRevision: 2,
      }),
    ).rejects.toMatchObject({
      code: "WORKSPACE_ASSIGNMENT_REMOVAL_CONFIRMATION_REQUIRED",
    });

    const removed = await removeInstructionWorkspaceConfiguration(
      configured.workspace.id,
      {
        path: fixture.libraryPath,
        expectedRevision: 2,
        confirmAssignedRemoval: true,
      },
    );
    expect(removed.library.workspaces).toEqual([]);
  });

  it("duplicates only on an explicit duplicate action and exports roots as unbound records", async () => {
    const fixture = await createTestRoot();
    const created = await createInstructionProfile(
      { name: "Original", body: "Intentional body." },
      { path: fixture.libraryPath },
    );
    const duplicate = await duplicateInstructionProfile(
      created.profile.id,
      "Intentional copy",
      { path: fixture.libraryPath, expectedRevision: 1 },
    );
    const registered = await configureInstructionWorkspace(
      fixture.workspace,
      {},
      { path: fixture.libraryPath, expectedRevision: 2 },
    );
    const exported = exportInstructionLibrary(registered.library, true);

    expect(duplicate.profile.id).not.toBe(created.profile.id);
    expect(duplicate.profile.body).toBe(created.profile.body);
    expect(exported.workspaces).toEqual([
      expect.objectContaining({ id: registered.workspace.id, scopes: [] }),
    ]);
    expect(exported.workspaces?.[0]).not.toHaveProperty("root");
  });

  it("duplicates global profiles without duplicating their assignment", async () => {
    const fixture = await createTestRoot();
    const created = await createInstructionProfile(
      { name: "Global", body: "Apply everywhere.", global: true },
      { path: fixture.libraryPath },
    );
    const duplicate = await duplicateInstructionProfile(
      created.profile.id,
      undefined,
      { path: fixture.libraryPath, expectedRevision: 1 },
    );

    expect(duplicate.profile).toMatchObject({
      name: "Global copy",
      global: false,
    });
    expect(
      duplicate.library.profiles.find(
        (profile) => profile.id === created.profile.id,
      ),
    ).toMatchObject({ global: true, enabled: true });
    await expect(loadInstructionLibrary(fixture.libraryPath)).resolves.toEqual(
      duplicate.library,
    );
  });

  it("duplicates tag-matched profiles as unassigned files", async () => {
    const fixture = await createTestRoot();
    const created = await createInstructionProfile(
      {
        name: "Automatic",
        body: "Apply to tagged workspaces.",
        match: { op: "tag", tag: "TypeScript" },
      },
      { path: fixture.libraryPath },
    );
    const duplicate = await duplicateInstructionProfile(
      created.profile.id,
      undefined,
      { path: fixture.libraryPath, expectedRevision: 1 },
    );

    expect(duplicate.profile).toMatchObject({
      name: "Automatic copy",
      global: false,
    });
    expect(duplicate.profile).not.toHaveProperty("match");
  });

  it("generates unique bounded names for repeated default duplicates", async () => {
    const fixture = await createTestRoot();
    const created = await createInstructionProfile(
      { name: "😀".repeat(200), body: "Duplicate safely." },
      { path: fixture.libraryPath },
    );
    const first = await duplicateInstructionProfile(
      created.profile.id,
      undefined,
      { path: fixture.libraryPath, expectedRevision: 1 },
    );
    const second = await duplicateInstructionProfile(
      created.profile.id,
      undefined,
      { path: fixture.libraryPath, expectedRevision: 2 },
    );

    expect(first.profile.name).toBe(`${"😀".repeat(195)} copy`);
    expect(second.profile.name).toBe(`${"😀".repeat(193)} copy 2`);
    expect(Array.from(first.profile.name)).toHaveLength(200);
    expect(Array.from(second.profile.name)).toHaveLength(200);
  });

  it("applies schema length limits by Unicode code point", async () => {
    const fixture = await createTestRoot();
    const acceptedName = "😀".repeat(200);
    const created = await createInstructionProfile(
      { name: acceptedName, body: "Unicode profile name." },
      { path: fixture.libraryPath },
    );
    expect(created.profile.name).toBe(acceptedName);

    await expect(
      createInstructionProfile(
        { name: "😀".repeat(201), body: "Too many code points." },
        { path: fixture.libraryPath, expectedRevision: 1 },
      ),
    ).rejects.toMatchObject({ code: "PROFILE_NAME_TOO_LONG" });
    await expect(
      createInstructionProfile(
        { name: "Invalid\nname", body: "Control character." },
        { path: fixture.libraryPath, expectedRevision: 1 },
      ),
    ).rejects.toMatchObject({ code: "PROFILE_NAME_INVALID" });
  });

  it("removes an optional description when it is cleared", async () => {
    const fixture = await createTestRoot();
    const created = await createInstructionProfile(
      { name: "Described", description: "Optional", body: "Body." },
      { path: fixture.libraryPath },
    );
    const updated = await updateInstructionProfile(
      created.profile.id,
      { description: "  " },
      { path: fixture.libraryPath, expectedRevision: 1 },
    );

    expect(updated.library.profiles[0]).not.toHaveProperty("description");
    await expect(
      updateInstructionProfile(
        created.profile.id,
        { description: "Terminal\u001b[31mcontrol" },
        { path: fixture.libraryPath, expectedRevision: 2 },
      ),
    ).rejects.toMatchObject({ code: "INSTRUCTION_LIBRARY_INVALID" });
  });

  it("normalizes workspace names and rejects empty or control-character names", async () => {
    const fixture = await createTestRoot();
    const configured = await configureInstructionWorkspace(
      fixture.workspace,
      { displayName: "  Ｗorkspace  " },
      { path: fixture.libraryPath },
    );
    expect(configured.workspace.displayName).toBe("Workspace");

    await expect(
      configureInstructionWorkspace(
        fixture.workspace,
        { displayName: "Workspace\nname" },
        { path: fixture.libraryPath, expectedRevision: 1 },
      ),
    ).rejects.toMatchObject({ code: "INSTRUCTION_LIBRARY_INVALID" });
    await expect(
      configureInstructionWorkspace(
        fixture.workspace,
        { displayName: "   " },
        { path: fixture.libraryPath, expectedRevision: 1 },
      ),
    ).rejects.toMatchObject({ code: "INSTRUCTION_LIBRARY_INVALID" });
  });

  it("relinks only when every retained assigned scope exists at the new root", async () => {
    const fixture = await createTestRoot();
    const nextRoot = join(fixture.root, "relocated");
    await Promise.all([
      mkdir(join(fixture.workspace, "apps", "web"), { recursive: true }),
      mkdir(nextRoot, { recursive: true }),
    ]);
    const created = await createInstructionProfile(
      { name: "Scoped", body: "Scoped profile." },
      { path: fixture.libraryPath },
    );
    const registered = await configureInstructionWorkspace(
      fixture.workspace,
      {},
      { path: fixture.libraryPath, expectedRevision: 1 },
    );
    await setWorkspaceInstructionScope(
      registered.workspace.id,
      "apps/web",
      [created.profile.id],
      { path: fixture.libraryPath, expectedRevision: 2 },
    );

    await expect(
      relinkInstructionWorkspace(registered.workspace.id, nextRoot, {
        path: fixture.libraryPath,
        expectedRevision: 3,
      }),
    ).rejects.toMatchObject({ code: "SCOPE_PATH_MISSING" });
    await mkdir(join(nextRoot, "apps", "web"), { recursive: true });
    const relinked = await relinkInstructionWorkspace(
      registered.workspace.id,
      nextRoot,
      {
        path: fixture.libraryPath,
        expectedRevision: 3,
      },
    );
    expect(
      relinked.library.workspaces.find(
        (workspace) => workspace.id === registered.workspace.id,
      ),
    ).toMatchObject({
      id: registered.workspace.id,
      scopes: [
        expect.objectContaining({
          path: "apps/web",
          profiles: [created.profile.id],
        }),
      ],
    });
    await expect(
      realpath(
        relinked.library.workspaces.find(
          (workspace) => workspace.id === registered.workspace.id,
        )!.root,
      ),
    ).resolves.toBe(await realpath(nextRoot));
  });
});

describe("deterministic resolution and composition", () => {
  it("orders global, manual, deeper-scope, and flow instructions exactly", async () => {
    const fixture = await createTestRoot();
    await mkdir(join(fixture.workspace, "apps", "web"), { recursive: true });
    await createInstructionProfile(
      { name: "Global", body: "Global policy.", global: true },
      { path: fixture.libraryPath },
    );
    const root = await createInstructionProfile(
      { name: "Root", body: "Root profile policy." },
      { path: fixture.libraryPath, expectedRevision: 1 },
    );
    const child = await createInstructionProfile(
      { name: "Web", body: "Web profile policy." },
      { path: fixture.libraryPath, expectedRevision: 2 },
    );
    const registered = await configureInstructionWorkspace(
      fixture.workspace,
      {},
      { path: fixture.libraryPath, expectedRevision: 3 },
    );
    await setWorkspaceInstructionScope(
      registered.workspace.id,
      ".",
      [root.profile.id],
      { path: fixture.libraryPath, expectedRevision: 4 },
    );
    await setWorkspaceInstructionScope(
      registered.workspace.id,
      "apps/web",
      [child.profile.id],
      { path: fixture.libraryPath, expectedRevision: 5 },
    );
    const resolution = await resolve(fixture.workspace, fixture.libraryPath, {
      model: "gpt-5.5",
      flow: { id: "build", guidance: "Flow guidance." },
    });
    expect(
      resolution.selectedSources.map((source) => [
        source.kind,
        source.scopePath,
        source.body,
      ]),
    ).toEqual([
      ["profile-global", ".", "Global policy."],
      ["profile-workspace", ".", "Root profile policy."],
      ["profile-workspace", "apps/web", "Web profile policy."],
      ["flow-guidance", ".", "Flow guidance."],
    ]);
    expect(Object.isFrozen(resolution)).toBe(true);
    expect(resolution.renderedEnvelope.indexOf("Global policy.")).toBeLessThan(
      resolution.renderedEnvelope.indexOf("Root profile policy."),
    );
    expect(
      resolution.renderedEnvelope.indexOf("Flow guidance."),
    ).toBeGreaterThan(
      resolution.renderedEnvelope.indexOf("Web profile policy."),
    );
    await expect(
      resolve(fixture.workspace, fixture.libraryPath, {
        model: "gpt-5.5",
        flow: { id: "build", guidance: "Flow guidance." },
      }),
    ).resolves.toEqual(resolution);
  });

  it("deduplicates only consecutive same-scope exact bodies and preserves scoped reassertion", async () => {
    const fixture = await createTestRoot();
    await mkdir(join(fixture.workspace, "apps", "web"), { recursive: true });
    const first = await createInstructionProfile(
      { name: "First", body: "Exact policy." },
      { path: fixture.libraryPath },
    );
    const second = await createInstructionProfile(
      { name: "Second", body: "Exact policy." },
      { path: fixture.libraryPath, expectedRevision: 1 },
    );
    const child = await createInstructionProfile(
      { name: "Child", body: "Exact policy." },
      { path: fixture.libraryPath, expectedRevision: 2 },
    );
    const registered = await configureInstructionWorkspace(
      fixture.workspace,
      {},
      { path: fixture.libraryPath, expectedRevision: 3 },
    );
    await setWorkspaceInstructionScope(
      registered.workspace.id,
      ".",
      [first.profile.id, second.profile.id],
      { path: fixture.libraryPath, expectedRevision: 4 },
    );
    await setWorkspaceInstructionScope(
      registered.workspace.id,
      "apps/web",
      [child.profile.id],
      { path: fixture.libraryPath, expectedRevision: 5 },
    );

    const resolution = await resolve(fixture.workspace, fixture.libraryPath);
    expect(resolution.selectedSources).toHaveLength(3);
    expect(resolution.bodyGroups).toHaveLength(2);
    expect(resolution.bodyGroups[0]?.attributions).toHaveLength(2);
    expect(resolution.bodyGroups[1]?.attributions).toHaveLength(1);
    expect(resolution.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "EXACT_BODY_DEDUPLICATED" }),
        expect.objectContaining({
          code: "EXACT_BODY_RETAINED_FOR_PRECEDENCE",
        }),
      ]),
    );
  });

  it("keeps metadata edits out of the digest, while order and body edits change future runs only", async () => {
    const fixture = await createTestRoot();
    const first = await createInstructionProfile(
      { name: "First", body: "First body." },
      { path: fixture.libraryPath },
    );
    const second = await createInstructionProfile(
      { name: "Second", body: "Second body." },
      { path: fixture.libraryPath, expectedRevision: 1 },
    );
    const registered = await configureInstructionWorkspace(
      fixture.workspace,
      {},
      { path: fixture.libraryPath, expectedRevision: 2 },
    );
    await setWorkspaceInstructionScope(
      registered.workspace.id,
      ".",
      [first.profile.id, second.profile.id],
      { path: fixture.libraryPath, expectedRevision: 3 },
    );
    const frozen = await resolve(fixture.workspace, fixture.libraryPath);

    await updateInstructionProfile(
      first.profile.id,
      { name: "Renamed", description: "Metadata only" },
      { path: fixture.libraryPath, expectedRevision: 4 },
    );
    const metadataOnly = await resolve(fixture.workspace, fixture.libraryPath);
    expect(metadataOnly.canonicalDigest).toBe(frozen.canonicalDigest);

    await setWorkspaceInstructionScope(
      registered.workspace.id,
      ".",
      [second.profile.id, first.profile.id],
      { path: fixture.libraryPath, expectedRevision: 5 },
    );
    const reordered = await resolve(fixture.workspace, fixture.libraryPath);
    expect(reordered.canonicalDigest).not.toBe(frozen.canonicalDigest);

    await updateInstructionProfile(
      first.profile.id,
      { body: "Changed body." },
      { path: fixture.libraryPath, expectedRevision: 6 },
    );
    const changed = await resolve(fixture.workspace, fixture.libraryPath);
    expect(changed.canonicalDigest).not.toBe(reordered.canonicalDigest);
    expect(frozen.selectedSources[0]?.body).toBe("First body.");
  });

  it("lists exact path-effective ancestors without task-dependent selection", async () => {
    const fixture = await createTestRoot();
    await Promise.all([
      mkdir(join(fixture.workspace, "apps", "web"), { recursive: true }),
      mkdir(join(fixture.workspace, "apps", "worker"), { recursive: true }),
    ]);
    const web = await createInstructionProfile(
      { name: "Web", body: "Web policy." },
      { path: fixture.libraryPath },
    );
    const worker = await createInstructionProfile(
      { name: "Worker", body: "Worker policy." },
      { path: fixture.libraryPath, expectedRevision: 1 },
    );
    const registered = await configureInstructionWorkspace(
      fixture.workspace,
      {},
      { path: fixture.libraryPath, expectedRevision: 2 },
    );
    await setWorkspaceInstructionScope(
      registered.workspace.id,
      "apps/web",
      [web.profile.id],
      { path: fixture.libraryPath, expectedRevision: 3 },
    );
    await setWorkspaceInstructionScope(
      registered.workspace.id,
      "apps/worker",
      [worker.profile.id],
      { path: fixture.libraryPath, expectedRevision: 4 },
    );

    const resolution = await resolve(fixture.workspace, fixture.libraryPath);
    const explanation = explainInstructionResolution(resolution, {
      previewPath: "apps/web/src",
    });
    expect(resolution.selectedSources.map((source) => source.name)).toEqual([
      "Web",
      "Worker",
    ]);
    expect(explanation.pathPreview?.effectiveOrder).toEqual([
      resolution.selectedSources.find((source) => source.name === "Web")?.id,
    ]);
  });

  it("blocks a configured scope that disappeared instead of promoting it to the root", async () => {
    const fixture = await createTestRoot();
    const scopeRoot = join(fixture.workspace, "apps", "web");
    await mkdir(scopeRoot, { recursive: true });
    const profile = await createInstructionProfile(
      { name: "Web", body: "Web-only policy." },
      { path: fixture.libraryPath },
    );
    const registered = await configureInstructionWorkspace(
      fixture.workspace,
      {},
      { path: fixture.libraryPath, expectedRevision: 1 },
    );
    await setWorkspaceInstructionScope(
      registered.workspace.id,
      "apps/web",
      [profile.profile.id],
      { path: fixture.libraryPath, expectedRevision: 2 },
    );
    await rm(scopeRoot, { recursive: true });

    await expect(
      resolve(fixture.workspace, fixture.libraryPath),
    ).rejects.toMatchObject({
      code: "SCOPE_PATH_MISSING",
      diagnostics: [
        expect.objectContaining({
          code: "SCOPE_PATH_MISSING",
          relativePath: "apps/web",
        }),
      ],
    });
  });

  it("blocks a configured scope whose parent was replaced by a directory link", async () => {
    const fixture = await createTestRoot();
    const scopeParent = join(fixture.workspace, "apps");
    await mkdir(join(scopeParent, "web"), { recursive: true });
    const profile = await createInstructionProfile(
      { name: "Linked scope", body: "Web-only policy." },
      { path: fixture.libraryPath },
    );
    const registered = await configureInstructionWorkspace(
      fixture.workspace,
      {},
      { path: fixture.libraryPath, expectedRevision: 1 },
    );
    await setWorkspaceInstructionScope(
      registered.workspace.id,
      "apps/web",
      [profile.profile.id],
      { path: fixture.libraryPath, expectedRevision: 2 },
    );

    const linkedTarget = join(fixture.workspace, "linked-apps");
    await rm(scopeParent, { recursive: true });
    await mkdir(join(linkedTarget, "web"), { recursive: true });
    try {
      await symlink(
        linkedTarget,
        scopeParent,
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch {
      // Link creation can be unavailable on locked-down Windows hosts.
      return;
    }

    await expect(
      resolve(fixture.workspace, fixture.libraryPath),
    ).rejects.toMatchObject({ code: "ASSIGNED_SCOPE_INVALID" });
  });

  it("blocks aggregate envelope overflow with complete contributor accounting and no truncation", async () => {
    const fixture = await createTestRoot();
    const profile = await createInstructionProfile(
      {
        name: "Near source limit",
        body: "x".repeat(131_000),
        global: true,
      },
      { path: fixture.libraryPath },
    );

    await expect(
      resolve(fixture.workspace, fixture.libraryPath),
    ).rejects.toMatchObject({
      code: "INSTRUCTION_ENVELOPE_TOO_LARGE",
      diagnostics: [
        expect.objectContaining({
          code: "INSTRUCTION_ENVELOPE_TOO_LARGE",
          details: expect.objectContaining({
            truncation: "none",
            contributors: [
              expect.objectContaining({
                sourceId: `profile-global:${profile.profile.id}`,
                byteLength: 131_000,
              }),
            ],
          }),
        }),
      ],
    });
  });
});

describe("library recovery and import conflicts", () => {
  it("bounds an oversized auxiliary audit log without failing a committed mutation", async () => {
    const fixture = await createTestRoot();
    const auditPath = join(fixture.root, "instruction-library.audit.jsonl");
    await writeFile(auditPath, `${"x".repeat(2 * 1024 * 1024 + 32)}\n`);

    const created = await createInstructionProfile(
      { name: "Audited", body: "Audited body." },
      { path: fixture.libraryPath },
    );
    expect(created.library.revision).toBe(1);
    const audit = await readFile(auditPath, "utf8");
    expect(Buffer.byteLength(audit, "utf8")).toBeLessThan(16 * 1024);
    expect(() => JSON.parse(audit.trim())).not.toThrow();
  });

  it("refuses to wrap a maximum-safe library revision", async () => {
    const fixture = await createTestRoot();
    const library = await loadInstructionLibrary(fixture.libraryPath);
    await writeFile(
      fixture.libraryPath,
      `${JSON.stringify({
        ...library,
        revision: Number.MAX_SAFE_INTEGER,
      })}\n`,
      "utf8",
    );

    await expect(
      createInstructionProfile(
        { name: "Overflow", body: "Must not be written." },
        { path: fixture.libraryPath },
      ),
    ).rejects.toMatchObject({
      code: "INSTRUCTION_LIBRARY_REVISION_EXHAUSTED",
    });
    await expect(
      loadInstructionLibrary(fixture.libraryPath),
    ).resolves.toMatchObject({
      revision: Number.MAX_SAFE_INTEGER,
      profiles: [],
    });
  });

  it("rejects an out-of-band store edit before the atomic commit", async () => {
    const fixture = await createTestRoot();
    const created = await createInstructionProfile(
      { name: "Concurrent", body: "Original body." },
      { path: fixture.libraryPath },
    );
    const external = {
      ...created.library,
      profiles: created.library.profiles.map((profile) => ({
        ...profile,
        description: "External editor won.",
      })),
    };

    await expect(
      mutateInstructionLibrary(
        async (library) => {
          await writeFile(
            fixture.libraryPath,
            `${JSON.stringify(external, null, 2)}\n`,
            "utf8",
          );
          return {
            ...library,
            profiles: library.profiles.map((profile) => ({
              ...profile,
              description: "Pending mutation.",
            })),
          };
        },
        {
          path: fixture.libraryPath,
          expectedRevision: 1,
        },
      ),
    ).rejects.toMatchObject({
      code: "INSTRUCTION_LIBRARY_CONCURRENT_WRITE",
    });
    await expect(
      loadInstructionLibrary(fixture.libraryPath),
    ).resolves.toMatchObject({
      revision: 1,
      profiles: [
        expect.objectContaining({ description: "External editor won." }),
      ],
    });
  });

  it("blocks a corrupt primary and performs only digest-reviewed backup recovery", async () => {
    const fixture = await createTestRoot();
    const created = await createInstructionProfile(
      { name: "Recoverable", body: "Original body." },
      { path: fixture.libraryPath },
    );
    await updateInstructionProfile(
      created.profile.id,
      { body: "New body." },
      { path: fixture.libraryPath, expectedRevision: 1 },
    );
    await writeFile(fixture.libraryPath, "{ corrupt", "utf8");

    const status = await inspectInstructionLibraryRecovery(fixture.libraryPath);
    expect(status).toMatchObject({
      primaryValid: false,
      backupValid: true,
      backupRevision: 1,
    });
    await expect(
      loadInstructionLibrary(fixture.libraryPath),
    ).rejects.toMatchObject({
      code: "INSTRUCTION_LIBRARY_INVALID_JSON",
      diagnostics: [
        expect.objectContaining({
          code: "INSTRUCTION_LIBRARY_RECOVERY_STATUS",
          details: expect.objectContaining({ backupValid: true }),
        }),
      ],
    });
    await expect(
      recoverInstructionLibraryFromBackup("0".repeat(64), fixture.libraryPath),
    ).rejects.toMatchObject({
      code: "INSTRUCTION_LIBRARY_RECOVERY_CONFLICT",
    });
    await expect(
      exportInstructionLibraryRecoveryBackup(
        status.backupDigest!,
        fixture.libraryPath,
      ),
    ).resolves.toMatchObject({
      profiles: [
        expect.objectContaining({
          id: created.profile.id,
          body: "Original body.",
        }),
      ],
    });

    const recovered = await recoverInstructionLibraryFromBackup(
      status.backupDigest!,
      fixture.libraryPath,
    );
    expect(recovered).toMatchObject({
      revision: 1,
      profiles: [
        expect.objectContaining({
          id: created.profile.id,
          body: "Original body.",
        }),
      ],
    });
    expect(
      (await readdir(fixture.root)).some((name) =>
        name.startsWith("instruction-library.json.corrupt-"),
      ),
    ).toBe(true);
  });

  it("does not silently replace a missing primary when a validated backup exists", async () => {
    const fixture = await createTestRoot();
    const created = await createInstructionProfile(
      { name: "Deletion recovery", body: "Recover this version." },
      { path: fixture.libraryPath },
    );
    await updateInstructionProfile(
      created.profile.id,
      { body: "Latest version." },
      { path: fixture.libraryPath, expectedRevision: 1 },
    );
    await rm(fixture.libraryPath);

    const status = await inspectInstructionLibraryRecovery(fixture.libraryPath);
    expect(status).toMatchObject({
      primaryValid: false,
      backupValid: true,
      backupRevision: 1,
      errorCode: "INSTRUCTION_LIBRARY_MISSING_WITH_BACKUP",
    });
    await expect(
      loadInstructionLibrary(fixture.libraryPath),
    ).rejects.toMatchObject({
      code: "INSTRUCTION_LIBRARY_MISSING_WITH_BACKUP",
    });

    const recovered = await recoverInstructionLibraryFromBackup(
      status.backupDigest!,
      fixture.libraryPath,
    );
    expect(recovered).toMatchObject({
      revision: 1,
      profiles: [
        expect.objectContaining({
          id: created.profile.id,
          body: "Recover this version.",
        }),
      ],
    });
    expect(
      (await readdir(fixture.root)).some((name) =>
        name.startsWith("instruction-library.json.corrupt-"),
      ),
    ).toBe(false);
  });

  it("can explicitly reset a missing primary with an invalid bounded backup", async () => {
    const fixture = await createTestRoot();
    const invalidBackup = "{ invalid recovery backup";
    await writeFile(`${fixture.libraryPath}.bak`, invalidBackup, "utf8");

    const status = await inspectInstructionLibraryRecovery(fixture.libraryPath);
    expect(status).toMatchObject({
      primaryValid: false,
      backupValid: false,
      resetSource: "backup",
      resetDigest: sha256(invalidBackup),
      errorCode: "INSTRUCTION_LIBRARY_MISSING_WITH_BACKUP",
    });
    await expect(
      resetCorruptInstructionLibrary("0".repeat(64), fixture.libraryPath),
    ).rejects.toMatchObject({
      code: "INSTRUCTION_LIBRARY_RECOVERY_CONFLICT",
    });

    const reset = await resetCorruptInstructionLibrary(
      status.resetDigest!,
      fixture.libraryPath,
    );
    await expect(readFile(reset.corruptCopy, "utf8")).resolves.toBe(
      invalidBackup,
    );
    await expect(loadInstructionLibrary(fixture.libraryPath)).resolves.toEqual(
      reset.library,
    );
  });

  it("resets only the reviewed corrupt digest and preserves the corrupt bytes", async () => {
    const fixture = await createTestRoot();
    await createInstructionProfile(
      { name: "Reset source", body: "Body to preserve for recovery." },
      { path: fixture.libraryPath },
    );
    const corruptBytes = "{ definitely corrupt";
    await writeFile(fixture.libraryPath, corruptBytes, "utf8");
    const status = await inspectInstructionLibraryRecovery(fixture.libraryPath);

    await expect(
      resetCorruptInstructionLibrary("0".repeat(64), fixture.libraryPath),
    ).rejects.toMatchObject({
      code: "INSTRUCTION_LIBRARY_RECOVERY_CONFLICT",
    });
    const reset = await resetCorruptInstructionLibrary(
      status.primaryDigest!,
      fixture.libraryPath,
    );
    expect(reset.library).toMatchObject({
      revision: 0,
      profiles: [],
      workspaces: [],
    });
    await expect(readFile(reset.corruptCopy, "utf8")).resolves.toBe(
      corruptBytes,
    );
    await expect(loadInstructionLibrary(fixture.libraryPath)).resolves.toEqual(
      reset.library,
    );
  });

  it("requires an explicit same-id conflict choice and returns imported bindings unbound", async () => {
    const fixture = await createTestRoot();
    const created = await createInstructionProfile(
      { name: "Portable", body: "Exported body." },
      { path: fixture.libraryPath },
    );
    const registered = await configureInstructionWorkspace(
      fixture.workspace,
      { displayName: "Portable workspace" },
      { path: fixture.libraryPath, expectedRevision: 1 },
    );
    const assigned = await setWorkspaceInstructionScope(
      registered.workspace.id,
      ".",
      [created.profile.id],
      { path: fixture.libraryPath, expectedRevision: 2 },
    );
    const exported = exportInstructionLibrary(assigned.library, true);
    await updateInstructionProfile(
      created.profile.id,
      { body: "Receiver body." },
      { path: fixture.libraryPath, expectedRevision: 3 },
    );

    await expect(
      importInstructionLibrary(exported, {
        path: fixture.libraryPath,
        expectedRevision: 4,
        includeWorkspaceBindings: true,
      }),
    ).rejects.toMatchObject({ code: "INSTRUCTION_IMPORT_ID_CONFLICT" });
    await expect(
      loadInstructionLibrary(fixture.libraryPath),
    ).resolves.toMatchObject({
      revision: 4,
      profiles: [
        expect.objectContaining({
          id: created.profile.id,
          body: "Receiver body.",
        }),
      ],
    });

    const imported = await importInstructionLibrary(exported, {
      path: fixture.libraryPath,
      expectedRevision: 4,
      includeWorkspaceBindings: true,
      choices: {
        conflicts: { [created.profile.id]: "keep-existing" },
      },
    });
    expect(imported.unboundWorkspaces).toEqual([
      expect.objectContaining({
        id: registered.workspace.id,
        displayName: "Portable workspace",
        scopes: [
          expect.objectContaining({
            path: ".",
            profiles: [created.profile.id],
          }),
        ],
      }),
    ]);
    expect(imported.unboundWorkspaces[0]).not.toHaveProperty("root");
    expect(imported.library.workspaces).toHaveLength(1);
    expect(imported.library.profiles[0]?.body).toBe("Receiver body.");
  });

  it("requires a conflict choice when same-id content matches but settings differ", async () => {
    const fixture = await createTestRoot();
    const created = await createInstructionProfile(
      { name: "Portable", body: "Same body.", tags: ["exported"] },
      { path: fixture.libraryPath },
    );
    const exported = exportInstructionLibrary(created.library);
    await updateInstructionProfile(
      created.profile.id,
      { tags: ["receiver"] },
      { path: fixture.libraryPath, expectedRevision: 1 },
    );

    await expect(
      importInstructionLibrary(exported, {
        path: fixture.libraryPath,
        expectedRevision: 2,
      }),
    ).rejects.toMatchObject({ code: "INSTRUCTION_IMPORT_ID_CONFLICT" });

    const replaced = await importInstructionLibrary(exported, {
      path: fixture.libraryPath,
      expectedRevision: 2,
      choices: { conflicts: { [created.profile.id]: "replace-existing" } },
    });
    expect(replaced.library.profiles[0]?.tags).toEqual(["exported"]);
  });

  it("remaps unbound workspace assignments when a conflicting profile is duplicated", async () => {
    const fixture = await createTestRoot();
    const created = await createInstructionProfile(
      { name: "Portable", body: "Exported body." },
      { path: fixture.libraryPath },
    );
    const registered = await configureInstructionWorkspace(
      fixture.workspace,
      {},
      { path: fixture.libraryPath, expectedRevision: 1 },
    );
    const assigned = await setWorkspaceInstructionScope(
      registered.workspace.id,
      ".",
      [created.profile.id],
      { path: fixture.libraryPath, expectedRevision: 2 },
    );
    const exported = exportInstructionLibrary(assigned.library, true);
    await updateInstructionProfile(
      created.profile.id,
      { body: "Receiver body." },
      { path: fixture.libraryPath, expectedRevision: 3 },
    );

    const imported = await importInstructionLibrary(exported, {
      path: fixture.libraryPath,
      expectedRevision: 4,
      includeWorkspaceBindings: true,
      choices: {
        conflicts: { [created.profile.id]: "duplicate-imported" },
        renamedProfiles: { [created.profile.id]: "Portable imported" },
      },
    });
    const duplicated = imported.library.profiles.find(
      (profile) => profile.name === "Portable imported",
    );
    expect(duplicated?.id).toBeDefined();
    expect(duplicated?.id).not.toBe(created.profile.id);
    expect(imported.unboundWorkspaces[0]?.scopes[0]?.profiles).toEqual([
      duplicated?.id,
    ]);
  });

  it("rejects malformed, unknown, and unused transfer conflict choices", async () => {
    const fixture = await createTestRoot();
    const created = await createInstructionProfile(
      { name: "Portable", body: "Exported body." },
      { path: fixture.libraryPath },
    );
    const exported = exportInstructionLibrary(created.library);

    await expect(
      importInstructionLibrary(exported, {
        path: fixture.libraryPath,
        choices: {
          conflicts: {
            ["00000000-0000-4000-8000-000000000099"]: "keep-existing",
          },
        },
      }),
    ).rejects.toMatchObject({ code: "INSTRUCTION_IMPORT_UNKNOWN_CHOICE" });
    await expect(
      importInstructionLibrary(exported, {
        path: fixture.libraryPath,
        choices: {
          conflicts: { [created.profile.id]: "keep-existing" },
        },
      }),
    ).rejects.toMatchObject({ code: "INSTRUCTION_IMPORT_UNUSED_CHOICE" });
    await expect(
      importInstructionLibrary(exported, {
        path: fixture.libraryPath,
        choices: { defaults: "merge" } as never,
      }),
    ).rejects.toMatchObject({ code: "INSTRUCTION_IMPORT_INVALID_CHOICE" });
    await expect(
      importInstructionLibrary(
        { ...exported, exportedAt: "0" },
        { path: fixture.libraryPath },
      ),
    ).rejects.toMatchObject({ code: "INSTRUCTION_IMPORT_INVALID" });
  });
});

describe("native inventory, delivery, and schemas", () => {
  it("uses locale-independent Unicode caseless profile identity", () => {
    expect(profileNameKey("Straße")).toBe(profileNameKey("STRASSE"));
    expect(profileNameKey("ς")).toBe(profileNameKey("σ"));
    expect(profileNameKey("ﬃ")).toBe(profileNameKey("FFI"));
  });

  it("inventories native files without selecting them and surfaces linked rule roots as unreadable", async () => {
    const fixture = await createTestRoot();
    await Promise.all([
      mkdir(join(fixture.workspace, ".github", "agents"), {
        recursive: true,
      }),
      mkdir(join(fixture.workspace, "packages", "web"), {
        recursive: true,
      }),
      mkdir(
        join(fixture.workspace, "packages", "web", ".github", "instructions"),
        { recursive: true },
      ),
    ]);
    await Promise.all([
      writeFile(join(fixture.workspace, "CLAUDE.md"), "Claude memory.\n"),
      writeFile(
        join(fixture.workspace, ".github", "copilot-instructions.md"),
        "Copilot memory.\n",
      ),
      writeFile(
        join(fixture.workspace, ".github", "agents", "reviewer.md"),
        "Custom agent memory.\n",
      ),
      writeFile(
        join(fixture.workspace, "packages", "web", "CLAUDE.md"),
        "Nested Claude memory.\n",
      ),
      writeFile(
        join(
          fixture.workspace,
          "packages",
          "web",
          ".github",
          "copilot-instructions.md",
        ),
        "Nested Copilot repository memory.\n",
      ),
      writeFile(
        join(
          fixture.workspace,
          "packages",
          "web",
          ".github",
          "instructions",
          "typescript.instructions.md",
        ),
        '---\napplyTo: "**/*.ts"\n---\nNested TypeScript policy.\n',
      ),
    ]);
    const linkedRules = join(fixture.root, "rules");
    await mkdir(linkedRules);
    let linked = false;
    try {
      await mkdir(join(fixture.workspace, ".claude"), { recursive: true });
      await symlink(
        linkedRules,
        join(fixture.workspace, ".claude", "rules"),
        process.platform === "win32" ? "junction" : "dir",
      );
      linked = true;
    } catch {
      // Link creation can be unavailable on locked-down Windows hosts.
    }

    const apiInventory = await inventoryNativeInstructions({
      workspaceRoot: fixture.workspace,
      providerId: "openai",
      surface: "api",
    });
    expect(apiInventory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          convention: "claude-project-memory",
          status: "inactive",
        }),
        expect.objectContaining({
          convention: "copilot-repository-instructions",
          status: "inactive",
        }),
      ]),
    );
    if (linked) {
      expect(apiInventory).toContainEqual(
        expect.objectContaining({
          convention: "claude-project-rules",
          status: "inactive",
        }),
      );
    }

    const copilotInventory = await inventoryNativeInstructions({
      workspaceRoot: fixture.workspace,
      providerId: "copilot-cli",
      surface: "cli",
    });
    expect(copilotInventory).toContainEqual(
      expect.objectContaining({
        convention: "copilot-repository-instructions",
        status: "suppressed",
      }),
    );
    expect(copilotInventory).toContainEqual(
      expect.objectContaining({
        path: "packages/web/CLAUDE.md",
        convention: "claude-project-memory",
        status: "suppressed",
      }),
    );
    expect(copilotInventory).toContainEqual(
      expect.objectContaining({
        path: "packages/web/.github/copilot-instructions.md",
        convention: "copilot-repository-instructions",
        status: "suppressed",
      }),
    );
    expect(copilotInventory).toContainEqual(
      expect.objectContaining({
        path: "packages/web/.github/instructions/typescript.instructions.md",
        convention: "copilot-path-instructions",
        status: "suppressed",
      }),
    );
    expect(copilotInventory).toContainEqual(
      expect.objectContaining({
        path: ".github/agents/reviewer.md",
        convention: "copilot-custom-agents",
        status: "native-extra",
      }),
    );
    expect(
      copilotInventory.every((entry) => !entry.path.includes(fixture.root)),
    ).toBe(true);
  });

  it("inventories provider ancestors and subagent definitions outside a nested workspace", async () => {
    const fixture = await createTestRoot();
    const repository = join(fixture.root, "repository");
    const nestedWorkspace = join(repository, "packages", "web");
    await Promise.all([
      mkdir(join(repository, ".git"), { recursive: true }),
      mkdir(join(repository, ".github", "copilot"), { recursive: true }),
      mkdir(join(repository, ".codex"), { recursive: true }),
      mkdir(join(repository, ".claude", "agents"), { recursive: true }),
      mkdir(nestedWorkspace, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(repository, "AGENTS.md"), "Repository agent policy.\n"),
      writeFile(
        join(repository, ".codex", "config.toml"),
        'developer_instructions = "Repository override."\n',
      ),
      writeFile(join(repository, "CLAUDE.md"), "Repository Claude policy.\n"),
      writeFile(
        join(repository, ".github", "copilot-instructions.md"),
        "Repository Copilot policy.\n",
      ),
      writeFile(
        join(repository, ".claude", "agents", "reviewer.md"),
        "Repository review subagent.\n",
      ),
      writeFile(
        join(repository, ".claude", "settings.json"),
        '{"enabledPlugins":{"example/plugin":true},"claudeMdExcludes":[]}\n',
      ),
      writeFile(
        join(repository, ".github", "copilot", "settings.json"),
        '{"enabledPlugins":{"example/plugin":true}}\n',
      ),
    ]);

    const codexBefore = await resolve(nestedWorkspace, fixture.libraryPath, {
      providerId: "codex-cli",
      surface: "cli",
    });
    expect(codexBefore.nativeInventory).toContainEqual(
      expect.objectContaining({
        convention: "codex-project-agents",
        status: "suppressed",
      }),
    );
    expect(codexBefore.nativeInventory).toContainEqual(
      expect.objectContaining({
        convention: "codex-project-configuration",
        status: "suppressed",
      }),
    );

    const claudeInventory = await inventoryNativeInstructions({
      workspaceRoot: nestedWorkspace,
      providerId: "claude-cli",
      surface: "cli",
    });
    expect(claudeInventory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          convention: "claude-project-memory",
          status: "native-extra",
          digest: sha256("Repository Claude policy.\n"),
        }),
        expect.objectContaining({
          convention: "claude-custom-agents",
          status: "native-extra",
          digest: sha256("Repository review subagent.\n"),
        }),
        expect.objectContaining({
          convention: "claude-project-settings",
          status: "native-extra",
        }),
      ]),
    );

    const copilotInventory = await inventoryNativeInstructions({
      workspaceRoot: nestedWorkspace,
      providerId: "copilot-cli",
      surface: "cli",
    });
    expect(copilotInventory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          convention: "claude-project-memory",
          status: "suppressed",
        }),
        expect.objectContaining({
          convention: "copilot-repository-instructions",
          status: "suppressed",
        }),
        expect.objectContaining({
          convention: "claude-custom-agents",
          status: "native-extra",
          digest: sha256("Repository review subagent.\n"),
        }),
        expect.objectContaining({
          convention: "copilot-repository-settings",
          status: "native-extra",
        }),
      ]),
    );

    await writeFile(
      join(repository, "AGENTS.md"),
      "Changed repository agent policy.\n",
    );
    const codexAfter = await resolve(nestedWorkspace, fixture.libraryPath, {
      providerId: "codex-cli",
      surface: "cli",
    });
    expect(codexAfter.canonicalDigest).toBe(codexBefore.canonicalDigest);
    expect(codexAfter.environmentDigest).not.toBe(
      codexBefore.environmentDigest,
    );

    await writeFile(join(repository, "AGENTS.md"), "Relocated policy.\n");
    const beforeRelocation = await resolve(
      nestedWorkspace,
      fixture.libraryPath,
      {
        providerId: "codex-cli",
        surface: "cli",
      },
    );
    await rename(
      join(repository, "AGENTS.md"),
      join(nestedWorkspace, "AGENTS.md"),
    );
    const afterRelocation = await resolve(
      nestedWorkspace,
      fixture.libraryPath,
      {
        providerId: "codex-cli",
        surface: "cli",
      },
    );
    expect(afterRelocation.canonicalDigest).toBe(
      beforeRelocation.canonicalDigest,
    );
    expect(afterRelocation.environmentDigest).not.toBe(
      beforeRelocation.environmentDigest,
    );
  });

  it("grades adapters without blocking and forbids replay after a digest mismatch", async () => {
    const fixture = await createTestRoot();
    const apiResolution = await resolve(
      fixture.workspace,
      fixture.libraryPath,
      {
        model: "gpt-5.5",
      },
    );
    const fullPlan = createInstructionDeliveryPlan(apiResolution);
    expect(fullPlan.grade).toBe("full");
    expect(fullPlan.dimensions).toHaveLength(12);

    const cliResolution = await resolve(
      fixture.workspace,
      fixture.libraryPath,
      {
        providerId: "copilot-cli",
        surface: "cli",
        model: "gpt-5.5",
      },
    );
    const compatiblePlan = createInstructionDeliveryPlan(cliResolution);
    expect(compatiblePlan.grade).toBe("compatible");
    expect(compatiblePlan.blockingReasons).toEqual([]);

    const receipt = createInstructionDeliveryReceipt({
      plan: fullPlan,
      phase: "initial",
      observedCanonicalDigest: "f".repeat(64),
      assembledRequestDigest: "e".repeat(64),
      deliveredBytes: apiResolution.budget.envelopeBytes,
      evidence: [
        {
          kind: "request-field",
          detail: "instructions",
          digest: "f".repeat(64),
        },
      ],
      now: new Date("2026-01-01T00:00:00.000Z"),
    });
    expect(receipt).toMatchObject({
      status: "indeterminate",
      bodyStored: false,
    });
    expect(() => assertInstructionDeliveryReceiptCertain(receipt)).toThrowError(
      /Do not automatically repeat/u,
    );
    expect(() =>
      createInstructionDeliveryReceipt({
        plan: fullPlan,
        phase: "initial",
        assembledRequestDigest: "d".repeat(64),
        evidence: [],
      }),
    ).toThrowError(/evidence/u);
    expect(() =>
      createInstructionDeliveryReceipt({
        plan: fullPlan,
        phase: "initial",
        assembledRequestDigest: "not-a-digest",
        deliveredBytes: -1,
        evidence: [
          {
            kind: "request-field",
            detail: "instructions",
          },
        ],
      }),
    ).toThrowError(/metadata is malformed/u);

    const unreadableNativeResolution = structuredClone(cliResolution);
    unreadableNativeResolution.providerId = "claude-cli";
    unreadableNativeResolution.nativeInventory = [
      {
        path: "CLAUDE.md",
        location: "workspace",
        convention: "claude-project-memory",
        status: "unreadable",
      },
    ];
    const unreadableNativePlan = createInstructionDeliveryPlan(
      unreadableNativeResolution,
    );
    expect(unreadableNativePlan.grade).toBe("unsupported");
    expect(unreadableNativePlan.blockingReasons.join(" ")).toContain(
      "could not be inventoried",
    );

    const unavailableNativeResolution = structuredClone(cliResolution);
    unavailableNativeResolution.providerId = "claude-cli";
    unavailableNativeResolution.nativeInventory = [];
    unavailableNativeResolution.diagnostics = [
      ...unavailableNativeResolution.diagnostics,
      {
        code: "NATIVE_INSTRUCTION_INVENTORY_UNAVAILABLE",
        severity: "warning",
        message: "Native inventory failed.",
      },
    ];
    const unavailableNativePlan = createInstructionDeliveryPlan(
      unavailableNativeResolution,
    );
    expect(unavailableNativePlan.grade).toBe("unsupported");
    expect(unavailableNativePlan.blockingReasons.join(" ")).toContain(
      "inventory failed",
    );
  });

  it("emits schema-valid closed explanations, plans, and receipts without bodies by default", async () => {
    const fixture = await createTestRoot();
    const created = await createInstructionProfile(
      {
        name: "Schema profile",
        body: "Sensitive profile body.",
        global: true,
      },
      { path: fixture.libraryPath },
    );
    await createInstructionProfile(
      {
        name: "Automatic schema profile",
        body: "Automatically selected body.",
        match: { op: "tag", tag: "TypeScript" },
      },
      { path: fixture.libraryPath, expectedRevision: 1 },
    );
    await configureInstructionWorkspace(
      fixture.workspace,
      { tags: ["TypeScript"] },
      { path: fixture.libraryPath, expectedRevision: 2 },
    );
    const resolution = await resolve(fixture.workspace, fixture.libraryPath, {
      model: "gpt-5.5",
    });
    expect(resolution.selectedSources).toContainEqual(
      expect.objectContaining({ kind: "profile-auto" }),
    );
    const explanation = explainInstructionResolution(resolution);
    const plan = createInstructionDeliveryPlan(resolution);
    const receipt = createInstructionDeliveryReceipt({
      plan,
      phase: "initial",
      assembledRequestDigest: sha256("schema-validation-request"),
      deliveredBytes: resolution.budget.envelopeBytes,
      evidence: [
        {
          kind: "request-field",
          detail: "instructions",
          digest: resolution.canonicalDigest,
        },
      ],
    });
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    addFormats.default(ajv);
    const schemaRoot = join(process.cwd(), "src", "shared");
    const [resolutionSchema, deliverySchema, librarySchema, exportSchema] =
      await Promise.all([
        readFile(
          join(schemaRoot, "instruction-resolution.schema.json"),
          "utf8",
        ),
        readFile(join(schemaRoot, "instruction-delivery.schema.json"), "utf8"),
        readFile(join(schemaRoot, "instruction-library.schema.json"), "utf8"),
        readFile(
          join(schemaRoot, "instruction-library-export.schema.json"),
          "utf8",
        ),
      ]);
    const validateResolution = ajv.compile(JSON.parse(resolutionSchema));
    const validateDelivery = ajv.compile(JSON.parse(deliverySchema));
    const validateLibrary = ajv.compile(JSON.parse(librarySchema));
    const validateExport = ajv.compile(JSON.parse(exportSchema));

    expect(
      validateResolution(explanation),
      JSON.stringify(validateResolution.errors ?? []),
    ).toBe(true);
    expect(
      validateDelivery(plan),
      JSON.stringify(validateDelivery.errors ?? []),
    ).toBe(true);
    expect(
      validateDelivery(receipt),
      JSON.stringify(validateDelivery.errors ?? []),
    ).toBe(true);
    expect(
      validateDelivery({
        ...plan,
        dimensions: plan.dimensions.map((dimension, index) =>
          index === plan.dimensions.length - 1
            ? { ...dimension, name: "content" }
            : dimension,
        ),
      }),
    ).toBe(false);
    expect(
      validateDelivery({
        ...receipt,
        error: "Delivered receipts cannot contain an error.",
      }),
    ).toBe(false);
    const indeterminateWithoutError: Record<string, unknown> = {
      ...receipt,
      status: "indeterminate",
    };
    delete indeterminateWithoutError.error;
    expect(validateDelivery(indeterminateWithoutError)).toBe(false);
    const library = await loadInstructionLibrary(fixture.libraryPath);
    expect(
      validateLibrary(library),
      JSON.stringify(validateLibrary.errors ?? []),
    ).toBe(true);
    expect(
      validateLibrary({ ...library, revision: 9_007_199_254_740_992 }),
    ).toBe(false);
    expect(
      validateLibrary({
        ...library,
        profiles: library.profiles.map((profile) =>
          profile.global ? { ...profile, enabled: false } : profile,
        ),
      }),
    ).toBe(false);
    expect(
      validateLibrary({
        ...library,
        profiles: library.profiles.map((profile) =>
          profile.global
            ? { ...profile, match: { op: "tag", tag: "TypeScript" } }
            : profile,
        ),
      }),
    ).toBe(false);
    const portable = exportInstructionLibrary(library, true);
    expect(
      validateExport(portable),
      JSON.stringify(validateExport.errors ?? []),
    ).toBe(true);
    expect(
      validateExport({
        ...portable,
        profiles: portable.profiles.map((profile) =>
          profile.global ? { ...profile, enabled: false } : profile,
        ),
      }),
    ).toBe(false);
    const invalidWorkspaceExport = {
      ...portable,
      workspaces: [
        {
          id: "00000000-0000-4000-8000-000000000001",
          scopes: [{ path: "", profiles: [created.profile.id] }],
        },
      ],
    };
    expect(validateExport(invalidWorkspaceExport)).toBe(false);
    invalidWorkspaceExport.workspaces[0]!.scopes[0]!.path = "src/../secret";
    expect(validateExport(invalidWorkspaceExport)).toBe(false);
    expect(explanation.sources[0]).not.toHaveProperty("body");
    expect(receipt).not.toHaveProperty("body");
  });
});
