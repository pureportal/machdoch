import type {
  ConversationMemoryEntry,
  TaskConversationContext,
} from "../../core/types.ts";
import type { ParsedCliArgs } from "./cli-args.ts";
import {
  createInteractiveChatSessionState,
  resolveConversationContext,
} from "./cli-task-run.ts";

const createMemoryEntry = (
  scope: ConversationMemoryEntry["scope"],
  content: string,
): ConversationMemoryEntry => {
  return {
    id: `${scope}-${content}`,
    scope,
    content,
    createdAt: 1,
    updatedAt: 1,
  };
};

const createArgs = (
  overrides: Partial<
    Pick<
      ParsedCliArgs,
      "conversationContextFile" | "globalMemoryEnabled" | "sessionMemoryEnabled"
    >
  > = {},
): Pick<
  ParsedCliArgs,
  "conversationContextFile" | "globalMemoryEnabled" | "sessionMemoryEnabled"
> => {
  return {
    ...overrides,
  };
};

describe("resolveConversationContext", () => {
  it("returns undefined when neither a base context nor CLI overrides exist", async () => {
    await expect(
      resolveConversationContext(createArgs()),
    ).resolves.toBeUndefined();
  });

  it("preserves explicit conversation state when no CLI overrides are provided", async () => {
    const explicitContext: TaskConversationContext = {
      history: [{ role: "user", content: "Summarize the repo" }],
      sessionMemoryEnabled: true,
      sessionMemory: [
        createMemoryEntry("session", "Prefers concise output"),
      ],
      globalMemoryEnabled: false,
      globalMemory: [createMemoryEntry("global", "Uses Windows")],
    };

    await expect(
      resolveConversationContext(createArgs(), explicitContext),
    ).resolves.toEqual(explicitContext);
  });

  it("lets CLI overrides win over the explicit conversation context", async () => {
    const explicitContext: TaskConversationContext = {
      history: [{ role: "user", content: "Inspect src" }],
      sessionMemoryEnabled: true,
      globalMemoryEnabled: true,
    };

    await expect(
      resolveConversationContext(
        createArgs({
          sessionMemoryEnabled: false,
          globalMemoryEnabled: false,
        }),
        explicitContext,
      ),
    ).resolves.toEqual({
      history: [{ role: "user", content: "Inspect src" }],
      sessionMemoryEnabled: false,
      globalMemoryEnabled: false,
    });
  });
});

describe("createInteractiveChatSessionState", () => {
  it("preserves seeded history, memory, and UI-control metadata", () => {
    const seededContext: TaskConversationContext = {
      history: [{ role: "user", content: "Continue from the previous run" }],
      sessionMemoryEnabled: false,
      sessionMemory: [createMemoryEntry("session", "Prefers terse answers")],
      globalMemoryEnabled: true,
      globalMemory: [createMemoryEntry("global", "Uses Windows")],
      uiControlEnabled: true,
      uiControl: {
        available: true,
        platform: "windows",
        supportsScreenshots: true,
        supportsWindowEnumeration: true,
        supportsInput: true,
        supportsWindowHandles: true,
      },
    };

    expect(createInteractiveChatSessionState(seededContext, false)).toEqual({
      history: [{ role: "user", content: "Continue from the previous run" }],
      sessionMemoryEnabled: false,
      sessionMemory: [createMemoryEntry("session", "Prefers terse answers")],
      globalMemoryEnabled: true,
      globalMemory: [createMemoryEntry("global", "Uses Windows")],
      uiControlEnabled: true,
      uiControl: {
        available: true,
        platform: "windows",
        supportsScreenshots: true,
        supportsWindowEnumeration: true,
        supportsInput: true,
        supportsWindowHandles: true,
      },
      effectiveGlobalMemoryEnabled: true,
    });
  });

  it("falls back to empty interactive chat state when no seed context exists", () => {
    expect(createInteractiveChatSessionState(undefined, false)).toEqual({
      history: [],
      sessionMemory: [],
      sessionMemoryEnabled: true,
      effectiveGlobalMemoryEnabled: false,
    });
  });
});
