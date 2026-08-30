// @vitest-environment jsdom

import {
  cleanup,
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
