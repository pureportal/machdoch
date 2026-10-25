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
const props = {
  provider: "codex-cli",
  model: "discovered",
  capabilities: {
    contextWindowTokens: 272_000,
    longContextWindowTokens: 872_000,
  },
};

it("shows exactly four presets with resolved workspace and model sizes", () => {
  const onChange = vi.fn();
  render(
    <ContextWindowPicker {...props} value={undefined} onChange={onChange} />,
  );
  expect(
    screen
      .getByRole("button", {
        name: "Context size: Workspace Default (872,000 tokens)",
      })
      .getAttribute("data-active"),
  ).toBe("true");
  open();
  expect(
    screen
      .getAllByRole("radio")
      .map((radio) => radio.closest("label")?.textContent),
  ).toEqual([
    "Workspace Default872,000 tokens",
    "Lowest272,000 tokens",
    "Provider Default272,000 tokens",
    "Highest872,000 tokens",
  ]);
  expect(screen.queryByRole("slider")).toBeNull();
  expect(screen.queryByRole("spinbutton")).toBeNull();
  choose("Highest");
  expect(onChange).not.toHaveBeenCalled();
  apply();
  expect(onChange).toHaveBeenCalledExactlyOnceWith("highest");
});

it("uses the configured workspace preset and commits inheritance separately", () => {
  const onChange = vi.fn();
  render(
    <ContextWindowPicker
      {...props}
      value="highest"
      inheritedValue="lowest"
      onChange={onChange}
    />,
  );
  open();
  expect(
    screen.getByRole("radio", { name: "Workspace Default 272,000 tokens" }),
  ).toBeTruthy();
  choose("Workspace Default");
  apply();
  expect(onChange).toHaveBeenLastCalledWith(undefined);
  open();
  choose("Provider Default");
  apply();
  expect(onChange).toHaveBeenLastCalledWith("default");
});

it("discards cancelled drafts", () => {
  const onChange = vi.fn();
  render(<ContextWindowPicker {...props} value="lowest" onChange={onChange} />);
  open();
  choose("Highest");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  open();
  expect(
    (screen.getByRole("radio", { name: /Lowest/ }) as HTMLInputElement).checked,
  ).toBe(true);
  expect(onChange).not.toHaveBeenCalled();
});

it("preserves the selected preset through model and provider changes, including fixed models", () => {
  const onChange = vi.fn();
  const { rerender } = render(
    <ContextWindowPicker {...props} value="highest" onChange={onChange} />,
  );
  open();
  rerender(
    <ContextWindowPicker
      {...props}
      model="smaller"
      capabilities={{
        contextWindowTokens: 64_000,
        longContextWindowTokens: 128_000,
      }}
      value="highest"
      onChange={onChange}
    />,
  );
  expect(
    (
      screen.getByRole("radio", {
        name: "Highest 128,000 tokens",
      }) as HTMLInputElement
    ).checked,
  ).toBe(true);
  rerender(
    <ContextWindowPicker
      {...props}
      provider="openai"
      value="highest"
      onChange={onChange}
    />,
  );
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(
    screen
      .getByRole("button", { name: /^Context size:/ })
      .hasAttribute("disabled"),
  ).toBe(true);
  rerender(
    <ContextWindowPicker {...props} value="highest" onChange={onChange} />,
  );
  open();
  expect(
    (
      screen.getByRole("radio", {
        name: "Highest 872,000 tokens",
      }) as HTMLInputElement
    ).checked,
  ).toBe(true);
  expect(onChange).not.toHaveBeenCalled();
});

it.each(["codex-cli", "copilot-cli", "claude-cli", "openai"])(
  "disables a single-size %s model",
  (provider) => {
    const onChange = vi.fn();
    render(
      <ContextWindowPicker
        provider={provider}
        model="sonnet"
        capabilities={{
          contextWindowTokens: 1_000_000,
          longContextWindowTokens: 1_000_000,
        }}
        value="highest"
        onChange={onChange}
      />,
    );
    const button = screen.getByRole("button", { name: /^Context size:/ });
    expect(button.hasAttribute("disabled")).toBe(true);
    fireEvent.click(button);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  },
);

it("renders distinct active SVGs for all four selections", () => {
  const onChange = vi.fn();
  const { rerender } = render(
    <ContextWindowPicker {...props} value={undefined} onChange={onChange} />,
  );
  const icons = new Set<string>();
  for (const value of [undefined, "lowest", "default", "highest"] as const) {
    rerender(
      <ContextWindowPicker {...props} value={value} onChange={onChange} />,
    );
    const button = screen.getByRole("button", { name: /^Context size:/ });
    expect(button.getAttribute("data-active")).toBe("true");
    icons.add(button.querySelector("svg")!.innerHTML);
  }
  expect(icons.size).toBe(4);
});
