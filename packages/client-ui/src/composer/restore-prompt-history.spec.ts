import { describe, expect, it } from "vitest";
import { resolvePromptHistoryRestore } from "./restore-prompt-history";

const original = { id: "current", path: "C:/Current.md" };
const recalled = {
  id: "recalled",
  assetId: "pose",
  workspaceRoot: "C:/Workspace",
};
const source = {
  draft: "Current task 🌿\n",
  draftContextAttachments: [original],
  promptHistory: ["Earlier request 🌿"],
  promptContextHistory: [[recalled]],
};
const history = {
  index: 0,
  prompt: source.promptHistory[0]!,
  attachmentIds: [recalled.id],
  previousDraft: source.draft,
  previousAttachmentIds: [original.id],
};

describe("native prompt history restoration", () => {
  it("restores the selected native attachments and preserves the edited draft exactly", () => {
    const result = resolvePromptHistoryRestore<{
      id: string;
      path?: string;
      assetId?: string;
      workspaceRoot?: string;
    }>(source, history, "  Edited 🌿\n\t");
    expect(result).toEqual({
      draft: "  Edited 🌿\n\t",
      draftContextAttachments: [recalled],
    });
    expect(result!.draftContextAttachments[0]).not.toBe(recalled);
    expect(source.draftContextAttachments).toEqual([original]);
  });

  it.each([
    { ...history, previousDraft: "Changed current task" },
    { ...history, previousAttachmentIds: [] },
    { ...history, attachmentIds: ["replaced-native-attachment"] },
    { ...history, prompt: "Changed historical request" },
    { ...history, index: 1 },
  ])("rejects stale composer or history state", (selection) => {
    expect(
      resolvePromptHistoryRestore<{ id: string }>(source, selection, "Edited"),
    ).toBeNull();
  });
});
