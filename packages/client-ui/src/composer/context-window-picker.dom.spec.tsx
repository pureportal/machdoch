import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ContextWindowPicker } from "./context-window-picker";

afterEach(cleanup);

const open = () =>
  fireEvent.click(screen.getByRole("button", { name: /^Context size:/ }));
const choose = (name: string) =>
  fireEvent.click(screen.getByRole("radio", { name: new RegExp(name) }));
const apply = () =>
  fireEvent.click(screen.getByRole("button", { name: "Apply" }));

it("edits exact token counts within the discovered range and only commits on Apply", () => {
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
  expect(screen.queryByRole("dialog")).toBeNull();
  open();
  const tokens = screen.getByRole("spinbutton", { name: "Tokens" });
  const slider = screen.getByRole("slider");
  expect(tokens.getAttribute("max")).toBe("1000000");
  expect(slider.getAttribute("min")).toBe("1");
  expect(slider.getAttribute("max")).toBe("1000000");
  expect(slider.getAttribute("step")).toBe("1");
  for (const value of ["1000001", "0", "-1", "1.5", ""]) {
    fireEvent.change(tokens, { target: { value } });
    expect(screen.getByRole("alert").textContent).toContain("1,000,000");
    expect(
      screen.getByRole("button", { name: "Apply" }).hasAttribute("disabled"),
    ).toBe(true);
    apply();
  }
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.change(tokens, { target: { value: "800000" } });
  expect((slider as HTMLInputElement).value).toBe("800000");
  fireEvent.blur(tokens);
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.change(slider, { target: { value: "400000" } });
  expect((tokens as HTMLInputElement).value).toBe("400000");
  apply();
  expect(onChange).toHaveBeenCalledExactlyOnceWith(400000);
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("discards edits when cancelled and restores the saved selection on reopening", () => {
  const onChange = vi.fn();
  render(
    <ContextWindowPicker
      provider="codex-cli"
      model="gpt-6-astra"
      value={64_000}
      onChange={onChange}
    />,
  );
  open();
  choose("Highest");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(onChange).not.toHaveBeenCalled();
  open();
  expect(
    (screen.getByRole("radio", { name: "Custom" }) as HTMLInputElement).checked,
  ).toBe(true);
  expect((screen.getByRole("spinbutton") as HTMLInputElement).value).toBe(
    "64000",
  );
});

it("applies Highest as the numeric model maximum and recognizes it when reopened", () => {
  const onChange = vi.fn();
  const props = { provider: "codex-cli", model: "gpt-5.4-mini", onChange };
  const { rerender } = render(
    <ContextWindowPicker {...props} value={undefined} />,
  );
  open();
  choose("Highest");
  expect(screen.queryByRole("slider")).toBeNull();
  apply();
  expect(onChange).toHaveBeenCalledWith(400000);
  rerender(<ContextWindowPicker {...props} value={400000} />);
  open();
  expect(
    (screen.getByRole("radio", { name: /Highest/ }) as HTMLInputElement)
      .checked,
  ).toBe(true);
});

it.each([
  ["claude-cli", "sonnet", undefined, 1_000_000],
  [
    "copilot-cli",
    "discovered-model",
    { contextWindowTokens: 200_000, longContextWindowTokens: 2_000_000 },
    2_000_000,
  ],
] as const)(
  "offers provider tiers without arbitrary inputs for %s",
  (provider, model, capabilities, maximum) => {
    const onChange = vi.fn();
    render(
      <ContextWindowPicker
        provider={provider}
        model={model}
        capabilities={capabilities}
        value={undefined}
        onChange={onChange}
      />,
    );
    open();
    expect(screen.queryByRole("spinbutton")).toBeNull();
    expect(screen.queryByRole("slider")).toBeNull();
    expect(screen.queryByRole("radio", { name: "Custom" })).toBeNull();
    choose(`Highest ${maximum.toLocaleString()}`);
    apply();
    expect(onChange).toHaveBeenCalledExactlyOnceWith("long");
  },
);

it.each([
  ["openai", "gpt-6-astra"],
  ["claude-cli", "haiku"],
  ["copilot-cli", "auto"],
  ["codex-cli", "unknown"],
])(
  "keeps a disabled, labelled icon for unsupported %s / %s",
  (provider, model) => {
    const onChange = vi.fn();
    render(
      <ContextWindowPicker
        provider={provider}
        model={model}
        value={undefined}
        onChange={onChange}
      />,
    );
    const trigger = screen.getByRole("button", {
      name: "Context size: unavailable for this model",
    });
    expect(trigger.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(trigger);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  },
);

it("resets an open draft when the model or its discovered limit changes", () => {
  const onChange = vi.fn();
  const { rerender } = render(
    <ContextWindowPicker
      provider="codex-cli"
      model="gpt-6-astra"
      value={undefined}
      onChange={onChange}
    />,
  );
  open();
  choose("Custom");
  fireEvent.change(screen.getByRole("spinbutton"), {
    target: { value: "900000" },
  });
  rerender(
    <ContextWindowPicker
      provider="codex-cli"
      model="gpt-5.4-mini"
      value={undefined}
      onChange={onChange}
    />,
  );
  expect(
    (
      screen.getByRole("radio", {
        name: "Workspace default",
      }) as HTMLInputElement
    ).checked,
  ).toBe(true);
  choose("Custom");
  expect(screen.getByRole("spinbutton").getAttribute("max")).toBe("400000");
  rerender(
    <ContextWindowPicker
      provider="codex-cli"
      model="gpt-5.4-mini"
      capabilities={{ contextWindowTokens: 250_000 }}
      value={undefined}
      onChange={onChange}
    />,
  );
  choose("Highest");
  apply();
  expect(onChange).toHaveBeenCalledExactlyOnceWith(250000);
});

it("preserves the difference between inheritance and an explicit provider default", () => {
  const onChange = vi.fn();
  render(
    <ContextWindowPicker
      provider="codex-cli"
      model="gpt-6-astra"
      value={64_000}
      onChange={onChange}
      inheritLabel="Keep current"
    />,
  );
  open();
  choose("Keep current");
  apply();
  expect(onChange).toHaveBeenLastCalledWith(undefined);
  open();
  choose("Provider default");
  apply();
  expect(onChange).toHaveBeenLastCalledWith("default");
});
