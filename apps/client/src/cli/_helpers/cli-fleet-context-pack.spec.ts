import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  managedSettingsDocumentSchema,
  type ProductCommand,
} from "@machdoch/fleet-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadRuntimeConfig } from "../../core/config.js";
import { createTaskExecutionController } from "../../core/execution.js";
import {
  loadFleetManagedProfile,
  type FleetManagedProfile,
} from "../../core/fleet-settings.js";
import { FleetCliProductRuntime } from "./cli-fleet-product.ts";
import {
  FLEET_CLI_STATE_SCHEMA_VERSION,
  captureFleetPackSettings,
  loadFleetCliState,
  resetTemporaryFleetPackSettings,
  saveFleetCliState,
  type FleetCliSession,
  type FleetCliState,
} from "./cli-fleet-state.ts";

vi.mock("../../core/fleet-settings.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../core/fleet-settings.js")>()),
  loadFleetManagedProfile: vi.fn<typeof loadFleetManagedProfile>(),
}));

const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.mocked(loadFleetManagedProfile).mockReset();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const createWorkspace = async () => {
  const root = await mkdtemp(join(tmpdir(), "machdoch-fleet-context-pack-"));
  roots.push(root);
  vi.stubEnv("MACHDOCH_USER_CONFIG_DIR", join(root, "config"));
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  return workspace;
};

const createPackRuntime = async () => {
  const workspace = await createWorkspace();
  const packId = crypto.randomUUID();
  const profile: FleetManagedProfile = {
    profileId: "profile_abcdefghijklmnopqrstuvwx",
    name: "Context packs",
    revision: 1,
    secrets: {},
    document: managedSettingsDocumentSchema.parse({
      defaults: {
        provider: null,
        model: null,
        mode: null,
        reasoning: null,
        webSearchProvider: null,
        theme: null,
        density: null,
        accent: null,
      },
      agentLimits: {
        infinite: null,
        executorTurns: null,
        autopilotExecutorIterations: null,
      },
      instructions: [],
      prompts: [],
      contextPacks: [
        {
          id: packId,
          name: "Temporary review",
          instructions: "",
          prompt: "Review the workspace",
          provider: "codex-cli",
          model: "gpt-5.4",
          mode: null,
          reasoning: null,
          contextWindow: "highest",
          temporary: true,
          variables: [],
          triggerPhrases: [],
          pathPatterns: [],
          promptEnhancementMode: "off",
          interviewEnabled: false,
          sessionMemoryEnabled: false,
          useWorkspaceMemory: false,
          useGlobalMemory: null,
          uiControlEnabled: false,
        },
      ],
    }),
  };
  vi.mocked(loadFleetManagedProfile).mockResolvedValue(profile);
  const executions: Array<{
    controller: ReturnType<typeof createTaskExecutionController>;
    finish: () => void;
  }> = [];
  const createController = vi.fn<typeof createTaskExecutionController>(
    (task, config) => {
      const abortController = new AbortController();
      let finish: () => void = () => undefined;
      const completion = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const controller = {
        signal: abortController.signal,
        cancel: vi.fn((reason?: string) => abortController.abort(reason)),
        execute: vi.fn(async () => {
          await completion;
          return {
            task,
            mode: config.mode,
            status: "executed" as const,
            summary: "Review complete",
            executedTools: [],
            outputSections: [],
          };
        }),
      };
      executions.push({ controller, finish });
      return controller;
    },
  );
  const runtime = await FleetCliProductRuntime.create(workspace, {
    loadRuntimeConfig: async (...arguments_) => ({
      ...(await loadRuntimeConfig(...arguments_)),
      provider: "codex-cli",
      model: "gpt-5.4",
      offline: false,
      providerAvailability: [{ provider: "codex-cli", configured: true }],
    }),
    createTaskExecutionController: createController,
  });
  return {
    runtime,
    workspace,
    createController,
    executions,
    contextPackId: `fleet:${profile.profileId}:${packId}`,
    execute: async (command: ProductCommand) => {
      expect(
        await runtime.handleRequest({ type: "executeProductCommand", command }),
      ).toMatchObject({ type: "commandAccepted" });
    },
    composer: async () => {
      const response = await runtime.handleRequest({
        type: "getProductSnapshot",
      });
      if (
        response.type !== "productSnapshot" ||
        !response.snapshot.shell?.composer
      )
        throw new Error("Session composer is missing.");
      return response.snapshot.shell.composer;
    },
    shutdown: async () => {
      for (const execution of executions) execution.finish();
      await runtime.shutdown();
    },
  };
};

describe.sequential("Fleet temporary context packs", () => {
  it.each([
    {
      name: "restores an unset context size after the first task is accepted",
      previousContext: undefined,
      manualContext: undefined,
    },
    {
      name: "restores the previous context size after the first task is accepted",
      previousContext: "lowest" as const,
      manualContext: undefined,
    },
    {
      name: "preserves a manual context change made after applying the pack",
      previousContext: "lowest" as const,
      manualContext: "default" as const,
    },
  ])("$name", async ({ previousContext, manualContext }) => {
    const fixture = await createPackRuntime();
    const { execute, composer, createController, executions, workspace } =
      fixture;
    try {
      const { sessionId } = await composer();
      if (previousContext !== undefined)
        await execute({
          kind: "set-session-context-window",
          sessionId,
          mode: previousContext,
        });
      await execute({
        kind: "apply-context-pack",
        sessionId,
        contextPackId: fixture.contextPackId,
      });
      expect(await composer()).toMatchObject({
        contextWindow: "highest",
        sessionMemoryEnabled: false,
      });
      if (manualContext !== undefined)
        await execute({
          kind: "set-session-context-window",
          sessionId,
          mode: manualContext,
        });

      await execute({
        kind: "submit-message",
        sessionId,
        prompt: "Review the workspace",
        promptEnhancementMode: "off",
        interviewEnabled: false,
      });
      expect(createController).toHaveBeenCalledOnce();
      expect(createController).toHaveBeenNthCalledWith(
        1,
        "Review the workspace",
        expect.objectContaining({ provider: "codex-cli", model: "gpt-5.4" }),
        expect.anything(),
        expect.objectContaining({
          conversationContext: expect.objectContaining({
            contextWindow: manualContext ?? "highest",
            sessionMemoryEnabled: false,
            workspaceMemoryEnabled: false,
          }),
        }),
      );
      const first = executions[0];
      if (!first) throw new Error("The first task did not start.");
      expect(first.controller.execute).toHaveBeenCalledOnce();
      const restoredContext = manualContext ?? previousContext;
      const runningComposer = await composer();
      expect(runningComposer.contextWindow).toBe(restoredContext);
      expect(runningComposer).toMatchObject({
        isExecuting: true,
        sessionMemoryEnabled: true,
      });
      const persisted = (await loadFleetCliState(workspace))?.sessions[0];
      expect(persisted).toMatchObject({
        sessionMemoryEnabled: true,
        useWorkspaceMemory: true,
        pendingTask: { prompt: "Review the workspace" },
      });
      expect(persisted?.contextWindow).toBe(restoredContext);
      expect(persisted).not.toHaveProperty("temporaryPackSettings");

      first.finish();
      await Promise.all(
        (
          fixture.runtime as unknown as {
            taskSettlements: Map<string, Promise<unknown>>;
          }
        ).taskSettlements.values(),
      );
      expect(await composer()).toMatchObject({ isExecuting: false });
      await execute({
        kind: "submit-message",
        sessionId,
        prompt: "Review the follow-up",
        promptEnhancementMode: "off",
        interviewEnabled: false,
      });
      expect(createController).toHaveBeenCalledTimes(2);
      const nextContext =
        createController.mock.calls[1]?.[3]?.conversationContext;
      expect(nextContext).toMatchObject({
        sessionMemoryEnabled: true,
        workspaceMemoryEnabled: true,
      });
      if (restoredContext === undefined)
        expect(nextContext).not.toHaveProperty("contextWindow");
      else expect(nextContext).toHaveProperty("contextWindow", restoredContext);
    } finally {
      await fixture.shutdown();
    }
  });

  it("round-trips an unset previous context size and restores it", async () => {
    const workspace = await createWorkspace();
    const session: FleetCliSession = {
      id: crypto.randomUUID(),
      title: "Temporary pack",
      workspace,
      provider: "codex-cli",
      model: "gpt-5.4",
      mode: "machdoch",
      parallelAgentMode: "disabled",
      reasoning: "medium",
      createdAt: 1,
      updatedAt: 1,
      tags: [],
      draft: "",
      promptHistory: [],
      sessionMemoryEnabled: true,
      useWorkspaceMemory: true,
      globalMemoryEnabled: true,
      messages: [],
    };
    const previous = captureFleetPackSettings(session);
    session.contextWindow = "highest";
    session.useWorkspaceMemory = false;
    session.temporaryPackSettings = {
      previous,
      applied: captureFleetPackSettings(session),
    };
    const state: FleetCliState = {
      schemaVersion: FLEET_CLI_STATE_SCHEMA_VERSION,
      workspaceRoot: workspace,
      activeSessionId: session.id,
      sessions: [session],
      commands: [],
    };

    await saveFleetCliState(state);
    const restored = await loadFleetCliState(workspace);
    const restoredSession = restored?.sessions[0];
    if (!restored || !restoredSession)
      throw new Error("Session state is missing.");
    expect(restoredSession.contextWindow).toBe("highest");
    expect(restoredSession.temporaryPackSettings).toEqual({
      previous,
      applied: captureFleetPackSettings(session),
    });
    expect(
      restoredSession.temporaryPackSettings?.previous.contextWindow,
    ).toBeUndefined();

    resetTemporaryFleetPackSettings(restoredSession);
    expect(captureFleetPackSettings(restoredSession)).toEqual(previous);
    expect(Object.hasOwn(restoredSession, "contextWindow")).toBe(false);
    expect(Object.hasOwn(restoredSession, "temporaryPackSettings")).toBe(false);

    await saveFleetCliState(restored);
    const savedSession = (await loadFleetCliState(workspace))?.sessions[0];
    expect(savedSession).toMatchObject({ useWorkspaceMemory: true });
    expect(savedSession).not.toHaveProperty("contextWindow");
    expect(savedSession).not.toHaveProperty("temporaryPackSettings");
  });
});
