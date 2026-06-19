import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RalphFlow } from "../../../core/ralph.js";
import { TooltipProvider } from "../components/ui/tooltip";
import {
  cancelDesktopTask,
  createRalphFlow,
  deleteRalphFlow,
  listRalphFlowRevisions,
  listRalphFlows,
  listRalphRuns,
  loadActiveDesktopTasks,
  loadProviderModelCatalog,
  resolveDroppedPaths,
  restoreRalphFlowRevision,
  runRalphFlow,
  saveRalphFlow,
  showRalphRunDetail,
  showRalphRunLog,
  showRalphFlow,
  subscribeToDesktopTaskProgress,
  type DesktopTaskProgressEvent,
} from "../runtime";
import { openMock } from "../test/tauri-test-mocks";
import { RalphFlowEditor, type RalphFlowEditorProps } from "./ralph-flow-editor";

vi.mock("../runtime", () => ({
  cancelDesktopTask: vi.fn(),
  createRalphFlow: vi.fn(),
  deleteRalphFlow: vi.fn(),
  listRalphFlowRevisions: vi.fn(),
  listRalphFlows: vi.fn(),
  listRalphRuns: vi.fn(),
  loadActiveDesktopTasks: vi.fn(),
  loadProviderModelCatalog: vi.fn(),
  resolveDroppedPaths: vi.fn(),
  restoreRalphFlowRevision: vi.fn(),
  runRalphFlow: vi.fn(),
  saveRalphFlow: vi.fn(),
  showRalphRunDetail: vi.fn(),
  showRalphRunLog: vi.fn(),
  showRalphFlow: vi.fn(),
  subscribeToDesktopTaskProgress: vi.fn(),
}));

class MockResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

const renderRalphFlowEditor = (
  initialPrompt = "Refactor {{scope:path=src}}",
  props: Partial<
    Pick<
      RalphFlowEditorProps,
      | "providerOptions"
      | "flowLibraryMode"
      | "onFlowLibraryModeChange"
      | "generationPromptHistory"
      | "onGenerationPromptHistoryChange"
    >
  > = {},
): ReturnType<typeof render> => {
  return render(
    <TooltipProvider>
      <RalphFlowEditor
        workspaceRoot="C:\\Project"
        initialPrompt={initialPrompt}
        runMode="machdoch"
        generationProvider="openai"
        generationModel="gpt-5.5"
        generationProfile="workspace"
        runProvider="openai"
        runModel="gpt-5.5"
        runProfile="workspace"
        {...props}
      />
    </TooltipProvider>,
  );
};

const createRunnableFlow = (): RalphFlow => ({
  schemaVersion: 1,
  id: "background-flow",
  name: "Background Flow",
  blocks: [
    { id: "start", type: "START", title: "Start" },
    { id: "end", type: "END", title: "End", status: "success" },
  ],
  edges: [
    {
      id: "start-to-end",
      from: "start",
      fromOutput: "SUCCESS",
      to: "end",
    },
  ],
});

let desktopProgressListener:
  | ((event: DesktopTaskProgressEvent) => void)
  | null = null;

describe("RalphFlowEditor", () => {
  beforeEach(() => {
    vi.mocked(createRalphFlow).mockReset();
    vi.mocked(cancelDesktopTask).mockReset();
    vi.mocked(deleteRalphFlow).mockReset();
    vi.mocked(listRalphFlowRevisions).mockReset();
    vi.mocked(listRalphFlows).mockReset();
    vi.mocked(listRalphRuns).mockReset();
    vi.mocked(loadActiveDesktopTasks).mockReset();
    vi.mocked(loadProviderModelCatalog).mockReset();
    vi.mocked(resolveDroppedPaths).mockReset();
    vi.mocked(restoreRalphFlowRevision).mockReset();
    vi.mocked(runRalphFlow).mockReset();
    vi.mocked(saveRalphFlow).mockReset();
    vi.mocked(showRalphRunDetail).mockReset();
    vi.mocked(showRalphRunLog).mockReset();
    vi.mocked(showRalphFlow).mockReset();
    vi.mocked(subscribeToDesktopTaskProgress).mockReset();
    desktopProgressListener = null;
    vi.mocked(subscribeToDesktopTaskProgress).mockImplementation(
      async (listener) => {
        desktopProgressListener = listener;

        return () => {
          desktopProgressListener = null;
        };
      },
    );
    vi.mocked(listRalphFlows).mockResolvedValue({
      workspaceRoot: "C:\\Project",
      flows: [],
    });
    vi.mocked(listRalphFlowRevisions).mockResolvedValue({
      flow: "ralph-flow",
      revisions: [],
    });
    vi.mocked(listRalphRuns).mockResolvedValue({
      runs: [],
    });
    vi.mocked(loadActiveDesktopTasks).mockResolvedValue([]);
    vi.mocked(showRalphFlow).mockResolvedValue({
      path: "C:\\Project\\.machdoch\\ralph\\flows\\ralph-flow.json",
      flow: {
        schemaVersion: 1,
        id: "ralph-flow",
        name: "Ralph Flow",
        blocks: [],
        edges: [],
      },
    });
    vi.mocked(resolveDroppedPaths).mockResolvedValue({
      workspaceRoot: "C:\\Project",
      entries: [],
    });
    vi.mocked(deleteRalphFlow).mockResolvedValue({
      id: "ralph-flow",
      path: "C:\\Project\\.machdoch\\ralph\\flows\\ralph-flow.json",
      revisionDirectory: "C:\\Project\\.machdoch\\ralph\\revisions\\ralph-flow",
      deletedRevisions: false,
    });
    vi.mocked(loadProviderModelCatalog).mockResolvedValue({
      generatedAt: 0,
      providers: [
        {
          provider: "openai",
          available: true,
          models: [
            { id: "gpt-5.5", label: "GPT-5.5" },
            { id: "gpt-5.4", label: "GPT-5.4" },
          ],
        },
        {
          provider: "anthropic",
          available: true,
          models: [{ id: "claude-opus-4-1", label: "Claude Opus 4.1" }],
        },
      ],
    });
    vi.mocked(saveRalphFlow).mockImplementation(async (_workspaceRoot, input) => ({
      path: "C:\\Project\\.machdoch\\ralph\\flows\\ralph-flow.json",
      flow: input.flow,
      validation: {
        valid: true,
        errors: [],
        warnings: [],
        errorIssues: [],
        warningIssues: [],
        variables: input.flow.variables ?? [],
      },
    }));
    vi.mocked(cancelDesktopTask).mockResolvedValue(undefined);
    vi.mocked(showRalphRunDetail).mockResolvedValue({
      scope: "workspace",
      path: "C:\\Project\\.machdoch\\ralph\\runs\\run-1\\run.json",
      record: {
        schemaVersion: 1,
        id: "run-1",
        createdAt: "2026-06-19T07:00:00.000Z",
        flowId: "background-flow",
        flowName: "Background Flow",
        status: "completed",
        summary: "Done.",
        variableValues: {},
        events: [],
        blockResults: [],
        validation: {
          valid: true,
          errors: [],
          warnings: [],
        },
      },
    });
    vi.mocked(showRalphRunLog).mockResolvedValue({
      id: "run-1",
      kind: "simple",
      path: "C:\\Project\\.machdoch\\ralph\\runs\\run-1\\simple.md",
      content: "Run log.",
    });
    openMock.mockReset();
    openMock.mockResolvedValue(null);

    vi.stubGlobal("ResizeObserver", MockResizeObserver);
    vi.stubGlobal("confirm", vi.fn(() => true));
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("opens as a canvas-first Ralph flow editor", async () => {
    renderRalphFlowEditor("Refactor {{scope:path=src}}");


    expect(await screen.findByText("Ralph Flow Editor")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add PROMPT block" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add VALIDATOR block" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add END block" })).toBeTruthy();
    expect(screen.getByText("Flow Settings")).toBeTruthy();
    expect(screen.getByText("Validation")).toBeTruthy();
    expect(screen.getByText("AI Flow Changes")).toBeTruthy();
    expect(screen.getByText("Create or select a flow before running.")).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "Open AI flow generator from canvas" }),
    );
    expect(screen.getByRole("button", { name: "Flow" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Improve" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Prompt" })).toBeTruthy();

    await waitFor(() => {
      expect(screen.getByText("No workspace Ralph flows found.")).toBeTruthy();
    });
  });

  it("shows a loading state before the Ralph flow list resolves", async () => {
    let resolveFlows:
      | ((result: Awaited<ReturnType<typeof listRalphFlows>>) => void)
      | undefined;
    vi.mocked(listRalphFlows).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFlows = resolve;
        }),
    );

    renderRalphFlowEditor("Refactor {{scope:path=src}}");


    expect(await screen.findByText("Loading Ralph flows...")).toBeTruthy();

    resolveFlows?.({ workspaceRoot: "C:\\Project", flows: [] });

    expect(await screen.findByText("No workspace Ralph flows found.")).toBeTruthy();
  });

  it("loads global Ralph flows when the Global library is selected", async () => {
    vi.mocked(listRalphFlows).mockResolvedValue({
      workspaceRoot: "C:\\Project",
      scope: "user",
      flows: [
        {
          id: "global-review",
          alias: "review",
          name: "Global Review",
          scope: "user",
          path: "C:\\Users\\andreas\\AppData\\Roaming\\machdoch\\ralph\\flows\\global-review.json",
          blockCount: 2,
          edgeCount: 1,
          variableCount: 0,
        },
      ],
    });
    vi.mocked(showRalphFlow).mockResolvedValue({
      path: "C:\\Users\\andreas\\AppData\\Roaming\\machdoch\\ralph\\flows\\global-review.json",
      scope: "user",
      flow: {
        schemaVersion: 1,
        id: "global-review",
        alias: "review",
        name: "Global Review",
        blocks: [],
        edges: [],
      },
    });

    renderRalphFlowEditor("Review {{scope:path=ALL}}", {
      flowLibraryMode: "user",
    });

    expect(await screen.findAllByText("Global Review")).not.toHaveLength(0);
    await waitFor(() => {
      expect(listRalphFlows).toHaveBeenCalledWith(
        expect.stringContaining("Project"),
        "user",
      );
      expect(showRalphFlow).toHaveBeenCalledWith(
        expect.stringContaining("Project"),
        "global-review",
        "user",
      );
    });
  });

  it("saves new global flows through the selected creation scope", async () => {
    renderRalphFlowEditor("Global audit flow", {
      flowLibraryMode: "user",
    });

    fireEvent.click(await screen.findByRole("button", { name: "New" }));
    await waitFor(() => {
      expect(
        screen
          .getAllByRole("button", { name: "Save" })
          .some((button) => !button.hasAttribute("disabled")),
      ).toBe(true);
    });
    const saveButton = screen
      .getAllByRole("button", { name: "Save" })
      .find((button) => !button.hasAttribute("disabled"));
    expect(saveButton).toBeTruthy();
    fireEvent.click(saveButton as HTMLElement);

    await waitFor(() => {
      expect(saveRalphFlow).toHaveBeenCalledWith(
        expect.stringContaining("Project"),
        expect.objectContaining({
          scope: "user",
          flow: expect.objectContaining({
            alias: "global-audit-flow",
          }),
        }),
      );
    });
  });

  it("disambiguates workspace and global flows with the same alias", async () => {
    vi.mocked(listRalphFlows).mockImplementation(async (_workspaceRoot, scope) => {
      const resolvedScope = scope ?? "workspace";
      const isGlobal = resolvedScope === "user";

      return {
        workspaceRoot: "C:\\Project",
        scope: resolvedScope,
        flows: [
          {
            id: isGlobal ? "global-review" : "workspace-review",
            alias: "review",
            name: isGlobal ? "Global Review" : "Workspace Review",
            scope: resolvedScope,
            path: isGlobal
              ? "C:\\Users\\andreas\\AppData\\Roaming\\machdoch\\ralph\\flows\\global-review.json"
              : "C:\\Project\\.machdoch\\ralph\\flows\\workspace-review.json",
            blockCount: 2,
            edgeCount: 1,
            variableCount: 0,
          },
        ],
      };
    });
    vi.mocked(showRalphFlow).mockImplementation(async (_workspaceRoot, id, scope) => ({
      path:
        scope === "user"
          ? "C:\\Users\\andreas\\AppData\\Roaming\\machdoch\\ralph\\flows\\global-review.json"
          : "C:\\Project\\.machdoch\\ralph\\flows\\workspace-review.json",
      scope,
      flow: {
        schemaVersion: 1,
        id,
        alias: "review",
        name: scope === "user" ? "Global Review" : "Workspace Review",
        blocks: [],
        edges: [],
      },
    }));

    renderRalphFlowEditor("Review {{scope:path=ALL}}", {
      flowLibraryMode: "all",
    });

    expect(await screen.findAllByText("Workspace Review")).not.toHaveLength(0);
    expect(await screen.findAllByText("Global Review")).not.toHaveLength(0);
    const globalFlowButton = screen
      .getAllByRole("button", { name: /Global Review/u })
      .at(0);
    expect(globalFlowButton).toBeTruthy();
    fireEvent.click(globalFlowButton as HTMLElement);

    await waitFor(() => {
      expect(showRalphFlow).toHaveBeenCalledWith(
        expect.stringContaining("Project"),
        "global-review",
        "user",
      );
    });
  });

  it("creates an editable draft with condition route selectors", async () => {
    renderRalphFlowEditor("Refactor {{scope:path=src}}");

    fireEvent.click(await screen.findByRole("button", { name: "New" }));

    expect(await screen.findByRole("button", { name: "Show flow settings" })).toBeTruthy();
    expect(screen.getByLabelText("Block title")).toBeTruthy();
    const startRouteTarget = screen.getByLabelText("SUCCESS route target");
    expect(startRouteTarget).toBeTruthy();
    expect(screen.getByText("Routes")).toBeTruthy();

    fireEvent.pointerDown(startRouteTarget, { button: 0, ctrlKey: false });

    expect(await screen.findByRole("menuitem", { name: "Self (Start [START])" }))
      .toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "End [END]" })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: "Self (Start [START])" }));

    fireEvent.click(screen.getByRole("button", { name: "Add PROMPT block" }));
    fireEvent.pointerDown(screen.getByLabelText("SUCCESS route target"), {
      button: 0,
      ctrlKey: false,
    });

    expect(await screen.findByRole("menuitem", { name: "Start [START]" }))
      .toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Self (Prompt 1 [PROMPT])" }))
      .toBeTruthy();
  });

  it("supports undo and redo for flow edits", async () => {
    renderRalphFlowEditor("Refactor {{scope:path=src}}");

    fireEvent.click(await screen.findByRole("button", { name: "New" }));
    fireEvent.click(await screen.findByRole("button", { name: "Show flow settings" }));

    const nameInput = (await screen.findByLabelText(
      "Flow name",
    )) as HTMLInputElement;
    const originalName = nameInput.value;

    fireEvent.change(nameInput, {
      target: { value: "Undoable Ralph Flow" },
    });

    expect((screen.getByLabelText("Flow name") as HTMLInputElement).value).toBe(
      "Undoable Ralph Flow",
    );

    fireEvent.click(screen.getByRole("button", { name: "Undo Ralph edit" }));

    await waitFor(() => {
      expect((screen.getByLabelText("Flow name") as HTMLInputElement).value).toBe(
        originalName,
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Redo Ralph edit" }));

    await waitFor(() => {
      expect((screen.getByLabelText("Flow name") as HTMLInputElement).value).toBe(
        "Undoable Ralph Flow",
      );
    });
  });

  it("adds and saves utility block configuration", async () => {
    renderRalphFlowEditor("Refactor {{scope:path=src}}");

    fireEvent.click(await screen.findByRole("button", { name: "New" }));
    fireEvent.click(await screen.findByRole("button", { name: "Add UTILITY block" }));

    expect(await screen.findByLabelText("Utility type")).toBeTruthy();
    expect((screen.getByLabelText("Block title") as HTMLInputElement).value).toBe(
      "Wait",
    );
    expect(screen.getByText("Delay for 1s")).toBeTruthy();
    expect(screen.getByText("Wait Utility")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Block provider" })).toBeNull();

    fireEvent.change(screen.getByLabelText("Utility type"), {
      target: { value: "RUN_CHECK" },
    });
    expect((screen.getByLabelText("Block title") as HTMLInputElement).value).toBe(
      "Run Check",
    );
    expect(screen.getByText("Run Check Utility")).toBeTruthy();
    expect(screen.getByText("Failed exit codes route to FAILED.")).toBeTruthy();
    fireEvent.change(await screen.findByLabelText("Utility command"), {
      target: { value: "npm run typecheck:ui" },
    });

    fireEvent.click(screen.getAllByRole("button", { name: "Save" })[0] as HTMLElement);

    await waitFor(() => {
      expect(saveRalphFlow).toHaveBeenCalled();
    });

    const savedFlow = vi.mocked(saveRalphFlow).mock.calls[0]?.[1].flow;
    const utilityBlock = savedFlow?.blocks.find(
      (block) => block.type === "UTILITY",
    );

    expect(utilityBlock).toMatchObject({
      type: "UTILITY",
      title: "Run Check",
      utility: {
        type: "RUN_CHECK",
        command: "npm run typecheck:ui",
      },
    });
  });

  it("adds and saves note and group node configuration", async () => {
    renderRalphFlowEditor("Refactor {{scope:path=src}}");

    fireEvent.click(await screen.findByRole("button", { name: "New" }));
    fireEvent.click(await screen.findByRole("button", { name: "Add NOTE block" }));

    fireEvent.change(await screen.findByLabelText("Note text"), {
      target: { value: "- [ ] Capture screenshot evidence" },
    });
    fireEvent.change(screen.getByLabelText("Note tone"), {
      target: { value: "sky" },
    });
    fireEvent.change(screen.getByLabelText("Note tags"), {
      target: { value: "manual QA, risk" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Add GROUP block" }));
    fireEvent.change(await screen.findByLabelText("Group description"), {
      target: { value: "Verification phase and evidence collection." },
    });
    fireEvent.change(screen.getByLabelText("Group tone"), {
      target: { value: "violet" },
    });

    fireEvent.click(screen.getAllByRole("button", { name: "Save" })[0] as HTMLElement);

    await waitFor(() => {
      expect(saveRalphFlow).toHaveBeenCalled();
    });

    const savedFlow = vi.mocked(saveRalphFlow).mock.calls[0]?.[1].flow;
    const noteBlock = savedFlow?.blocks.find((block) => block.type === "NOTE");
    const groupBlock = savedFlow?.blocks.find((block) => block.type === "GROUP");

    expect(noteBlock).toMatchObject({
      type: "NOTE",
      text: "- [ ] Capture screenshot evidence",
      tone: "sky",
      tags: ["manual QA", "risk"],
      size: {
        width: 280,
        height: 180,
      },
    });
    expect(groupBlock).toMatchObject({
      type: "GROUP",
      description: "Verification phase and evidence collection.",
      tone: "violet",
      size: {
        width: 720,
        height: 420,
      },
      moveChildren: true,
      layoutMode: "freeform",
    });
  });

  it("derives and saves group children from canvas geometry", async () => {
    const groupedFlow: RalphFlow = {
      schemaVersion: 1,
      id: "grouped-flow",
      name: "Grouped Flow",
      blocks: [
        {
          id: "start",
          type: "START",
          title: "Start",
          position: { x: 120, y: 120 },
        },
        {
          id: "prompt",
          type: "PROMPT",
          title: "Prompt",
          prompt: "Do work.",
          position: { x: 380, y: 120 },
        },
        {
          id: "phase",
          type: "GROUP",
          title: "Phase",
          description: "",
          childBlockIds: [],
          position: { x: 80, y: 80 },
          size: { width: 680, height: 280 },
          tone: "sky",
          moveChildren: true,
          layoutMode: "freeform",
        },
      ],
      edges: [
        {
          id: "start-to-prompt",
          from: "start",
          fromOutput: "SUCCESS",
          to: "prompt",
        },
      ],
    };

    vi.mocked(listRalphFlows).mockResolvedValue({
      workspaceRoot: "C:\\Project",
      flows: [
        {
          id: groupedFlow.id,
          name: groupedFlow.name,
          path: "C:\\Project\\.machdoch\\ralph\\flows\\grouped-flow.json",
          blockCount: groupedFlow.blocks.length,
          edgeCount: groupedFlow.edges.length,
          variableCount: 0,
        },
      ],
    });
    vi.mocked(showRalphFlow).mockResolvedValue({
      path: "C:\\Project\\.machdoch\\ralph\\flows\\grouped-flow.json",
      flow: groupedFlow,
    });

    renderRalphFlowEditor("Refactor {{scope:path=src}}");

    expect(await screen.findByText("2 child block(s)")).toBeTruthy();
    fireEvent.click(await screen.findByText("Phase"));
    fireEvent.change(await screen.findByLabelText("Group description"), {
      target: { value: "Derived geometry group." },
    });
    fireEvent.click(screen.getAllByRole("button", { name: "Save" })[0] as HTMLElement);

    await waitFor(() => {
      expect(saveRalphFlow).toHaveBeenCalled();
    });

    const savedFlow = vi.mocked(saveRalphFlow).mock.calls[0]?.[1].flow;
    const groupBlock = savedFlow?.blocks.find((block) => block.type === "GROUP");

    expect(groupBlock).toMatchObject({
      type: "GROUP",
      childBlockIds: ["start", "prompt"],
      description: "Derived geometry group.",
    });
  });

  it("detaches saved group children when they are outside the group bounds", async () => {
    const detachedFlow: RalphFlow = {
      schemaVersion: 1,
      id: "detached-group-flow",
      name: "Detached Group Flow",
      blocks: [
        {
          id: "start",
          type: "START",
          title: "Start",
          position: { x: 120, y: 120 },
        },
        {
          id: "prompt",
          type: "PROMPT",
          title: "Prompt",
          prompt: "Do work.",
          position: { x: 380, y: 120 },
        },
        {
          id: "phase",
          type: "GROUP",
          title: "Phase",
          description: "Moved away with Ctrl.",
          childBlockIds: ["start", "prompt"],
          position: { x: 900, y: 80 },
          size: { width: 360, height: 240 },
          tone: "sky",
          moveChildren: true,
          layoutMode: "freeform",
        },
      ],
      edges: [
        {
          id: "start-to-prompt",
          from: "start",
          fromOutput: "SUCCESS",
          to: "prompt",
        },
      ],
    };

    vi.mocked(listRalphFlows).mockResolvedValue({
      workspaceRoot: "C:\\Project",
      flows: [
        {
          id: detachedFlow.id,
          name: detachedFlow.name,
          path: "C:\\Project\\.machdoch\\ralph\\flows\\detached-group-flow.json",
          blockCount: detachedFlow.blocks.length,
          edgeCount: detachedFlow.edges.length,
          variableCount: 0,
        },
      ],
    });
    vi.mocked(showRalphFlow).mockResolvedValue({
      path: "C:\\Project\\.machdoch\\ralph\\flows\\detached-group-flow.json",
      flow: detachedFlow,
    });

    renderRalphFlowEditor("Refactor {{scope:path=src}}");

    expect(await screen.findByText("0 child block(s)")).toBeTruthy();
    fireEvent.click(await screen.findByText("Phase"));
    fireEvent.change(await screen.findByLabelText("Group description"), {
      target: { value: "Detached after Ctrl move." },
    });
    fireEvent.click(screen.getAllByRole("button", { name: "Save" })[0] as HTMLElement);

    await waitFor(() => {
      expect(saveRalphFlow).toHaveBeenCalled();
    });

    const savedFlow = vi.mocked(saveRalphFlow).mock.calls.at(-1)?.[1].flow;
    const groupBlock = savedFlow?.blocks.find((block) => block.id === "phase");

    expect(groupBlock).toMatchObject({
      type: "GROUP",
      childBlockIds: [],
    });
  });

  it("cleans layout without moving notes, groups, or grouped children", async () => {
    const groupedFlow: RalphFlow = {
      schemaVersion: 1,
      id: "grouped-clean-flow",
      name: "Grouped Clean Flow",
      blocks: [
        {
          id: "start",
          type: "START",
          title: "Start",
          position: { x: 120, y: 120 },
        },
        {
          id: "prompt",
          type: "PROMPT",
          title: "Prompt",
          prompt: "Do work.",
          position: { x: 380, y: 120 },
        },
        {
          id: "phase",
          type: "GROUP",
          title: "Phase",
          description: "Keep this frame anchored.",
          childBlockIds: [],
          position: { x: 80, y: 80 },
          size: { width: 680, height: 280 },
          tone: "sky",
          moveChildren: true,
          layoutMode: "freeform",
        },
        {
          id: "note",
          type: "NOTE",
          title: "Evidence note",
          text: "Manual checks stay next to the group.",
          position: { x: 840, y: 90 },
          size: { width: 280, height: 180 },
          tone: "amber",
          tags: ["qa"],
        },
        {
          id: "review",
          type: "VALIDATOR",
          title: "Review",
          prompt: "Review the output.",
          position: { x: 1180, y: 120 },
        },
      ],
      edges: [
        {
          id: "start-to-prompt",
          from: "start",
          fromOutput: "SUCCESS",
          to: "prompt",
        },
        {
          id: "prompt-to-review",
          from: "prompt",
          fromOutput: "SUCCESS",
          to: "review",
        },
      ],
    };

    vi.mocked(listRalphFlows).mockResolvedValue({
      workspaceRoot: "C:\\Project",
      flows: [
        {
          id: groupedFlow.id,
          name: groupedFlow.name,
          path: "C:\\Project\\.machdoch\\ralph\\flows\\grouped-clean-flow.json",
          blockCount: groupedFlow.blocks.length,
          edgeCount: groupedFlow.edges.length,
          variableCount: 0,
        },
      ],
    });
    vi.mocked(showRalphFlow).mockResolvedValue({
      path: "C:\\Project\\.machdoch\\ralph\\flows\\grouped-clean-flow.json",
      flow: groupedFlow,
    });

    renderRalphFlowEditor("Refactor {{scope:path=src}}");

    expect(await screen.findByText("2 child block(s)")).toBeTruthy();
    fireEvent.click(
      await screen.findByRole("button", { name: "Clean Ralph layout" }),
    );
    fireEvent.click(screen.getAllByRole("button", { name: "Save" })[0] as HTMLElement);

    await waitFor(() => {
      expect(saveRalphFlow).toHaveBeenCalled();
    });

    const savedFlow = vi.mocked(saveRalphFlow).mock.calls.at(-1)?.[1].flow;
    const startBlock = savedFlow?.blocks.find((block) => block.id === "start");
    const promptBlock = savedFlow?.blocks.find((block) => block.id === "prompt");
    const groupBlock = savedFlow?.blocks.find((block) => block.id === "phase");
    const noteBlock = savedFlow?.blocks.find((block) => block.id === "note");
    const reviewBlock = savedFlow?.blocks.find((block) => block.id === "review");

    expect(startBlock?.position).toEqual({ x: 120, y: 120 });
    expect(promptBlock?.position).toEqual({ x: 380, y: 120 });
    expect(groupBlock).toMatchObject({
      childBlockIds: ["start", "prompt"],
      position: { x: 80, y: 80 },
      size: { width: 680, height: 280 },
    });
    expect(noteBlock).toMatchObject({
      position: { x: 840, y: 90 },
      size: { width: 280, height: 180 },
    });
    expect(reviewBlock?.position?.x).toBeGreaterThan(1120);
    expect(groupBlock?.childBlockIds).not.toContain("review");
  });

  it("edits and saves flow-level max transitions", async () => {
    renderRalphFlowEditor("Refactor {{scope:path=src}}");

    fireEvent.click(await screen.findByRole("button", { name: "New" }));
    fireEvent.click(await screen.findByRole("button", { name: "Show flow settings" }));
    fireEvent.change(await screen.findByLabelText("Flow max transitions"), {
      target: { value: "30" },
    });

    fireEvent.click(screen.getAllByRole("button", { name: "Save" })[0] as HTMLElement);

    await waitFor(() => {
      expect(saveRalphFlow).toHaveBeenCalled();
    });

    const savedFlow = vi.mocked(saveRalphFlow).mock.calls[0]?.[1].flow;

    expect(savedFlow?.settings).toEqual({
      maxTransitions: 30,
    });
  });

  it("adds and saves UI analysis utility configuration", async () => {
    renderRalphFlowEditor("Refactor {{scope:path=src}}");

    fireEvent.click(await screen.findByRole("button", { name: "New" }));
    fireEvent.click(await screen.findByRole("button", { name: "Add UTILITY block" }));
    fireEvent.change(await screen.findByLabelText("Utility type"), {
      target: { value: "UI_ANALYZE" },
    });
    fireEvent.change(await screen.findByLabelText("UI analysis adapter"), {
      target: { value: "tauri-mcp" },
    });
    fireEvent.change(await screen.findByLabelText("UI analysis MCP server"), {
      target: { value: "tauri" },
    });
    fireEvent.change(await screen.findByLabelText("UI analysis MCP tool"), {
      target: { value: "capture_screenshot" },
    });
    fireEvent.blur(await screen.findByLabelText("UI analysis MCP arguments JSON"), {
      target: { value: '{ "window": "main" }' },
    });

    fireEvent.click(screen.getAllByRole("button", { name: "Save" })[0] as HTMLElement);

    await waitFor(() => {
      expect(saveRalphFlow).toHaveBeenCalled();
    });

    const savedFlow = vi.mocked(saveRalphFlow).mock.calls[0]?.[1].flow;
    const utilityBlock = savedFlow?.blocks.find(
      (block) => block.type === "UTILITY",
    );

    expect(utilityBlock).toMatchObject({
      type: "UTILITY",
      title: "UI Analyze",
      utility: {
        type: "UI_ANALYZE",
        adapter: "tauri-mcp",
        mcpServerId: "tauri",
        mcpToolName: "capture_screenshot",
        mcpArguments: {
          window: "main",
        },
      },
    });
  });

  it("adds and saves MCP tool block configuration", async () => {
    renderRalphFlowEditor("Refactor {{scope:path=src}}");

    fireEvent.click(await screen.findByRole("button", { name: "New" }));
    fireEvent.pointerDown(screen.getByRole("button", { name: "Add MCP block" }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Tool" }));

    expect(await screen.findByText("MCP Tool")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Block provider" })).toBeNull();

    fireEvent.change(screen.getByLabelText("MCP server"), {
      target: { value: "github" },
    });
    fireEvent.change(screen.getByLabelText("MCP tool name"), {
      target: { value: "search_issues" },
    });
    fireEvent.blur(screen.getByLabelText("MCP arguments JSON"), {
      target: { value: '{ "query": "{{query:string}}" }' },
    });

    fireEvent.click(screen.getAllByRole("button", { name: "Save" })[0] as HTMLElement);

    await waitFor(() => {
      expect(saveRalphFlow).toHaveBeenCalled();
    });

    const savedFlow = vi.mocked(saveRalphFlow).mock.calls[0]?.[1].flow;
    const mcpBlock = savedFlow?.blocks.find(
      (block) => block.type === "MCP_TOOL",
    );

    expect(mcpBlock).toMatchObject({
      type: "MCP_TOOL",
      serverId: "github",
      toolName: "search_issues",
      arguments: {
        query: "{{query:string}}",
      },
    });
  });

  it("edits end status and validator selected block scope", async () => {
    renderRalphFlowEditor("Refactor {{scope:path=src}}");

    fireEvent.click(await screen.findByRole("button", { name: "New" }));
    fireEvent.click(await screen.findByRole("button", { name: "Add PROMPT block" }));
    fireEvent.click(await screen.findByRole("button", { name: "Add VALIDATOR block" }));

    fireEvent.change(await screen.findByLabelText("Validation scope"), {
      target: { value: "selectedBlocks" },
    });
    fireEvent.click(await screen.findByText("Prompt 1 [PROMPT]"));

    fireEvent.click(screen.getByRole("button", { name: "Add END block" }));
    fireEvent.change(await screen.findByLabelText("End status"), {
      target: { value: "review" },
    });

    fireEvent.click(screen.getAllByRole("button", { name: "Save" })[0] as HTMLElement);

    await waitFor(() => {
      expect(saveRalphFlow).toHaveBeenCalled();
    });

    const savedFlow = vi.mocked(saveRalphFlow).mock.calls[0]?.[1].flow;
    const validatorBlock = savedFlow?.blocks.find(
      (block) => block.type === "VALIDATOR",
    );
    const reviewEnd = savedFlow?.blocks.find(
      (block) => block.type === "END" && block.id !== "end",
    );

    expect(validatorBlock).toMatchObject({
      validationScope: {
        mode: "selectedBlocks",
        blockIds: ["prompt-1"],
      },
    });
    expect(reviewEnd).toMatchObject({
      type: "END",
      status: "review",
    });
  });

  it("keeps new draft saves available when previous flow details are still loading", async () => {
    vi.mocked(listRalphFlows).mockResolvedValue({
      workspaceRoot: "C:\\Project",
      flows: [
        {
          id: "existing-flow",
          name: "Existing Flow",
          path: "C:\\Project\\.machdoch\\ralph\\flows\\existing-flow.json",
          blockCount: 2,
          edgeCount: 1,
          variableCount: 0,
        },
      ],
    });
    vi.mocked(showRalphFlow).mockImplementation(
      () => new Promise(() => {}),
    );

    renderRalphFlowEditor("Refactor {{scope:path=src}}");


    expect(await screen.findAllByText("Existing Flow")).not.toHaveLength(0);
    await waitFor(() => {
      expect(showRalphFlow).toHaveBeenCalledWith(
        expect.stringContaining("Project"),
        "existing-flow",
        "workspace",
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "New" }));

    await waitFor(() => {
      expect(
        screen.queryByText("Wait for the current Ralph operation to finish."),
      ).toBeNull();
    });

    const saveButtons = screen.getAllByRole("button", { name: "Save" });
    expect(saveButtons.some((button) => !button.hasAttribute("disabled"))).toBe(
      true,
    );
    expect(screen.getByText("Save flow before running.")).toBeTruthy();
  });

  it("deletes saved Ralph flows from the flow list", async () => {
    const flowPath = "C:\\Project\\.machdoch\\ralph\\flows\\existing-flow.json";
    const confirmMock = vi.mocked(window.confirm);

    vi.mocked(listRalphFlows).mockResolvedValue({
      workspaceRoot: "C:\\Project",
      flows: [
        {
          id: "existing-flow",
          name: "Existing Flow",
          path: flowPath,
          blockCount: 2,
          edgeCount: 1,
          variableCount: 0,
        },
      ],
    });
    vi.mocked(showRalphFlow).mockResolvedValue({
      path: flowPath,
      flow: {
        schemaVersion: 1,
        id: "existing-flow",
        name: "Existing Flow",
        blocks: [],
        edges: [],
      },
    });
    vi.mocked(deleteRalphFlow).mockResolvedValue({
      id: "existing-flow",
      path: flowPath,
      revisionDirectory: "C:\\Project\\.machdoch\\ralph\\revisions\\existing-flow",
      deletedRevisions: true,
    });

    renderRalphFlowEditor("Refactor {{scope:path=src}}");

    const flowButton = await screen.findByRole("button", {
      name: /Existing Flow/u,
    });
    expect(
      screen.queryByRole("button", { name: "Delete Ralph flow Existing Flow" }),
    ).toBeNull();
    fireEvent.contextMenu(flowButton);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));

    await waitFor(() => {
      expect(deleteRalphFlow).toHaveBeenCalledWith(
        expect.stringContaining("Project"),
        "existing-flow",
        "workspace",
      );
    });
    expect(confirmMock).toHaveBeenCalledWith(
      'Delete Ralph flow "Existing Flow"? This removes the saved flow and its revisions.',
    );
    expect(screen.queryByRole("menuitem", { name: "Delete" })).toBeNull();
  });

  it("copies saved Ralph flows to global from the row context menu", async () => {
    const flowPath = "C:\\Project\\.machdoch\\ralph\\flows\\existing-flow.json";

    vi.mocked(listRalphFlows).mockImplementation(async (_workspaceRoot, scope) => ({
      workspaceRoot: "C:\\Project",
      ...(scope ? { scope } : {}),
      flows:
        scope === "user"
          ? []
          : [
              {
                id: "existing-flow",
                name: "Existing Flow",
                path: flowPath,
                blockCount: 2,
                edgeCount: 1,
                variableCount: 0,
              },
            ],
    }));
    vi.mocked(showRalphFlow).mockResolvedValue({
      path: flowPath,
      scope: "workspace",
      flow: {
        schemaVersion: 1,
        id: "existing-flow",
        name: "Existing Flow",
        blocks: [],
        edges: [],
      },
    });

    renderRalphFlowEditor("Refactor {{scope:path=src}}");

    fireEvent.contextMenu(
      await screen.findByRole("button", { name: /Existing Flow/u }),
    );

    expect(screen.getByRole("menuitem", { name: "Copy to global" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Copy to workspace" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Move to global" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Move to workspace" })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy to global" }));

    await waitFor(() => {
      expect(showRalphFlow).toHaveBeenCalledWith(
        expect.stringContaining("Project"),
        "existing-flow",
        "workspace",
      );
      expect(saveRalphFlow).toHaveBeenCalledWith(
        expect.stringContaining("Project"),
        expect.objectContaining({
          scope: "user",
          flow: expect.objectContaining({ id: "existing-flow" }),
        }),
      );
    });
    expect(deleteRalphFlow).not.toHaveBeenCalled();
  });

  it("moves saved Ralph flows to global from the row context menu", async () => {
    const flowPath = "C:\\Project\\.machdoch\\ralph\\flows\\existing-flow.json";
    const confirmMock = vi.mocked(window.confirm);

    vi.mocked(listRalphFlows).mockImplementation(async (_workspaceRoot, scope) => ({
      workspaceRoot: "C:\\Project",
      ...(scope ? { scope } : {}),
      flows:
        scope === "user"
          ? []
          : [
              {
                id: "existing-flow",
                name: "Existing Flow",
                path: flowPath,
                blockCount: 2,
                edgeCount: 1,
                variableCount: 0,
              },
            ],
    }));
    vi.mocked(showRalphFlow).mockResolvedValue({
      path: flowPath,
      scope: "workspace",
      flow: {
        schemaVersion: 1,
        id: "existing-flow",
        name: "Existing Flow",
        blocks: [],
        edges: [],
      },
    });
    vi.mocked(deleteRalphFlow).mockResolvedValue({
      id: "existing-flow",
      path: flowPath,
      revisionDirectory: "C:\\Project\\.machdoch\\ralph\\revisions\\existing-flow",
      deletedRevisions: true,
    });

    renderRalphFlowEditor("Refactor {{scope:path=src}}");

    fireEvent.contextMenu(
      await screen.findByRole("button", { name: /Existing Flow/u }),
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "Move to global" }));

    await waitFor(() => {
      expect(saveRalphFlow).toHaveBeenCalledWith(
        expect.stringContaining("Project"),
        expect.objectContaining({
          scope: "user",
          flow: expect.objectContaining({ id: "existing-flow" }),
        }),
      );
      expect(deleteRalphFlow).toHaveBeenCalledWith(
        expect.stringContaining("Project"),
        "existing-flow",
        "workspace",
      );
    });
    expect(confirmMock).toHaveBeenCalledWith(
      'Move Ralph flow "Existing Flow" from workspace to global?',
    );
  });

  it("uses labeled provider and catalog-backed model selectors", async () => {
    renderRalphFlowEditor("Refactor {{scope:path=src}}");

    fireEvent.click(await screen.findByRole("button", { name: "New" }));
    fireEvent.click(await screen.findByRole("button", { name: "Add PROMPT block" }));

    const providerButton = await screen.findByRole("button", {
      name: "Block provider",
    });
    const modelButton = screen.getByRole("button", { name: "Block model" });

    expect(providerButton.textContent).toContain("Default");
    expect(providerButton.textContent).not.toContain("default");
    expect(modelButton.textContent).toContain("Default (GPT-5.5)");
    expect(screen.queryByRole("textbox", { name: "Block model" })).toBeNull();

    fireEvent.pointerDown(providerButton, { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Anthropic" }));

    expect(screen.getByRole("button", { name: "Block provider" }).textContent).toContain(
      "Anthropic",
    );
    expect(screen.getByRole("button", { name: "Block model" }).textContent).toContain(
      "Claude Opus 4.1",
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: "Block model" }), {
      button: 0,
      ctrlKey: false,
    });

    const modelItems = screen
      .getAllByRole("menuitem")
      .map((item) => item.textContent ?? "");

    expect(modelItems.some((item) => item.includes("Claude Opus 4.1"))).toBe(true);
    expect(modelItems.some((item) => item.includes("GPT-5.5"))).toBe(false);
  });

  it("limits block provider selectors to connected provider options", async () => {
    renderRalphFlowEditor("Refactor {{scope:path=src}}", {
      providerOptions: ["openai"],
    });

    fireEvent.click(await screen.findByRole("button", { name: "New" }));
    fireEvent.click(await screen.findByRole("button", { name: "Add PROMPT block" }));

    fireEvent.pointerDown(
      await screen.findByRole("button", { name: "Block provider" }),
      {
        button: 0,
        ctrlKey: false,
      },
    );

    expect(await screen.findByRole("menuitem", { name: "Default" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "OpenAI" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Anthropic" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Google" })).toBeNull();
  });

  it("adds selected files as Ralph block attachments", async () => {
    openMock.mockResolvedValue(["C:\\Project\\docs\\plan.md"]);
    vi.mocked(resolveDroppedPaths).mockResolvedValue({
      workspaceRoot: "C:\\Project",
      entries: [
        {
          path: "C:\\Project\\docs\\plan.md",
          kind: "file",
          name: "plan.md",
          parent: "C:\\Project\\docs",
        },
      ],
    });

    renderRalphFlowEditor("Refactor {{scope:path=src}}");

    fireEvent.click(await screen.findByRole("button", { name: "New" }));
    fireEvent.click(await screen.findByRole("button", { name: "Add PROMPT block" }));
    fireEvent.pointerDown(
      await screen.findByRole("button", { name: "Add block attachment" }),
      {
        button: 0,
        ctrlKey: false,
      },
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "Files" }));

    await waitFor(() => {
      expect(screen.getByText("plan.md")).toBeTruthy();
    });

    expect(screen.queryByRole("textbox", { name: "Block attachments" })).toBeNull();
    expect(openMock).toHaveBeenCalledWith(
      expect.objectContaining({
        directory: false,
        multiple: true,
        title: "Add Files as Context",
      }),
    );
    expect(resolveDroppedPaths).toHaveBeenCalledWith([
      "C:\\Project\\docs\\plan.md",
    ]);

    const saveButtons = screen.getAllByRole("button", { name: "Save" });
    expect(saveButtons.length).toBeGreaterThan(0);
    fireEvent.click(saveButtons[0] as HTMLElement);

    await waitFor(() => {
      expect(saveRalphFlow).toHaveBeenCalled();
    });

    const savedFlow = vi.mocked(saveRalphFlow).mock.calls[0]?.[1].flow;
    const promptBlock = savedFlow?.blocks.find(
      (block) => block.type === "PROMPT",
    );

    expect(promptBlock?.settings?.attachments).toEqual([
      expect.objectContaining({
        source: "path",
        value: "C:\\Project\\docs\\plan.md",
        kind: "file",
      }),
    ]);
  });

  it("does not replace a new unsaved draft when generation finishes late", async () => {
    let finishGeneration:
      | ((value: Awaited<ReturnType<typeof createRalphFlow>>) => void)
      | undefined;
    const generatedFlow: RalphFlow = {
      schemaVersion: 1,
      id: "generated-flow",
      alias: "generated-flow",
      name: "Generated Flow",
      blocks: [{ id: "start", type: "START", title: "Start" }],
      edges: [],
    };

    vi.mocked(createRalphFlow).mockImplementation(
      () =>
        new Promise((resolve) => {
          finishGeneration = resolve;
        }),
    );

    renderRalphFlowEditor("Create a generated flow");

    fireEvent.click(
      await screen.findByRole("button", { name: "Open AI flow generator from canvas" }),
    );
    fireEvent.click(
      screen
        .getAllByRole("button", { name: "Generate" })
        .find((button) => button.className.includes("emerald-600")) as HTMLElement,
    );
    fireEvent.click(screen.getByRole("button", { name: "New" }));

    finishGeneration?.({
      status: "created",
      flowPath: "C:\\Project\\.machdoch\\ralph\\flows\\generated-flow.json",
      flow: generatedFlow,
      rounds: 1,
      summary: "Created Generated Flow.",
      validation: {
        valid: true,
        errors: [],
        warnings: [],
        errorIssues: [],
        warningIssues: [],
        variables: [],
      },
    });

    await waitFor(() => {
      const saveButtons = screen.getAllByRole("button", { name: "Save" });
      expect(saveButtons.some((button) => !button.hasAttribute("disabled"))).toBe(
        true,
      );
    });

    const saveButtons = screen.getAllByRole("button", { name: "Save" });
    const enabledSaveButton = saveButtons.find(
      (button) => !button.hasAttribute("disabled"),
    );
    fireEvent.click(enabledSaveButton as HTMLElement);

    await waitFor(() => {
      expect(saveRalphFlow).toHaveBeenCalled();
    });
    expect(vi.mocked(saveRalphFlow).mock.calls.at(-1)?.[1].flow.id).not.toBe(
      generatedFlow.id,
    );
  });

  it("copies blocked AI flow generation details to the clipboard", async () => {
    const writeText = vi
      .fn<(text: string) => Promise<void>>()
      .mockResolvedValue(undefined);
    const summary =
      "The Ralph generator did not execute successfully (blocked): unexpected argument '--ask-for-approval'.";

    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    vi.mocked(createRalphFlow).mockResolvedValue({
      status: "blocked",
      flowPath: "",
      flow: null,
      rounds: 0,
      summary,
      validation: {
        valid: false,
        errors: [],
        warnings: [],
        errorIssues: [],
        warningIssues: [],
        variables: [],
      },
    });

    renderRalphFlowEditor("Create a generated flow");

    fireEvent.click(
      await screen.findByRole("button", { name: "Open AI flow generator from canvas" }),
    );
    fireEvent.click(
      screen
        .getAllByRole("button", { name: "Generate" })
        .find((button) => button.className.includes("emerald-600")) as HTMLElement,
    );

    expect(await screen.findByText("Blocked")).toBeTruthy();
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Copy Ralph generation error",
      }),
    );

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(`Blocked\n\n${summary}`);
    });
    expect(
      screen.getByRole("button", { name: "Copy Ralph generation error" }).textContent,
    ).toContain("Copied");
  });

  it("navigates AI flow prompt history with arrow keys", async () => {
    const onGenerationPromptHistoryChange = vi.fn();

    vi.mocked(createRalphFlow).mockResolvedValue({
      status: "blocked",
      flowPath: "",
      flow: null,
      rounds: 0,
      summary: "Generation blocked.",
      validation: {
        valid: false,
        errors: [],
        warnings: [],
        errorIssues: [],
        warningIssues: [],
        variables: [],
      },
    });

    renderRalphFlowEditor("Create a generated flow", {
      onGenerationPromptHistoryChange,
    });

    fireEvent.click(
      await screen.findByRole("button", { name: "Open AI flow generator from canvas" }),
    );

    const input = (await screen.findByLabelText(
      "AI flow generation prompt",
    )) as HTMLTextAreaElement;
    const generateButton = (): HTMLButtonElement => {
      const button = screen
        .getAllByRole("button", { name: "Generate" })
        .find((candidate) => candidate.className.includes("emerald-600"));

      expect(button).toBeTruthy();
      return button as HTMLButtonElement;
    };

    fireEvent.change(input, { target: { value: "Build release flow" } });
    fireEvent.click(generateButton());

    await waitFor(() => {
      expect(createRalphFlow).toHaveBeenCalledTimes(1);
    });

    await waitFor(() => {
      expect(generateButton().hasAttribute("disabled")).toBe(false);
    });

    fireEvent.change(input, { target: { value: "Review pull request flow" } });
    fireEvent.click(generateButton());

    await waitFor(() => {
      expect(createRalphFlow).toHaveBeenCalledTimes(2);
    });
    expect(onGenerationPromptHistoryChange).toHaveBeenLastCalledWith([
      "Build release flow",
      "Review pull request flow",
    ]);

    fireEvent.change(input, { target: { value: "Scratch draft" } });
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input.value).toBe("Review pull request flow");

    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input.value).toBe("Build release flow");

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input.value).toBe("Review pull request flow");

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input.value).toBe("Scratch draft");
  });

  it("saves dirty drafts from the standalone editor", async () => {
    renderRalphFlowEditor("Refactor {{scope:path=src}}");

    fireEvent.click(await screen.findByRole("button", { name: "New" }));
    fireEvent.click(await screen.findByRole("button", { name: "Show flow settings" }));
    fireEvent.change(await screen.findByLabelText("Flow name"), {
      target: { value: "Saved on close" },
    });
    const saveButton = screen
      .getAllByRole("button", { name: "Save" })
      .find((button) => !button.hasAttribute("disabled"));

    expect(saveButton).toBeTruthy();
    fireEvent.click(saveButton as HTMLElement);

    await waitFor(() => {
      expect(saveRalphFlow).toHaveBeenCalledWith(
        expect.stringContaining("Project"),
        {
          flow: expect.objectContaining({
            id: expect.any(String),
            alias: "refactor-scope-path-src",
            name: "Saved on close",
          }),
          scope: "workspace",
        },
      );
    });
    expect(screen.getByText("Ralph Flow Editor")).toBeTruthy();
  });

  it("keeps Ralph runs in the background when the editor unmounts", async () => {
    const flow = createRunnableFlow();
    let finishRun: ((value: Awaited<ReturnType<typeof runRalphFlow>>) => void) | undefined;

    vi.mocked(listRalphFlows).mockResolvedValue({
      workspaceRoot: "C:\\Project",
      flows: [
        {
          id: flow.id,
          name: flow.name,
          path: "C:\\Project\\.machdoch\\ralph\\flows\\background-flow.json",
          blockCount: 2,
          edgeCount: 1,
          variableCount: 0,
          valid: true,
        },
      ],
    });
    vi.mocked(showRalphFlow).mockResolvedValue({
      path: "C:\\Project\\.machdoch\\ralph\\flows\\background-flow.json",
      flow,
    });
    vi.mocked(runRalphFlow).mockImplementation(
      () =>
        new Promise((resolve) => {
          finishRun = resolve;
        }),
    );

    const view = renderRalphFlowEditor("Refactor {{scope:path=src}}");

    await screen.findByText("Ready to run.");

    const runButton = screen
      .getAllByRole("button", { name: "Run Ralph flow" })
      .find((button) => !button.hasAttribute("disabled"));
    expect(runButton).toBeTruthy();
    fireEvent.click(runButton as HTMLElement);

    expect(await screen.findByText("Background Ralph runs")).toBeTruthy();
    expect(await screen.findByLabelText("Flow status: Running")).toBeTruthy();
    view.unmount();

    await waitFor(() => {
      expect(screen.queryByText("Ralph Flow Editor")).toBeNull();
    });
    expect(cancelDesktopTask).not.toHaveBeenCalled();

    finishRun?.({
      run: {
        flow: flow.id,
        status: "completed",
        summary: "Done.",
        missingVariables: [],
        unknownVariables: [],
        validation: {
          valid: true,
          errors: [],
          warnings: [],
          errorIssues: [],
          warningIssues: [],
          variables: [],
        },
        events: [],
        blockResults: [],
      },
    });
  });

  it("shows the currently active Ralph block while a run is in progress", async () => {
    const flow = createRunnableFlow();

    vi.mocked(listRalphFlows).mockResolvedValue({
      workspaceRoot: "C:\\Project",
      flows: [
        {
          id: flow.id,
          name: flow.name,
          path: "C:\\Project\\.machdoch\\ralph\\flows\\background-flow.json",
          blockCount: 2,
          edgeCount: 1,
          variableCount: 0,
          valid: true,
        },
      ],
    });
    vi.mocked(showRalphFlow).mockResolvedValue({
      path: "C:\\Project\\.machdoch\\ralph\\flows\\background-flow.json",
      flow,
    });
    vi.mocked(runRalphFlow).mockImplementation(
      () =>
        new Promise(() => {
          // Keep the run active while progress events are inspected.
        }),
    );

    renderRalphFlowEditor("Refactor {{scope:path=src}}");

    await screen.findByText("Ready to run.");

    const runButton = screen
      .getAllByRole("button", { name: "Run Ralph flow" })
      .find((button) => !button.hasAttribute("disabled"));
    expect(runButton).toBeTruthy();
    fireEvent.click(runButton as HTMLElement);

    await waitFor(() => {
      expect(runRalphFlow).toHaveBeenCalled();
    });

    const taskId = vi.mocked(runRalphFlow).mock.calls[0]?.[1].taskId;
    expect(taskId).toBeTruthy();

    desktopProgressListener?.({
      taskId: taskId ?? "ralph-background-flow",
      timestamp: Date.now(),
      progress: {
        task: "Ralph flow `Background Flow`",
        mode: "machdoch",
        state: "executing",
        message: "Running Ralph block `Start`.",
        executedTools: [],
        outputSections: [],
        cancellable: true,
        timelineEvent: {
          kind: "state",
          phase: "started",
          label: "Running Ralph block `Start`.",
          metadata: {
            ralphEventType: "block-start",
            ralphActiveBlockId: "start",
            ralphActiveBlockTitle: "Start",
          },
        },
      },
    });

    expect(await screen.findByText("Active: Start")).toBeTruthy();
  });

  it("recovers already running Ralph task ids into the flow list", async () => {
    const flow = createRunnableFlow();
    vi.mocked(loadActiveDesktopTasks).mockResolvedValue([
      {
        id: "ralph-background-flow-1700000000000-abc123",
        kind: "ralph",
        workspaceRoot: "C:\\Project",
        arguments: ["run", "background-flow"],
        startedAt: 1_700_000_000_000,
      },
    ]);
    vi.mocked(listRalphFlows).mockResolvedValue({
      workspaceRoot: "C:\\Project",
      flows: [
        {
          id: flow.id,
          name: flow.name,
          path: "C:\\Project\\.machdoch\\ralph\\flows\\background-flow.json",
          blockCount: 2,
          edgeCount: 1,
          variableCount: 0,
          valid: true,
        },
      ],
    });
    vi.mocked(showRalphFlow).mockResolvedValue({
      path: "C:\\Project\\.machdoch\\ralph\\flows\\background-flow.json",
      flow,
    });

    renderRalphFlowEditor("Refactor {{scope:path=src}}");


    await waitFor(() => {
      expect(loadActiveDesktopTasks).toHaveBeenCalled();
    });
    expect(await screen.findByLabelText("Flow status: Running")).toBeTruthy();
  });

  it("keeps the run button label scoped to the selected flow", async () => {
    const flow = createRunnableFlow();

    vi.mocked(loadActiveDesktopTasks).mockResolvedValue([
      {
        id: "ralph-other-flow-1700000000000-abc123",
        kind: "ralph",
        workspaceRoot: "C:\\Project",
        arguments: ["run", "other-flow"],
        startedAt: 1_700_000_000_000,
      },
    ]);
    vi.mocked(listRalphFlows).mockResolvedValue({
      workspaceRoot: "C:\\Project",
      flows: [
        {
          id: flow.id,
          name: flow.name,
          path: "C:\\Project\\.machdoch\\ralph\\flows\\background-flow.json",
          blockCount: 2,
          edgeCount: 1,
          variableCount: 0,
          valid: true,
        },
        {
          id: "other-flow",
          name: "Other Flow",
          path: "C:\\Project\\.machdoch\\ralph\\flows\\other-flow.json",
          blockCount: 2,
          edgeCount: 1,
          variableCount: 0,
          valid: true,
        },
      ],
    });
    vi.mocked(showRalphFlow).mockResolvedValue({
      path: "C:\\Project\\.machdoch\\ralph\\flows\\background-flow.json",
      flow,
    });

    renderRalphFlowEditor("Refactor {{scope:path=src}}");

    await screen.findByText("Ready to run.");
    await waitFor(() => {
      expect(loadActiveDesktopTasks).toHaveBeenCalled();
    });

    const runButton = screen
      .getAllByRole("button", { name: "Run Ralph flow" })
      .find((button) => !button.hasAttribute("disabled"));

    expect(runButton?.textContent).toContain("Run");
    expect(runButton?.textContent).not.toContain("Run another");
  });

  it("opens structured run details from history", async () => {
    const flow = createRunnableFlow();

    vi.mocked(listRalphFlows).mockResolvedValue({
      workspaceRoot: "C:\\Project",
      flows: [
        {
          id: flow.id,
          name: flow.name,
          path: "C:\\Project\\.machdoch\\ralph\\flows\\background-flow.json",
          blockCount: 2,
          edgeCount: 1,
          variableCount: 1,
          valid: true,
        },
      ],
    });
    vi.mocked(showRalphFlow).mockResolvedValue({
      path: "C:\\Project\\.machdoch\\ralph\\flows\\background-flow.json",
      flow: {
        ...flow,
        variables: [
          {
            name: "scope",
            type: "path",
            required: true,
          },
        ],
      },
    });
    vi.mocked(listRalphRuns).mockResolvedValue({
      runs: [
        {
          id: "run-42",
          path: "C:\\Project\\.machdoch\\ralph\\runs\\run-42\\run.json",
          createdAt: "2026-06-19T07:00:00.000Z",
          finishedAt: "2026-06-19T07:00:02.000Z",
          flowId: flow.id,
          flowName: flow.name,
          status: "completed",
          summary: "Completed history.",
          blockCount: 1,
          eventCount: 2,
        },
      ],
    });
    vi.mocked(showRalphRunDetail).mockResolvedValue({
      scope: "workspace",
      path: "C:\\Project\\.machdoch\\ralph\\runs\\run-42\\run.json",
      record: {
        schemaVersion: 1,
        id: "run-42",
        createdAt: "2026-06-19T07:00:00.000Z",
        finishedAt: "2026-06-19T07:00:02.000Z",
        flowId: flow.id,
        flowName: flow.name,
        status: "completed",
        summary: "Completed history.",
        variableValues: {
          scope: "src/core",
        },
        events: [
          { type: "block-start", blockId: "start", attempt: 1 },
          {
            type: "end",
            blockId: "end",
            status: "completed",
            summary: "Done.",
          },
        ],
        blockResults: [
          {
            blockId: "start",
            output: "SUCCESS",
            status: "completed",
            attempt: 1,
            summary: "Started.",
          },
        ],
        validation: {
          valid: true,
          errors: [],
          warnings: [],
        },
      },
    });

    renderRalphFlowEditor("Refactor {{scope:path=src}}");

    fireEvent.click(await screen.findByText("Ready to run."));
    fireEvent.click(await screen.findByRole("button", { name: "History" }));
    fireEvent.click(await screen.findByText("Completed history."));

    await waitFor(() => {
      expect(showRalphRunDetail).toHaveBeenCalledWith(
        "C:\\Project",
        "run-42",
        "workspace",
      );
    });
    expect(await screen.findByText("Resolved variables")).toBeTruthy();
    expect(await screen.findByText("src/core")).toBeTruthy();
  });

  it("stops an active Ralph run through the desktop cancel bridge", async () => {
    const flow = createRunnableFlow();

    vi.mocked(listRalphFlows).mockResolvedValue({
      workspaceRoot: "C:\\Project",
      flows: [
        {
          id: flow.id,
          name: flow.name,
          path: "C:\\Project\\.machdoch\\ralph\\flows\\background-flow.json",
          blockCount: 2,
          edgeCount: 1,
          variableCount: 0,
          valid: true,
        },
      ],
    });
    vi.mocked(showRalphFlow).mockResolvedValue({
      path: "C:\\Project\\.machdoch\\ralph\\flows\\background-flow.json",
      flow,
    });
    vi.mocked(runRalphFlow).mockImplementation(
      () =>
        new Promise(() => {
          // Keep the run active until the test clicks Stop.
        }),
    );

    renderRalphFlowEditor("Refactor {{scope:path=src}}");

    await screen.findByText("Ready to run.");

    const runButton = screen
      .getAllByRole("button", { name: "Run Ralph flow" })
      .find((button) => !button.hasAttribute("disabled"));
    expect(runButton).toBeTruthy();
    fireEvent.click(runButton as HTMLElement);

    const stopButton = await screen.findByRole("button", {
      name: "Stop Ralph run Background Flow",
    });
    fireEvent.click(stopButton);

    await waitFor(() => {
      const taskId = vi.mocked(runRalphFlow).mock.calls[0]?.[1].taskId;
      expect(cancelDesktopTask).toHaveBeenCalledWith(taskId);
    });
  });
});
