import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureWorkspaceStorage } from "./workspace-storage.js";
import { getWorkspaceStorageMarkerPath } from "./workspace-storage-paths.js";
import { loadWorkspaceConfigFile } from "./config.js";
import { loadWorkspaceMemory } from "./workspace-memory.js";
import { RalphRunStore } from "./_helpers/ralph-run-store.helper.js";
import { readRalphRunRecord, type RalphFlow } from "./ralph.js";
import { createRalphFlowFingerprint } from "./_helpers/create-ralph-flow-fingerprint.helper.js";

const roots: string[] = [];
const createWorkspace = async () => {
  const root = await mkdtemp(join(tmpdir(), "machdoch-storage-migration-"));
  roots.push(root);
  return root;
};
const write = async (root: string, path: string, value: string) => {
  const target = join(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, value);
};
const exists = async (path: string) =>
  lstat(path).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 3 })),
  );
});

describe("workspace storage migration", () => {
  it("migrates on the first workspace load, preserves shared files, and skips subsequent work", async () => {
    const root = await createWorkspace();
    await write(root, ".gitignore", "node_modules/\n.machdoch\n");
    await write(root, ".machdoch/config.json", '{"memoryEnabled":true}');
    await write(root, ".machdoch/run.json", '{"configurations":[]}');
    await write(root, ".machdoch/prompts/task.prompt.md", "A shared task");
    await write(root, ".machdoch/custom.json", '{"userDefined":true}');
    await write(root, ".machdoch/memory.json", '{"version":1,"entries":[]}');
    await write(
      root,
      ".machdoch/reasoning-bank.json",
      '{"version":1,"lessons":[]}',
    );
    await write(
      root,
      ".machdoch/ralph/runs/history/simple.jsonl",
      "durable history\n",
    );
    await write(root, ".machdoch/ralph/run-summary-cache.json", "{}");
    await write(
      root,
      ".machdoch/ralph/generations/one/trace.jsonl",
      "generation history\n",
    );
    await write(
      root,
      ".machdoch/mcp/mcp.json",
      '{"schemaVersion":1,"servers":[]}',
    );
    await write(root, ".machdoch/mcp/discovery-cache.json", "{}");
    await write(
      root,
      ".machdoch/chrome-landing-test/Profile/data",
      "browser data",
    );
    await write(root, ".machdoch/screenshot.png", "image bytes");
    await loadWorkspaceConfigFile(root);
    for (const path of [
      "config.json",
      "run.json",
      "prompts/task.prompt.md",
      "mcp/mcp.json",
      "custom.json",
    ]) {
      expect(await exists(join(root, ".machdoch", path))).toBe(true);
    }
    expect(await loadWorkspaceMemory(root)).toEqual([]);
    expect(
      await readFile(
        join(root, ".machdoch/local/state/ralph/runs/history/simple.jsonl"),
        "utf8",
      ),
    ).toBe("durable history\n");
    expect(
      await exists(
        join(root, ".machdoch/local/cache/ralph/run-summary-cache.json"),
      ),
    ).toBe(true);
    expect(
      await exists(
        join(
          root,
          ".machdoch/local/artifacts/ralph/generations/one/trace.jsonl",
        ),
      ),
    ).toBe(true);
    expect(
      await exists(
        join(root, ".machdoch/local/cache/mcp/discovery-cache.json"),
      ),
    ).toBe(true);
    expect(
      await exists(
        join(root, ".machdoch/local/cache/chrome-landing-test/Profile/data"),
      ),
    ).toBe(true);
    expect(
      await readFile(
        join(root, ".machdoch/local/artifacts/screenshot.png"),
        "utf8",
      ),
    ).toBe("image bytes");
    expect(await readFile(join(root, ".gitignore"), "utf8")).toBe(
      "node_modules/\n**/.machdoch/local/\n",
    );
    expect(
      await readFile(join(root, ".machdoch/.gitignore"), "utf8"),
    ).toContain("/local/");
    const marker = await lstat(getWorkspaceStorageMarkerPath(root));
    await Promise.all(
      Array.from({ length: 5 }, () => ensureWorkspaceStorage(root)),
    );
    expect((await lstat(getWorkspaceStorageMarkerPath(root))).mtimeMs).toBe(
      marker.mtimeMs,
    );
    expect(await exists(join(root, ".machdoch/memory.json"))).toBe(false);
  });

  it("relocates flow, run, and checkpoint references and preserves checkpoint integrity", async () => {
    const root = await createWorkspace();
    const flow: RalphFlow = {
      schemaVersion: 1,
      id: "flow",
      name: "Flow",
      guidance: "Read .machdoch/ralph/counters.json",
      blocks: [],
      edges: [],
    };
    const checkpoint = {
      flowFingerprint: createRalphFlowFingerprint(flow),
      currentBlockId: "work",
      variables: { file: ".machdoch/ralph/tasks.json" },
    };
    const envelope = {
      schemaVersion: 1,
      generation: 1,
      createdAt: "2026-01-01T00:00:00Z",
      checkpoint,
      checksum: createHash("sha256")
        .update(JSON.stringify({ generation: 1, checkpoint }))
        .digest("hex"),
    };
    const record = {
      schemaVersion: 1,
      id: "run",
      createdAt: "2026-01-01T00:00:00Z",
      flowId: "flow",
      flowName: "Flow",
      status: "completed",
      summary: "Done",
      events: [],
      blockResults: [],
      logPaths: {
        simpleMarkdownPath: join(root, ".machdoch/ralph/runs/run/simple.md"),
      },
      preparation: { flowFingerprint: createRalphFlowFingerprint(flow), flowSnapshot: flow },
    };
    await write(root, ".machdoch/ralph/flows/flow.json", JSON.stringify(flow));
    await write(
      root,
      ".machdoch/ralph/runs/run/run.json",
      JSON.stringify(record),
    );
    await write(
      root,
      ".machdoch/ralph/runs/run/checkpoints/0000000001-11111111-1111-1111-1111-111111111111.json",
      JSON.stringify(envelope),
    );
    await ensureWorkspaceStorage(root);
    const migratedFlow = JSON.parse(
      await readFile(join(root, ".machdoch/ralph/flows/flow.json"), "utf8"),
    );
    expect(migratedFlow.guidance).toBe("Read .machdoch/local/state/ralph/counters.json");
    const migratedRun = await readRalphRunRecord(root, "run");
    expect(migratedRun.record.logPaths?.simpleMarkdownPath).toBe(
      join(root, ".machdoch/local/state/ralph/runs/run/simple.md"),
    );
    const store = new RalphRunStore(
      join(root, ".machdoch/local/state/ralph/runs/run"),
    );
    expect(
      (await store.readLatestCheckpoint())?.checkpoint.variables,
    ).toEqual({ file: ".machdoch/local/state/ralph/tasks.json" });
    expect((await store.readLatestCheckpoint())?.checkpoint.flowFingerprint).toBe(
      createRalphFlowFingerprint(migratedFlow),
    );
    const migratedRecord = JSON.parse(await readFile(
      join(root, ".machdoch/local/state/ralph/runs/run/run.json"), "utf8",
    ));
    expect(migratedRecord.preparation.flowFingerprint).toBe(createRalphFlowFingerprint(migratedFlow));
  });

  it("preserves conflicts and can resume after they are resolved", async () => {
    const root = await createWorkspace();
    await write(root, ".machdoch/memory.json", "old");
    await write(root, ".machdoch/local/state/memory.json", "new");
    await expect(ensureWorkspaceStorage(root)).rejects.toThrow("conflict");
    expect(await readFile(join(root, ".machdoch/memory.json"), "utf8")).toBe(
      "old",
    );
    expect(
      await readFile(join(root, ".machdoch/local/state/memory.json"), "utf8"),
    ).toBe("new");
    expect(await exists(getWorkspaceStorageMarkerPath(root))).toBe(false);
    await write(root, ".machdoch/local/state/memory.json", "old");
    await ensureWorkspaceStorage(root);
    expect(await exists(join(root, ".machdoch/memory.json"))).toBe(false);
    expect(await exists(getWorkspaceStorageMarkerPath(root))).toBe(true);
  });

  it("does not move storage while a RALPH owner is alive", async () => {
    const root = await createWorkspace();
    await write(
      root,
      ".machdoch/ralph/runs/active/run-lease.json",
      JSON.stringify({
        ownerId: `${process.pid}:11111111-1111-1111-1111-111111111111`,
      }),
    );
    await expect(ensureWorkspaceStorage(root)).rejects.toThrow(
      "Stop the active RALPH run",
    );
    expect(
      await exists(join(root, ".machdoch/ralph/runs/active/run-lease.json")),
    ).toBe(true);
    expect(await exists(getWorkspaceStorageMarkerPath(root))).toBe(false);
  });

  it("rejects a linked local directory without writing outside the workspace", async () => {
    const root = await createWorkspace();
    const outside = await createWorkspace();
    await mkdir(join(root, ".machdoch"));
    await symlink(
      outside,
      join(root, ".machdoch/local"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(ensureWorkspaceStorage(root)).rejects.toThrow(
      "regular directory",
    );
    expect(await readdir(outside)).toEqual([]);
    await rm(join(root, ".machdoch/local"));
  });
});
