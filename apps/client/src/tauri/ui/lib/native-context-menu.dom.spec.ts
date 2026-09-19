/** @vitest-environment jsdom */

import { afterEach, describe, expect, it } from "vitest";
import { preserveNativeContextMenu } from "./native-context-menu";

afterEach(() => {
  document.body.replaceChildren();
  window.getSelection()?.removeAllRanges();
});

describe("native context menus", () => {
  it("allows editing controls and explicitly registered custom triggers", () => {
    document.body.innerHTML =
      '<input><textarea></textarea><div contenteditable="true"><span>Edit</span></div><button data-app-context-menu-trigger><span>Copy</span></button><p>Label</p>';
    for (const element of document.querySelectorAll("input, textarea, span")) {
      expect(preserveNativeContextMenu(element)).toBe(true);
    }
    expect(preserveNativeContextMenu(document.querySelector("p"))).toBe(false);
  });

  it("allows a native menu over selected text without enabling it elsewhere", () => {
    document.body.innerHTML =
      "<pre><code>Diagnostic</code></pre><p>Elsewhere</p>";
    const code = document.querySelector("code")!;
    const range = document.createRange();
    range.selectNodeContents(code);
    window.getSelection()?.addRange(range);
    expect(preserveNativeContextMenu(code)).toBe(true);
    expect(preserveNativeContextMenu(document.querySelector("p"))).toBe(false);
  });
});
