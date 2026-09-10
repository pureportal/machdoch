import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadRalphSnapshot } from "./ralph-snapshot.js";
import { getRalphRunDirectory } from "./_helpers/create-ralph-storage-paths.helper.js";
import { createFlow } from "./__test__/ralph-test-helpers.js";
import { writeRalphFlow } from "./ralph.js";
import { RalphRunStore } from "./_helpers/ralph-run-store.helper.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "machdoch-ralph-activity-"));
  vi.stubEnv("MACHDOCH_USER_CONFIG_DIR", join(root, "user-config"));
});
afterEach(async () => {
  const target = resolve(root);
  if (!target.startsWith(join(resolve(tmpdir()), "machdoch-ralph-activity-")))
    throw new Error("Unexpected test directory");
  await rm(target, { recursive: true, force: true });
});

describe("RALPH activity snapshots", () => {
  it("keeps long-running flows outside the history limit and rechecks independent leases on every refresh", async () => {
    const directory = getRalphRunDirectory(root);
    await mkdir(directory, { recursive: true });
    await Promise.all(
      Array.from({ length: 56 }, async (_, index) => {
        const runDirectory = join(directory, `run-${index}`);
        await mkdir(runDirectory);
        await writeFile(
          join(runDirectory, "run.json"),
          JSON.stringify({
            schemaVersion: 1,
            id: `run-${index}`,
            createdAt: new Date(
              1_700_000_000_000 + index * 1_000,
            ).toISOString(),
            flowId: "flow",
            flowName: "Flow",
            status: index === 0 ? "running" : "completed",
            summary: "Result",
            events: [],
            blockResults: [],
          }),
        );
      }),
    );
    const leasePath = new RalphRunStore(join(directory, "run-0")).leasePath;
    const lease = {
      schemaVersion: 1,
      runId: "run-0",
      flowId: "flow",
      ownerId: "owner",
      generation: 1,
      acquiredAt: new Date().toISOString(),
      durationMs: 60_000,
    };
    await writeFile(leasePath, JSON.stringify(lease));
    const active = await loadRalphSnapshot(root, { scope: "workspace" });
    expect(active.scopes[0]?.runs).toHaveLength(51);
    expect(
      active.scopes[0]?.runs.find((run) => run.id === "run-0")?.status,
    ).toBe("running");
    await writeFile(
      leasePath,
      JSON.stringify({ ...lease, releasedAt: new Date().toISOString() }),
    );
    const finished = await loadRalphSnapshot(root, { scope: "workspace" });
    expect(finished.scopes[0]?.runs).toHaveLength(50);
    expect(finished.scopes[0]?.runs.some((run) => run.id === "run-0")).toBe(
      false,
    );
  });

  it("loads workspace and global storage independently, including errors", async () => {
    await writeRalphFlow(root, createFlow());
    await mkdir(join(root, "user-config", "ralph"), { recursive: true });
    await writeFile(
      join(root, "user-config", "ralph", "flows"),
      "not a directory",
    );
    const workspace = await loadRalphSnapshot(root, { scope: "workspace" });
    expect(workspace.scopes).toHaveLength(1);
    expect(workspace.scopes[0]?.flows[0]?.name).toBe("Refactor flow");
    await expect(loadRalphSnapshot(root, { scope: "user" })).rejects.toThrow();
  });
});
