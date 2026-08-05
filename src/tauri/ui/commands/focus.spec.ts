// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { classifyFocusPath, getElementFocusSnapshot } from "./focus";

describe("focus classification", () => {
  it("classifies native editable and interactive controls", () => {
    expect(classifyFocusPath([document.createElement("input")]).kind).toBe(
      "text-entry",
    );
    expect(classifyFocusPath([document.createElement("button")]).kind).toBe(
      "interactive-control",
    );

    const button = document.createElement("button");
    const icon = document.createElement("span");
    button.append(icon);
    expect(classifyFocusPath([icon, button]).kind).toBe("interactive-control");
  });

  it("treats editors, contenteditable regions, and xterm as strong boundaries", () => {
    const editor = document.createElement("div");
    editor.className = "cm-editor";
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    const editableChild = document.createElement("span");
    editable.append(editableChild);
    const terminal = document.createElement("div");
    terminal.className = "xterm";
    expect(classifyFocusPath([editor]).kind).toBe("editor");
    expect(classifyFocusPath([editableChild, editable]).kind).toBe("editor");
    expect(classifyFocusPath([terminal]).kind).toBe("terminal");
  });

  it("uses explicit focus ownership across a composed path", () => {
    const input = document.createElement("input");
    const surface = document.createElement("div");
    surface.dataset.commandFocus = "command-surface";
    surface.dataset.commandOwner = "palette";
    expect(classifyFocusPath([input, surface])).toEqual({
      kind: "command-surface",
      ownerPath: ["palette"],
    });

    document.body.append(surface);
    surface.append(input);
    expect(getElementFocusSnapshot(input)).toEqual({
      kind: "command-surface",
      ownerPath: ["palette"],
    });
  });
});
