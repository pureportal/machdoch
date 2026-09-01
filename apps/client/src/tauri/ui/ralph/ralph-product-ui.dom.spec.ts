// @vitest-environment jsdom

import type { ProductRalph, ProductShell } from "@machdoch/fleet-protocol";
import { Ralph } from "@machdoch/product-ui";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

type ProductComposer = NonNullable<ProductShell["composer"]>;

const composer = (
  overrides: Partial<ProductComposer> = {},
): ProductComposer => ({
  sessionId: "session-1",
  draft: "",
  provider: "openai",
  providerLabel: "OpenAI",
  model: "gpt-5.6",
  modelLabel: "GPT-5.6",
  modelCatalogLoading: false,
  modelCatalog: [
    {
      provider: "openai",
      label: "OpenAI",
      available: true,
      models: [
        {
          id: "gpt-5.6",
          label: "GPT-5.6",
          reasoningOptions: ["default", "high"],
        },
        {
          id: "gpt-basic",
          label: "GPT Basic",
          reasoningOptions: ["default"],
        },
      ],
    },
  ],
  mode: "machdoch",
  defaultMode: "machdoch",
  reasoning: "high",
  defaultReasoning: "high",
  reasoningOptions: ["default", "high"],
  promptEnhancementMode: "off",
  interviewEnabled: false,
  interviewAvailable: true,
  workspace: "C:/repo",
  workspaceLabel: "repo",
  canSend: true,
  isExecuting: false,
  sessionMemoryEnabled: false,
  globalMemoryAvailable: false,
  globalMemoryEnabled: false,
  uiControlAvailable: false,
  uiControlEnabled: false,
  uiControlDescription: "",
  attachments: [],
  chooserProviders: ["openai"],
  matchedContextPackIds: [],
  ...overrides,
});

const ralph = (overrides: Partial<ProductRalph> = {}): ProductRalph => ({
  workspaceRoot: "C:/repo",
  loading: false,
  flows: [
    {
      id: "release-flow",
      name: "Release flow",
      scope: "workspace",
      blockCount: 2,
      edgeCount: 1,
      variables: [],
      maxTransitions: 48,
    },
  ],
  runs: [],
  updatedAt: 1,
  ...overrides,
});

afterEach(() => cleanup());

describe("shared Fleet RALPH UI", () => {
  it("validates typed variables before dispatching a run", async () => {
    const onCommand = vi.fn().mockResolvedValue(true);
    render(
      createElement(Ralph, {
        ralph: ralph({
          flows: [
            {
              id: "release-flow",
              name: "Release flow",
              scope: "workspace",
              blockCount: 2,
              edgeCount: 1,
              variables: [
                { name: "attempts", type: "number", required: true },
                { name: "callback", type: "url", required: false },
              ],
              maxTransitions: 48,
            },
          ],
        }),
        composer: composer(),
        pending: false,
        onCommand,
      }),
    );

    fireEvent.click(screen.getByLabelText("Run Release flow"));
    const dialog = screen.getByRole("dialog", { name: "Run Release flow" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Run" }));

    expect(screen.getByText("This variable is required.")).toBeTruthy();
    expect(onCommand).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("attempts"), {
      target: { value: "2" },
    });
    fireEvent.change(screen.getByLabelText("callback"), {
      target: { value: "localhost" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Run" }));

    expect(screen.getByText("Enter a valid URL.")).toBeTruthy();
    expect(onCommand).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("attempts"), {
      target: { value: "2" },
    });
    fireEvent.change(screen.getByLabelText("callback"), {
      target: { value: "https://example.com/callback" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Run" }));

    await waitFor(() =>
      expect(onCommand).toHaveBeenCalledWith({
        kind: "ralph-run",
        workspace: "C:/repo",
        scope: "workspace",
        flowId: "release-flow",
        parameters: {
          attempts: "2",
          callback: "https://example.com/callback",
        },
        provider: "openai",
        model: "gpt-5.6",
        reasoning: "high",
        maxTransitions: 48,
      }),
    );
  });

  it("handles variable names inherited by ordinary objects", async () => {
    const onCommand = vi.fn().mockResolvedValue(true);
    render(
      createElement(Ralph, {
        ralph: ralph({
          flows: [
            {
              id: "release-flow",
              name: "Release flow",
              scope: "workspace",
              blockCount: 2,
              edgeCount: 1,
              variables: [
                {
                  name: "toString",
                  type: "string",
                  default: "safe",
                  required: false,
                },
              ],
            },
          ],
        }),
        composer: composer(),
        pending: false,
        onCommand,
      }),
    );

    fireEvent.click(screen.getByLabelText("Run Release flow"));
    expect((screen.getByLabelText("toString") as HTMLInputElement).value).toBe(
      "safe",
    );
    fireEvent.click(
      within(
        screen.getByRole("dialog", { name: "Run Release flow" }),
      ).getByRole("button", { name: "Run" }),
    );

    await waitFor(() =>
      expect(onCommand).toHaveBeenCalledWith(
        expect.objectContaining({ parameters: { toString: "safe" } }),
      ),
    );
  });

  it("prevents a second run while the same scoped flow is active", () => {
    render(
      createElement(Ralph, {
        ralph: ralph({
          runs: [
            {
              id: "run-active",
              flowId: "release-flow",
              flowName: "Release flow",
              scope: "workspace",
              status: "running",
              summary: "Running",
              createdAt: 1,
              blockCount: 1,
              eventCount: 1,
              taskId: "task-active",
              cancellable: true,
              recoverable: false,
            },
          ],
        }),
        composer: composer(),
        pending: false,
        onCommand: vi.fn().mockResolvedValue(true),
      }),
    );

    expect(
      (screen.getByLabelText("Run Release flow") as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("normalizes reasoning when a newly selected model supports fewer modes", async () => {
    const onCommand = vi.fn().mockResolvedValue(true);
    render(
      createElement(Ralph, {
        ralph: ralph(),
        composer: composer(),
        pending: false,
        onCommand,
      }),
    );

    fireEvent.click(screen.getByLabelText("RALPH run model: OpenAI GPT-5.6"));
    fireEvent.click(screen.getByLabelText("Choose OpenAI GPT Basic"));
    fireEvent.click(screen.getByLabelText("Run Release flow"));

    await waitFor(() =>
      expect(onCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "ralph-run",
          model: "gpt-basic",
          reasoning: "default",
        }),
      ),
    );
    expect(
      [
        ...screen.getByLabelText("RALPH reasoning").querySelectorAll("option"),
      ].map((option) => option.value),
    ).toEqual(["default"]);
  });

  it("disables runs when the selected provider is unavailable", () => {
    const unavailableComposer = composer({
      modelCatalog: [
        {
          provider: "openai",
          label: "OpenAI",
          available: false,
          error: "Not configured",
          models: [
            {
              id: "gpt-5.6",
              label: "GPT-5.6",
              reasoningOptions: ["default", "high"],
            },
          ],
        },
      ],
    });
    render(
      createElement(Ralph, {
        ralph: ralph(),
        composer: unavailableComposer,
        pending: false,
        onCommand: vi.fn().mockResolvedValue(true),
      }),
    );

    expect(
      (screen.getByLabelText("Run Release flow") as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
