import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  SmartContextPackEditorDialog,
  type SmartContextPackEditorInitialValue,
} from "./editor";

afterEach(cleanup);

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

const initial: SmartContextPackEditorInitialValue = {
  mode: "edit",
  id: "commit",
  name: "Commit and push",
  scope: "global",
  instructions: "",
  prompt: "Commit and push",
  contextAttachments: [],
  variables: [],
  triggerPhrases: [],
  triggerPathPatterns: [],
  provider: "codex-cli",
  model: "gpt-6.1-sol",
};

function editor(value = initial, onSubmit = vi.fn()) {
  render(
    <SmartContextPackEditorDialog
      open
      initialValue={value}
      workspaceRoot="C:/Project"
      modelOptions={[
        {
          provider: "codex-cli",
          id: "gpt-6.1-sol",
          label: "GPT 6.1 Sol",
          capabilities: { contextWindowTokens: 400_000 },
        },
      ]}
      onOpenChange={vi.fn()}
      onSubmit={onSubmit}
    />,
  );
  return onSubmit;
}

async function select(label: string, option: string) {
  fireEvent.keyDown(screen.getByRole("combobox", { name: label }), {
    key: "ArrowDown",
  });
  fireEvent.click(await screen.findByRole("option", { name: option }));
}

describe("context pack editor", () => {
  it("saves temporary duration and explicit off settings", async () => {
    const save = editor();
    await select("Apply settings", "Next prompt only");
    await select("Interview", "Disabled");
    await select("Prompt enhancement", "Off");
    fireEvent.click(screen.getByRole("button", { name: "Save pack" }));
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save.mock.calls[0]?.[0]).toMatchObject({
      temporary: true,
      provider: "codex-cli",
      model: "gpt-6.1-sol",
      interviewEnabled: false,
      promptEnhancementMode: "off",
    });
  });

  it("loads a temporary pack and can make it persistent", async () => {
    const save = editor({ ...initial, temporary: true });
    expect(
      screen.getByRole("combobox", { name: "Apply settings" }).textContent,
    ).toBe("Next prompt only");
    await select("Apply settings", "This and following prompts");
    fireEvent.click(screen.getByRole("button", { name: "Save pack" }));
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save.mock.calls[0]?.[0].temporary).toBe(false);
  });

  it("clears all setting overrides while retaining content", async () => {
    const save = editor({ ...initial, interviewEnabled: true, runMode: "ask" });
    fireEvent.click(screen.getByRole("button", { name: "Clear overrides" }));
    expect(screen.queryByLabelText("Model")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save pack" }));
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save.mock.calls[0]?.[0]).toMatchObject({
      name: initial.name,
      prompt: initial.prompt,
    });
    expect(save.mock.calls[0]?.[0].provider).toBeUndefined();
    expect(save.mock.calls[0]?.[0].mode).toBeUndefined();
    expect(save.mock.calls[0]?.[0].interviewEnabled).toBeUndefined();
  });

  it("requires a model after changing providers and keeps save failures editable", async () => {
    const save = vi
      .fn()
      .mockRejectedValue(new Error("Save failed. Try again."));
    editor(initial, save);
    await select("Provider", "OpenAI");
    expect(
      (screen.getByRole("button", { name: "Save pack" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("combobox", { name: "Model" }));
    fireEvent.change(
      screen.getByRole("combobox", { name: "Search models or enter model ID" }),
      {
        target: { value: "chosen-model" },
      },
    );
    fireEvent.click(
      await screen.findByRole("option", { name: "Use “chosen-model”" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save pack" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("Save failed"),
    );
    expect(
      (screen.getByRole("button", { name: "Save pack" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it("selects a discovered model and applies context size without saving the pack", async () => {
    const save = editor();
    fireEvent.click(screen.getByRole("combobox", { name: "Model" }));
    fireEvent.click(await screen.findByRole("option", { name: "GPT 6.1 Sol" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Context size: Keep current" }),
    );
    fireEvent.click(screen.getByRole("radio", { name: /Highest/ }));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save pack" }));
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save.mock.calls[0]?.[0]).toMatchObject({
      model: "gpt-6.1-sol",
      contextWindow: 400_000,
    });
  });
});
