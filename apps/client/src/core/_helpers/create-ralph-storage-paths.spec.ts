import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createRalphRevisionFilePath,
  createRalphRunArtifactPaths,
  getRalphArtifactDirectory,
  getRalphFlowDirectory,
  getRalphFlowPath,
  getRalphFlowStorageDirectory,
  getRalphRevisionDirectory,
  getRalphRevisionPath,
  getRalphRunDirectory,
  getRalphStorageDirectory,
  getUserRalphDirectory,
} from "./create-ralph-storage-paths.helper.js";

const originalUserConfigDirectory = process.env.MACHDOCH_USER_CONFIG_DIR;
const temporaryRoots: string[] = [];

const createTemporaryRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "machdoch-ralph-storage-"));
  temporaryRoots.push(root);
  return root;
};

afterEach(async () => {
  if (originalUserConfigDirectory === undefined) {
    delete process.env.MACHDOCH_USER_CONFIG_DIR;
  } else {
    process.env.MACHDOCH_USER_CONFIG_DIR = originalUserConfigDirectory;
  }

  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

describe("create Ralph storage paths", () => {
  it("creates workspace-scoped storage directories from the workspace root", () => {
    const workspaceRoot = join("workspace", "project");

    expect(getRalphStorageDirectory(workspaceRoot)).toBe(
      join(workspaceRoot, ".machdoch", "ralph"),
    );
    expect(getRalphFlowDirectory(workspaceRoot)).toBe(
      join(workspaceRoot, ".machdoch", "ralph", "flows"),
    );
    expect(getRalphFlowStorageDirectory(workspaceRoot)).toBe(
      join(workspaceRoot, ".machdoch", "ralph", "flows"),
    );
    expect(getRalphRunDirectory(workspaceRoot)).toBe(
      join(workspaceRoot, ".machdoch", "ralph", "runs"),
    );
    expect(getRalphArtifactDirectory(workspaceRoot)).toBe(
      join(workspaceRoot, ".machdoch", "ralph", "artifacts"),
    );
  });

  it("creates user-scoped directories from the configured user config directory", () => {
    process.env.MACHDOCH_USER_CONFIG_DIR = join("custom", "machdoch-config");

    expect(getUserRalphDirectory()).toBe(join("custom", "machdoch-config", "ralph"));
    expect(getRalphStorageDirectory("ignored", "user")).toBe(
      join("custom", "machdoch-config", "ralph"),
    );
    expect(getRalphFlowStorageDirectory("ignored", "user")).toBe(
      join("custom", "machdoch-config", "ralph", "flows"),
    );
  });

  it("normalizes flow and revision path segments", () => {
    const workspaceRoot = join("workspace", "project");

    expect(getRalphFlowPath(workspaceRoot, " Refactor Flow ")).toBe(
      join(workspaceRoot, ".machdoch", "ralph", "flows", "refactor-flow.json"),
    );
    expect(getRalphRevisionDirectory(workspaceRoot, " Refactor Flow ")).toBe(
      join(workspaceRoot, ".machdoch", "ralph", "revisions", "refactor-flow"),
    );
    expect(getRalphRevisionPath(workspaceRoot, " Refactor Flow ", " Revision:One ")).toBe(
      join(
        workspaceRoot,
        ".machdoch",
        "ralph",
        "revisions",
        "refactor-flow",
        "Revision:One.json",
      ),
    );
  });

  it("throws for invalid empty flow and revision inputs", () => {
    const workspaceRoot = join("workspace", "project");

    expect(() => getRalphFlowPath(workspaceRoot, "")).toThrow(
      "Expected Ralph flow id",
    );
    expect(() => getRalphRevisionPath(workspaceRoot, "flow", "")).toThrow(
      "Expected Ralph revision id",
    );
  });

  it("creates a timestamp revision path and suffixes collisions", async () => {
    const root = await createTemporaryRoot();
    const revisionDirectory = join(root, "revisions");
    const timestamp = "2026-06-20T12:34:56.789Z";

    expect(createRalphRevisionFilePath(revisionDirectory, timestamp)).toBe(
      join(revisionDirectory, "2026-06-20T12-34-56-789Z.json"),
    );

    await mkdir(revisionDirectory, { recursive: true });
    await mkdir(join(revisionDirectory, "2026-06-20T12-34-56-789Z.json"));

    expect(createRalphRevisionFilePath(revisionDirectory, timestamp)).toBe(
      join(revisionDirectory, "2026-06-20T12-34-56-789Z-1.json"),
    );
  });

  it("creates run artifact paths from a normalized preferred id", async () => {
    const root = await createTemporaryRoot();
    const runDirectory = join(root, "runs");

    expect(
      createRalphRunArtifactPaths(runDirectory, "2026-06-20T12:34:56.789Z", " My Run "),
    ).toEqual({
      id: "My-Run",
      directory: join(runDirectory, "My-Run"),
      recordPath: join(runDirectory, "My-Run", "run.json"),
      simpleJsonlPath: join(runDirectory, "My-Run", "simple.jsonl"),
      simpleMarkdownPath: join(runDirectory, "My-Run", "simple.md"),
      traceJsonlPath: join(runDirectory, "My-Run", "trace.jsonl"),
    });
  });

  it("creates timestamp run artifact paths and suffixes existing directories", async () => {
    const root = await createTemporaryRoot();
    const runDirectory = join(root, "runs");
    const timestamp = "2026-06-20T12:34:56.789Z";

    await mkdir(join(runDirectory, "2026-06-20T12-34-56-789Z"), { recursive: true });

    const paths = createRalphRunArtifactPaths(runDirectory, timestamp);

    expect(paths.id).toBe("2026-06-20T12-34-56-789Z-1");
    expect(paths.directory).toBe(join(runDirectory, "2026-06-20T12-34-56-789Z-1"));
    expect(paths.recordPath).toBe(join(paths.directory, "run.json"));
    expect(paths.simpleJsonlPath).toBe(join(paths.directory, "simple.jsonl"));
    expect(paths.simpleMarkdownPath).toBe(join(paths.directory, "simple.md"));
    expect(paths.traceJsonlPath).toBe(join(paths.directory, "trace.jsonl"));
  });
});
