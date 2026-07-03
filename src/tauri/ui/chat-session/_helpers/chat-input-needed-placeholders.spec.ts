import { describe, expect, it } from "vitest";
import {
  extractChatInputNeededPlaceholders,
  replaceChatInputNeededPlaceholders,
} from "./chat-input-needed-placeholders";

describe("chat input-needed placeholders", () => {
  it("extracts unique placeholders in first-seen order and counts repeats", () => {
    expect(
      extractChatInputNeededPlaceholders(
        "Update [[SCOPE]] for [[ target_file ]] and check [[scope]] again.",
      ),
    ).toEqual([
      {
        key: "SCOPE",
        lookupKey: "scope",
        occurrenceCount: 2,
      },
      {
        key: "target_file",
        lookupKey: "target_file",
        occurrenceCount: 1,
      },
    ]);
  });

  it("ignores legacy double-brace placeholders", () => {
    expect(
      extractChatInputNeededPlaceholders(
        "Use {{FIRST}} before {{ second }} and then [[THIRD]].",
      ),
    ).toEqual([
      {
        key: "THIRD",
        lookupKey: "third",
        occurrenceCount: 1,
      },
    ]);
    expect(
      replaceChatInputNeededPlaceholders(
        "Use {{FIRST}} before {{ second }} and then [[THIRD]].",
        {
          first: "one",
          second: "two",
          third: "three",
        },
      ),
    ).toBe("Use {{FIRST}} before {{ second }} and then three.");
  });

  it("replaces every occurrence for each collected key", () => {
    expect(
      replaceChatInputNeededPlaceholders(
        "Update [[SCOPE]] and then validate [[ scope ]].",
        {
          scope: "src/tauri/ui",
        },
      ),
    ).toBe("Update src/tauri/ui and then validate src/tauri/ui.");
  });

  it("extracts defaults, optional markers, and choices", () => {
    expect(
      extractChatInputNeededPlaceholders(
        "Deploy [[ENV=staging|dev,staging,prod]] with [[NOTES?=none]] and [[RISK?|low,medium,high]].",
      ),
    ).toEqual([
      {
        key: "ENV",
        lookupKey: "env",
        occurrenceCount: 1,
        defaultValue: "staging",
        options: ["dev", "staging", "prod"],
      },
      {
        key: "NOTES",
        lookupKey: "notes",
        occurrenceCount: 1,
        defaultValue: "none",
        optional: true,
      },
      {
        key: "RISK",
        lookupKey: "risk",
        occurrenceCount: 1,
        optional: true,
        options: ["low", "medium", "high"],
      },
    ]);
  });

  it("merges metadata from repeated placeholders by first available value", () => {
    expect(
      extractChatInputNeededPlaceholders(
        "Review [[SCOPE]] then [[scope=src|docs,src]] and [[ scope? ]].",
      ),
    ).toEqual([
      {
        key: "SCOPE",
        lookupKey: "scope",
        occurrenceCount: 3,
        defaultValue: "src",
        optional: true,
        options: ["docs", "src"],
      },
    ]);
  });

  it("replaces extended placeholder syntax by lookup key", () => {
    expect(
      replaceChatInputNeededPlaceholders(
        "Deploy [[ENV=staging|dev,staging,prod]] with [[NOTES?=none]].",
        {
          env: "prod",
          notes: "",
        },
      ),
    ).toBe("Deploy prod with .");
  });

  it("leaves Ralph double-brace placeholders untouched", () => {
    const message =
      "Use {{lastResult}}, {{lastResultSummary}}, {{result:block-id}}, {{data:block:path}}, {{workspace.root}}, then fill [[SCOPE]].";

    expect(extractChatInputNeededPlaceholders(message)).toEqual([
      {
        key: "SCOPE",
        lookupKey: "scope",
        occurrenceCount: 1,
      },
    ]);
    expect(
      replaceChatInputNeededPlaceholders(message, {
        lastresult: "ignored",
        scope: "docs",
      }),
    ).toBe(
      "Use {{lastResult}}, {{lastResultSummary}}, {{result:block-id}}, {{data:block:path}}, {{workspace.root}}, then fill docs.",
    );
  });

  it("allows bracket placeholders for Ralph-style names", () => {
    const message = "Summarize [[lastResult]], fill [[SCOPE]].";

    expect(extractChatInputNeededPlaceholders(message)).toEqual([
      {
        key: "lastResult",
        lookupKey: "lastresult",
        occurrenceCount: 1,
      },
      {
        key: "SCOPE",
        lookupKey: "scope",
        occurrenceCount: 1,
      },
    ]);
    expect(
      replaceChatInputNeededPlaceholders(message, {
        lastresult: "the previous output",
        scope: "docs",
      }),
    ).toBe("Summarize the previous output, fill docs.");
  });

  it("ignores path-like bracket templates", () => {
    const message =
      "Use [[scope:path=ALL]], [[workspace.root]], [[BROKEN|]], and fill [[SCOPE]].";

    expect(extractChatInputNeededPlaceholders(message)).toEqual([
      {
        key: "SCOPE",
        lookupKey: "scope",
        occurrenceCount: 1,
      },
    ]);
    expect(
      replaceChatInputNeededPlaceholders(message, {
        scope: "docs",
      }),
    ).toBe(
      "Use [[scope:path=ALL]], [[workspace.root]], [[BROKEN|]], and fill docs.",
    );
  });
});
