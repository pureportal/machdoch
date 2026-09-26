import { createChatSession } from "./cli-chat-sessions.js";
import type {
  ConversationMemoryEntry,
  TaskConversationContext,
} from "../../core/types.ts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ParsedCliArgs } from "./cli-args.ts";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyContextPathsToTask,
  createImageInputsFromPaths,
  resolveConversationContext,
} from "./cli-task-run.ts";

const { probeCodexCliImageInput } = vi.hoisted(() => ({
  probeCodexCliImageInput: vi.fn<() => Promise<boolean | undefined>>(),
}));

vi.mock("./codex-cli-image-capability.js", () => ({
  probeCodexCliImageInput,
}));

const createMemoryEntry = (
  scope: ConversationMemoryEntry["scope"],
  content: string,
): ConversationMemoryEntry => {
  return {
    id: `${scope}-${content}`,
    scope,
    key: content.toLowerCase().replaceAll(" ", "-"),
    kind: "fact",
    content,
    searchTerms: [],
    importance: 3,
    confidence: 1,
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
      wasQueued: true,
      sessionId: "conversation-id",
      workspaceMemoryEnabled: false,
      workspace: { selection: "selected", root: "C:/workspace" },
      workspaceRun: {
        workspaceRoot: "C:/workspace",
        primaryConfigurationId: null,
        configurations: [],
      },
      sessionMemoryEnabled: true,
      sessionMemory: [createMemoryEntry("session", "Prefers concise output")],
      globalMemoryEnabled: false,
      globalMemory: [createMemoryEntry("global", "Uses Windows")],
    };

    await expect(
      resolveConversationContext(createArgs(), explicitContext),
    ).resolves.toEqual(explicitContext);
  });

  it.each([true, false])(
    "preserves queued status %s through the desktop context file",
    async (wasQueued) => {
      const workspaceRoot = await createWorkspace();
      const contextFile = join(workspaceRoot, "conversation.json");
      await writeFile(
        contextFile,
        JSON.stringify({ history: [], wasQueued }),
      );

      await expect(
        resolveConversationContext(
          createArgs({ conversationContextFile: contextFile }),
        ),
      ).resolves.toMatchObject({ history: [], wasQueued });
    },
  );

  it("keeps Pose chat type and scene when the desktop task reaches the CLI", async () => {
    const sessionId = "6b48f2b2-9b96-4567-aab3-e6423dbe482a";
    const poseScene = {
      aspectRatio: "1:1" as const,
      people: [
        {
          pose: "standing" as const,
          x: 0.5,
          y: 0.92,
          scale: 0.8,
          mirror: false,
        },
      ],
    };
    const context: TaskConversationContext = {
      history: [],
      sessionId,
      chatType: "pose",
      poseScene,
    };
    await expect(
      resolveConversationContext(createArgs(), context),
    ).resolves.toEqual(context);
    await expect(
      resolveConversationContext(createArgs(), {
        history: [],
        sessionId,
        chatType: "pose",
      }),
    ).resolves.toEqual({
      history: [],
      sessionId,
      chatType: "pose",
    });
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
  afterEach(() => {
    probeCodexCliImageInput.mockReset();
  });

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

  it("loads images for Copilot CLI provider-managed model selection", async () => {
    const workspaceRoot = await createWorkspace();

    await writeFile(join(workspaceRoot, "screen.png"), Buffer.from("image"));

    await expect(
      createImageInputsFromPaths(["screen.png"], workspaceRoot, {
        provider: "copilot-cli",
        model: "gpt-5.6-terra",
      }),
    ).resolves.toEqual([
      {
        path: join(workspaceRoot, "screen.png"),
        mediaType: "image/png",
        data: Buffer.from("image").toString("base64"),
      },
    ]);
  });

  it("loads images for GPT-6 Sol through Codex CLI", async () => {
    const workspaceRoot = await createWorkspace();
    probeCodexCliImageInput.mockResolvedValue(true);

    await writeFile(join(workspaceRoot, "screen.png"), Buffer.from("image"));

    await expect(
      createImageInputsFromPaths(["screen.png"], workspaceRoot, {
        provider: "codex-cli",
        model: "gpt-6-sol",
      }),
    ).resolves.toEqual([
      {
        path: join(workspaceRoot, "screen.png"),
        mediaType: "image/png",
        data: Buffer.from("image").toString("base64"),
      },
    ]);
    expect(probeCodexCliImageInput).toHaveBeenCalledWith(
      "gpt-6-sol",
      workspaceRoot,
    );
  });

  it("rejects images when Codex CLI reports a text-only model", async () => {
    const workspaceRoot = await createWorkspace();
    probeCodexCliImageInput.mockResolvedValue(false);
    await writeFile(join(workspaceRoot, "screen.png"), Buffer.from("image"));

    await expect(
      createImageInputsFromPaths(["screen.png"], workspaceRoot, {
        provider: "codex-cli",
        model: "gpt-6-astra",
      }),
    ).rejects.toThrow(
      "Codex CLI reports that `gpt-6-astra` does not support image input",
    );
  });

  it("lets Codex CLI validate images when its catalog has no modality metadata", async () => {
    const workspaceRoot = await createWorkspace();
    probeCodexCliImageInput.mockResolvedValue(undefined);
    await writeFile(join(workspaceRoot, "screen.png"), Buffer.from("image"));

    await expect(
      createImageInputsFromPaths(["screen.png"], workspaceRoot, {
        provider: "codex-cli",
        model: "new-codex-model",
      }),
    ).resolves.toHaveLength(1);
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

describe("createChatSession", () => {
  it("preserves seeded history, memory, and UI-control metadata", () => {
    const seededContext: TaskConversationContext = {
      history: [{ role: "user", content: "Continue from the previous run" }],
      sessionMemoryEnabled: false,
      sessionMemory: [createMemoryEntry("session", "Prefers terse answers")],
      globalMemoryEnabled: true,
      globalMemory: [createMemoryEntry("global", "Uses Windows")],
      uiControlEnabled: true,
      workspace: { selection: "selected", root: "C:/workspace" },
      workspaceRun: {
        workspaceRoot: "C:/workspace",
        primaryConfigurationId: null,
        configurations: [],
      },
      uiControl: {
        available: true,
        platform: "windows",
        supportsScreenshots: true,
        supportsWindowEnumeration: true,
        supportsInput: true,
        supportsWindowHandles: true,
      },
    };

    expect(
      createChatSession("C:/workspace", seededContext).context,
    ).toMatchObject({
      history: [{ role: "user", content: "Continue from the previous run" }],
      workspace: { selection: "selected", root: "C:/workspace" },
      workspaceRun: {
        workspaceRoot: "C:/workspace",
        primaryConfigurationId: null,
        configurations: [],
      },
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
    });
  });

  it("starts an empty conversation when no seed context exists", () => {
    expect(createChatSession("C:/workspace").context).toMatchObject({
      history: [],
      sessionMemory: [],
      sessionMemoryEnabled: true,
    });
  });
});
