import type {
  ConversationMemoryEntry,
  TaskConversationContext,
} from "../../core/types.ts";
import type { ParsedCliArgs } from "./cli-args.ts";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyContextPathsToTask,
  createImageInputsFromPaths,
  createInteractiveChatSessionState,
  normalizePastedTask,
  parseInteractivePasteCommand,
  readPastedTask,
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

const workspacesToClean: string[] = [];

const createWorkspace = async (): Promise<string> => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "machdoch-cli-context-"));
  workspacesToClean.push(workspaceRoot);

  return workspaceRoot;
};

afterEach(async () => {
  await Promise.all(
    workspacesToClean
      .splice(0)
      .map((workspaceRoot) =>
        rm(workspaceRoot, { recursive: true, force: true }),
      ),
  );
});

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

describe("applyContextPathsToTask", () => {
  it("appends GUI-style file and folder context references to a task", async () => {
    const workspaceRoot = await createWorkspace();

    await mkdir(join(workspaceRoot, "docs"), { recursive: true });
    await writeFile(join(workspaceRoot, "README.md"), "# machdoch\n");

    await expect(
      applyContextPathsToTask(
        "Summarize the selected context",
        ["README.md", "docs", "missing-target"],
        workspaceRoot,
      ),
    ).resolves.toBe(
      [
        "Summarize the selected context",
        "",
        "Use these paths:",
        '- file: "README.md"',
        '- folder: "docs"',
        '- path: "missing-target"',
      ].join("\n"),
    );
  });

  it("returns the trimmed task when no context paths were provided", async () => {
    await expect(
      applyContextPathsToTask("  Summarize the repo  ", undefined, "C:/repo"),
    ).resolves.toBe("Summarize the repo");
  });
});

describe("createImageInputsFromPaths", () => {
  it("loads image attachments as base64 inputs for a vision-capable model", async () => {
    const workspaceRoot = await createWorkspace();

    await writeFile(join(workspaceRoot, "screen.png"), Buffer.from("image"));

    await expect(
      createImageInputsFromPaths(["screen.png"], workspaceRoot, {
        provider: "openai",
        model: "gpt-5.5",
      }),
    ).resolves.toEqual([
      {
        path: join(workspaceRoot, "screen.png"),
        mediaType: "image/png",
        data: Buffer.from("image").toString("base64"),
      },
    ]);
  });

  it("rejects image attachments for text-only models", async () => {
    const workspaceRoot = await createWorkspace();

    await writeFile(join(workspaceRoot, "screen.png"), Buffer.from("image"));

    await expect(
      createImageInputsFromPaths(["screen.png"], workspaceRoot, {
        provider: "openai",
        model: "gpt-3.5-turbo",
      }),
    ).rejects.toThrow("does not support reading image attachments");
  });

  it("rejects provider-unsupported image formats", async () => {
    const workspaceRoot = await createWorkspace();

    await writeFile(join(workspaceRoot, "photo.heic"), Buffer.from("image"));

    await expect(
      createImageInputsFromPaths(["photo.heic"], workspaceRoot, {
        provider: "openai",
        model: "gpt-5.5",
      }),
    ).rejects.toThrow("Unsupported image attachment format");
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

describe("interactive paste helpers", () => {
  class PasteLineInterface extends EventEmitter {
    prompts: string[] = [];
    questionCalls = 0;
    private promptText: string;

    constructor(promptText = "machdoch> ") {
      super();
      this.promptText = promptText;
    }

    async question(): Promise<string> {
      this.questionCalls += 1;
      throw new Error("line-event paste mode should not call question()");
    }

    getPrompt(): string {
      return this.promptText;
    }

    setPrompt(promptText: string): void {
      this.promptText = promptText;
    }

    prompt(): void {
      this.prompts.push(this.promptText);
    }
  }

  it("recognizes paste commands with optional execution modes", () => {
    expect(parseInteractivePasteCommand("show README.md")).toEqual({
      recognized: false,
    });
    expect(parseInteractivePasteCommand("/paste")).toEqual({
      recognized: true,
    });
    expect(parseInteractivePasteCommand("/paste plan")).toEqual({
      recognized: true,
      mode: "plan",
    });
    expect(parseInteractivePasteCommand("/paste beta")).toEqual({
      recognized: true,
      error: "Usage: /paste [plan|safe|ask|auto]",
    });
  });

  it("normalizes pasted multiline task text", () => {
    expect(
      normalizePastedTask([
        "",
        "Create a Docker Compose setup.",
        "",
        "Repos:",
        "- backend",
        "- frontend",
        "",
      ]),
    ).toBe("Create a Docker Compose setup.\n\nRepos:\n- backend\n- frontend");

    expect(normalizePastedTask(["", "  ", ""])).toBeUndefined();
  });

  it("reads pasted lines until the terminator", async () => {
    const prompts: string[] = [];
    const notices: string[] = [];
    const inputs = ["line one", "line two", "/end"];
    let inputIndex = 0;

    await expect(
      readPastedTask(
        {
          question: async (query) => {
            prompts.push(query);
            const input = inputs[inputIndex];
            inputIndex += 1;

            return input ?? "/end";
          },
        },
        {
          writeLine: (line = "") => {
            notices.push(line);
          },
        },
      ),
    ).resolves.toBe("line one\nline two");

    expect(prompts).toEqual(["paste> ", "paste> ", "paste> "]);
    expect(notices).toEqual([
      "Paste task text. Finish with a line containing only /end.",
    ]);
  });

  it("captures fast pasted lines through one line-event listener", async () => {
    const notices: string[] = [];
    const interfaceHandle = new PasteLineInterface();
    const pastedTask = readPastedTask(interfaceHandle, {
      writeLine: (line = "") => {
        notices.push(line);
      },
    });

    interfaceHandle.emit("line", "You are a DevOps AI agent.");
    interfaceHandle.emit("line", "");
    interfaceHandle.emit("line", "Repos:");
    interfaceHandle.emit("line", "- backend");
    interfaceHandle.emit("line", "- frontend");
    interfaceHandle.emit("line", "/end");

    await expect(pastedTask).resolves.toBe(
      [
        "You are a DevOps AI agent.",
        "",
        "Repos:",
        "- backend",
        "- frontend",
      ].join("\n"),
    );
    expect(interfaceHandle.questionCalls).toBe(0);
    expect(interfaceHandle.prompts).toEqual([
      "paste> ",
      "paste> ",
      "paste> ",
      "paste> ",
      "paste> ",
      "paste> ",
    ]);
    expect(interfaceHandle.getPrompt()).toBe("machdoch> ");
    expect(notices).toEqual([
      "Paste task text. Finish with a line containing only /end.",
    ]);
  });
});
