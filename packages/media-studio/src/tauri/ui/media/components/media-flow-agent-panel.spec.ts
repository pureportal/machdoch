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
import { afterEach, describe, expect, it, vi } from "vitest";
import { createImageRecipeFlow } from "../../../../core/media/compiler.js";
import { DEFAULT_IMAGE_RECIPE_SETTINGS } from "../media-studio-store";
import { invoke, isRemoteMedia } from "../media-platform";
import { MediaFlowAgentPanel } from "./media-flow-agent-panel";
import type { MediaFlowAgentResult } from "../../../../core/media/flow-agent.js";

vi.mock("../media-platform", () => ({
  invoke: vi.fn(),
  hasMediaHost: () => true,
  isRemoteMedia: vi.fn(() => false),
}));
afterEach(cleanup);
const flow = createImageRecipeFlow({
  id: "flow:chat",
  createdAt: "2026-09-20T00:00:00Z",
  settings: { ...DEFAULT_IMAGE_RECIPE_SETTINGS, prompt: "A forest" },
});
const props = (): ComponentProps<typeof MediaFlowAgentPanel> => ({
  open: true,
  workspaceRoot: "C:/workspace",
  flow,
  models: [],
  addons: [],
  assets: [],
  onApply: vi.fn(),
  onClose: vi.fn(),
});
const send = (text: string) => {
  fireEvent.change(screen.getByRole("textbox"), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
};

describe("Media Studio flow assistant", () => {
  it("applies an edit and includes conversation in subsequent requests", async () => {
    const settings = props();
    vi.mocked(invoke).mockResolvedValue({
      message: "Changed the prompt.",
      flow: { ...flow, name: "Updated" },
    });
    render(createElement(MediaFlowAgentPanel, settings));
    send("Add a sunset");
    await screen.findByText("Changed the prompt.");
    expect(settings.onApply).toHaveBeenCalledTimes(1);
    send("Make it warmer");
    await waitFor(() => expect(settings.onApply).toHaveBeenCalledTimes(2));
    expect(invoke).toHaveBeenLastCalledWith(
      "run_media_flow_agent",
      expect.objectContaining({
        request: expect.objectContaining({
          messages: [
            { role: "user", content: "Add a sunset" },
            { role: "assistant", content: "Changed the prompt." },
          ],
        }),
      }),
    );
  });

  it("rejects late edits when the user changed the flow", async () => {
    let resolve!: (result: MediaFlowAgentResult) => void;
    vi.mocked(invoke).mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const settings = props();
    const view = render(createElement(MediaFlowAgentPanel, settings));
    send("Add a sunset");
    view.rerender(
      createElement(MediaFlowAgentPanel, {
        ...settings,
        flow: { ...flow, name: "Manual edit" },
      }),
    );
    await act(async () => resolve({ message: "Updated", flow }));
    expect(settings.onApply).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("flow changed");
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
      "Add a sunset",
    );
  });

  it("ignores results after leaving the editor", async () => {
    let resolve!: (result: MediaFlowAgentResult) => void;
    vi.mocked(invoke).mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const settings = props();
    const view = render(createElement(MediaFlowAgentPanel, settings));
    send("Add a sunset");
    view.unmount();
    await act(async () => resolve({ message: "Updated", flow }));
    expect(settings.onApply).not.toHaveBeenCalled();
  });

  it("keeps failed requests available for retry", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("Provider unavailable"));
    render(createElement(MediaFlowAgentPanel, props()));
    send("Add a sunset");
    await screen.findByRole("alert");
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
      "Add a sunset",
    );
    expect(
      (screen.getByRole("button", { name: "Send" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it("disables requests on a remote media host", () => {
    vi.mocked(isRemoteMedia).mockReturnValue(true);
    render(createElement(MediaFlowAgentPanel, props()));
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).disabled).toBe(
      true,
    );
  });
});
