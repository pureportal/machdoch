import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
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

const renderPicker = ({
  contextPacks = [createPack()],
  activeDraft = "",
  contextAttachments = [],
  matchedContextPackIds = [],
  onSaveContextPack = vi.fn(),
  onApplyContextPack = vi.fn(),
  onDeleteContextPack = vi.fn(),
}: Partial<ComponentProps<typeof SmartContextPackPicker>> = {}) => {
  render(
    <SmartContextPackPicker
      contextPacks={contextPacks}
      workspaceRoot="C:\\Project"
      activeDraft={activeDraft}
      activeProvider="openai"
      activeModel="gpt-5.5"
      activeRunMode="machdoch"
      activeReasoning="default"
      contextAttachments={contextAttachments}
      matchedContextPackIds={matchedContextPackIds}
      imageInputSupported
      workspaceLabel="Project"
      onSaveContextPack={onSaveContextPack}
      onApplyContextPack={onApplyContextPack}
      onDeleteContextPack={onDeleteContextPack}
      onExportContextPacks={vi.fn()}
      onImportContextPacks={vi.fn()}
    />,
  );

  return {
    onSaveContextPack,
    onApplyContextPack,
    onDeleteContextPack,
  };
};

const openContextPackPicker = async (): Promise<HTMLElement> => {
  fireEvent.click(screen.getByRole("button", { name: "Context packs" }));
  return await screen.findByRole("searchbox", {
    name: "Search context packs",
  });
};

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

    renderPicker({ onDeleteContextPack });

    await openContextPackPicker();

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

  it("focuses the pack search input when opened", async () => {
    renderPicker();

    const searchInput = await openContextPackPicker();

    await waitFor(() => {
      expect(document.activeElement).toBe(searchInput);
    });
  });

  it("filters pack entries from typed search text", async () => {
    renderPicker({
      contextPacks: [
        createPack({ id: "pack-1", name: "Review PR", updatedAt: 3 }),
        createPack({
          id: "pack-2",
          name: "Release Notes",
          instructions: "Summarize user-facing changes.",
          updatedAt: 2,
        }),
        createPack({
          id: "pack-3",
          name: "Deploy Checklist",
          prompt: "Verify deployment risk.",
          updatedAt: 1,
        }),
      ],
    });

    const searchInput = await openContextPackPicker();
    fireEvent.change(searchInput, { target: { value: "release" } });

    expect(screen.getByText("Release Notes")).toBeTruthy();
    expect(screen.queryByText("Review PR")).toBeNull();
    expect(screen.queryByText("Deploy Checklist")).toBeNull();
  });

  it("applies the highest-ranked pack when pressing Enter in search", async () => {
    const onApplyContextPack = vi.fn();

    renderPicker({
      contextPacks: [
        createPack({
          id: "pack-1",
          name: "Legacy Deploy",
          updatedAt: 2,
        }),
        createPack({
          id: "pack-2",
          name: "Deploy Checklist",
          updatedAt: 1,
        }),
      ],
      onApplyContextPack,
    });

    const searchInput = await openContextPackPicker();
    fireEvent.change(searchInput, { target: { value: "deploy checklist" } });
    fireEvent.keyDown(searchInput, { key: "Enter" });

    await waitFor(() => {
      expect(onApplyContextPack).toHaveBeenCalledWith("pack-2");
    });
  });

  it("shows compact pack rows without token, path, scope text, or usage metadata", async () => {
    renderPicker({
      contextPacks: [
        createPack({
          useCount: 3,
          contextAttachments: [
            {
              id: "attachment-1",
              path: "C:\\Project\\src\\index.ts",
              kind: "file",
              name: "index.ts",
            },
          ],
        }),
        createPack({
          id: "pack-2",
          workspace: null,
          name: "Global Helper",
          updatedAt: 1,
        }),
      ],
    });

    await openContextPackPicker();

    expect(screen.getByText("Review PR")).toBeTruthy();
    expect(
      screen.getByRole("img", { name: "Workspace context pack" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("img", { name: "Global context pack" }),
    ).toBeTruthy();
    expect(screen.getByText("Review PR").parentElement?.textContent?.trim()).toBe(
      "Review PR",
    );
    expect(
      screen.getByText("Global Helper").parentElement?.textContent?.trim(),
    ).toBe("Global Helper");
    expect(screen.queryByText(/tokens/u)).toBeNull();
    expect(screen.queryByText(/paths?/u)).toBeNull();
    expect(screen.queryByText("3 uses")).toBeNull();
    expect(screen.queryByText("Focus on regressions.")).toBeNull();
  });

  it("opens a full save dialog with an editable highlighted prompt", async () => {
    const onSaveContextPack = vi.fn();

    renderPicker({
      contextPacks: [],
      activeDraft: "Review {target_file}",
      onSaveContextPack,
    });

    fireEvent.click(screen.getByRole("button", { name: "Context packs" }));
    fireEvent.click(await screen.findByRole("button", { name: "Save" }));

    expect(await screen.findByText("Create context pack")).toBeTruthy();

    const promptInput = screen.getByLabelText("Prompt") as HTMLTextAreaElement;

    expect(promptInput.value).toBe("Review {target_file}");
    expect(screen.getByText("{target_file}").className).toContain(
      "text-emerald-200",
    );

    fireEvent.change(promptInput, {
      target: { value: "Review {target_file} for {ticket_id}" },
    });

    expect(screen.getByText("{ticket_id}").className).toContain(
      "text-emerald-200",
    );

    fireEvent.click(screen.getByRole("button", { name: "Save pack" }));

    expect(onSaveContextPack).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Review {target_file}",
        scope: "workspace",
        prompt: "Review {target_file} for {ticket_id}",
        provider: "openai",
        model: "gpt-5.5",
        mode: "machdoch",
        reasoning: "default",
      }),
    );
    expect(onSaveContextPack.mock.calls[0]?.[0].variables).toEqual(
      expect.arrayContaining([
        { name: "target_file" },
        { name: "ticket_id" },
      ]),
    );
  });

  it("edits an existing pack with the same dialog component", async () => {
    const onSaveContextPack = vi.fn();

    renderPicker({
      contextPacks: [
        createPack({
          prompt: "Run {test_command}.",
          variables: [{ name: "test_command", defaultValue: "pnpm test" }],
        }),
      ],
      onSaveContextPack,
    });

    fireEvent.click(screen.getByRole("button", { name: "Context packs" }));
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Edit context pack Review PR",
      }),
    );

    expect(await screen.findByText("Edit context pack")).toBeTruthy();

    const promptInput = screen.getByLabelText("Prompt") as HTMLTextAreaElement;
    const variablesInput = screen.getByPlaceholderText(
      "ticket_id, target_file, test_command=npm test",
    ) as HTMLTextAreaElement;

    expect(promptInput.value).toBe("Run {test_command}.");
    expect(variablesInput.value).toBe("test_command=pnpm test");

    fireEvent.change(promptInput, {
      target: { value: "Run pnpm test -- --watch=false." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Update pack" }));

    expect(onSaveContextPack).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "pack-1",
        name: "Review PR",
        prompt: "Run pnpm test -- --watch=false.",
      }),
    );
    expect(onSaveContextPack.mock.calls[0]?.[0].variables).toEqual([
      { name: "test_command", defaultValue: "pnpm test" },
    ]);
  });
});
