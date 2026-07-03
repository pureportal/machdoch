import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SmartContextPack } from "../../chat-session.model";
import { listRalphFlows, showRalphFlow } from "../../runtime";
import { SmartContextPackPicker } from "./smart-context-packs";

vi.mock("../../runtime", () => ({
  listRalphFlows: vi.fn(),
  showRalphFlow: vi.fn(),
}));

const createPack = (
  overrides: Partial<SmartContextPack> = {},
): SmartContextPack => ({
  id: "pack-1",
  workspace: "C:\\Project",
  name: "Review PR",
  instructions: "Focus on regressions.",
  prompt: "Review the staged changes.",
  contextAttachments: [],
  variables: [],
  trigger: {
    phrases: [],
    pathPatterns: [],
    autoApply: false,
  },
  provider: "openai",
  model: "gpt-5.5",
  mode: "machdoch",
  createdAt: 1,
  updatedAt: 2,
  useCount: 0,
  ...overrides,
});

describe("SmartContextPackPicker", () => {
  beforeEach(() => {
    vi.mocked(listRalphFlows).mockResolvedValue({
      workspaceRoot: "C:\\Project",
      flows: [
        {
          id: "refactor",
          name: "Refactor",
          path: "C:\\Project\\.machdoch\\ralph\\flows\\refactor.json",
          blockCount: 1,
          edgeCount: 0,
          variableCount: 0,
        },
      ],
    });
    vi.mocked(showRalphFlow).mockResolvedValue({
      path: "C:\\Project\\.machdoch\\ralph\\flows\\refactor.json",
      flow: {
        schemaVersion: 1,
        id: "refactor",
        name: "Refactor",
        blocks: [
          {
            id: "pack",
            type: "PACK",
            title: "Pack",
            packIds: ["pack-1"],
          },
        ],
        edges: [],
      },
    });
  });

  it("warns before deleting a pack used by a Ralph flow", async () => {
    const onDeleteContextPack = vi.fn();

    render(
      <SmartContextPackPicker
        contextPacks={[createPack()]}
        workspaceRoot="C:\\Project"
        activeDraft=""
        activeProvider="openai"
        activeModel="gpt-5.5"
        activeRunMode="machdoch"
        activeReasoning="default"
        contextAttachments={[]}
        matchedContextPackIds={[]}
        imageInputSupported
        workspaceLabel="Project"
        onSaveContextPack={vi.fn()}
        onApplyContextPack={vi.fn()}
        onDeleteContextPack={onDeleteContextPack}
        onExportContextPacks={vi.fn()}
        onImportContextPacks={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Context packs" }));

    expect(await screen.findByText("Used by 1 Ralph flow")).toBeTruthy();

    const deleteButton = screen.getByRole("button", {
      name: "Delete context pack Review PR",
    });
    fireEvent.click(deleteButton);

    expect(onDeleteContextPack).not.toHaveBeenCalled();
    expect(
      await screen.findByText(
        "This pack is used by Refactor. Click delete again to remove it anyway.",
      ),
    ).toBeTruthy();

    fireEvent.click(deleteButton);

    await waitFor(() => {
      expect(onDeleteContextPack).toHaveBeenCalledWith("pack-1");
    });
  });
});
