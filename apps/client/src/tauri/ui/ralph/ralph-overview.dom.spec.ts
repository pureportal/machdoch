// @vitest-environment jsdom

import { createElement } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RalphOverview } from "./components/ralph-overview";
import {
  createOverviewLibrary,
  createOverviewRun,
  createOverviewTask,
} from "./__test__/ralph-overview-fixtures";

afterEach(cleanup);
const callbacks = () => ({
  onOpen: vi.fn(),
  onRefresh: vi.fn(),
  onChooseWorkspace: vi.fn(),
  workspaceRoot: "C:/one",
  tasksLoaded: true,
  taskError: null,
});

describe("RALPH overview", () => {
  it("waits for a resumed flow's identity before opening its editor", () => {
    const handlers = callbacks();
    const task = {
      ...createOverviewTask("C:/two", "resume", "user"),
      arguments: ["resume", "run-1", "--scope", "user"],
    };
    const props = { ...handlers, libraries: [], tasks: [task] };
    const { rerender } = render(createElement(RalphOverview, props));
    const pending = screen.getByRole("button", {
      name: "Open Resuming flow in C:/two",
    }) as HTMLButtonElement;
    expect(pending.disabled).toBe(true);
    expect(pending.title).toBe("Loading flow details");
    const library = createOverviewLibrary("C:/one", "user");
    library.runs = [createOverviewRun({ status: "crashed" })];
    rerender(createElement(RalphOverview, { ...props, libraries: [library] }));
    fireEvent.click(
      screen.getByRole("button", { name: "Open Release in C:/two" }),
    );
    expect(handlers.onOpen).toHaveBeenCalledWith({
      workspaceRoot: "C:/two",
      flowId: "release",
      scope: "user",
      runId: "run-1",
      running: true,
    });
  });

  it("shows running flows from multiple workspaces alongside inactive flows without expanding workspaces", () => {
    const first = createOverviewLibrary("C:/one/project");
    const second = createOverviewLibrary("C:/two/project");
    const inactive = createOverviewLibrary("C:/inactive");
    inactive.runs = [createOverviewRun()];
    const handlers = callbacks();
    render(
      createElement(RalphOverview, {
        ...handlers,
        libraries: [first, second, inactive],
        tasks: [
          createOverviewTask(first.workspaceRoot),
          createOverviewTask(second.workspaceRoot),
        ],
      }),
    );
    const running = screen.getByRole("region", { name: "Running 2" });
    expect(within(running).getAllByText("Release")).toHaveLength(2);
    expect(within(running).getByText("C:/one/project")).toBeTruthy();
    expect(within(running).getByText("C:/two/project")).toBeTruthy();
    expect(
      within(screen.getByRole("region", { name: "C:/inactive" })).getByText(
        "Completed",
      ),
    ).toBeTruthy();
    fireEvent.click(
      within(running).getByRole("button", {
        name: "Open Release in C:/two/project",
      }),
    );
    expect(handlers.onOpen).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceRoot: "C:/two/project",
        flowId: "release",
        scope: "workspace",
        running: true,
      }),
    );
  });

  it("opens the exact resumed run and keeps global flows distinct", () => {
    const library = createOverviewLibrary("C:/one", "user");
    library.runs = [createOverviewRun({ id: "resume-me", status: "crashed" })];
    const task = {
      ...createOverviewTask("C:/two", "task", "user"),
      arguments: ["resume", "resume-me", "--scope", "user"],
    };
    const handlers = callbacks();
    render(
      createElement(RalphOverview, {
        ...handlers,
        libraries: [library, createOverviewLibrary("C:/two")],
        tasks: [task],
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Open Release in C:/two" }),
    );
    expect(handlers.onOpen).toHaveBeenCalledWith({
      workspaceRoot: "C:/two",
      flowId: "release",
      scope: "user",
      runId: "resume-me",
      running: true,
    });
    expect(screen.getByRole("region", { name: "Global flows" })).toBeTruthy();
  });

  it("distinguishes checking, failed, empty, and successfully idle workspaces", () => {
    const library = {
      ...createOverviewLibrary("/one"),
      loaded: false,
      loading: true,
      flows: [],
    };
    const props = {
      ...callbacks(),
      libraries: [library],
      tasks: [],
      tasksLoaded: false,
    };
    const { rerender } = render(createElement(RalphOverview, props));
    expect(screen.getByText("Checking activity…")).toBeTruthy();
    expect(screen.queryByText("No running flows")).toBeNull();
    rerender(
      createElement(RalphOverview, {
        ...props,
        tasksLoaded: true,
        libraries: [
          { ...library, loading: false, error: "Workspace disconnected" },
        ],
      }),
    );
    expect(screen.getByRole("alert").textContent).toContain(
      "Workspace disconnected",
    );
    expect(screen.getByText("Activity unavailable")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(props.onRefresh).toHaveBeenCalledOnce();
    rerender(
      createElement(RalphOverview, {
        ...props,
        tasksLoaded: true,
        libraries: [{ ...library, loading: false, loaded: true }],
      }),
    );
    expect(screen.getByText("No running flows")).toBeTruthy();
    expect(screen.getByText("No flows")).toBeTruthy();
  });
});
