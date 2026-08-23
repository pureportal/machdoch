import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  forgetWorkspaceMemory,
  loadWorkspaceMemory,
  rememberWorkspaceMemory,
} from "./workspace-memory.ts";

const roots: string[] = [];

const createWorkspace = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "machdoch-workspace-memory-"));
  roots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("workspace memory", () => {
  it("persists facts only inside the selected workspace", async () => {
    const workspaceA = await createWorkspace();
    const workspaceB = await createWorkspace();

    await rememberWorkspaceMemory(
      workspaceA,
      "Use pnpm package for release builds",
      {
        key: "release-build-command",
        kind: "constraint",
        importance: 4,
        confidence: 0.9,
      },
    );

    expect(await loadWorkspaceMemory(workspaceA)).toMatchObject([
      {
        scope: "workspace",
        key: "release-build-command",
        content: "Use pnpm package for release builds",
      },
    ]);
    expect(await loadWorkspaceMemory(workspaceB)).toEqual([]);
  });

  it("replaces a conflicting fact with the same concept key", async () => {
    const workspace = await createWorkspace();
    const first = await rememberWorkspaceMemory(workspace, "Use Node 20", {
      key: "node-version",
      kind: "constraint",
    });
    const replacement = await rememberWorkspaceMemory(
      workspace,
      "Use Node 22",
      {
        key: "node-version",
        kind: "constraint",
      },
    );
    const entries = await loadWorkspaceMemory(workspace);

    expect(replacement.id).toBe(first.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.content).toBe("Use Node 22");
  });

  it("deletes an entry by id", async () => {
    const workspace = await createWorkspace();
    const entry = await rememberWorkspaceMemory(workspace, "Use Node 22", {
      key: "node-version",
    });

    await expect(forgetWorkspaceMemory(workspace, entry.id)).resolves.toBe(
      true,
    );
    await expect(forgetWorkspaceMemory(workspace, entry.id)).resolves.toBe(
      false,
    );
    await expect(loadWorkspaceMemory(workspace)).resolves.toEqual([]);
  });
});
