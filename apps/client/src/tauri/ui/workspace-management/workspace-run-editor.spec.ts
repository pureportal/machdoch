// @vitest-environment jsdom

import {
  cleanup,
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  WorkspaceRunConfigurationDocument,
  WorkspaceRunSnapshot,
} from "../../../shared/workspace-run.js";
import { clearWorkspaceRunDetection } from "./workspace-run-detection-state";
import { WorkspaceRunEditor } from "./workspace-run-editor";

const runtime = vi.hoisted(() => ({
  precheckWorkspaceRunConfigurationJson: vi.fn(),
  saveWorkspaceRunConfigurationDocument: vi.fn(),
}));
const ai = vi.hoisted(() => ({
  generateWorkspaceRunDetection: vi.fn(),
  validateWorkspaceRunDetections: vi.fn(),
}));

vi.mock("../runtime", () => runtime);
vi.mock("./workspace-run-ai", () => ai);

const document: WorkspaceRunConfigurationDocument = {
  schemaVersion: 2,
  configurations: [],
};
const snapshot: WorkspaceRunSnapshot = {
  workspaceRoot: "C:/workspace",
  primaryConfigurationId: null,
  configurations: [],
};

beforeEach(() => {
  clearWorkspaceRunDetection("C:/workspace");
  vi.clearAllMocks();
});

afterEach(() => cleanup());

describe("WorkspaceRunEditor", () => {
  it("preserves unsaved edits during background refreshes and resets when switching workspaces", () => {
    const onSaved = vi.fn();
    const { rerender } = render(
      createElement(WorkspaceRunEditor, {
        workspaceRoot: "C:/workspace",
        document,
        onSaved,
      }),
    );
    const draft =
      '{"schemaVersion":2,"configurations":[],"draft":"unfinished"}';
    fireEvent.change(screen.getByLabelText("Run configuration JSON"), {
      target: { value: draft },
    });
    const refreshed = {
      ...document,
      configurations: [
        {
          id: "group",
          name: "Updated",
          kind: "composite" as const,
          primary: true,
          children: [],
          startOrder: "parallel" as const,
        },
      ],
    };
    rerender(
      createElement(WorkspaceRunEditor, {
        workspaceRoot: "C:/workspace",
        document: refreshed,
        onSaved,
      }),
    );
    expect(
      (screen.getByLabelText("Run configuration JSON") as HTMLTextAreaElement)
        .value,
    ).toBe(draft);
    expect(
      (screen.getByRole("button", { name: "Detect" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    rerender(
      createElement(WorkspaceRunEditor, {
        workspaceRoot: "C:/another-workspace",
        document,
        onSaved,
      }),
    );
    expect(
      (screen.getByLabelText("Run configuration JSON") as HTMLTextAreaElement)
        .value,
    ).toBe(JSON.stringify(document, null, 2));
  });

  it("does not start a native save if prechecking finishes after switching workspaces", async () => {
    let finish = (_document: WorkspaceRunConfigurationDocument) => {};
    runtime.precheckWorkspaceRunConfigurationJson.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const onSaved = vi.fn();
    const { rerender } = render(
      createElement(WorkspaceRunEditor, {
        workspaceRoot: "C:/workspace",
        document,
        onSaved,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    rerender(
      createElement(WorkspaceRunEditor, {
        workspaceRoot: "C:/another-workspace",
        document,
        onSaved,
      }),
    );
    await act(async () => {
      finish(document);
    });
    expect(
      runtime.saveWorkspaceRunConfigurationDocument,
    ).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("ignores an old workspace's completed save and prevents duplicate saves and edits while saving", async () => {
    runtime.precheckWorkspaceRunConfigurationJson.mockResolvedValueOnce(
      document,
    );
    let finish = (_snapshot: WorkspaceRunSnapshot) => {};
    runtime.saveWorkspaceRunConfigurationDocument.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const onSaved = vi.fn();
    const { rerender } = render(
      createElement(WorkspaceRunEditor, {
        workspaceRoot: "C:/workspace",
        document,
        onSaved,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(
        runtime.saveWorkspaceRunConfigurationDocument,
      ).toHaveBeenCalledTimes(1),
    );
    const editor = screen.getByLabelText(
      "Run configuration JSON",
    ) as HTMLTextAreaElement;
    expect(editor.disabled).toBe(true);
    fireEvent.change(editor, { target: { value: "discard this raced edit" } });
    expect(editor.value).toBe(JSON.stringify(document, null, 2));
    rerender(
      createElement(WorkspaceRunEditor, {
        workspaceRoot: "C:/another-workspace",
        document,
        onSaved,
      }),
    );
    await act(async () => {
      finish(snapshot);
    });
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("marks a normalized save as clean even before its parent refreshes the document", async () => {
    runtime.precheckWorkspaceRunConfigurationJson.mockResolvedValueOnce(
      document,
    );
    runtime.saveWorkspaceRunConfigurationDocument.mockResolvedValueOnce(
      snapshot,
    );
    const onDirtyChange = vi.fn();
    render(
      createElement(WorkspaceRunEditor, {
        workspaceRoot: "C:/workspace",
        document,
        onSaved: vi.fn(),
        onDirtyChange,
      }),
    );
    fireEvent.change(screen.getByLabelText("Run configuration JSON"), {
      target: { value: JSON.stringify(document) },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));
    expect(
      (screen.getByRole("button", { name: "Detect" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });
  it("keeps invalid edited JSON recoverable and does not save it", async () => {
    runtime.precheckWorkspaceRunConfigurationJson.mockRejectedValueOnce(
      new Error("Invalid run configuration JSON: expected value"),
    );
    const onSaved = vi.fn();
    render(
      createElement(WorkspaceRunEditor, {
        workspaceRoot: "C:/workspace",
        document,
        onSaved,
      }),
    );
    const editor = screen.getByLabelText("Run configuration JSON");

    fireEvent.change(editor, { target: { value: "{" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(
      await screen.findByText("Invalid run configuration JSON: expected value"),
    ).toBeTruthy();
    expect(
      runtime.saveWorkspaceRunConfigurationDocument,
    ).not.toHaveBeenCalled();
    expect((editor as HTMLTextAreaElement).value).toBe("{");
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("prechecks AI JSON before replacing the editable draft", async () => {
    ai.generateWorkspaceRunDetection.mockResolvedValue({
      documentJson: "{invalid",
      detections: [],
    });
    runtime.precheckWorkspaceRunConfigurationJson.mockRejectedValue(
      new Error("Invalid run configuration JSON: expected value"),
    );
    render(
      createElement(WorkspaceRunEditor, {
        workspaceRoot: "C:/workspace",
        document,
        onSaved: vi.fn(),
      }),
    );
    const editor = screen.getByLabelText(
      "Run configuration JSON",
    ) as HTMLTextAreaElement;
    const originalDraft = editor.value;

    fireEvent.click(screen.getByRole("button", { name: "Detect" }));

    await waitFor(() =>
      expect(
        runtime.precheckWorkspaceRunConfigurationJson,
      ).toHaveBeenCalledWith("C:/workspace", "{invalid"),
    );
    expect(
      await screen.findByText(/Invalid run configuration JSON/u),
    ).toBeTruthy();
    expect(editor.value).toBe(originalDraft);
    expect(ai.validateWorkspaceRunDetections).not.toHaveBeenCalled();
  });

  it("prechecks valid edits before saving", async () => {
    runtime.precheckWorkspaceRunConfigurationJson.mockResolvedValue(document);
    runtime.saveWorkspaceRunConfigurationDocument.mockResolvedValue(snapshot);
    const onSaved = vi.fn();
    render(
      createElement(WorkspaceRunEditor, {
        workspaceRoot: "C:/workspace",
        document,
        onSaved,
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(onSaved).toHaveBeenCalledWith(document, snapshot),
    );
    expect(runtime.precheckWorkspaceRunConfigurationJson).toHaveBeenCalledTimes(
      1,
    );
    expect(runtime.saveWorkspaceRunConfigurationDocument).toHaveBeenCalledWith(
      "C:/workspace",
      document,
    );
  });

  it("presents detected configurations and identifies the default", async () => {
    const detectedDocument: WorkspaceRunConfigurationDocument = {
      schemaVersion: 2,
      configurations: [
        {
          id: "web",
          name: "Web",
          kind: "task",
          primary: false,
          command: "pnpm dev:web",
          workingDirectory: ".",
          environment: {},
          hotReload: true,
          ports: [],
          urls: [],
          restartPolicy: {
            onCrash: false,
            maxRestarts: 5,
            windowMs: 60_000,
            backoffMs: 1_000,
            maxBackoffMs: 30_000,
          },
        },
        {
          id: "complete-stack",
          name: "Complete Stack",
          kind: "composite",
          primary: true,
          children: ["web"],
          startOrder: "parallel",
        },
      ],
    };
    ai.generateWorkspaceRunDetection.mockResolvedValue({
      documentJson: JSON.stringify(detectedDocument),
      detections: [
        {
          configurationId: "web",
          confidence: "medium",
          evidence: ["package.json defines dev:web"],
          uncertainFields: ["ports"],
        },
        {
          configurationId: "complete-stack",
          confidence: "high",
          evidence: ["The workspace starts its services together."],
          uncertainFields: [],
        },
      ],
    });
    runtime.precheckWorkspaceRunConfigurationJson.mockResolvedValue(
      detectedDocument,
    );

    render(
      createElement(WorkspaceRunEditor, {
        workspaceRoot: "C:/workspace",
        document,
        onSaved: vi.fn(),
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Detect" }));

    const detected = await screen.findByRole("region", {
      name: "Detected run configurations",
    });
    expect(detected.textContent).toContain("Web");
    expect(detected.textContent).toContain("Complete Stack");
    expect(detected.textContent).toContain("Default");
    expect(detected.textContent).toContain("Review Ports");
    expect(detected.textContent).toContain("pnpm dev:web");
  });
});
