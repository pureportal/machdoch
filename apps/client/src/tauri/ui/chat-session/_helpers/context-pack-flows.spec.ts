import { describe, expect, it } from "vitest";
import type { SmartContextPack } from "@machdoch/client-ui/context-packs/model";
import { createSession } from "../../chat-session.model";
import {
  createContextPackFlowStepTask,
  createQueuedContextPackFlowSteps,
} from "./context-pack-flows";

const createPack = (
  overrides: Partial<SmartContextPack> = {},
): SmartContextPack => ({
  id: "pack-1",
  workspace: null,
  name: "Implement",
  instructions: "",
  prompt: "Implement [[task]] on {branch}.",
  contextAttachments: [],
  variables: [{ name: "branch" }],
  trigger: { phrases: [], pathPatterns: [] },
  createdAt: 1,
  updatedAt: 1,
  useCount: 0,
  ...overrides,
});

describe("context pack flows", () => {
  it("fills pack variables and inline placeholders from shared values", () => {
    expect(
      createContextPackFlowStepTask(createPack(), {
        task: "login",
        branch: "feature/login",
      }),
    ).toBe(
      "## Context Pack: Implement\n\n### Prompt\nImplement login on feature/login.",
    );
  });

  it("matches pack variables case-insensitively", () => {
    expect(
      createContextPackFlowStepTask(
        createPack({
          prompt: "Push {Branch}.",
          variables: [{ name: "Branch" }],
        }),
        { branch: "main" },
      ),
    ).toBe("## Context Pack: Implement\n\n### Prompt\nPush main.");
  });

  it("keeps a pack title when the pack only carries attachments", () => {
    expect(
      createContextPackFlowStepTask(
        createPack({
          prompt: "",
          variables: [],
          contextAttachments: [
            {
              id: "spec",
              source: "path",
              kind: "file",
              name: "spec.md",
              path: "C:\\Project\\spec.md",
            },
          ],
        }),
        {},
      ),
    ).toBe("## Context Pack: Implement");
  });

  it("queues ordered flow steps with per-pack settings", () => {
    const session = createSession({
      id: "session-1",
      provider: "openai",
      model: "gpt-5.5",
    });
    const attachment = {
      id: "plan",
      source: "path" as const,
      kind: "file" as const,
      name: "plan.md",
      path: "C:\\Project\\plan.md",
    };
    const messages = createQueuedContextPackFlowSteps({
      session,
      flowName: "Ship",
      steps: [
        {
          pack: createPack({ promptEnhancementMode: "simple" }),
          contextAttachments: [attachment],
        },
        {
          pack: createPack({
            id: "pack-2",
            name: "Commit",
            prompt: "Commit to {branch}.",
            mode: "machdoch",
            provider: "claude-cli",
            model: "claude-opus",
          }),
          contextAttachments: [],
        },
      ],
      valuesByLookupKey: { task: "login", branch: "main" },
      availableProviders: ["openai"],
      promptEnhancementMode: "off",
      orderRank: 3,
      timestamp: 10,
    });

    expect(messages).toHaveLength(2);
    expect(messages.map((message) => message.orderRank)).toEqual([3, 4]);
    expect(messages.map((message) => message.iteration)).toEqual([
      expect.objectContaining({ index: 1, total: 2, label: "Ship" }),
      expect.objectContaining({ index: 2, total: 2, label: "Ship" }),
    ]);
    expect(messages[0]?.iteration?.groupId).toBe(
      messages[1]?.iteration?.groupId,
    );
    expect(messages[0]?.iteration?.mode).toBeUndefined();
    expect(messages[0]?.promptEnhancementRequest).toEqual({ mode: "simple" });
    expect(messages[1]?.promptEnhancementRequest).toBeUndefined();
    expect(messages[1]?.task).toBe(
      "## Context Pack: Commit\n\n### Prompt\nCommit to main.",
    );
    expect(messages[1]?.settings).toEqual(
      expect.objectContaining({
        provider: "openai",
        model: "gpt-5.5",
        mode: "machdoch",
        promptEnhancementMode: "off",
      }),
    );
    expect(messages[0]?.contextAttachments).toEqual([
      { ...attachment, id: expect.any(String) },
    ]);
    expect(messages[0]?.contextAttachments[0]?.id).not.toBe(attachment.id);
    expect(messages.every((message) => message.status === "queued")).toBe(true);
  });
});
