import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  closeAll: vi.fn(),
  closeAllBrowserSessions: vi.fn(),
  ensureAutomaticProviderSync: vi.fn(),
  printTaskInterviewSummary: vi.fn(),
  printTaskPreview: vi.fn(),
  runInteractiveChat: vi.fn(),
  loadRalphSnapshot: vi.fn(),
  writeStdoutLine: vi.fn(),
}));

vi.mock("../core/ralph-snapshot.js", () => ({
  loadRalphSnapshot: mocks.loadRalphSnapshot,
}));

vi.mock("./_helpers/cli-io.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./_helpers/cli-io.js")>()),
  writeStdoutLine: mocks.writeStdoutLine,
}));

vi.mock("../core/mcp/client.js", () => ({
  mcpClientManager: {
    closeAll: mocks.closeAll,
  },
}));

vi.mock("../core/_helpers/browser-tool-definitions.js", () => ({
  closeAllBrowserSessions: mocks.closeAllBrowserSessions,
}));

vi.mock("./_helpers/cli-provider-sync-commands.js", () => ({
  ensureAutomaticProviderSync: mocks.ensureAutomaticProviderSync,
}));

vi.mock("./_helpers/cli-task-run.js", () => ({
  printTaskPreview: mocks.printTaskPreview,
  runInteractiveChat: mocks.runInteractiveChat,
}));

vi.mock("./_helpers/cli-interview-commands.js", () => ({
  printTaskInterviewSummary: mocks.printTaskInterviewSummary,
}));

import { runCli } from "./app.ts";

describe("runCli agent resource lifecycle", () => {
  beforeEach(() => {
    mocks.closeAll.mockReset().mockResolvedValue(undefined);
    mocks.closeAllBrowserSessions.mockReset().mockResolvedValue(0);
    mocks.ensureAutomaticProviderSync.mockReset().mockResolvedValue(undefined);
    mocks.printTaskInterviewSummary.mockReset().mockResolvedValue(undefined);
    mocks.printTaskPreview.mockReset().mockResolvedValue(undefined);
    mocks.runInteractiveChat.mockReset().mockResolvedValue(undefined);
    mocks.loadRalphSnapshot.mockReset();
    mocks.writeStdoutLine.mockReset();
  });

  it("closes agent resources after a one-shot task", async () => {
    await runCli(["--quick", "--task", "inspect the workspace"]);

    expect(mocks.printTaskPreview).toHaveBeenCalledOnce();
    expect(mocks.closeAll).toHaveBeenCalledOnce();
    expect(mocks.closeAllBrowserSessions).toHaveBeenCalledOnce();
  });

  it("reads Ralph status without provider synchronization or agent cleanup", async () => {
    const snapshot = { workspaceRoot: process.cwd(), scopes: [] };
    mocks.loadRalphSnapshot.mockResolvedValue(snapshot);

    await runCli(["--json", "ralph", "snapshot"]);

    expect(mocks.loadRalphSnapshot).toHaveBeenCalledExactlyOnceWith(
      process.cwd(),
      {},
    );
    expect(mocks.writeStdoutLine).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify(snapshot),
    );
    expect(mocks.ensureAutomaticProviderSync).not.toHaveBeenCalled();
    expect(mocks.closeAll).not.toHaveBeenCalled();
    expect(mocks.closeAllBrowserSessions).not.toHaveBeenCalled();
  });

  it("propagates failed Ralph status reads without initializing agent resources", async () => {
    mocks.loadRalphSnapshot.mockRejectedValue(
      new Error("Workspace unavailable"),
    );

    await expect(runCli(["--json", "ralph", "snapshot"])).rejects.toThrow(
      "Workspace unavailable",
    );

    expect(mocks.writeStdoutLine).not.toHaveBeenCalled();
    expect(mocks.ensureAutomaticProviderSync).not.toHaveBeenCalled();
    expect(mocks.closeAll).not.toHaveBeenCalled();
    expect(mocks.closeAllBrowserSessions).not.toHaveBeenCalled();
  });

  it.each(["workspace", "user"])(
    "restricts snapshot reads to the requested %s scope",
    async (scope) => {
      mocks.loadRalphSnapshot.mockResolvedValue({
        workspaceRoot: process.cwd(),
        scopes: [],
      });
      await runCli(["--json", "ralph", "snapshot", "--scope", scope]);
      expect(mocks.loadRalphSnapshot).toHaveBeenCalledExactlyOnceWith(
        process.cwd(),
        { scope },
      );
      expect(mocks.ensureAutomaticProviderSync).not.toHaveBeenCalled();
    },
  );

  it("closes agent resources when a one-shot task fails", async () => {
    const error = new Error("task failed");
    mocks.printTaskPreview.mockRejectedValueOnce(error);

    await expect(
      runCli(["--quick", "--task", "inspect the workspace"]),
    ).rejects.toBe(error);

    expect(mocks.closeAll).toHaveBeenCalledOnce();
    expect(mocks.closeAllBrowserSessions).toHaveBeenCalledOnce();
  });

  it("closes agent resources after a task interview", async () => {
    await runCli(["interview", "--prompt", "refine the task scope"]);

    expect(mocks.printTaskInterviewSummary).toHaveBeenCalledOnce();
    expect(mocks.closeAll).toHaveBeenCalledOnce();
    expect(mocks.closeAllBrowserSessions).toHaveBeenCalledOnce();
  });

  it("keeps agent resources open until interactive chat exits", async () => {
    let finishChat: (() => void) | undefined;
    mocks.runInteractiveChat.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishChat = resolve;
        }),
    );

    const running = runCli(["chat"]);
    await vi.waitFor(() => {
      expect(mocks.runInteractiveChat).toHaveBeenCalledOnce();
    });

    expect(mocks.closeAll).not.toHaveBeenCalled();
    expect(mocks.closeAllBrowserSessions).not.toHaveBeenCalled();
    finishChat?.();
    await running;

    expect(mocks.closeAll).toHaveBeenCalledOnce();
    expect(mocks.closeAllBrowserSessions).toHaveBeenCalledOnce();
  });
});
