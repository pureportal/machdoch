import { createRef } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ComposerInput } from "./composer-input";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("submits desktop Enter once and preserves newline modifiers", () => {
  const submit = vi.fn();
  render(<ComposerInput aria-label="Task" onSubmit={submit} />);
  const input = screen.getByRole("textbox", { name: "Task" });
  for (const modifiers of [{}, { ctrlKey: true }, { metaKey: true }]) {
    expect(fireEvent.keyDown(input, { key: "Enter", ...modifiers })).toBe(
      false,
    );
  }
  expect(submit).toHaveBeenCalledTimes(3);
  for (const modifiers of [{ shiftKey: true }, { altKey: true }]) {
    expect(fireEvent.keyDown(input, { key: "Enter", ...modifiers })).toBe(true);
  }
  expect(submit).toHaveBeenCalledTimes(3);
});

it("preserves mobile Enter and accepts explicit submit shortcuts", () => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: true })),
  );
  const submit = vi.fn();
  render(<ComposerInput aria-label="Task" onSubmit={submit} />);
  const input = screen.getByRole("textbox", { name: "Task" });
  expect(fireEvent.keyDown(input, { key: "Enter" })).toBe(true);
  expect(submit).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
  expect(submit).toHaveBeenCalledOnce();
});

it("does not submit while composing or when a consumer handles Enter", () => {
  const submit = vi.fn();
  const view = render(<ComposerInput aria-label="Task" onSubmit={submit} />);
  const input = screen.getByRole("textbox", { name: "Task" });
  fireEvent.compositionStart(input);
  fireEvent.keyDown(input, { key: "Enter" });
  fireEvent.compositionEnd(input);
  fireEvent.keyDown(input, { key: "Enter", isComposing: true });
  fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
  expect(submit).not.toHaveBeenCalled();
  view.rerender(
    <ComposerInput
      aria-label="Task"
      onSubmit={submit}
      onKeyDown={(event) => event.preventDefault()}
    />,
  );
  fireEvent.keyDown(input, { key: "Enter" });
  expect(submit).not.toHaveBeenCalled();
});

it("forwards the textarea and grows and shrinks when controlled text changes", () => {
  const ref = createRef<HTMLTextAreaElement>();
  const view = render(
    <ComposerInput
      aria-label="Task"
      value=""
      onChange={vi.fn()}
      onSubmit={vi.fn()}
      ref={ref}
    />,
  );
  const input = screen.getByRole("textbox", { name: "Task" });
  expect(ref.current).toBe(input);
  Object.defineProperty(input, "scrollHeight", {
    configurable: true,
    value: 120,
  });
  view.rerender(
    <ComposerInput
      aria-label="Task"
      value="Long text"
      onChange={vi.fn()}
      onSubmit={vi.fn()}
      ref={ref}
    />,
  );
  expect(ref.current!.style.height).toBe("120px");
  Object.defineProperty(input, "scrollHeight", {
    configurable: true,
    value: 40,
  });
  view.rerender(
    <ComposerInput
      aria-label="Task"
      value=""
      onChange={vi.fn()}
      onSubmit={vi.fn()}
      ref={ref}
    />,
  );
  expect(ref.current!.style.height).toBe("40px");
  view.unmount();
  expect(ref.current).toBeNull();
});
