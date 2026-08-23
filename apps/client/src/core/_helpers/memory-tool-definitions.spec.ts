import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadWorkspaceMemory } from "../workspace-memory.ts";
import type { ConversationMemoryRuntime } from "./agent-tools-shared.ts";
import { createMemoryToolDefinitions } from "./memory-tool-definitions.ts";

const createMemoryRuntime = (): ConversationMemoryRuntime => ({
  sessionEnabled: true,
  sessionEntries: [],
  workspaceEnabled: true,
  workspaceEntries: [],
  globalEnabled: false,
  globalEntries: [],
});

const memoryArgs = (
  fact: string,
  key = "node-version",
): Record<string, unknown> => ({
  fact,
  memory_key: key,
  kind: "constraint",
  importance: 4,
  sensitivity: "non-sensitive",
});

describe("memory tool definitions", () => {
  it("exposes tools for enabled scopes only", () => {
    const names = createMemoryToolDefinitions(createMemoryRuntime()).map(
      (definition) => definition.spec.name,
    );

    expect(names).toEqual([
      "remember_session_memory",
      "remember_workspace_memory",
    ]);
  });

  it("replaces session facts by stable concept key", async () => {
    const workspaceRoot = await mkdtemp(
      join(tmpdir(), "machdoch-memory-tool-"),
    );
    const memory = createMemoryRuntime();
    const tool = createMemoryToolDefinitions(memory).find(
      (definition) => definition.spec.name === "remember_session_memory",
    );

    try {
      const first = await tool?.execute(memoryArgs("Use Node 20"), {
        workspaceRoot,
        memory,
      });
      const replacement = await tool?.execute(memoryArgs("Use Node 22"), {
        workspaceRoot,
        memory,
      });

      expect(first?.memoryUpdate?.entry.content).toBe("Use Node 20");
      expect(replacement?.memoryUpdate?.entry).toMatchObject({
        id: first?.memoryUpdate?.entry.id,
        key: "node-version",
        content: "Use Node 22",
      });
      expect(replacement?.sections[0]?.lines).toContain("status: replaced");
      expect(memory.sessionEntries).toHaveLength(1);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("persists workspace facts and rejects sensitive input", async () => {
    const workspaceRoot = await mkdtemp(
      join(tmpdir(), "machdoch-memory-tool-"),
    );
    const memory = createMemoryRuntime();
    const tool = createMemoryToolDefinitions(memory).find(
      (definition) => definition.spec.name === "remember_workspace_memory",
    );

    try {
      const saved = await tool?.execute(memoryArgs("Use Node 22 for builds"), {
        workspaceRoot,
        memory,
      });
      const rejected = await tool?.execute(
        {
          ...memoryArgs("The API key is secret", "api-key"),
          sensitivity: "sensitive",
        },
        { workspaceRoot, memory },
      );

      expect(saved?.memoryUpdate).toMatchObject({
        scope: "workspace",
        entry: { key: "node-version", content: "Use Node 22 for builds" },
      });
      expect(await loadWorkspaceMemory(workspaceRoot)).toHaveLength(1);
      expect(rejected?.toolResult.isError).toBe(true);
      expect(await loadWorkspaceMemory(workspaceRoot)).toHaveLength(1);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});
