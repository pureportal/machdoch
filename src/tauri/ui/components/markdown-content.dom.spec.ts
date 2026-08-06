/** @vitest-environment jsdom */

import { createElement } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarkdownContent } from "./markdown-content";

afterEach(() => {
  cleanup();
});

describe("MarkdownContent code copying", () => {
  it("copies decoded fenced-code text without the parser-added trailing newline", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(globalThis.navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    render(
      createElement(MarkdownContent, {
        content: `\`\`\`ts title="sample"
const value = "<tag> & text";
\`\`\``,
      }),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Copy code block to clipboard" }),
    );

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('const value = "<tag> & text";');
    });
    expect(
      screen
        .getByRole("button", { name: "Copied code block" })
        .getAttribute("title"),
    ).toBe("Copied");
  });
});
