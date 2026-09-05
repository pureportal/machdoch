import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProductCommand } from "@machdoch/fleet-protocol";
import { loadRuntimeConfig } from "../../core/config.ts";
import { FleetCliProductRuntime } from "./cli-fleet-product.ts";

describe("Fleet project task integration", () => {
  it("persists multiple workspaces, runs separate projects concurrently, and protects active or unknown workspaces", async () => {
    const root = await mkdtemp(join(tmpdir(), "machdoch-project-task-"));
    vi.stubEnv("MACHDOCH_USER_CONFIG_DIR", join(root, "config"));
    vi.stubEnv("MACHDOCH_WORKSPACE_ROOT", join(root, "projects"));
    const taskRoots: string[] = [];
    const runtime = await FleetCliProductRuntime.create(root, {
      loadRuntimeConfig: async (...args) => ({
        ...(await loadRuntimeConfig(...args)),
        provider: "openai",
        model: "gpt-5.4",
        offline: false,
        providerAvailability: [{ provider: "openai", configured: true }],
      }),
      createTaskExecutionController: (task, config) => {
        taskRoots.push(config.workspaceRoot);
        let finish!: () => void;
        const stopped = new Promise<void>((resolve) => {
          finish = resolve;
        });
        return {
          signal: new AbortController().signal,
          cancel: () => finish(),
          execute: async () => {
            await stopped;
            return {
              task,
              mode: config.mode,
              status: "cancelled",
              summary: "Stopped",
              executedTools: [],
              outputSections: [],
            };
          },
        };
      },
    });
    const execute = (command: ProductCommand) =>
      runtime.handleRequest({ type: "executeProductCommand", command });
    const snapshot = async () => {
      const response = await runtime.handleRequest({
        type: "getProductSnapshot",
      });
      if (response.type !== "productSnapshot" || !response.snapshot.shell)
        throw new Error(JSON.stringify(response));
      return response.snapshot.shell;
    };
    try {
      for (const name of ["one", "two"])
        expect(
          (
            await execute({
              kind: "create-project",
              commandId: `create-${name}`,
              name,
              initializeGit: false,
            })
          ).type,
        ).toBe("commandAccepted");
      await vi.waitFor(async () =>
        expect(
          (await snapshot()).projectLibrary?.projects.every(
            (project) => project.status === "ready",
          ),
        ).toBe(true),
      );
      const projects = (await snapshot()).projectLibrary!.projects;
      const one = projects.find((project) => project.name === "one")!;
      const two = projects.find((project) => project.name === "two")!;
      const sessions = [];
      for (const workspace of [one.workspace, one.workspace, two.workspace]) {
        expect(
          (await execute({ kind: "create-session", workspace })).type,
        ).toBe("commandAccepted");
        sessions.push((await snapshot()).activeSessionId!);
      }
      const submit = (sessionId: string) =>
        execute({
          kind: "submit-message",
          sessionId,
          prompt: "Work in this project",
          promptEnhancementMode: "off",
          interviewEnabled: false,
        });
      expect((await submit(sessions[0]!)).type).toBe("commandAccepted");
      expect(await submit(sessions[1]!)).toMatchObject({
        type: "error",
        code: "conflict",
      });
      await execute({ kind: "activate-session", sessionId: sessions[1]! });
      expect((await snapshot()).composer).toMatchObject({
        canSend: false,
        sendDisabledReason: "Another agent task is running in this project.",
      });
      expect((await submit(sessions[2]!)).type).toBe("commandAccepted");
      expect(taskRoots).toEqual([one.workspace, two.workspace]);
      expect(
        await execute({
          kind: "set-session-workspace",
          sessionId: sessions[0]!,
          workspace: two.workspace,
        }),
      ).toMatchObject({ type: "error", code: "conflict" });
      expect(
        await execute({ kind: "forget-project", projectId: one.id }),
      ).toMatchObject({ type: "error", code: "conflict" });
      expect(
        await execute({
          kind: "create-session",
          workspace: join(root, "outside"),
        }),
      ).toMatchObject({ type: "error", code: "invalidRequest" });
      expect(
        await execute({ kind: "create-session", commandId: "create-one" }),
      ).toMatchObject({ type: "error", code: "conflict" });
      await execute({ kind: "create-session", commandId: "session-id" });
      expect(
        await execute({
          kind: "create-project",
          commandId: "session-id",
          name: "collision",
          initializeGit: false,
        }),
      ).toMatchObject({ type: "error", code: "conflict" });
      await runtime.shutdown();
      const restored = await FleetCliProductRuntime.create(root);
      try {
        const response = await restored.handleRequest({
          type: "getProductSnapshot",
        });
        expect(response).toMatchObject({
          type: "productSnapshot",
          snapshot: {
            shell: {
              projectLibrary: {
                projects: expect.arrayContaining([
                  expect.objectContaining({ name: "one", status: "ready" }),
                  expect.objectContaining({ name: "two", status: "ready" }),
                ]),
              },
              sessions: expect.arrayContaining([
                expect.objectContaining({ workspace: one.workspace }),
                expect.objectContaining({ workspace: two.workspace }),
              ]),
            },
          },
        });
      } finally {
        await restored.shutdown();
      }
    } finally {
      await runtime.shutdown();
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  });
});
