// @vitest-environment jsdom

import {
  productSnapshotVersion,
  type ProductSnapshot,
} from "@machdoch/fleet-protocol";
import { RemoteProductApp, type ProductRuntime } from "@machdoch/product-ui";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const snapshot: ProductSnapshot = {
  enabled: true,
  serverTime: 1,
  eventId: 1,
  sessions: [],
  commands: [],
  shell: {
    version: productSnapshotVersion,
    capturedAt: 1,
    activeSessionId: "session-1",
    sessions: [
      {
        id: "session-1",
        title: "Architecture review",
        status: "ready",
        provider: "openai",
        model: "gpt-5.6",
        mode: "machdoch",
        effectiveMode: "machdoch",
        reasoning: "high",
        effectiveReasoning: "high",
        createdAt: 1,
        updatedAt: 1,
        tags: [],
        messageCount: 0,
        promptHistoryCount: 0,
        attachmentCount: 0,
        canRename: true,
        canDelete: true,
        canArchive: true,
        canPin: true,
        canDuplicate: true,
        canBranch: true,
      },
    ],
    workspaces: [],
    visibleMessages: [],
    composer: {
      sessionId: "session-1",
      draft: "",
      provider: "openai",
      providerLabel: "OpenAI",
      model: "gpt-5.6",
      modelLabel: "GPT-5.6",
      modelCatalogLoading: false,
      modelCatalog: [],
      mode: "machdoch",
      defaultMode: "machdoch",
      reasoning: "high",
      defaultReasoning: "high",
      reasoningOptions: ["default", "high"],
      promptEnhancementMode: "off",
      interviewEnabled: false,
      interviewAvailable: false,
      workspaceLabel: "Not Set",
      canSend: true,
      isExecuting: false,
      sessionMemoryEnabled: true,
      sessionMemory: [
        {
          id: "memory-1",
          content: "Package manager: pnpm",
          createdAt: Date.UTC(2026, 7, 31, 14, 30),
          sourceSession: {
            id: "session-1",
            title: "Architecture review",
          },
        },
      ],
      globalMemoryAvailable: false,
      globalMemoryEnabled: false,
      uiControlAvailable: false,
      uiControlEnabled: false,
      uiControlDescription: "",
      attachments: [],
      chooserProviders: ["openai"],
      matchedContextPackIds: [],
    },
    contextPacks: [],
    promptHistory: [],
  },
};

afterEach(() => cleanup());

describe("Fleet session memory", () => {
  it("opens memory from the chat toggle and dispatches forget", async () => {
    const execute = vi.fn().mockResolvedValue({
      commandId: "command-1",
      duplicate: false,
    });
    const runtime: ProductRuntime = {
      getSnapshot: vi.fn().mockResolvedValue(snapshot),
      execute,
    };

    render(
      createElement(RemoteProductApp, {
        instanceName: "Desktop",
        runtime,
      }),
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Manage session memory" }),
    );
    const dialog = screen.getByRole("dialog", { name: "Session memory" });
    expect(within(dialog).getByText("Package manager: pnpm")).toBeTruthy();
    expect(within(dialog).getByText("Architecture review")).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: "Forget" }));
    await waitFor(() =>
      expect(execute).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "forget-session-memory",
          sessionId: "session-1",
          memoryId: "memory-1",
        }),
      ),
    );
  });
});
