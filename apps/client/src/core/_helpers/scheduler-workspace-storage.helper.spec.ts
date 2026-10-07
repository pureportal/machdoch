import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DurableSmartScheduler,
  readSmartSchedulerState,
  type SmartSchedulerState,
} from "../scheduler.ts";
import {
  getSchedulerDefinitionPath,
  getSchedulerStatePath,
  migrateWorkspaceSchedulerStorage,
  readWorkspaceSchedulerStateUnlocked,
  writeWorkspaceSchedulerStateUnlocked,
} from "./scheduler-workspace-storage.helper.ts";
import { withSchedulerStateLock } from "./scheduler-file-storage.helper.ts";

const renameFailure = vi.hoisted(() => ({
  path: undefined as string | undefined,
  skip: 0,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const fileSystem = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...fileSystem,
    rename: async (
      ...args: Parameters<typeof fileSystem.rename>
    ): Promise<void> => {
      if (args[1] === renameFailure.path) {
        if (renameFailure.skip > 0) {
          renameFailure.skip -= 1;
        } else {
          renameFailure.path = undefined;
          throw Object.assign(new Error("Injected scheduler write failure"), {
            code: "EIO",
          });
        }
      }
      await fileSystem.rename(...args);
    },
  };
});

const roots: string[] = [];

const createWorkspace = async (): Promise<string> => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "machdoch-scheduler-storage-")),
  );
  roots.push(root);
  return root;
};

const readJson = async (path: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;

const seedCombinedState = async (
  root: string,
): Promise<SmartSchedulerState> => {
  const scheduler = new DurableSmartScheduler({
    statePath: join(root, "custom-scheduler.json"),
    clock: { now: () => 100 },
  });
  const job = await scheduler.upsertJob(
    {
      name: "Migration fixture",
      schedule: { type: "interval", intervalMs: 1_000, anchorAt: 0 },
      triggers: [
        { kind: "app", eventType: "app.migrate", firingMode: "state" },
      ],
      target: { workspaceRoot: root, prompt: "Keep the queued execution" },
      retry: { maxAttempts: 3 },
    },
    "create-fixture",
  );
  await scheduler.recordEventAndEnqueueRuns({
    type: "app.migrate",
    kind: "app",
    workspaceRoot: root,
    dedupeKey: "migration-event",
  });
  await scheduler.triggerJobNow(job.id, "migration-manual");
  const deletedJob = await scheduler.upsertJob({
    triggers: [{ kind: "manual" }],
    target: { workspaceRoot: root, prompt: "Deleted job history" },
  });
  await scheduler.deleteJob(deletedJob.id, "delete-fixture");

  const state = await scheduler.getState();
  state.jobs[0]!.target = {
    ...state.jobs[0]!.target,
    type: "ralph-flow",
    ralphFlow: {
      scope: "workspace",
      id: "pinned-flow",
      params: {},
      resumePolicy: "recoverable",
      flowFingerprint: "pinned-fingerprint",
      flowSnapshotAt: 100,
      flowSnapshot: {
        schemaVersion: 1,
        id: "pinned-flow",
        name: "Pinned revision",
        blocks: [],
        edges: [],
      },
    },
  };
  const running = state.runs[0]!;
  running.status = "running";
  running.attempt = 1;
  running.claimToken = "durable-claim";
  running.startedAt = 100;
  running.targetSnapshot = structuredClone(state.jobs[0]!.target);
  running.attemptHistory = [
    {
      attempt: 1,
      claimToken: "previous-claim",
      startedAt: 50,
      finishedAt: 75,
      status: "failed",
      error: "Recoverable interruption",
      nextRetryAt: 100,
    },
  ];
  await mkdir(dirname(getSchedulerDefinitionPath(root)), { recursive: true });
  await writeFile(
    getSchedulerDefinitionPath(root),
    JSON.stringify(state),
    "utf8",
  );
  return state;
};

afterEach(async () => {
  renameFailure.path = undefined;
  renameFailure.skip = 0;
  await Promise.all(
    roots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 3 })),
  );
});

describe("migrateWorkspaceSchedulerStorage", () => {
  it("preserves definitions, claims, snapshots, trigger state, history and receipts exactly once", async () => {
    const root = await createWorkspace();
    const original = await seedCombinedState(root);

    await Promise.all([
      migrateWorkspaceSchedulerStorage(root),
      migrateWorkspaceSchedulerStorage(root),
    ]);

    expect(await readSmartSchedulerState(getSchedulerStatePath(root))).toEqual(
      original,
    );
    const definitions = await readJson(getSchedulerDefinitionPath(root));
    const runtime = await readJson(getSchedulerStatePath(root));
    expect(definitions.schema).toBe("machdoch.smartScheduler.definitions");
    expect(runtime.schema).toBe("machdoch.smartScheduler.runtime");
    expect(definitions).not.toHaveProperty("runs");
    expect(definitions).not.toHaveProperty("events");
    expect(definitions).not.toHaveProperty("mutationReceipts");
    expect(definitions).not.toHaveProperty("updatedAt");
    expect(definitions.jobs).toHaveLength(1);
    const definition = (definitions.jobs as Array<Record<string, unknown>>)[0]!;
    expect(definition.target).toMatchObject({ workspaceRoot: "." });
    expect(definition).not.toHaveProperty("nextRunAt");
    expect(definition).not.toHaveProperty("schedule");
    expect(definition).not.toHaveProperty("updatedAt");
    expect(definition.triggers).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ nextRunAt: expect.any(Number) }),
      ]),
    );
    expect(
      (definition.target as Record<string, unknown>).ralphFlow,
    ).not.toHaveProperty("flowSnapshot");
    expect(runtime.jobs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: original.jobs[0]!.id,
          ralphFlow: expect.objectContaining({
            flowFingerprint: "pinned-fingerprint",
          }),
        }),
        expect.objectContaining({
          status: "deleted",
          deletedDefinition: expect.any(Object),
        }),
      ]),
    );
    expect(runtime.definitionUpdate).toBeUndefined();

    const paths = [
      getSchedulerDefinitionPath(root),
      getSchedulerStatePath(root),
    ];
    const before = await Promise.all(paths.map((path) => stat(path)));
    await migrateWorkspaceSchedulerStorage(root);
    const after = await Promise.all(paths.map((path) => stat(path)));
    expect(after.map((entry) => entry.mtimeMs)).toEqual(
      before.map((entry) => entry.mtimeMs),
    );
  });

  it("leaves the source intact when the local commit fails and succeeds on retry", async () => {
    const root = await createWorkspace();
    const original = await seedCombinedState(root);
    const source = await readFile(getSchedulerDefinitionPath(root), "utf8");
    renameFailure.path = getSchedulerStatePath(root);

    await expect(migrateWorkspaceSchedulerStorage(root)).rejects.toThrow(
      "Injected scheduler write failure",
    );
    expect(await readFile(getSchedulerDefinitionPath(root), "utf8")).toBe(
      source,
    );
    await expect(
      readFile(getSchedulerStatePath(root), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });

    await migrateWorkspaceSchedulerStorage(root);
    expect(await readSmartSchedulerState(getSchedulerStatePath(root))).toEqual(
      original,
    );
  });

  it("resumes a migration after the local state commits and the shared commit fails", async () => {
    const root = await createWorkspace();
    const original = await seedCombinedState(root);
    const source = await readFile(getSchedulerDefinitionPath(root), "utf8");
    renameFailure.path = getSchedulerDefinitionPath(root);

    await expect(migrateWorkspaceSchedulerStorage(root)).rejects.toThrow(
      "Injected scheduler write failure",
    );
    expect(await readFile(getSchedulerDefinitionPath(root), "utf8")).toBe(
      source,
    );
    expect(await readJson(getSchedulerStatePath(root))).toHaveProperty(
      "definitionUpdate",
    );
    expect((await readJson(getSchedulerStatePath(root))).runs).toEqual(
      original.runs,
    );

    await migrateWorkspaceSchedulerStorage(root);
    expect(await readSmartSchedulerState(getSchedulerStatePath(root))).toEqual(
      original,
    );
    expect(await readJson(getSchedulerStatePath(root))).not.toHaveProperty(
      "definitionUpdate",
    );
  });

  it("clears an interrupted final local commit without rewriting the committed shared file", async () => {
    const root = await createWorkspace();
    const original = await seedCombinedState(root);
    renameFailure.path = getSchedulerStatePath(root);
    renameFailure.skip = 1;

    await expect(migrateWorkspaceSchedulerStorage(root)).rejects.toThrow("Injected scheduler write failure");
    const committed = await readFile(getSchedulerDefinitionPath(root), "utf8");
    const before = await stat(getSchedulerDefinitionPath(root));
    expect(JSON.parse(committed).schema).toBe("machdoch.smartScheduler.definitions");
    expect(await readJson(getSchedulerStatePath(root))).toHaveProperty("definitionUpdate");

    await migrateWorkspaceSchedulerStorage(root);
    expect(await readSmartSchedulerState(getSchedulerStatePath(root))).toEqual(original);
    expect(await readJson(getSchedulerStatePath(root))).not.toHaveProperty("definitionUpdate");
    expect(await readFile(getSchedulerDefinitionPath(root), "utf8")).toBe(committed);
    expect((await stat(getSchedulerDefinitionPath(root))).mtimeMs).toBe(before.mtimeMs);
  });

  it("rejects conflicting shared edits while retaining the pending migration", async () => {
    const root = await createWorkspace();
    const original = await seedCombinedState(root);
    renameFailure.path = getSchedulerDefinitionPath(root);
    await expect(migrateWorkspaceSchedulerStorage(root)).rejects.toThrow(
      "Injected scheduler write failure",
    );

    original.jobs[0]!.name = "Concurrent shared edit";
    const edited = JSON.stringify(original);
    await writeFile(getSchedulerDefinitionPath(root), edited, "utf8");
    const pending = await readFile(getSchedulerStatePath(root), "utf8");

    await expect(migrateWorkspaceSchedulerStorage(root)).rejects.toThrow(
      "changed during a pending update",
    );
    expect(await readFile(getSchedulerDefinitionPath(root), "utf8")).toBe(
      edited,
    );
    expect(await readFile(getSchedulerStatePath(root), "utf8")).toBe(pending);
  });

  it("preserves conflicting local history without overwriting either document", async () => {
    const root = await createWorkspace();
    const original = await seedCombinedState(root);
    await migrateWorkspaceSchedulerStorage(root);
    const runtime = await readJson(getSchedulerStatePath(root));
    const runs = runtime.runs as SmartSchedulerState["runs"];
    runs[0]!.status = "queued";
    runs[0]!.nextAttemptAt = 200;
    delete runs[0]!.claimToken;
    runs.push({ ...structuredClone(runs[1]!), id: "additional-local-run" });
    await writeFile(
      getSchedulerStatePath(root),
      JSON.stringify(runtime),
      "utf8",
    );
    await writeFile(
      getSchedulerDefinitionPath(root),
      JSON.stringify(original),
      "utf8",
    );

    await expect(migrateWorkspaceSchedulerStorage(root)).rejects.toThrow(
      "storage conflict",
    );
    expect(await readJson(getSchedulerStatePath(root))).toEqual(runtime);
    expect(await readJson(getSchedulerDefinitionPath(root))).toEqual(original);
  });

  it("rejects a corrupt local destination without overwriting either file", async () => {
    const root = await createWorkspace();
    await seedCombinedState(root);
    const source = await readFile(getSchedulerDefinitionPath(root), "utf8");
    await mkdir(dirname(getSchedulerStatePath(root)), { recursive: true });
    await writeFile(getSchedulerStatePath(root), "{", "utf8");

    await expect(migrateWorkspaceSchedulerStorage(root)).rejects.toThrow();
    expect(await readFile(getSchedulerDefinitionPath(root), "utf8")).toBe(
      source,
    );
    expect(await readFile(getSchedulerStatePath(root), "utf8")).toBe("{");
  });

  it("finishes interrupted definition mutations before replaying their idempotency receipts", async () => {
    const root = await createWorkspace();
    const scheduler = new DurableSmartScheduler({
      statePath: getSchedulerStatePath(root),
      clock: { now: () => 100 },
    });
    const job = await scheduler.upsertJob({
      triggers: [{ kind: "manual" }],
      target: { workspaceRoot: root, prompt: "Run" },
    });
    const original = await readFile(getSchedulerDefinitionPath(root), "utf8");
    renameFailure.path = getSchedulerDefinitionPath(root);

    await expect(
      scheduler.updateJob(job.id, { name: "Recovered definition" }, "edit-job"),
    ).rejects.toThrow("Injected scheduler write failure");
    expect(await readFile(getSchedulerDefinitionPath(root), "utf8")).toBe(
      original,
    );

    const restarted = new DurableSmartScheduler({
      statePath: getSchedulerStatePath(root),
    });
    const replayed = await restarted.updateJob(
      job.id,
      { name: "Recovered definition" },
      "edit-job",
    );
    expect(replayed.name).toBe("Recovered definition");
    expect((await restarted.getJob(job.id))?.name).toBe("Recovered definition");
    expect(
      (await restarted.getState()).mutationReceipts.filter(
        (receipt) => receipt.key === "edit-job",
      ),
    ).toHaveLength(1);
    expect(await readJson(getSchedulerStatePath(root))).not.toHaveProperty(
      "definitionUpdate",
    );
  });

  it("rejects a runtime mutation based on definitions that changed after its read", async () => {
    const root = await createWorkspace();
    const scheduler = new DurableSmartScheduler({ statePath: getSchedulerStatePath(root) });
    await scheduler.upsertJob({
      triggers: [{ kind: "manual" }],
      target: { workspaceRoot: root, prompt: "Original task" },
    });
    const statePath = getSchedulerStatePath(root);
    const originalRuntime = await readFile(statePath, "utf8");
    await withSchedulerStateLock(statePath, async () => {
      const loaded = await readWorkspaceSchedulerStateUnlocked(root);
      const definitions = await readJson(getSchedulerDefinitionPath(root));
      (definitions.jobs as Array<{ name: string }>)[0]!.name = "Concurrent edit";
      const edited = JSON.stringify(definitions);
      await writeFile(getSchedulerDefinitionPath(root), edited, "utf8");
      loaded.state.updatedAt += 1;

      await expect(writeWorkspaceSchedulerStateUnlocked(root, loaded.state, loaded.definitionFingerprint))
        .rejects.toThrow("changed during a mutation");
      expect(await readFile(getSchedulerDefinitionPath(root), "utf8")).toBe(edited);
      expect(await readFile(statePath, "utf8")).toBe(originalRuntime);
    });
  });

  it("migrates version one provenance explicitly into the new split schema", async () => {
    const root = await createWorkspace();
    const original = await seedCombinedState(root);
    original.jobs[0]!.dedupeKey = "prompt:.machdoch/prompts/fixture.prompt.md";
    original.jobs[1]!.dedupeKey = "ralph-watch:fixture-watch";
    const previous = {
      ...original,
      schemaVersion: 1,
      jobs: original.jobs.map(({ provenance: _provenance, ...job }) => job),
    };
    await writeFile(
      getSchedulerDefinitionPath(root),
      JSON.stringify(previous),
      "utf8",
    );

    await migrateWorkspaceSchedulerStorage(root);
    const restored = await readSmartSchedulerState(getSchedulerStatePath(root));
    expect(restored.jobs.map((job) => job.provenance)).toEqual([
      { kind: "workspace-prompt", definitionPath: ".machdoch/prompts/fixture.prompt.md" },
      { kind: "ralph-watch", watchId: "fixture-watch" },
    ]);
    expect(restored.runs).toEqual(original.runs);
    expect(restored.mutationReceipts).toEqual(original.mutationReceipts);
  });
});
