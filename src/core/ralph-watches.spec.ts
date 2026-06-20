import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createUserRalphWatchScheduler,
  createRalphWatchSchedulerJobInput,
  deleteRalphWatch,
  listRalphWatches,
  syncRalphWatchSchedulerJobs,
  upsertRalphWatch,
  watchRootMatchesPath,
} from "./ralph-watches.js";

describe("Ralph watches", () => {
  const rootsToClean: string[] = [];
  let previousUserConfigRoot: string | undefined;

  const createRoot = async (prefix: string): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), prefix));
    rootsToClean.push(root);

    return root;
  };

  beforeEach(async () => {
    previousUserConfigRoot = process.env.MACHDOCH_USER_CONFIG_DIR;
    process.env.MACHDOCH_USER_CONFIG_DIR = await createRoot("machdoch-ralph-watch-user-");
  });

  afterEach(async () => {
    if (previousUserConfigRoot === undefined) {
      delete process.env.MACHDOCH_USER_CONFIG_DIR;
    } else {
      process.env.MACHDOCH_USER_CONFIG_DIR = previousUserConfigRoot;
    }

    await Promise.all(
      rootsToClean.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it("normalizes a global watch and creates a scoped scheduler Ralph target", async () => {
    const watchRoot = await createRoot("machdoch-ralph-watch-root-");
    const watch = await upsertRalphWatch({
      id: "docs",
      flow: { scope: "user", id: "summarize-docs" },
      executionWorkspaceRoot: watchRoot,
      roots: [{ path: watchRoot, include: ["**/*.md"] }],
      events: ["created", "changed"],
      params: {
        changed_path: "{{payload.path}}",
      },
      permissions: {
        allowedRoots: [watchRoot],
        allowWrites: true,
      },
    });

    expect(await listRalphWatches()).toEqual([expect.objectContaining({ id: "docs" })]);
    expect(
      watchRootMatchesPath(watch.roots[0]!, join(watch.roots[0]!.path, "guide.md")),
    ).toBe(true);
    expect(
      watchRootMatchesPath(
        watch.roots[0]!,
        join(watch.roots[0]!.path, "nested", "guide.md"),
      ),
    ).toBe(true);
    expect(
      watchRootMatchesPath(
        watch.roots[0]!,
        join(watch.roots[0]!.path, ".machdoch", "run.json"),
      ),
    ).toBe(false);

    const jobInput = createRalphWatchSchedulerJobInput(watch);
    expect(jobInput.dedupeKey).toBe("ralph-watch:docs");
    expect(jobInput.target).toMatchObject({
      type: "ralph-flow",
      workspaceRoot: watch.executionWorkspaceRoot,
      ralphFlow: {
        scope: "user",
        id: "summarize-docs",
        params: {
          changed_path: "{{payload.path}}",
        },
        permissions: expect.objectContaining({
          allowWrites: true,
          allowCommands: false,
        }),
      },
    });
  });

  it("removes stale scheduler jobs when watches are deleted outside the scheduler", async () => {
    const watchRoot = await createRoot("machdoch-ralph-watch-root-");
    const scheduler = createUserRalphWatchScheduler();

    await upsertRalphWatch({
      id: "docs",
      flow: { scope: "user", id: "summarize-docs" },
      executionWorkspaceRoot: watchRoot,
      roots: [{ path: watchRoot }],
    });
    await syncRalphWatchSchedulerJobs(scheduler);
    expect(await scheduler.listJobs()).toEqual([
      expect.objectContaining({ dedupeKey: "ralph-watch:docs" }),
    ]);

    await deleteRalphWatch("docs");
    await syncRalphWatchSchedulerJobs(scheduler);
    expect(await scheduler.listJobs()).toEqual([]);
  });

  it("rejects execution workspaces outside the watch permission roots", async () => {
    const watchRoot = await createRoot("machdoch-ralph-watch-root-");
    const workspaceRoot = await createRoot("machdoch-ralph-watch-workspace-");

    await expect(
      upsertRalphWatch({
        id: "docs",
        flow: { scope: "user", id: "summarize-docs" },
        executionWorkspaceRoot: workspaceRoot,
        roots: [{ path: watchRoot }],
      }),
    ).rejects.toThrow("is outside the watch allowed roots");
  });
});
