import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SmartContextPackEditorDialog,
  type SmartContextPackEditorInitialValue,
} from "./editor";

afterEach(cleanup);

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
      onOpenChange={vi.fn()}
      onSubmit={onSubmit}
    />,
  );
  return onSubmit;
}

describe("context pack editor", () => {
  it("saves temporary duration and explicit off settings", async () => {
    const save = editor();
    fireEvent.change(screen.getByLabelText("Apply settings"), {
      target: { value: "temporary" },
    });
    fireEvent.change(screen.getByLabelText("Interview"), {
      target: { value: "disabled" },
    });
    fireEvent.change(screen.getByLabelText("Prompt enhancement"), {
      target: { value: "off" },
    });
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
      (screen.getByLabelText("Apply settings") as HTMLSelectElement).value,
    ).toBe("temporary");
    fireEvent.change(screen.getByLabelText("Apply settings"), {
      target: { value: "persistent" },
    });
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
    fireEvent.change(screen.getByLabelText("Provider"), {
      target: { value: "openai" },
    });
    expect(
      (screen.getByRole("button", { name: "Save pack" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.change(screen.getByLabelText("Model"), {
      target: { value: "chosen-model" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save pack" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("Save failed"),
    );
    expect(
      (screen.getByRole("button", { name: "Save pack" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });
});
