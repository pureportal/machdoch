import { describe, expect, it } from "vitest";
import {
  continueList,
  insertLink,
  pasteLink,
  toggleInline,
  toggleLines,
  type TextEdit,
} from "./markdown-editing";

function apply(text: string, edit: TextEdit) {
  const result = text.slice(0, edit.from) + edit.insert + text.slice(edit.to);
  return {
    text: result,
    selected: result.slice(edit.selection.start, edit.selection.end),
    caret: edit.selection.start,
  };
}

describe("inline formatting", () => {
  it("wraps the selection and unwraps it again", () => {
    const bold = apply(
      "Fix the crash",
      toggleInline("Fix the crash", { start: 8, end: 13 }, "bold"),
    );
    expect(bold).toMatchObject({
      text: "Fix the **crash**",
      selected: "crash",
    });
    const plain = apply(
      bold.text,
      toggleInline(bold.text, { start: 10, end: 15 }, "bold"),
    );
    expect(plain).toMatchObject({ text: "Fix the crash", selected: "crash" });
    expect(
      apply("**done**", toggleInline("**done**", { start: 0, end: 8 }, "bold")),
    ).toMatchObject({ text: "done", selected: "done" });
  });

  it("places the caret between markers without a selection", () => {
    expect(
      apply("Use ", toggleInline("Use ", { start: 4, end: 4 }, "code")),
    ).toMatchObject({ text: "Use ``", caret: 5 });
  });
});

describe("line formatting", () => {
  it("turns lines into numbered lists, task lists and back", () => {
    const text = "Steps\n\nOpen app\nUpload file";
    const numbered = apply(
      text,
      toggleLines(text, { start: 7, end: text.length }, "number"),
    );
    expect(numbered.text).toBe("Steps\n\n1. Open app\n2. Upload file");
    const tasks = apply(
      numbered.text,
      toggleLines(
        numbered.text,
        { start: 7, end: numbered.text.length },
        "task",
      ),
    );
    expect(tasks.text).toBe("Steps\n\n- [ ] Open app\n- [ ] Upload file");
    const cleared = apply(
      tasks.text,
      toggleLines(tasks.text, { start: 7, end: tasks.text.length }, "task"),
    );
    expect(cleared.text).toBe("Steps\n\nOpen app\nUpload file");
  });

  it("keeps blank lines, quotes lists and leaves the caret at the line end", () => {
    expect(
      apply("a\n\nb", toggleLines("a\n\nb", { start: 0, end: 4 }, "bullet"))
        .text,
    ).toBe("- a\n\n- b");
    expect(
      apply("- a", toggleLines("- a", { start: 0, end: 3 }, "quote")).text,
    ).toBe("> - a");
    expect(
      apply("Title", toggleLines("Title", { start: 2, end: 2 }, "heading")),
    ).toMatchObject({ text: "## Title", caret: 8 });
    expect(
      apply("", toggleLines("", { start: 0, end: 0 }, "bullet")),
    ).toMatchObject({ text: "- ", caret: 2 });
  });
});

describe("links", () => {
  it("links the selection and selects the address to type", () => {
    expect(
      apply("See docs", insertLink("See docs", { start: 4, end: 8 })),
    ).toMatchObject({ text: "See [docs](https://)", selected: "https://" });
    expect(apply("", insertLink("", { start: 0, end: 0 }))).toMatchObject({
      text: "[link](https://)",
      selected: "link",
    });
  });

  it("turns a pasted address over selected words into a link", () => {
    expect(
      apply(
        "Read the guide",
        pasteLink(
          "Read the guide",
          { start: 9, end: 14 },
          " https://example.test/guide ",
        )!,
      ),
    ).toMatchObject({ text: "Read the [guide](https://example.test/guide)" });
    expect(pasteLink("Read", { start: 0, end: 4 }, "not a url")).toBeNull();
    expect(
      pasteLink("Read", { start: 2, end: 2 }, "https://a.test"),
    ).toBeNull();
    expect(
      pasteLink("https://old.test", { start: 0, end: 16 }, "https://new.test"),
    ).toBeNull();
  });
});

describe("list continuation", () => {
  it("continues bullets, numbers, quotes and unchecked tasks", () => {
    for (const [text, expected] of [
      ["- one", "- one\n- "],
      ["  * nested", "  * nested\n  * "],
      ["9. nine", "9. nine\n10. "],
      ["- [x] done", "- [x] done\n- [ ] "],
      ["> quote", "> quote\n> "],
    ] as const) {
      const result = apply(
        text,
        continueList(text, { start: text.length, end: text.length })!,
      );
      expect(result).toMatchObject({ text: expected, caret: expected.length });
    }
  });

  it("ends the list on an empty item and ignores plain lines", () => {
    expect(
      apply("- one\n- ", continueList("- one\n- ", { start: 8, end: 8 })!),
    ).toMatchObject({ text: "- one\n\n", caret: 7 });
    expect(
      apply(
        "- one\n  - ",
        continueList("- one\n  - ", { start: 10, end: 10 })!,
      ),
    ).toMatchObject({ text: "- one\n  ", caret: 8 });
    expect(continueList("plain", { start: 5, end: 5 })).toBeNull();
    expect(continueList("- one", { start: 1, end: 1 })).toBeNull();
    expect(continueList("- one", { start: 0, end: 5 })).toBeNull();
  });
});
