import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { productSnapshotSchema } from "@machdoch/fleet-protocol";
import { loadRuntimeConfig } from "../../core/config.js";
import {
  FleetCliProductRuntime,
  pruneCompletedFleetTaskSessions,
} from "./cli-fleet-product.ts";
import { getFleetCliStatePath } from "./cli-fleet-state.ts";

const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe.sequential("Fleet CLI product runtime", () => {
  it("bounds completed task diagnostics without discarding active tasks", () => {
    const taskSessions = new Map([
      ["completed-old", { updatedAt: 1 }],
      ["active-old", { updatedAt: 2 }],
      ["completed-middle", { updatedAt: 3 }],
      ["completed-new", { updatedAt: 4 }],
    ]);

    pruneCompletedFleetTaskSessions(taskSessions, new Set(["active-old"]), 3);

    expect([...taskSessions.keys()]).toEqual([
      "active-old",
      "completed-middle",
      "completed-new",
    ]);

    const activeTasks = new Set(taskSessions.keys());
    taskSessions.set("completed-extra", { updatedAt: 5 });
    pruneCompletedFleetTaskSessions(taskSessions, activeTasks, 2);

    expect([...taskSessions.keys()]).toEqual([
      "active-old",
      "completed-middle",
      "completed-new",
    ]);
  });

  it("hosts persistent product snapshots and idempotent commands without Tauri", async () => {
    const root = await mkdtemp(join(tmpdir(), "machdoch-fleet-product-"));
    roots.push(root);
    vi.stubEnv("MACHDOCH_USER_CONFIG_DIR", join(root, "config"));
    const workspace = join(root, "workspace");
    const runtime = await FleetCliProductRuntime.create(workspace);

    const first = await runtime.handleRequest({
      type: "executeProductCommand",
      command: {
        kind: "create-session",
        commandId: "command-create-session",
      },
    });
    const duplicate = await runtime.handleRequest({
      type: "executeProductCommand",
      command: {
        kind: "create-session",
        commandId: "command-create-session",
      },
    });
    expect(first).toEqual({
      type: "commandAccepted",
      receipt: { commandId: "command-create-session", duplicate: false },
    });
    expect(duplicate).toEqual({
      type: "commandAccepted",
      receipt: { commandId: "command-create-session", duplicate: true },
    });

    const response = await runtime.handleRequest({
      type: "getProductSnapshot",
    });
    expect(response.type).toBe("productSnapshot");
    if (response.type !== "productSnapshot") return;
    expect(productSnapshotSchema.safeParse(response.snapshot).success).toBe(
      true,
    );
    expect(response.snapshot.shell?.sessions).toHaveLength(2);
    expect(response.snapshot.shell?.workspaces).toEqual([
      expect.objectContaining({ root: workspace, sessionCount: 2 }),
    ]);
    const activeSessionId = response.snapshot.shell?.activeSessionId;
    expect(activeSessionId).toBeTruthy();
    if (!activeSessionId) return;

    await runtime.handleRequest({
      type: "executeProductCommand",
      command: {
        kind: "set-workspace-memory",
        commandId: "command-disable-workspace-memory",
        sessionId: activeSessionId,
        enabled: false,
      },
    });

    const updated = await runtime.handleRequest({
      type: "getProductSnapshot",
    });
    expect(
      updated.type === "productSnapshot"
        ? updated.snapshot.shell?.composer
        : undefined,
    ).toMatchObject({
      workspaceMemoryAvailable: true,
      workspaceMemoryEnabled: false,
    });
    await expect(
      readFile(getFleetCliStatePath(workspace), "utf8"),
    ).resolves.toContain('"useWorkspaceMemory": false');
    await runtime.shutdown();
  });

  it("publishes and forgets session memory through Fleet commands", async () => {
    const root = await mkdtemp(join(tmpdir(), "machdoch-fleet-memory-"));
    roots.push(root);
    vi.stubEnv("MACHDOCH_USER_CONFIG_DIR", join(root, "config"));
    const workspace = join(root, "workspace");
    const runtime = await FleetCliProductRuntime.create(workspace, {
      loadRuntimeConfig: async (...arguments_) => ({
        ...(await loadRuntimeConfig(...arguments_)),
        provider: "openai",
        model: "gpt-5.4",
        offline: false,
        providerAvailability: [{ provider: "openai", configured: true }],
      }),
      createTaskExecutionController: (
        task,
        config,
        _customizations,
        options,
      ) => {
        const sourceSessionId = options?.conversationContext?.sessionId;
        const abortController = new AbortController();
        return {
          signal: abortController.signal,
          cancel: (reason?: string) => abortController.abort(reason),
          execute: async () => ({
            task,
            mode: config.mode,
            status: "executed" as const,
            summary: "Done",
            executedTools: [],
            outputSections: [],
            memoryUpdates: [
              {
                scope: "session" as const,
                entry: {
                  id: "memory-1",
                  scope: "session" as const,
                  ...(sourceSessionId ? { sourceSessionId } : {}),
                  key: "package-manager",
                  kind: "fact" as const,
                  content: "Package manager: pnpm",
                  searchTerms: ["package manager"],
                  importance: 3,
                  confidence: 1,
                  createdAt: 100,
                  updatedAt: 100,
                },
              },
            ],
          }),
        };
      },
    });
    const initial = await runtime.handleRequest({ type: "getProductSnapshot" });
    expect(initial.type).toBe("productSnapshot");
    if (initial.type !== "productSnapshot") return;
    const sessionId = initial.snapshot.shell?.activeSessionId;
    expect(sessionId).toBeTruthy();
    if (!sessionId) return;

    await runtime.handleRequest({
      type: "executeProductCommand",
      command: {
        kind: "submit-message",
        commandId: "command-remember",
        sessionId,
        prompt: "Remember package manager",
        promptEnhancementMode: "off",
        interviewEnabled: false,
      },
    });

    let sessionMemory = initial.snapshot.shell?.composer?.sessionMemory ?? [];
    for (
      let attempt = 0;
      attempt < 10 && sessionMemory.length === 0;
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      const response = await runtime.handleRequest({
        type: "getProductSnapshot",
      });
      if (response.type === "productSnapshot") {
        sessionMemory = response.snapshot.shell?.composer?.sessionMemory ?? [];
      }
    }

    expect(sessionMemory).toEqual([
      expect.objectContaining({
        id: "memory-1",
        content: "Package manager: pnpm",
        sourceSession: {
          id: sessionId,
          title: "Remember package manager",
        },
      }),
    ]);

    const forgotten = await runtime.handleRequest({
      type: "executeProductCommand",
      command: {
        kind: "forget-session-memory",
        commandId: "command-forget-memory",
        sessionId,
        memoryId: "memory-1",
      },
    });
    expect(forgotten).toEqual({
      type: "commandAccepted",
      receipt: { commandId: "command-forget-memory", duplicate: false },
    });

    const final = await runtime.handleRequest({ type: "getProductSnapshot" });
    expect(
      final.type === "productSnapshot"
        ? final.snapshot.shell?.composer?.sessionMemory
        : undefined,
    ).toEqual([]);

    const retainedSessionMemory = (
      runtime as unknown as {
        sessionMemory: Map<string, unknown>;
      }
    ).sessionMemory;
    expect(retainedSessionMemory.has(sessionId)).toBe(true);

    await runtime.handleRequest({
      type: "executeProductCommand",
      command: {
        kind: "delete-session",
        commandId: "command-delete-session",
        sessionId,
      },
    });

    expect(retainedSessionMemory.has(sessionId)).toBe(false);
    await runtime.shutdown();
  });
});
