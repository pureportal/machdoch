import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  disableInvokeMock,
  enableInvokeMock,
  convertFileSrcMock,
  invokeMock,
  isTauriMock,
  openUrlMock,
} from "./test/tauri-test-mocks";
import {
  authorizeMcpOAuth,
  cancelDesktopTask,
  beginMcpOAuth,
  createInstruction,
  createMcpConfigRawWithPreset,
  generateInstruction,
  detectFullscreenWindowOnMonitor,
  discoverMcpServer,
  disableRemoteControlServer,
  enableRemoteControlServer,
  finishMcpOAuth,
  forgetRemoteControlPairings,
  getRemoteControlStatus,
  loadActiveDesktopTaskIds,
  loadActiveDesktopTasks,
  loadDesktopLaunchId,
  loadRecentDesktopTaskResults,
  listMcpCachedCapabilities,
  listMcpServers,
  listInstructions,
  loadMcpConfigDocument,
  loadProviderModelCatalog,
  openAttachedPath,
  openExternalUrl,
  openRalphFlowInExplorer,
  openRemoteControlUrl,
  createRalphFlow,
  deleteRalphFlow,
  listRalphFlowRevisions,
  restoreRalphFlowRevision,
  saveRalphFlow,
  setRemoteControlPort,
  loadUserReviewModelSettings,
  resolveDroppedPaths,
  refreshMcpDiscoveryCache,
  resumeRalphRun,
  runRalphFlow,
  runDesktopTask,
  saveClipboardImageAttachment,
  saveInstruction,
  saveMcpConfigDocument,
  saveUserReviewModelSettings,
  saveUserSpeechToTextInputDevice,
  showRalphRunDetail,
  resolveAttachedImagePreviewSource,
  subscribeToRemoteControlCommands,
} from "./runtime";
import {
  desktopEventListeners,
  listenMock,
} from "./test/tauri-test-mocks";

describe("desktop runtime fullscreen detection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    enableInvokeMock();
    isTauriMock.mockReturnValue(true);
    invokeMock.mockResolvedValue(false);
  });

  afterEach(() => {
    disableInvokeMock();
  });

  it("passes monitor bounds under the Rust command's monitor parameter", async () => {
    const monitor = { x: 0, y: 0, width: 1920, height: 1080 };

    invokeMock.mockResolvedValueOnce(true);

    await expect(detectFullscreenWindowOnMonitor(monitor)).resolves.toBe(true);
    expect(invokeMock).toHaveBeenCalledWith(
      "detect_fullscreen_window_on_monitor",
      { monitor },
    );
  });

  it("falls back to visible when Tauri commands are unavailable", async () => {
    disableInvokeMock();

    await expect(
      detectFullscreenWindowOnMonitor({ x: 0, y: 0, width: 1920, height: 1080 }),
    ).resolves.toBe(false);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("loads the desktop launch ID through the Tauri runtime", async () => {
    invokeMock.mockResolvedValueOnce("launch-123");

    await expect(loadDesktopLaunchId()).resolves.toBe("launch-123");
    expect(invokeMock).toHaveBeenCalledWith("get_desktop_launch_id");
  });

  it("loads active desktop task IDs through the Tauri runtime", async () => {
    invokeMock.mockResolvedValueOnce(["task-2", "task-1"]);

    await expect(loadActiveDesktopTaskIds()).resolves.toEqual([
      "task-2",
      "task-1",
    ]);
    expect(invokeMock).toHaveBeenCalledWith("get_active_desktop_task_ids");
  });

  it("loads active desktop task metadata through the Tauri runtime", async () => {
    invokeMock.mockResolvedValueOnce([
      {
        id: "ralph-task",
        kind: "ralph",
        workspaceRoot: "C:\\Project",
        arguments: ["run", "flow-id"],
        startedAt: 123,
      },
    ]);

    await expect(loadActiveDesktopTasks()).resolves.toEqual([
      {
        id: "ralph-task",
        kind: "ralph",
        workspaceRoot: "C:\\Project",
        arguments: ["run", "flow-id"],
        startedAt: 123,
      },
    ]);
    expect(invokeMock).toHaveBeenCalledWith("get_active_desktop_tasks");
  });

  it("loads recent desktop task results through the Tauri runtime", async () => {
    const results = [
      {
        id: "task-123",
        kind: "desktop",
        workspaceRoot: "C:\\Docs",
        arguments: [],
        startedAt: 100,
        finishedAt: 200,
        outcome: {
          status: "succeeded",
          response: {
            execution: {
              task: "Inspect notes",
              mode: "ask",
              status: "executed",
              summary: "Done.",
              executedTools: [],
              outputSections: [],
            },
          },
        },
      },
    ];

    invokeMock.mockResolvedValueOnce(results);

    await expect(
      loadRecentDesktopTaskResults([" task-123 ", "", "task-456"]),
    ).resolves.toEqual(results);
    expect(invokeMock).toHaveBeenCalledWith(
      "get_recent_desktop_task_results",
      {
        taskIds: ["task-123", "task-456"],
      },
    );
  });

  it("loads the provider model catalog through the Tauri runtime", async () => {
    invokeMock.mockResolvedValueOnce({
      generatedAt: 123,
      providers: [
        {
          provider: "openai",
          source: "provider-api",
          available: true,
          models: [],
        },
      ],
    });

    await expect(loadProviderModelCatalog()).resolves.toMatchObject({
      generatedAt: 123,
      providers: [
        {
          provider: "openai",
          available: true,
        },
      ],
    });
    expect(invokeMock).toHaveBeenCalledWith("get_provider_model_catalog");
  });

  it("stages MCP preset server config in visible JSON", () => {
    const raw = createMcpConfigRawWithPreset(
      '{ "schemaVersion": 1, "servers": [] }',
      "serper-search",
    );
    const parsed = JSON.parse(raw) as {
      servers: Array<{
        id: string;
        preset: string;
        enabled: boolean;
        transport: { type: string; command: string };
      }>;
    };

    expect(parsed.servers).toHaveLength(1);
    expect(parsed.servers[0]).toMatchObject({
      id: "serper",
      preset: "serper-search",
      enabled: true,
      transport: {
        type: "stdio",
        command: "npx",
      },
    });
  });

  it("stages the Tauri MCP server preset in visible JSON", () => {
    const raw = createMcpConfigRawWithPreset(
      '{ "schemaVersion": 1, "servers": [] }',
      "tauri-mcp-server",
    );
    const parsed = JSON.parse(raw) as {
      servers: Array<{
        id: string;
        preset: string;
        enabled: boolean;
        transport: {
          type: string;
          command: string;
          args: string[];
          cwd: string;
          inheritEnvironment: boolean;
        };
      }>;
    };

    expect(parsed.servers).toHaveLength(1);
    expect(parsed.servers[0]).toMatchObject({
      id: "tauri",
      preset: "tauri-mcp-server",
      enabled: true,
      transport: {
        type: "stdio",
        command: "npx",
        args: ["-y", "@hypothesi/tauri-mcp-server"],
        cwd: "${workspaceRoot}",
        inheritEnvironment: true,
      },
    });
  });

  it("loads and saves workspace MCP config through Tauri commands", async () => {
    invokeMock
      .mockResolvedValueOnce({
        scope: "workspace",
        path: "C:\\Project\\.machdoch\\mcp\\mcp.json",
        exists: false,
        raw: '{\n  "schemaVersion": 1,\n  "servers": []\n}\n',
      })
      .mockResolvedValueOnce({
        scope: "workspace",
        path: "C:\\Project\\.machdoch\\mcp\\mcp.json",
        exists: true,
        raw: '{\n  "schemaVersion": 1,\n  "servers": []\n}\n',
      });

    await expect(loadMcpConfigDocument("workspace", "C:\\Project")).resolves.toMatchObject({
      scope: "workspace",
      exists: false,
    });
    await expect(
      saveMcpConfigDocument(
        "workspace",
        '{ "schemaVersion": 1, "servers": [] }',
        "C:\\Project",
      ),
    ).resolves.toMatchObject({
      scope: "workspace",
      exists: true,
    });

    expect(invokeMock).toHaveBeenNthCalledWith(
      1,
      "get_workspace_mcp_config_document",
      { workspaceRoot: "C:\\Project" },
    );
    expect(invokeMock).toHaveBeenNthCalledWith(
      2,
      "save_workspace_mcp_config_document",
      {
        workspaceRoot: "C:\\Project",
        raw: '{\n  "schemaVersion": 1,\n  "servers": []\n}\n',
      },
    );
  });

  it("runs MCP management commands through the desktop bridge", async () => {
    invokeMock
      .mockResolvedValueOnce({
        workspaceRoot: "C:\\Project",
        servers: [],
      })
      .mockResolvedValueOnce({
        workspaceRoot: "C:\\Project",
        servers: {},
      })
      .mockResolvedValueOnce({
        workspaceRoot: "C:\\Project",
        discovery: { serverId: "serper" },
        cachePath: null,
      })
      .mockResolvedValueOnce({
        workspaceRoot: "C:\\Project",
        discovery: { serverId: "serper" },
        cachePath: "C:\\Project\\.machdoch\\mcp\\discovery-cache.json",
      })
      .mockResolvedValueOnce({
        workspaceRoot: "C:\\Project",
        result: {
          serverId: "github",
          status: "authorization-required",
          configPath: "C:\\Users\\Test\\AppData\\Roaming\\machdoch\\mcp.json",
          authorizationUrl: "https://github.com/login/oauth/authorize",
        },
      })
      .mockResolvedValueOnce({
        workspaceRoot: "C:\\Project",
        result: {
          serverId: "github",
          status: "authorized",
          configPath: "C:\\Users\\Test\\AppData\\Roaming\\machdoch\\mcp.json",
          stateVerified: true,
        },
      })
      .mockResolvedValueOnce({
        workspaceRoot: "C:\\Project",
        result: {
          serverId: "github",
          status: "authorized",
          configPath: "C:\\Users\\Test\\AppData\\Roaming\\machdoch\\mcp.json",
          stateVerified: true,
        },
      });

    await listMcpServers("C:\\Project", true);
    await listMcpCachedCapabilities("C:\\Project");
    await discoverMcpServer("C:\\Project", "serper");
    await refreshMcpDiscoveryCache("C:\\Project", "serper");
    await beginMcpOAuth("C:\\Project", "github");
    await authorizeMcpOAuth("C:\\Project", "github");
    await finishMcpOAuth(
      "C:\\Project",
      "github",
      "http://127.0.0.1:43110/oauth/callback?code=abc&state=xyz",
    );

    expect(invokeMock).toHaveBeenNthCalledWith(1, "run_mcp_command", {
      request: {
        workspaceRoot: "C:\\Project",
        arguments: ["servers", "--include-disabled"],
      },
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "run_mcp_command", {
      request: {
        workspaceRoot: "C:\\Project",
        arguments: ["cache"],
      },
    });
    expect(invokeMock).toHaveBeenNthCalledWith(3, "run_mcp_command", {
      request: {
        workspaceRoot: "C:\\Project",
        arguments: ["discover", "serper"],
      },
    });
    expect(invokeMock).toHaveBeenNthCalledWith(4, "run_mcp_command", {
      request: {
        workspaceRoot: "C:\\Project",
        arguments: ["refresh", "serper"],
      },
    });
    expect(invokeMock).toHaveBeenNthCalledWith(5, "run_mcp_command", {
      request: {
        workspaceRoot: "C:\\Project",
        arguments: ["oauth-start", "github"],
      },
    });
    expect(invokeMock).toHaveBeenNthCalledWith(6, "run_mcp_command", {
      request: {
        workspaceRoot: "C:\\Project",
        arguments: ["oauth-authorize", "github"],
      },
    });
    expect(invokeMock).toHaveBeenNthCalledWith(7, "run_mcp_command", {
      request: {
        workspaceRoot: "C:\\Project",
        arguments: [
          "oauth-finish",
          "github",
          "http://127.0.0.1:43110/oauth/callback?code=abc&state=xyz",
        ],
      },
    });
  });

  it("runs instruction management commands through the desktop bridge", async () => {
    invokeMock
      .mockResolvedValueOnce({
        workspaceRoot: "C:\\Project",
        instructions: [],
        diagnostics: [],
      })
      .mockResolvedValueOnce({
        path: "C:\\Project\\.machdoch\\instructions\\new-review.instructions.md",
        scope: "workspace",
        name: "New Review",
        created: true,
      })
      .mockResolvedValueOnce({
        path: "C:\\Project\\.machdoch\\instructions\\review.instructions.md",
        scope: "workspace",
        name: "Review Rules",
        created: false,
      })
      .mockResolvedValueOnce({
        status: "updated",
        path: "C:\\Project\\.machdoch\\instructions\\review.instructions.md",
        scope: "workspace",
        name: "Review Rules",
        rounds: 2,
        validation: { valid: true, diagnostics: [] },
        generatorResults: [],
        summary: "Updated workspace instruction.",
      });

    await listInstructions("C:\\Project");
    await createInstruction("C:\\Project", {
      name: "New Review",
      prompt: "Prefer focused tests.",
      scope: "workspace",
      maxRounds: 3,
    });
    await saveInstruction("C:\\Project", {
      name: "Review Rules",
      prompt: "Prefer strict TypeScript.",
      path: ".machdoch/instructions/review.instructions.md",
      scope: "workspace",
      mode: "auto",
      audience: "executor",
      applyTo: ["src/**/*.ts"],
      exclude: ["dist/**"],
      keywords: ["review"],
      priority: 40,
      maxRounds: 3,
    });
    await generateInstruction("C:\\Project", {
      name: "Review Rules",
      prompt: "Create durable review instructions.",
      path: ".machdoch/instructions/review.instructions.md",
      scope: "workspace",
      maxRounds: 2,
    });

    expect(invokeMock).toHaveBeenNthCalledWith(1, "run_instruction_command", {
      request: {
        workspaceRoot: "C:\\Project",
        arguments: ["list"],
      },
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "run_instruction_command", {
      request: {
        workspaceRoot: "C:\\Project",
        arguments: [
          "create",
          "New Review",
          "--prompt",
          "Prefer focused tests.",
          "--scope",
          "workspace",
        ],
      },
    });
    expect(invokeMock).toHaveBeenNthCalledWith(3, "run_instruction_command", {
      request: {
        workspaceRoot: "C:\\Project",
        arguments: [
          "save",
          "Review Rules",
          "--prompt",
          "Prefer strict TypeScript.",
          "--path",
          ".machdoch/instructions/review.instructions.md",
          "--scope",
          "workspace",
          "--instruction-mode",
          "auto",
          "--audience",
          "executor",
          "--priority",
          "40",
          "--apply-to",
          "src/**/*.ts",
          "--exclude",
          "dist/**",
          "--keyword",
          "review",
        ],
      },
    });
    expect(invokeMock).toHaveBeenNthCalledWith(4, "run_instruction_command", {
      request: {
        workspaceRoot: "C:\\Project",
        arguments: [
          "generate",
          "Review Rules",
          "--prompt",
          "Create durable review instructions.",
          "--path",
          ".machdoch/instructions/review.instructions.md",
          "--scope",
          "workspace",
          "--max-rounds",
          "2",
        ],
      },
    });
  });

  it("passes active runtime options to Ralph flow creation", async () => {
    invokeMock.mockResolvedValueOnce({
      status: "created",
      flowPath: "C:\\Project\\.machdoch\\ralph\\flows\\refactor.json",
      rounds: 1,
      validation: {
        valid: true,
        errors: [],
        warnings: [],
        errorIssues: [],
        warningIssues: [],
        variables: [],
      },
      summary: "Created.",
      flow: null,
    });

    await createRalphFlow("C:\\Project", {
      name: "refactor",
      prompt: "Refactor imports",
      existingFlow: {
        schemaVersion: 1,
        id: "refactor",
        name: "Refactor",
        blocks: [],
        edges: [],
      },
      target: "refactor",
      generationMode: "do-it",
      mode: "machdoch",
      provider: "openai",
      model: "gpt-5.5",
      maxRounds: 2,
      taskId: "ralph-generation-task",
    });

    expect(invokeMock).toHaveBeenCalledWith("run_ralph_command", {
      request: {
        workspaceRoot: "C:\\Project",
        arguments: [
          "create",
          "--mode",
          "machdoch",
          "--runtime-provider",
          "openai",
          "--model",
          "gpt-5.5",
          "--name",
          "refactor",
          "--prompt",
          "Refactor imports",
          "--existing-flow-json",
          JSON.stringify({
            schemaVersion: 1,
            id: "refactor",
            name: "Refactor",
            blocks: [],
            edges: [],
          }),
          "--flow-target",
          "refactor",
          "--generation-mode",
          "do-it",
          "--max-rounds",
          "2",
        ],
        taskId: "ralph-generation-task",
      },
    });
  });

  it("saves edited Ralph flows through the desktop command bridge", async () => {
    invokeMock.mockResolvedValueOnce({
      path: "C:\\Project\\.machdoch\\ralph\\flows\\refactor.json",
      flow: {
        schemaVersion: 1,
        id: "refactor",
        name: "Refactor",
        blocks: [],
        edges: [],
      },
      validation: {
        valid: true,
        errors: [],
        warnings: [],
        errorIssues: [],
        warningIssues: [],
        variables: [],
      },
    });

    await saveRalphFlow("C:\\Project", {
      flow: {
        schemaVersion: 1,
        id: "refactor",
        name: "Refactor",
        blocks: [],
        edges: [],
      },
    });

    expect(invokeMock).toHaveBeenCalledWith("run_ralph_command", {
      request: {
        workspaceRoot: "C:\\Project",
        arguments: [
          "save",
          "refactor",
          "--flow-json",
          JSON.stringify({
            schemaVersion: 1,
            id: "refactor",
            name: "Refactor",
            blocks: [],
            edges: [],
          }),
        ],
      },
    });
  });

  it("deletes Ralph flows through the desktop command bridge", async () => {
    invokeMock.mockResolvedValueOnce({
      id: "refactor",
      path: "C:\\Project\\.machdoch\\ralph\\flows\\refactor.json",
      revisionDirectory: "C:\\Project\\.machdoch\\ralph\\revisions\\refactor",
      deletedRevisions: true,
    });

    await deleteRalphFlow("C:\\Project", "refactor");

    expect(invokeMock).toHaveBeenCalledWith("run_ralph_command", {
      request: {
        workspaceRoot: "C:\\Project",
        arguments: ["delete", "refactor"],
      },
    });
  });

  it("lists Ralph flow revisions through the desktop command bridge", async () => {
    invokeMock.mockResolvedValueOnce({
      flow: "refactor",
      revisions: [
        {
          id: "2026-06-13T10-00-00-000Z",
          path: "C:\\Project\\.machdoch\\ralph\\revisions\\refactor\\2026-06-13T10-00-00-000Z.json",
          createdAt: "2026-06-13T10:00:00.000Z",
          flowName: "Refactor",
          blockCount: 4,
          edgeCount: 4,
          valid: true,
        },
      ],
    });

    await listRalphFlowRevisions("C:\\Project", "refactor");

    expect(invokeMock).toHaveBeenCalledWith("run_ralph_command", {
      request: {
        workspaceRoot: "C:\\Project",
        arguments: ["revisions", "refactor"],
      },
    });
  });

  it("restores Ralph flow revisions through the desktop command bridge", async () => {
    invokeMock.mockResolvedValueOnce({
      path: "C:\\Project\\.machdoch\\ralph\\flows\\refactor.json",
      flow: {
        schemaVersion: 1,
        id: "refactor",
        name: "Refactor",
        blocks: [],
        edges: [],
      },
      validation: {
        valid: true,
        errors: [],
        warnings: [],
        errorIssues: [],
        warningIssues: [],
        variables: [],
      },
      revision: {
        id: "2026-06-13T10-00-00-000Z",
        path: "C:\\Project\\.machdoch\\ralph\\revisions\\refactor\\2026-06-13T10-00-00-000Z.json",
        createdAt: "2026-06-13T10:00:00.000Z",
        flowName: "Refactor",
        blockCount: 4,
        edgeCount: 4,
        valid: true,
      },
    });

    await restoreRalphFlowRevision("C:\\Project", {
      name: "refactor",
      revision: "2026-06-13T10-00-00-000Z",
    });

    expect(invokeMock).toHaveBeenCalledWith("run_ralph_command", {
      request: {
        workspaceRoot: "C:\\Project",
        arguments: [
          "restore",
          "refactor",
          "--revision",
          "2026-06-13T10-00-00-000Z",
        ],
      },
    });
  });

  it("passes active runtime options and variables to Ralph flow runs", async () => {
    invokeMock.mockResolvedValueOnce({
      run: {
        flow: "refactor",
        status: "completed",
        summary: "Done.",
        missingVariables: [],
        unknownVariables: [],
        events: [],
        blockResults: [],
      },
    });

    await runRalphFlow("C:\\Project", {
      name: "refactor",
      taskId: "ralph-refactor-run-1",
      params: {
        scope: "src/core",
      },
      mode: "ask",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    });

    expect(invokeMock).toHaveBeenCalledWith("run_ralph_command", {
      request: {
        workspaceRoot: "C:\\Project",
        taskId: "ralph-refactor-run-1",
        arguments: [
          "run",
          "refactor",
          "--mode",
          "ask",
          "--runtime-provider",
          "anthropic",
          "--model",
          "claude-sonnet-4-6",
          "--param",
          "scope=src/core",
        ],
      },
    });
  });

  it("passes input responses to Ralph resume runs", async () => {
    invokeMock.mockResolvedValueOnce({
      run: {
        flow: "refactor",
        status: "completed",
        summary: "Done.",
        missingVariables: [],
        unknownVariables: [],
        events: [],
        blockResults: [],
      },
    });

    await resumeRalphRun("C:\\Project", {
      runId: "run-1",
      taskId: "ralph-resume-1",
      scope: "workspace",
      inputResponse: {
        requestId: "request-1",
        action: "submit",
        values: {
          title: "Add export button",
          priority: 2,
        },
      },
    });

    expect(invokeMock).toHaveBeenCalledWith("run_ralph_command", {
      request: {
        workspaceRoot: "C:\\Project",
        taskId: "ralph-resume-1",
        arguments: [
          "resume",
          "run-1",
          "--input-json",
          JSON.stringify({
            requestId: "request-1",
            action: "submit",
            values: {
              title: "Add export button",
              priority: 2,
            },
          }),
          "--scope",
          "workspace",
        ],
      },
    });
  });

  it("passes retry-current requests to Ralph resume runs", async () => {
    invokeMock.mockResolvedValueOnce({
      run: {
        flow: "refactor",
        status: "completed",
        summary: "Done.",
        missingVariables: [],
        unknownVariables: [],
        events: [],
        blockResults: [],
      },
    });

    await resumeRalphRun("C:\\Project", {
      runId: "run-1",
      taskId: "ralph-resume-1",
      scope: "workspace",
      retryCurrent: true,
    });

    expect(invokeMock).toHaveBeenCalledWith("run_ralph_command", {
      request: {
        workspaceRoot: "C:\\Project",
        taskId: "ralph-resume-1",
        arguments: [
          "resume",
          "run-1",
          "--retry-current",
          "--scope",
          "workspace",
        ],
      },
    });
  });

  it("loads structured Ralph run details through the desktop command bridge", async () => {
    invokeMock.mockResolvedValueOnce({
      scope: "workspace",
      path: "C:\\Project\\.machdoch\\ralph\\runs\\run-1\\run.json",
      record: {
        schemaVersion: 1,
        id: "run-1",
        createdAt: "2026-06-19T07:00:00.000Z",
        flowId: "refactor",
        flowName: "Refactor",
        status: "completed",
        summary: "Done.",
        variableValues: {
          scope: "src/core",
        },
        events: [],
        blockResults: [],
        validation: {
          valid: true,
          errors: [],
          warnings: [],
        },
      },
    });

    await expect(
      showRalphRunDetail("C:\\Project", "run-1", "workspace"),
    ).resolves.toMatchObject({
      record: {
        id: "run-1",
        variableValues: {
          scope: "src/core",
        },
      },
    });

    expect(invokeMock).toHaveBeenCalledWith("run_ralph_command", {
      request: {
        workspaceRoot: "C:\\Project",
        arguments: ["run-detail", "run-1", "--scope", "workspace"],
      },
    });
  });

  it("opens Ralph flows through the desktop Ralph opener", async () => {
    invokeMock.mockResolvedValueOnce(undefined);

    await openRalphFlowInExplorer(" C:\\Project ", " existing-flow ", "workspace");

    expect(invokeMock).toHaveBeenCalledWith("open_ralph_flow_in_explorer", {
      request: {
        workspaceRoot: "C:\\Project",
        flow: "existing-flow",
        scope: "workspace",
      },
    });
  });

  it("returns no active desktop task snapshot when Tauri commands are unavailable", async () => {
    disableInvokeMock();

    await expect(loadActiveDesktopTaskIds()).resolves.toBeNull();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("resolves dropped paths through the Rust command", async () => {
    invokeMock.mockResolvedValueOnce({
      workspaceRoot: "C:\\Docs",
      entries: [
        {
          path: "C:\\Docs\\notes.md",
          kind: "file",
          name: "notes.md",
          parent: "C:\\Docs",
        },
      ],
    });

    await expect(resolveDroppedPaths([" C:\\Docs\\notes.md "])).resolves.toEqual({
      workspaceRoot: "C:\\Docs",
      entries: [
        {
          path: "C:\\Docs\\notes.md",
          kind: "file",
          name: "notes.md",
          parent: "C:\\Docs",
        },
      ],
    });
    expect(invokeMock).toHaveBeenCalledWith("resolve_dropped_paths", {
      paths: ["C:\\Docs\\notes.md"],
    });
  });

  it("saves clipboard image attachments through the Rust command", async () => {
    invokeMock.mockResolvedValueOnce("C:\\Temp\\clipboard-image.png");

    await expect(
      saveClipboardImageAttachment({
        blob: new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }),
        mediaType: "image/png",
        fileName: "clipboard-image.png",
      }),
    ).resolves.toBe("C:\\Temp\\clipboard-image.png");

    expect(invokeMock).toHaveBeenCalledWith("save_clipboard_image_attachment", {
      request: {
        dataBase64: "AQID",
        mediaType: "image/png",
        fileName: "clipboard-image.png",
      },
    });
  });

  it("passes attachment opening with the active workspace boundary", async () => {
    invokeMock.mockResolvedValueOnce(undefined);

    await openAttachedPath(" C:\\Docs\\plan.md ", " C:\\Docs ");

    expect(invokeMock).toHaveBeenCalledWith("open_attached_path", {
      path: "C:\\Docs\\plan.md",
      workspaceRoot: "C:\\Docs",
    });
  });

  it("resolves attached image preview sources through the Rust command", async () => {
    invokeMock.mockResolvedValueOnce("C:\\Docs\\screen.png");

    await expect(
      resolveAttachedImagePreviewSource(" C:\\Docs\\screen.png ", " C:\\Docs "),
    ).resolves.toBe(
      "http://asset.localhost/C%3A%5CDocs%5Cscreen.png",
    );

    expect(invokeMock).toHaveBeenCalledWith(
      "resolve_attached_image_preview_path",
      {
        path: "C:\\Docs\\screen.png",
        workspaceRoot: "C:\\Docs",
      },
    );
    expect(convertFileSrcMock).toHaveBeenCalledWith("C:\\Docs\\screen.png");
  });

  it("normalizes Windows extended-length image preview paths before conversion", async () => {
    invokeMock.mockResolvedValueOnce("\\\\?\\C:\\Docs\\screen.png");

    await expect(
      resolveAttachedImagePreviewSource(
        " \\\\?\\C:\\Docs\\screen.png ",
        " C:\\Docs ",
      ),
    ).resolves.toBe(
      "http://asset.localhost/C%3A%5CDocs%5Cscreen.png",
    );

    expect(convertFileSrcMock).toHaveBeenCalledWith("C:\\Docs\\screen.png");
  });

  it("normalizes Windows namespaced UNC image preview paths before conversion", async () => {
    invokeMock.mockResolvedValueOnce("\\\\?\\unc\\server\\share\\screen.png");

    await expect(
      resolveAttachedImagePreviewSource(
        "\\\\?\\UNC\\server\\share\\screen.png",
        null,
      ),
    ).resolves.toBe(
      "http://asset.localhost/%5C%5Cserver%5Cshare%5Cscreen.png",
    );

    expect(convertFileSrcMock).toHaveBeenCalledWith(
      "\\\\server\\share\\screen.png",
    );
  });

  it("normalizes Windows DOS device image preview paths before conversion", async () => {
    invokeMock.mockResolvedValueOnce("\\\\.\\C:\\Docs\\screen.png");

    await expect(
      resolveAttachedImagePreviewSource("\\\\.\\C:\\Docs\\screen.png", null),
    ).resolves.toBe(
      "http://asset.localhost/C%3A%5CDocs%5Cscreen.png",
    );

    expect(convertFileSrcMock).toHaveBeenCalledWith("C:\\Docs\\screen.png");
  });

  it("normalizes persisted image preview paths when Tauri commands are unavailable", async () => {
    disableInvokeMock();

    await expect(
      resolveAttachedImagePreviewSource("\\\\?\\C:\\Docs\\screen.png", null),
    ).resolves.toBe(
      "http://asset.localhost/C%3A%5CDocs%5Cscreen.png",
    );

    expect(invokeMock).not.toHaveBeenCalled();
    expect(convertFileSrcMock).toHaveBeenCalledWith("C:\\Docs\\screen.png");
  });

  it("leaves unsupported Windows namespace preview paths unchanged", async () => {
    invokeMock.mockResolvedValueOnce("\\\\?\\Volume{abc}\\screen.png");

    await expect(
      resolveAttachedImagePreviewSource("\\\\?\\Volume{abc}\\screen.png", null),
    ).resolves.toBe(
      "http://asset.localhost/%5C%5C%3F%5CVolume%7Babc%7D%5Cscreen.png",
    );

    expect(convertFileSrcMock).toHaveBeenCalledWith(
      "\\\\?\\Volume{abc}\\screen.png",
    );
  });

  it("opens attachment URLs through the Tauri opener", async () => {
    await openExternalUrl(" https://example.com/docs ");

    expect(openUrlMock).toHaveBeenCalledWith("https://example.com/docs");
  });

  it("passes desktop task runs under the Rust command's request parameter", async () => {
    invokeMock.mockResolvedValueOnce({
      execution: {
        task: "Inspect notes",
        workspaceRoot: "C:\\Docs",
        mode: "ask",
        status: "executed",
        summary: "Done.",
      },
    });

    await runDesktopTask(" C:\\Docs ", " Inspect notes ", {
      imagePaths: [" C:\\Docs\\screen.png "],
      mode: "ask",
      taskId: "task-123",
    });

    expect(invokeMock).toHaveBeenCalledWith("run_desktop_task", {
      request: {
        workspaceRoot: "C:\\Docs",
        task: "Inspect notes",
        imagePaths: ["C:\\Docs\\screen.png"],
        mode: "ask",
        taskId: "task-123",
      },
    });
  });

  it("passes desktop task cancellation through the Rust command", async () => {
    invokeMock.mockResolvedValueOnce(undefined);

    await cancelDesktopTask("task-123");

    expect(invokeMock).toHaveBeenCalledWith("cancel_desktop_task", {
      taskId: "task-123",
    });
  });

  it("manages Mission Control through the Rust commands", async () => {
    const status = {
      enabled: true,
      displayUrl: "http://127.0.0.1:4567/?token=secret",
      eventId: 1,
      pairedDeviceCount: 2,
      port: 4567,
      sessions: [],
    };
    invokeMock.mockResolvedValue(status);

    await expect(getRemoteControlStatus()).resolves.toEqual(status);
    expect(invokeMock).toHaveBeenCalledWith("get_remote_control_status");

    await expect(enableRemoteControlServer()).resolves.toEqual(status);
    expect(invokeMock).toHaveBeenCalledWith("enable_remote_control_server");

    await expect(disableRemoteControlServer()).resolves.toEqual(status);
    expect(invokeMock).toHaveBeenCalledWith("disable_remote_control_server");

    await expect(setRemoteControlPort(49152)).resolves.toEqual(status);
    expect(invokeMock).toHaveBeenCalledWith("set_remote_control_port", {
      port: 49152,
    });

    await expect(forgetRemoteControlPairings()).resolves.toEqual(status);
    expect(invokeMock).toHaveBeenCalledWith("forget_remote_control_pairings");
  });

  it("normalizes stopped Mission Control status payloads with null handoff fields", async () => {
    invokeMock.mockResolvedValueOnce({
      enabled: false,
      localUrl: null,
      lanUrl: null,
      displayUrl: null,
      qrSvg: null,
      tokenHint: null,
      startedAt: null,
      bindAddress: null,
      eventId: 2,
      pairedDeviceCount: 0,
      port: 4567,
      sessions: [],
    });

    await expect(disableRemoteControlServer()).resolves.toEqual({
      enabled: false,
      eventId: 2,
      pairedDeviceCount: 0,
      port: 4567,
      sessions: [],
    });
  });

  it("opens Mission Control through the Rust command", async () => {
    invokeMock.mockResolvedValueOnce(undefined);

    await openRemoteControlUrl("http://127.0.0.1:4567/#token=secret");

    expect(invokeMock).toHaveBeenCalledWith("open_remote_control_url");
  });

  it("filters Mission Control command events", async () => {
    const commands: unknown[] = [];

    const unsubscribe = await subscribeToRemoteControlCommands((event) => {
      commands.push(event);
    });

    expect(listenMock).toHaveBeenCalledWith(
      "remote-control-command",
      expect.any(Function),
    );

    desktopEventListeners.get("remote-control-command")?.({
      payload: {
        commandId: "cmd-1",
        kind: "follow-up",
        taskId: "task-123",
        prompt: "Inspect the failure",
        createdAt: 123,
      },
    });
    desktopEventListeners.get("remote-control-command")?.({
      payload: {
        commandId: "cmd-2",
        kind: "unsupported",
        createdAt: 124,
      },
    });
    desktopEventListeners.get("remote-control-command")?.({
      payload: {
        commandId: "cmd-3",
        kind: "approval-decision",
        decision: "approve",
        promptId: "approval-1",
        createdAt: 125,
      },
    });
    desktopEventListeners.get("remote-control-command")?.({
      payload: {
        commandId: "cmd-4",
        kind: "set-session-mode",
        sessionId: "session-1",
        mode: "auto",
        createdAt: 126,
      },
    });
    desktopEventListeners.get("remote-control-command")?.({
      payload: {
        commandId: "cmd-5",
        kind: "set-session-mode",
        sessionId: "session-1",
        mode: "ask",
        createdAt: 127,
      },
    });

    expect(commands).toEqual([
      {
        commandId: "cmd-1",
        kind: "follow-up",
        taskId: "task-123",
        prompt: "Inspect the failure",
        createdAt: 123,
      },
      {
        commandId: "cmd-5",
        kind: "set-session-mode",
        sessionId: "session-1",
        mode: "ask",
        createdAt: 127,
      },
    ]);

    unsubscribe();
  });

  it("saves the speech input device through the Rust command", async () => {
    invokeMock.mockResolvedValueOnce({
      activeProvider: "openai",
      inputDeviceId: "mic-2",
      providerAvailability: [],
    });

    await expect(saveUserSpeechToTextInputDevice(" mic-2 ")).resolves.toEqual({
      activeProvider: "openai",
      inputDeviceId: "mic-2",
      providerAvailability: [],
    });
    expect(invokeMock).toHaveBeenCalledWith(
      "save_user_speech_to_text_input_device",
      { inputDeviceId: "mic-2" },
    );
  });

  it("loads review model settings through the Tauri runtime", async () => {
    invokeMock.mockResolvedValueOnce({
      mode: "dedicated",
      provider: "google",
      model: "gemini-2.5-flash-lite",
    });

    await expect(loadUserReviewModelSettings()).resolves.toEqual({
      mode: "dedicated",
      provider: "google",
      model: "gemini-2.5-flash-lite",
    });
    expect(invokeMock).toHaveBeenCalledWith("get_user_review_model_settings");
  });

  it("saves normalized review model settings through the Tauri runtime", async () => {
    invokeMock.mockResolvedValueOnce({
      mode: "dedicated",
      provider: "openai",
      model: "gpt-5.4-mini",
    });

    await expect(
      saveUserReviewModelSettings({
        mode: "dedicated",
        provider: "openai",
        model: " gpt-5.4-mini ",
      }),
    ).resolves.toEqual({
      mode: "dedicated",
      provider: "openai",
      model: "gpt-5.4-mini",
    });
    expect(invokeMock).toHaveBeenCalledWith(
      "save_user_review_model_settings",
      {
        settings: {
          mode: "dedicated",
          provider: "openai",
          model: "gpt-5.4-mini",
        },
      },
    );
  });

  it("falls back to base review model settings when a dedicated model is incomplete", async () => {
    disableInvokeMock();

    await expect(
      saveUserReviewModelSettings({
        mode: "dedicated",
        provider: "openai",
      }),
    ).resolves.toEqual({
      mode: "base",
    });
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
