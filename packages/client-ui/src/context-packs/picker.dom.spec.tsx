import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { SmartContextPack } from "./model";
import {
  SmartContextPackPicker,
  type SmartContextPackPickerProps,
} from "./picker";

afterEach(cleanup);

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

const reviewPack: SmartContextPack = {
  id: "review",
  name: "Review",
  workspace: "C:/Project",
  instructions: "",
  prompt: "Review the change",
  contextAttachments: [],
  variables: [],
  trigger: { phrases: [], pathPatterns: [] },
  createdAt: 1,
  updatedAt: 1,
  useCount: 0,
};

function renderPicker(overrides: Partial<SmartContextPackPickerProps> = {}) {
  const props: SmartContextPackPickerProps = {
    loadRalphPackUsage: vi.fn().mockResolvedValue({}),
    contextPacks: [reviewPack],
    workspaceRoot: "C:/Project",
    activeDraft: "",
    activeProvider: "openai",
    activeModel: "test-model",
    activeRunMode: "machdoch",
    activeReasoning: "default",
    activePromptEnhancementMode: "off",
    activeInterviewEnabled: false,
    activeSessionMemoryEnabled: false,
    activeUseGlobalMemory: false,
    activeUiControlEnabled: false,
    contextAttachments: [],
    matchedContextPackIds: [],
    imageInputSupported: false,
    workspaceLabel: "Project",
    onSaveContextPack: vi.fn(),
    onApplyContextPack: vi.fn(),
    onDeleteContextPack: vi.fn(),
    onExportContextPacks: vi.fn(),
    onImportContextPacks: vi.fn(),
    ...overrides,
  };
  render(<SmartContextPackPicker {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Context packs: 1" }));
  fireEvent.click(
    screen.getByRole("button", { name: "Delete context pack Review" }),
  );
  return props;
}

const CONFIRMATION = { name: "Delete Review?" };

async function confirmation() {
  return screen.findByRole("dialog", CONFIRMATION);
}

function closedConfirmation() {
  return expect(screen.queryByRole("dialog", CONFIRMATION)).toBeNull();
}

describe("context pack deletion", () => {
  it("deletes only after confirmation", async () => {
    const props = renderPicker();
    fireEvent.click(
      within(await confirmation()).getByRole("button", { name: "Cancel" }),
    );
    closedConfirmation();
    expect(props.onDeleteContextPack).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", { name: "Delete context pack Review" }),
    );
    const deleteButton = within(await confirmation()).getByRole("button", {
      name: "Delete pack",
    });
    await waitFor(() => expect(deleteButton).toHaveProperty("disabled", false));
    fireEvent.click(deleteButton);
    await waitFor(closedConfirmation);
    expect(props.onDeleteContextPack).toHaveBeenCalledExactlyOnceWith("review");
  });

  it("names the Ralph flows that use the pack", async () => {
    renderPicker({
      loadRalphPackUsage: vi.fn().mockResolvedValue({ review: ["Release"] }),
    });
    expect((await confirmation()).textContent).toContain("Used by Release.");
  });

  it("keeps a failed deletion open for retry", async () => {
    const onDeleteContextPack = vi
      .fn()
      .mockRejectedValueOnce(new Error("Pack is locked."))
      .mockResolvedValueOnce(undefined);
    renderPicker({ onDeleteContextPack });
    const dialog = await confirmation();
    const deleteButton = within(dialog).getByRole("button", {
      name: "Delete pack",
    });
    await waitFor(() => expect(deleteButton).toHaveProperty("disabled", false));
    fireEvent.click(deleteButton);
    expect((await within(dialog).findByRole("alert")).textContent).toBe(
      "Pack is locked.",
    );
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Delete pack" }),
    );
    await waitFor(closedConfirmation);
    expect(onDeleteContextPack).toHaveBeenCalledTimes(2);
  });
});
