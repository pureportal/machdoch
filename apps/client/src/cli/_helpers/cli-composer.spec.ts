import { describe, expect, it } from "vitest";
import { PromptComposer } from "./cli-composer.js";
import { layoutPrompt } from "./cli-prompt-layout.js";
import { clipTerminalText, terminalCellWidth } from "./cli-terminal-text.js";

describe("prompt editing", () => {
  it("restores a draft after navigating history and leaves Down on a new draft alone", () => {
    const composer = new PromptComposer(["latest", "older"]);
    composer.insert("draft");
    composer.recall(1);
    expect(composer.draft.text).toBe("draft");
    composer.recall(-1);
    expect(composer.draft.text).toBe("latest");
    composer.recall(-1);
    expect(composer.draft.text).toBe("older");
    composer.recall(1);
    composer.recall(1);
    expect(composer.draft.text).toBe("draft");
  });

  it("moves within wrapped input before recalling history", () => {
    const composer = new PromptComposer(["history"]);
    composer.insert("abcdefghijk");
    composer.moveVertical(-1, "> ", 8);
    expect(composer.draft).toMatchObject({ text: "abcdefghijk", cursor: 5 });
    composer.moveVertical(-1, "> ", 8);
    expect(composer.draft.text).toBe("history");
    composer.recall(1);
    expect(composer.draft).toMatchObject({ text: "abcdefghijk", cursor: 5 });
  });

  it("searches case insensitively and restores a cancelled search draft", () => {
    const composer = new PromptComposer([
      "Fix parser",
      "fix tests",
      "unrelated",
    ]);
    composer.insert("draft");
    composer.beginSearch();
    composer.updateSearch("FIX");
    expect(composer.draft.text).toBe("Fix parser");
    composer.beginSearch();
    expect(composer.draft.text).toBe("fix tests");
    composer.endSearch(true);
    expect(composer.draft.text).toBe("draft");
  });

  it("moves across complete emoji and combining characters", () => {
    const composer = new PromptComposer();
    composer.insert("a👩‍💻é");
    composer.moveCharacter(-1);
    expect(composer.draft.cursor).toBe(6);
    composer.moveCharacter(-1);
    expect(composer.draft.cursor).toBe(1);
    composer.moveCharacter(1);
    expect(composer.draft.cursor).toBe(6);
  });

  it("preserves multiline content, kill/yank and undo", () => {
    const composer = new PromptComposer();
    composer.insert("first\nsecond", true);
    composer.remove(6, 12, true);
    composer.yank();
    expect(composer.draft.text).toBe("first\nsecond");
    composer.undoEdit();
    expect(composer.draft.text).toBe("first\n");
    expect(composer.submit()).toMatchObject({ text: "first\n", pasted: true });
    expect(composer.draft.text).toBe("");
  });
});

describe("terminal layout", () => {
  it("measures wide characters and complete graphemes", () => {
    expect(terminalCellWidth("界👩‍💻é")).toBe(5);
    expect(layoutPrompt("ab界cd", "> ", 7).rows).toEqual(["> ab界c", "  d"]);
    expect(clipTerminalText("a👩‍💻bc", 4)).toBe("a👩‍💻…");
    expect(clipTerminalText("界界", 2)).toBe("…");
  });
});
