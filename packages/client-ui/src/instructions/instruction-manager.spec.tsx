import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type {
  InstructionProfileView,
  InstructionRegistryResult,
} from "@machdoch/fleet-protocol/instruction-contract";
import { TooltipProvider } from "@machdoch/media-studio/tauri/ui/components/ui/tooltip.js";
import { CommandProvider } from "@machdoch/media-studio/tauri/ui/commands/command-context.js";
import { InstructionManager } from "./instruction-manager";
import type {
  InstructionManagementControls,
  InstructionRuntime,
} from "./types";

const profile: InstructionProfileView = {
  id: "profile",
  name: "Review",
  body: "Original body",
  createdAt: "2026-10-06T00:00:00.000Z",
  updatedAt: "2026-10-06T00:00:00.000Z",
  byteLength: 13,
  lineCount: 1,
  digest: "digest",
  manualAssignmentCount: 0,
  enabled: true,
  global: false,
  tags: [],
};
const registry = (
  body: string,
  revision: number,
): InstructionRegistryResult => ({
  schemaVersion: 2,
  revision,
  profiles: [{ ...profile, body }],
  workspaces: [],
});
const runtime: InstructionRuntime = {
  runAiTask: vi.fn(),
  cancelAiTask: vi.fn().mockResolvedValue(undefined),
  renderMarkdown: (content) => <p>{content}</p>,
};

function harness() {
  const onSave = vi.fn().mockResolvedValue(false);
  const onRefresh = vi.fn().mockResolvedValue(undefined);
  const setup: InstructionManagementControls = {
    workspaceRoot: "/project",
    registry: registry("Original body", 1),
    loading: false,
    saving: false,
    message: null,
    onSave,
    onRefresh,
  };
  const component = () => (
    <TooltipProvider>
      <CommandProvider activeView="instructions" runtime="browser">
        <InstructionManager setup={setup} runtime={runtime} />
      </CommandProvider>
    </TooltipProvider>
  );
  const view = render(component());
  return {
    onSave,
    onRefresh,
    update: (next: InstructionRegistryResult) => {
      setup.registry = next;
      view.rerender(component());
    },
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("keeps an unsaved draft and its reviewed revision when the library changes", async () => {
  const view = harness();
  const name = await screen.findByLabelText("Name", { exact: true });
  fireEvent.change(name, { target: { value: "Unsaved review" } });
  view.update(registry("Changed elsewhere", 2));
  expect((name as HTMLInputElement).value).toBe("Unsaved review");
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(view.onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Unsaved review",
        body: "Original body",
        expectedRevision: 1,
      }),
    ),
  );
  expect((name as HTMLInputElement).value).toBe("Unsaved review");
  vi.spyOn(window, "confirm").mockReturnValue(true);
  fireEvent.click(screen.getByRole("button", { name: "Discard" }));
  expect((name as HTMLInputElement).value).toBe("Review");
  fireEvent.change(name, { target: { value: "Reviewed update" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(view.onSave).toHaveBeenLastCalledWith(
      expect.objectContaining({
        body: "Changed elsewhere",
        expectedRevision: 2,
      }),
    ),
  );
});

it("retains an edited file removed by another viewer and requires confirmation before refreshing", async () => {
  const view = harness();
  const name = await screen.findByLabelText("Name", { exact: true });
  fireEvent.change(name, { target: { value: "Keep this draft" } });
  view.update({ ...registry("", 2), profiles: [] });
  expect((name as HTMLInputElement).value).toBe("Keep this draft");
  const confirmation = vi.spyOn(window, "confirm").mockReturnValue(false);
  const refreshCount = view.onRefresh.mock.calls.length;
  fireEvent.click(screen.getByRole("button", { name: /Refresh instruction/ }));
  expect(confirmation).toHaveBeenCalled();
  expect(view.onRefresh).toHaveBeenCalledTimes(refreshCount);
  expect((name as HTMLInputElement).value).toBe("Keep this draft");
  await act(async () => {});
});
