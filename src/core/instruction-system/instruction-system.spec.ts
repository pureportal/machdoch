import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
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
  createLocalInstruction,
  deleteInstructionProfile,
  deleteLocalInstruction,
  discoverLocalInstructions,
  duplicateInstructionProfile,
  explainInstructionResolution,
  exportInstructionLibrary,
  exportInstructionLibraryRecoveryBackup,
  importInstructionLibrary,
  inspectInstructionLibraryRecovery,
  inventoryNativeInstructions,
  loadInstructionLibrary,
  mutateInstructionLibrary,
  normalizeScopePath,
  profileNameKey,
  recoverInstructionLibraryFromBackup,
  relinkInstructionWorkspace,
  resetCorruptInstructionLibrary,
  registerInstructionWorkspace,
  resolveInstructionSet,
  setDefaultInstructionProfiles,
  setWorkspaceInstructionScope,
  sha256,
  updateInstructionProfile,
  updateLocalInstruction,
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
    const firstBinding = await registerInstructionWorkspace(
      first.workspace,
      {},
      { path: first.libraryPath, expectedRevision: 1 },
    );
    const secondBinding = await registerInstructionWorkspace(
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

  it("applies defaults to unregistered workspaces without negative exceptions", async () => {
    const fixture = await createTestRoot();
    const created = await createInstructionProfile(
      { name: "Global", body: "Apply everywhere." },
      { path: fixture.libraryPath },
    );
    await setDefaultInstructionProfiles([created.profile.id], {
      path: fixture.libraryPath,
      expectedRevision: 1,
    });

    const resolution = await resolve(fixture.workspace, fixture.libraryPath);
    expect(resolution.workspaceRegistered).toBe(false);
    expect(resolution.selectedSources).toEqual([
      expect.objectContaining({
        kind: "profile-default",
        profileId: created.profile.id,
        scopePath: ".",
        body: "Apply everywhere.",
      }),
    ]);
    expect(resolution.diagnostics).toContainEqual(
      expect.objectContaining({ code: "WORKSPACE_NOT_REGISTERED" }),
    );
  });

  it("blocks redundant new references, stale edits, and deletion of assigned profiles", async () => {
    const fixture = await createTestRoot();
    await mkdir(join(fixture.workspace, "apps", "web"), { recursive: true });
    const created = await createInstructionProfile(
      { name: "Shared", body: "Shared policy." },
      { path: fixture.libraryPath },
    );
    const registered = await registerInstructionWorkspace(
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
      deleteInstructionProfile(created.profile.id, {
        path: fixture.libraryPath,
        expectedRevision: 3,
      }),
    ).rejects.toMatchObject({ code: "PROFILE_IS_ASSIGNED" });
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
    const registered = await registerInstructionWorkspace(
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
    const registered = await registerInstructionWorkspace(
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
  it("orders defaults, assignments, local files, deeper scopes, and flow guidance exactly", async () => {
    const fixture = await createTestRoot();
    await mkdir(join(fixture.workspace, "apps", "web"), { recursive: true });
    const global = await createInstructionProfile(
      { name: "Global", body: "Global policy." },
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
    await setDefaultInstructionProfiles([global.profile.id], {
      path: fixture.libraryPath,
      expectedRevision: 3,
    });
    const registered = await registerInstructionWorkspace(
      fixture.workspace,
      {},
      { path: fixture.libraryPath, expectedRevision: 4 },
    );
    await setWorkspaceInstructionScope(
      registered.workspace.id,
      ".",
      [root.profile.id],
      { path: fixture.libraryPath, expectedRevision: 5 },
    );
    await setWorkspaceInstructionScope(
      registered.workspace.id,
      "apps/web",
      [child.profile.id],
      { path: fixture.libraryPath, expectedRevision: 6 },
    );
    await createLocalInstruction(fixture.workspace, ".", "Root local policy.");
    await createLocalInstruction(
      fixture.workspace,
      "apps/web",
      "Web local policy.",
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
      ["profile-default", ".", "Global policy."],
      ["profile-workspace", ".", "Root profile policy."],
      ["project-local", ".", "Root local policy."],
      ["profile-workspace", "apps/web", "Web profile policy."],
      ["project-local", "apps/web", "Web local policy."],
      ["flow-guidance", ".", "Flow guidance."],
    ]);
    expect(Object.isFrozen(resolution)).toBe(true);
    expect(resolution.renderedEnvelope.indexOf("Global policy.")).toBeLessThan(
      resolution.renderedEnvelope.indexOf("Root profile policy."),
    );
    expect(
      resolution.renderedEnvelope.indexOf("Flow guidance."),
    ).toBeGreaterThan(resolution.renderedEnvelope.indexOf("Web local policy."));
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
    const registered = await registerInstructionWorkspace(
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
    const registered = await registerInstructionWorkspace(
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
    const registered = await registerInstructionWorkspace(
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
    const registered = await registerInstructionWorkspace(
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

  it("blocks aggregate envelope overflow with complete contributor accounting and no truncation", async () => {
    const fixture = await createTestRoot();
    const profile = await createInstructionProfile(
      { name: "Near source limit", body: "x".repeat(131_000) },
      { path: fixture.libraryPath },
    );
    await setDefaultInstructionProfiles([profile.profile.id], {
      path: fixture.libraryPath,
      expectedRevision: 1,
    });

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
                sourceId: `profile-default:${profile.profile.id}`,
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
      defaults: { profiles: [] },
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
    const registered = await registerInstructionWorkspace(
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

  it("remaps unbound workspace assignments when a conflicting profile is duplicated", async () => {
    const fixture = await createTestRoot();
    const created = await createInstructionProfile(
      { name: "Portable", body: "Exported body." },
      { path: fixture.libraryPath },
    );
    const registered = await registerInstructionWorkspace(
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
        choices: {
          defaults: "invalid" as "merge",
        },
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

describe("local discovery, native inventory, delivery, and schemas", () => {
  it("normalizes explicit local edits, enforces digest CAS, and preserves ignored entries", async () => {
    const fixture = await createTestRoot();
    await Promise.all([
      mkdir(join(fixture.workspace, "apps", "web"), { recursive: true }),
      mkdir(join(fixture.workspace, "node_modules", "ignored"), {
        recursive: true,
      }),
    ]);
    const rootLocal = await createLocalInstruction(
      fixture.workspace,
      ".",
      "\uFEFFRoot\r\npolicy\r",
    );
    await writeFile(
      join(fixture.workspace, "node_modules", "ignored", "AGENTS.md"),
      "Ignored.\n",
    );
    expect(rootLocal.body).toBe("Root\npolicy\n");
    await expect(
      updateLocalInstruction(
        fixture.workspace,
        ".",
        "Changed.",
        "0".repeat(64),
      ),
    ).rejects.toMatchObject({ code: "LOCAL_INSTRUCTION_REVISION_CONFLICT" });
    const updated = await updateLocalInstruction(
      fixture.workspace,
      ".",
      "Changed.",
      rootLocal.digest,
    );
    const discovery = await discoverLocalInstructions(fixture.workspace);
    expect(discovery.files.map((file) => file.relativePath)).toEqual([
      "AGENTS.md",
    ]);
    expect(discovery.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "LOCAL_INSTRUCTION_DIRECTORY_IGNORED",
        relativePath: "node_modules",
      }),
    );
    await deleteLocalInstruction(fixture.workspace, ".", updated.digest);
    await expect(
      stat(join(fixture.workspace, "AGENTS.md")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects unsafe edits and skips invalid or linked local discovery", async () => {
    const fixture = await createTestRoot();
    expect(() => normalizeScopePath("")).toThrow();
    expect(() => normalizeScopePath("   ")).toThrow();
    expect(() => normalizeScopePath("../outside")).toThrow();
    expect(() => normalizeScopePath("C:outside")).toThrow();
    await expect(
      createLocalInstruction(fixture.workspace, ".", "\0bad"),
    ).rejects.toMatchObject({ code: "INSTRUCTION_NUL_BYTE" });
    await writeFile(join(fixture.workspace, "AGENTS.md"), Buffer.from([0xff]));
    await expect(discoverLocalInstructions(fixture.workspace)).resolves.toEqual(
      expect.objectContaining({
        files: [],
        diagnostics: expect.arrayContaining([
          expect.objectContaining({
            code: "INSTRUCTION_INVALID_UTF8",
            severity: "warning",
            relativePath: "AGENTS.md",
          }),
        ]),
      }),
    );
    await rm(join(fixture.workspace, "AGENTS.md"));

    const linkedTarget = join(fixture.root, "linked-target");
    await mkdir(linkedTarget);
    await writeFile(join(linkedTarget, "AGENTS.md"), "Must not load.\n");
    let linkCreated = false;
    try {
      await symlink(
        linkedTarget,
        join(fixture.workspace, "linked"),
        process.platform === "win32" ? "junction" : "dir",
      );
      linkCreated = true;
    } catch {
      // Some Windows CI accounts cannot create links; static link behavior is
      // covered when the host permits it.
    }
    if (linkCreated) {
      await expect(
        registerInstructionWorkspace(
          join(fixture.workspace, "linked"),
          {},
          { path: fixture.libraryPath },
        ),
      ).rejects.toMatchObject({ code: "WORKSPACE_ROOT_INVALID" });
      const discovery = await discoverLocalInstructions(fixture.workspace);
      expect(discovery.files).toEqual([]);
      expect(discovery.diagnostics).toContainEqual(
        expect.objectContaining({ code: "LOCAL_INSTRUCTION_LINK_SKIPPED" }),
      );
    }
  });

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
      locals: [],
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
      locals: [],
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
      locals: [],
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
      locals: [],
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
  });

  it("emits schema-valid closed explanations, plans, and receipts without bodies by default", async () => {
    const fixture = await createTestRoot();
    const created = await createInstructionProfile(
      { name: "Schema profile", body: "Sensitive profile body." },
      { path: fixture.libraryPath },
    );
    await setDefaultInstructionProfiles([created.profile.id], {
      path: fixture.libraryPath,
      expectedRevision: 1,
    });
    const resolution = await resolve(fixture.workspace, fixture.libraryPath, {
      model: "gpt-5.5",
    });
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
    const portable = exportInstructionLibrary(library, true);
    expect(
      validateExport(portable),
      JSON.stringify(validateExport.errors ?? []),
    ).toBe(true);
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
