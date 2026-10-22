import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ContextWindowPicker } from "./context-window-picker";

afterEach(cleanup);

it("uses Codex's discovered long-context capacity and rejects invalid input", () => {
  const onChange = vi.fn();
  render(
    <ContextWindowPicker
      provider="codex-cli"
      model="discovered-model"
      capabilities={{
        contextWindowTokens: 200_000,
        longContextWindowTokens: 1_000_000,
      }}
      value={64_000}
      onChange={onChange}
    />,
  );
  const tokens = screen.getByRole("spinbutton", {
    name: "Context size tokens",
  });
  expect(tokens.getAttribute("max")).toBe("1000000");
  fireEvent.change(tokens, { target: { value: "1000001" } });
  fireEvent.blur(tokens);
  expect(screen.getByRole("alert").textContent).toContain("1,000,000");
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.change(tokens, { target: { value: "800000" } });
  fireEvent.blur(tokens);
  expect(onChange).toHaveBeenCalledWith(800000);
});

it("requires provider and model support before showing context controls", () => {
  const { rerender } = render(
    <ContextWindowPicker
      provider="openai"
      model="gpt-6-astra"
      value={undefined}
      onChange={vi.fn()}
    />,
  );
  expect(screen.queryByRole("combobox")).toBeNull();
  rerender(
    <ContextWindowPicker
      provider="claude-cli"
      model="haiku"
      value={undefined}
      onChange={vi.fn()}
    />,
  );
  expect(screen.queryByRole("combobox")).toBeNull();
  rerender(
    <ContextWindowPicker
      provider="copilot-cli"
      model="discovered-model"
      capabilities={{ longContextWindowTokens: 2_000_000 }}
      value="long"
      onChange={vi.fn()}
    />,
  );
  expect(screen.getByRole("option", { name: "2,000,000 tokens" })).toBeTruthy();
});
