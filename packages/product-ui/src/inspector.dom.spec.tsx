import type { ProductShell, ProductSnapshot } from "@machdoch/fleet-protocol";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Inspector } from "./inspector";

const emptyShell: ProductShell = {
  version: 5,
  capturedAt: 1,
  sessions: [],
  workspaces: [],
  visibleMessages: [],
  contextPacks: [],
  promptHistory: [],
};

function harness(
  shell: ProductShell,
  sessions: ProductSnapshot["sessions"] = [],
  pending = false,
) {
  const onCommand = vi.fn().mockResolvedValue(true);
  const onRefresh = vi.fn().mockResolvedValue(undefined);
  const element = (value: ProductShell) => (
    <div className="machdoch-product">
      <Inspector
        shell={value}
        snapshot={{
          enabled: true,
          eventId: 1,
          serverTime: 1,
          sessions,
          commands: [],
          shell: value,
        }}
        activeSessionId="session"
        pending={pending}
        onCommand={onCommand}
        onRefresh={onRefresh}
      />
    </div>
  );
  const view = render(element(shell));
  return {
    onCommand,
    onRefresh,
    show: (value: ProductShell) => view.rerender(element(value)),
  };
}

function tab(name: string) {
  fireEvent.mouseDown(screen.getByRole("tab", { name }), {
    button: 0,
    ctrlKey: false,
  });
}

beforeEach(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterEach(cleanup);

describe("Activity workflows", () => {
  it.each(["Instructions", "Scheduler"])(
    "distinguishes loading, error, and empty %s",
    async (name) => {
      const state = {
        loading: true,
        profiles: [],
        jobs: [],
        runs: [],
        updatedAt: 1,
      };
      const key = name === "Instructions" ? "instructions" : "scheduler";
      const view = harness({ ...emptyShell, [key]: state });
      tab(name);
      expect(screen.getByRole("status").textContent).toContain("Loading");
      view.show({
        ...emptyShell,
        [key]: { ...state, loading: false, error: "Load failed" },
      });
      expect(screen.getByRole("alert").textContent).toContain("Load failed");
      expect(
        screen.queryByText(/^No instructions$|^No scheduled work$/),
      ).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await act(async () => {});
      expect(view.onRefresh).toHaveBeenCalledTimes(1);
      view.show({ ...emptyShell, [key]: { ...state, loading: false } });
      expect(
        screen.getByText(/^No instructions$|^No scheduled work$/),
      ).toBeTruthy();
    },
  );

  it("shows task progress and logs without dispatching commands and retains expansion during polling", () => {
    const view = harness(
      emptyShell,
      [
        {
          taskId: "task",
          task: "Review project",
          mode: "machdoch",
          state: "failed",
          message: "Could not finish",
          cancellable: true,
          startedAt: 1,
          updatedAt: 2,
          progressCount: 1,
          timeline: [
            {
              createdAt: 1,
              kind: "progress",
              phase: "working",
              label: "Reading project",
              detail: "Checked the project configuration",
            },
          ],
          logs: [
            {
              createdAt: 2,
              stream: "stderr",
              chunk: "Missing project dependency",
            },
          ],
        },
      ],
      true,
    );
    const details = screen.getByText("Task details").closest("details")!;
    details.open = true;
    expect(screen.getByLabelText("Task logs").textContent).toContain(
      "Missing project dependency",
    );
    expect(screen.getByLabelText("Task progress").textContent).toContain(
      "Checked the project configuration",
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(view.onCommand).not.toHaveBeenCalled();
    view.show({ ...emptyShell, capturedAt: 2 });
    expect(details.open).toBe(true);
  });

  it("keeps a failed context deletion in its dialog for retry", async () => {
    const view = harness({
      ...emptyShell,
      contextPacks: [
        {
          id: "pack",
          name: "Review context",
          instructionsPreview: "Project instructions",
          promptPreview: "",
          attachmentCount: 0,
          variables: [],
          matched: false,
        },
      ],
    });
    tab("Context");
    view.onCommand.mockResolvedValueOnce(false);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Delete Review context?",
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Delete context pack" }),
    );
    await act(async () => {});
    expect(within(dialog).getByRole("alert").textContent).toContain(
      "Try again",
    );
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Delete context pack" }),
    );
    await act(async () => {});
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(view.onCommand).toHaveBeenCalledTimes(2);
    expect(view.onCommand).toHaveBeenLastCalledWith({
      kind: "delete-context-pack",
      contextPackId: "pack",
    });
  });
});
