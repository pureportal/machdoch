/** @vitest-environment jsdom */

import { createElement } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CopyContextMenu } from "./copy-context-menu";
import { commandOverlayStore } from "../../commands/command-overlay-store";

const writeText = vi.fn();

beforeEach(() => {
  writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
});

afterEach(() => {
  cleanup();
  window.getSelection()?.removeAllRanges();
});

const renderPath = (onClick = vi.fn()) =>
  render(
    createElement(CopyContextMenu, {
      values: [
        { label: "Copy full path", value: "C:\\workspace\\src\\index.ts" },
      ],
      children: createElement("button", { onClick }, "index.ts"),
    }),
  );

describe("CopyContextMenu", () => {
  it("copies the complete value without activating the underlying row and can reopen", async () => {
    const activate = vi.fn();
    renderPath(activate);
    const trigger = screen.getByRole("button", { name: "index.ts" });
    fireEvent.contextMenu(trigger);
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Copy full path" }),
    );
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(writeText).toHaveBeenCalledWith("C:\\workspace\\src\\index.ts");
    expect(activate).not.toHaveBeenCalled();
    fireEvent.contextMenu(trigger);
    expect(
      await screen.findByRole("menuitem", { name: "Copy full path" }),
    ).toBeTruthy();
  });

  it("opens from the keyboard and restores focus after Escape", async () => {
    renderPath();
    const trigger = screen.getByRole("button", { name: "index.ts" });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "F10", shiftKey: true });
    const menu = await screen.findByRole("menu");
    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("allows the command palette to dismiss the menu", async () => {
    renderPath();
    fireEvent.contextMenu(screen.getByRole("button", { name: "index.ts" }));
    await screen.findByRole("menu");
    await commandOverlayStore.dismissTopNonModal();
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("captures only selection belonging to the target", async () => {
    renderPath();
    const trigger = screen.getByRole("button", { name: "index.ts" });
    const range = document.createRange();
    range.setStart(trigger.firstChild!, 0);
    range.setEnd(trigger.firstChild!, 5);
    window.getSelection()?.addRange(range);
    fireEvent.contextMenu(trigger);
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Copy selection" }),
    );
    expect(writeText).toHaveBeenCalledWith("index");
  });

  it("ignores selection outside the target and captures dynamic values when opened", async () => {
    let selection = "first";
    render(
      createElement(
        "div",
        null,
        createElement("p", null, "Unrelated text"),
        createElement(CopyContextMenu, {
          values: () => [
            { label: "Copy terminal selection", value: selection },
          ],
          children: createElement("button", null, "Terminal"),
        }),
      ),
    );
    const range = document.createRange();
    range.selectNodeContents(screen.getByText("Unrelated text"));
    window.getSelection()?.addRange(range);
    selection = "latest";
    fireEvent.contextMenu(screen.getByRole("button", { name: "Terminal" }));
    expect(
      screen.queryByRole("menuitem", { name: "Copy selection" }),
    ).toBeNull();
    selection = "changed after opening";
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Copy terminal selection" }),
    );
    expect(writeText).toHaveBeenCalledWith("latest");
  });

  it("reports a rejected clipboard write and permits retry", async () => {
    writeText.mockRejectedValueOnce(new Error("Denied"));
    renderPath();
    const trigger = screen.getByRole("button", { name: "index.ts" });
    fireEvent.contextMenu(trigger);
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Copy full path" }),
    );
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Could not copy",
    );
    fireEvent.contextMenu(trigger);
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Copy full path" }),
    );
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(writeText).toHaveBeenCalledTimes(2);
  });

  it("keeps native menus and keyboard editing available inside copyable content", () => {
    render(
      createElement(CopyContextMenu, {
        values: [{ label: "Copy details", value: "Details" }],
        children: createElement(
          "div",
          null,
          createElement("input", { "aria-label": "Name" }),
          createElement(
            "div",
            { contentEditable: true, "data-testid": "editor" },
            "Editable",
          ),
        ),
      }),
    );
    for (const target of [
      screen.getByRole("textbox"),
      screen.getByTestId("editor"),
    ]) {
      expect(fireEvent.contextMenu(target)).toBe(true);
      expect(fireEvent.keyDown(target, { key: "F10", shiftKey: true })).toBe(
        true,
      );
      expect(screen.queryByRole("menu")).toBeNull();
    }
  });

  it("opens the innermost copy menu from the keyboard", async () => {
    render(
      createElement(CopyContextMenu, {
        values: [{ label: "Copy outer", value: "Outer" }],
        children: createElement(
          "section",
          null,
          createElement(CopyContextMenu, {
            values: [{ label: "Copy inner", value: "Inner" }],
            children: createElement("button", null, "Inner"),
          }),
        ),
      }),
    );
    const trigger = screen.getByRole("button", { name: "Inner" });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "F10", shiftKey: true });
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Copy inner" }),
    );
    expect(writeText).toHaveBeenCalledWith("Inner");
    expect(screen.queryByRole("menuitem", { name: "Copy outer" })).toBeNull();
  });
});
