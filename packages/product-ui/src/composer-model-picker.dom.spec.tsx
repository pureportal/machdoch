import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposerModelPicker } from "./composer-model-picker";

afterEach(cleanup);

function openPicker(query = "日本") {
  const onSelect = vi.fn();
  render(
    <ComposerModelPicker
      providers={[
        {
          id: "provider",
          label: "Provider",
          available: true,
          models: [
            { id: "other", label: "Other" },
            { id: "japanese", label: "日本" },
            { id: "japanese-fast", label: "日本 Fast" },
          ],
        },
      ]}
      activeProvider="provider"
      activeProviderLabel="Provider"
      activeModel="other"
      activeModelLabel="Other"
      loading={false}
      onSelect={onSelect}
    />,
  );
  const trigger = screen.getByRole("button", {
    name: "Session model: Provider Other",
  });
  fireEvent.click(trigger);
  const search = screen.getByRole<HTMLInputElement>("textbox", {
    name: "Search models",
  });
  fireEvent.change(search, { target: { value: query } });
  expect(screen.queryByRole("dialog", { name: "Session model" })).not.toBeNull();
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  expect(onSelect).not.toHaveBeenCalled();
  return { onSelect, search, trigger };
}

describe("model search composition selection", () => {
  it.each([{ isComposing: true }, { keyCode: 229 }])(
    "keeps the picker open without selecting for IME Enter (%j)",
    (signal) => {
      const { onSelect, search, trigger } = openPicker();
      const event = new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
        ...signal,
      });
      fireEvent(search, event);
      expect.soft(onSelect).not.toHaveBeenCalled();
      expect.soft(screen.queryByRole("dialog", { name: "Session model" })).not.toBeNull();
      expect.soft(trigger.getAttribute("aria-expanded")).toBe("true");
      expect.soft(event.defaultPrevented).toBe(false);
    },
  );

  it("selects the first match exactly once on Enter after composition ends", () => {
    const { onSelect, search, trigger } = openPicker("");
    fireEvent.compositionStart(search);
    fireEvent.compositionUpdate(search, { data: "日本" });
    fireEvent.change(search, { target: { value: "日本" } });
    fireEvent.compositionEnd(search, { data: "日本" });
    expect(onSelect).not.toHaveBeenCalled();
    expect(fireEvent.keyDown(search, { key: "Enter", isComposing: false, keyCode: 13 })).toBe(false);
    expect(onSelect.mock.calls).toEqual([["provider", "japanese"]]);
    expect(screen.queryByRole("dialog", { name: "Session model" })).toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps the picker open without selecting when Enter has no match", () => {
    const { onSelect, search, trigger } = openPicker("no matching model");
    expect(screen.getByRole("status").textContent).toBe("No matching models.");
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "Session model" })).not.toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
  });

  it("selects the clicked match exactly once and closes the picker", () => {
    const { onSelect, trigger } = openPicker();
    fireEvent.click(screen.getByRole("button", { name: "Choose Provider 日本 Fast" }));
    expect(onSelect.mock.calls).toEqual([["provider", "japanese-fast"]]);
    expect(screen.queryByRole("dialog", { name: "Session model" })).toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });
});
