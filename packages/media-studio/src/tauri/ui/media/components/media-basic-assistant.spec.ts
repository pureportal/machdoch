// @vitest-environment jsdom

import { createElement, type ComponentProps } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMediaModelCatalogSnapshot } from "../../../../core/media/catalog.js";
import type { MediaFlowAgentResult } from "../../../../core/media/flow-agent.js";
import { DEFAULT_MEDIA_STUDIO_STATE } from "../media-studio-store";
import { createBasicAssistantFlow } from "../media-basic-assistant";
import { hasMediaHost, invoke } from "../media-platform";
import { MediaBasicAssistant } from "./media-basic-assistant";

vi.mock("../media-platform", () => ({
  invoke: vi.fn(),
  hasMediaHost: vi.fn(() => true),
}));
vi.mock("../../components/ui/dialog", () => ({
  Dialog: ({
    open,
    children,
    onOpenChange,
  }: {
    open: boolean;
    children: React.ReactNode;
    onOpenChange: (value: boolean) => void;
  }) =>
    open
      ? createElement(
          "div",
          { role: "dialog" },
          children,
          createElement(
            "button",
            { onClick: () => onOpenChange(false) },
            "Close",
          ),
        )
      : null,
  DialogContent: ({ children }: { children: React.ReactNode }) =>
    createElement("div", null, children),
  DialogHeader: ({ children }: { children: React.ReactNode }) =>
    createElement("div", null, children),
  DialogTitle: ({ children }: { children: React.ReactNode }) =>
    createElement("h2", null, children),
}));
afterEach(cleanup);
beforeEach(() => {
  vi.mocked(hasMediaHost).mockReturnValue(true);
  vi.mocked(invoke).mockReset();
});

const props = (): ComponentProps<typeof MediaBasicAssistant> => ({
  workspaceRoot: "C:/workspace",
  draft: structuredClone({
    target: "image",
    recipe: {
      ...DEFAULT_MEDIA_STUDIO_STATE.recipe,
      prompt: "A forest",
      qualityGateEnabled: false,
    },
    videoRecipe: DEFAULT_MEDIA_STUDIO_STATE.videoRecipe,
    audioRecipe: DEFAULT_MEDIA_STUDIO_STATE.audioRecipe,
  }),
  catalog: createMediaModelCatalogSnapshot({
    isOpenAiConfigured: false,
    isLocalFluxInstalled: true,
  }),
  assets: [],
  onApply: vi.fn(),
});
const send = () => {
  fireEvent.click(screen.getByRole("button", { name: "Assistant" }));
  fireEvent.change(screen.getByRole("textbox"), {
    target: { value: "A forest at sunset, two images" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Fill settings" }));
};
const response = (
  settings: ReturnType<typeof props>,
): MediaFlowAgentResult => ({
  message: "Filled settings.",
  flow: createBasicAssistantFlow(
    {
      ...settings.draft,
      recipe: {
        ...settings.draft.recipe,
        prompt: "A forest at sunset",
        outputCount: 2,
      },
    },
    settings.catalog.models,
  ),
  poseMaps: [],
});

describe("Basic settings assistant", () => {
  it("applies all fields atomically without generating media", async () => {
    const settings = props();
    vi.mocked(invoke).mockResolvedValue(response(settings));
    render(createElement(MediaBasicAssistant, settings));
    send();
    await waitFor(() => expect(settings.onApply).toHaveBeenCalledOnce());
    expect(settings.onApply).toHaveBeenCalledWith(
      expect.objectContaining({
        recipe: expect.objectContaining({
          prompt: "A forest at sunset",
          outputCount: 2,
        }),
      }),
    );
    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith(
      "run_media_flow_agent",
      expect.objectContaining({
        request: expect.objectContaining({
          messages: [],
          prompt: expect.stringContaining("Basic image fields"),
        }),
      }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps unavailable requests and provider failures available for retry", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("Codex is unavailable"));
    render(createElement(MediaBasicAssistant, props()));
    send();
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Codex is unavailable",
    );
    expect(
      (screen.getByRole("textbox") as HTMLTextAreaElement).value,
    ).toContain("sunset");
    expect(
      (
        screen.getByRole("button", {
          name: "Fill settings",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });

  it("shows an assistant answer without changing settings", async () => {
    const settings = props();
    vi.mocked(invoke).mockResolvedValue({
      message: "This request needs a lip sync model in Advanced mode.",
      flow: null,
      poseMaps: [],
    });
    render(createElement(MediaBasicAssistant, settings));
    send();
    await screen.findByRole("alert");
    expect(settings.onApply).not.toHaveBeenCalled();
  });

  it("rejects a result after manual edits or a target change", async () => {
    const settings = props();
    let resolve!: (result: MediaFlowAgentResult) => void;
    vi.mocked(invoke).mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const view = render(createElement(MediaBasicAssistant, settings));
    send();
    view.rerender(
      createElement(MediaBasicAssistant, {
        ...settings,
        draft: { ...settings.draft, target: "audio" },
      }),
    );
    await act(async () => resolve(response(settings)));
    expect(settings.onApply).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("settings changed");
  });

  it("ignores a late response after closing the assistant", async () => {
    const settings = props();
    let resolve!: (result: MediaFlowAgentResult) => void;
    vi.mocked(invoke).mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    render(createElement(MediaBasicAssistant, settings));
    send();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await act(async () => resolve(response(settings)));
    expect(settings.onApply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Assistant" }));
    expect(
      (
        screen.getByRole("button", {
          name: "Fill settings",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });

  it("ignores responses after leaving Basic mode", async () => {
    const settings = props();
    let resolve!: (result: MediaFlowAgentResult) => void;
    vi.mocked(invoke).mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const view = render(createElement(MediaBasicAssistant, settings));
    send();
    view.unmount();
    await act(async () => resolve(response(settings)));
    expect(settings.onApply).not.toHaveBeenCalled();
  });

  it("disables the assistant without a connected media host", () => {
    vi.mocked(hasMediaHost).mockReturnValue(false);
    render(createElement(MediaBasicAssistant, props()));
    expect(
      (screen.getByRole("button", { name: "Assistant" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});
