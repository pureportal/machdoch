import { fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import type {
  RalphFlow,
  RalphFlowSummary,
} from "../../../../core/ralph.js";
import type { ActiveRalphRun } from "../_helpers/ralph-active-run-progress.helper";
import { getFlowSummarySelectionKey } from "../_helpers/upsert-flow-summary.helper";
import {
  RalphFlowLibraryPanel,
  type RalphFlowListRow,
} from "./ralph-flow-library-panel";

class ResizeObserverMock {
  observe(): void {}

  unobserve(): void {}

  disconnect(): void {}
}

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverMock);
});

const workspaceFlow: RalphFlowSummary = {
  blockCount: 2,
  edgeCount: 1,
  id: "workspace-flow",
  name: "Workspace flow",
  path: "flows/workspace-flow.json",
  scope: "workspace",
  variableCount: 0,
};

const userFlow: RalphFlowSummary = {
  blockCount: 1,
  edgeCount: 0,
  id: "user-flow",
  name: "User flow",
  path: "flows/user-flow.json",
  scope: "user",
  variableCount: 0,
};

const displayRows: RalphFlowListRow[] = [
  { count: 1, scope: "workspace", type: "heading" },
  { flow: workspaceFlow, type: "flow" },
  { count: 1, scope: "user", type: "heading" },
  { flow: userFlow, type: "flow" },
];

const activeRun = {
  flowId: workspaceFlow.id,
  flowName: workspaceFlow.name,
  id: "run-1",
  scope: "workspace",
  status: "running",
} as ActiveRalphRun;

const renderPanel = (
  props: Partial<ComponentProps<typeof RalphFlowLibraryPanel>> = {},
) => {
  const defaultProps: ComponentProps<typeof RalphFlowLibraryPanel> = {
    activeRunsByFlowKey: new Map(),
    defaultFlowActionScope: "workspace",
    dirty: false,
    displayFlowRows: displayRows,
    draftFlow: null,
    errorCount: 0,
    flowLibraryMode: "workspace",
    flowListOpen: true,
    flowsLoading: false,
    generationCreatedFlow: null,
    getStarterFlowUpdate: () => null,
    loading: false,
    onCollapseFlowList: vi.fn(),
    onCreateLocalFlow: vi.fn(),
    onFlowContextMenu: vi.fn(),
    onFlowLibraryModeChange: vi.fn(),
    onOpenFlowList: vi.fn(),
    onOpenStarterFlowDialog: vi.fn(),
    onRefreshFlows: vi.fn(),
    onSelectFlow: vi.fn(),
    onUpgradeStarterFlow: vi.fn(),
    selectedFlowKey: null,
    selectedScope: "workspace",
    warningCount: 0,
    workspaceRoot: "C:/workspace",
  };

  return render(<RalphFlowLibraryPanel {...defaultProps} {...props} />);
};

describe("RalphFlowLibraryPanel", () => {
  it("renders flow headings and active run status labels", () => {
    renderPanel({
      activeRunsByFlowKey: new Map([
        [getFlowSummarySelectionKey(workspaceFlow), [activeRun]],
      ]),
    });

    expect(screen.getAllByText("Workspace").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Global").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /Workspace flow/ })).toBeTruthy();
    expect(screen.getByLabelText("Flow status: Running")).toBeTruthy();
  });

  it("reports starter updates before saved status", () => {
    const onUpgradeStarterFlow = vi.fn();
    renderPanel({
      getStarterFlowUpdate: (flow) =>
        flow.id === userFlow.id
          ? { currentVersion: 1, latestVersion: 2, starterId: "starter" }
          : null,
      onUpgradeStarterFlow,
    });

    expect(screen.getByLabelText("Flow status: Starter update")).toBeTruthy();
    expect(screen.getByText("Starter v2 available")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Upgrade User flow to starter version 2",
      }),
    );
    expect(onUpgradeStarterFlow).toHaveBeenCalledWith(userFlow);
  });

  it("disables starter upgrades while another flow operation is running", () => {
    renderPanel({
      getStarterFlowUpdate: (flow) =>
        flow.id === userFlow.id
          ? { currentVersion: 1, latestVersion: 2, starterId: "starter" }
          : null,
      loading: true,
    });

    expect(
      screen
        .getByRole("button", {
          name: "Upgrade User flow to starter version 2",
        })
        .hasAttribute("disabled"),
    ).toBe(true);
  });

  it("uses draft validation state for the selected draft flow", () => {
    renderPanel({
      dirty: true,
      draftFlow: {
        schemaVersion: 1,
        blocks: [],
        edges: [],
        id: workspaceFlow.id,
        name: workspaceFlow.name,
      } as RalphFlow,
      selectedFlowKey: getFlowSummarySelectionKey(workspaceFlow),
      selectedScope: "workspace",
    });

    expect(screen.getByLabelText("Flow status: Unsaved")).toBeTruthy();
  });

  it("disables creation actions without a workspace and shows the empty message", () => {
    renderPanel({
      displayFlowRows: [],
      workspaceRoot: "",
    });

    expect(screen.getByText("Choose a workspace before creating Ralph flows.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "New" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(
      screen.getByRole("button", { name: "Open starter Ralph flows" }),
    ).toHaveProperty("disabled", true);
  });

  it("calls back for library mode changes and collapsed opening", () => {
    const onFlowLibraryModeChange = vi.fn();
    const onOpenFlowList = vi.fn();

    renderPanel({ onFlowLibraryModeChange });
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    expect(onFlowLibraryModeChange).toHaveBeenCalledWith("all");

    renderPanel({ flowListOpen: false, onOpenFlowList });
    fireEvent.click(screen.getByRole("button", { name: "Open Ralph flows" }));
    expect(onOpenFlowList).toHaveBeenCalledOnce();
  });
});
