import { createRef, useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tokenizeComposer } from "./composer-syntax";
import { ComposerInput } from "./composer-input";

afterEach(cleanup);

describe("composer syntax", () => {
  it.each(["\n```", ""])(
    "keeps multiline fenced code opaque with ending %s",
    (ending) => {
      const value =
        "```ts\nconst text = 'example';\n/goal clear\nhttps://example.com" +
        ending;
      expect(tokenizeComposer(value)).toEqual([{ text: value, kind: "code" }]);
    },
  );
  it.each([
    "/goal -- Fix auth\nSee https://example.com/sign-in.",
    "Read (https://example.com/a_(b)). Then https://example.com/c!",
    "# Checklist\n- **Verify auth**\n1. `pnpm test`",
    "```ts\nconst url = 'https://example.com';\n```\n/goal resume",
    "```\n/goal clear\nhttps://example.com",
    "<script>alert('no')</script>\n日本語 👋",
  ])("preserves every character of %s", (value) => {
    expect(
      tokenizeComposer(value)
        .map((token) => token.text)
        .join(""),
    ).toBe(value);
  });

  it("keeps code opaque and excludes prose punctuation from links", () => {
    const tokens = tokenizeComposer(
      "/goal Fix `https://example.com` (https://example.com/a_(b)).",
    );
    expect(tokens.filter((token) => token.kind)).toEqual([
      { text: "/goal", kind: "command" },
      { text: "`https://example.com`", kind: "code" },
      { text: "https://example.com/a_(b)", kind: "link" },
    ]);
    expect(
      tokenizeComposer("See /goal or /tmp/file").some((token) => token.kind),
    ).toBe(false);
  });

  it("updates highlights without changing submitted text, selection, or accessibility", () => {
    const submit = vi.fn();
    const ref = createRef<HTMLTextAreaElement>();
    function Harness() {
      const [value, setValue] = useState("");
      return (
        <ComposerInput
          ref={ref}
          aria-label="Message"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onSubmit={() => submit(value)}
        />
      );
    }
    const { container } = render(<Harness />);
    const input = screen.getByRole<HTMLTextAreaElement>("textbox", {
      name: "Message",
    });
    const value = "/goal Check https://example.com and `code`";
    fireEvent.change(input, { target: { value } });
    input.setSelectionRange(6, 11);
    expect(
      container.querySelector('[data-syntax="command"]')?.textContent,
    ).toBe("/goal");
    expect(container.querySelector('[data-syntax="link"]')?.textContent).toBe(
      "https://example.com",
    );
    expect(
      container
        .querySelector(".m-composer-highlight")
        ?.getAttribute("aria-hidden"),
    ).toBe("true");
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
    expect([ref.current, input.selectionStart, input.selectionEnd]).toEqual([
      input,
      6,
      11,
    ]);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(submit).toHaveBeenCalledExactlyOnceWith(value);
    fireEvent.change(input, { target: { value: "Plain text" } });
    expect(container.querySelector('[data-highlighted="true"]')).toBeNull();
  });
});
