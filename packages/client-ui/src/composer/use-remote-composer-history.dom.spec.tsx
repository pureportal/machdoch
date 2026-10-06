import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  act,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ProductAttachment } from "@machdoch/fleet-protocol";
import type { RemoteComposerProps } from "@machdoch/product-ui";
import {
  createComposerDraftStore,
  useComposerDraft,
} from "@machdoch/product-ui/composer-controls";
import { useRemoteComposerHistory } from "./use-remote-composer-history";

const original: ProductAttachment = {
  id: "original",
  source: "path",
  kind: "file",
  name: "Current.md",
  path: "C:/Fixture/Current.md",
};
const first: ProductAttachment = {
  id: "first",
  source: "path",
  kind: "directory",
  name: "Notes",
  path: "C:/Fixture/Notes",
};
const second: ProductAttachment = {
  id: "second",
  source: "media-asset",
  kind: "image",
  name: "Pose",
  assetId: "11111111-1111-4111-8111-111111111111",
  workspaceRoot: "C:/Fixture",
};

function props(): RemoteComposerProps {
  return {
    session: {
      id: "history-session",
      title: "History",
      status: "idle",
      workspace: "C:/Fixture",
      provider: "openai",
      model: "model",
      effectiveMode: "ask",
      createdAt: 1,
      updatedAt: 1,
      tags: [],
      messageCount: 0,
      promptHistoryCount: 2,
      attachmentCount: 1,
      canRename: true,
      canDelete: true,
      canArchive: true,
      canPin: true,
      canDuplicate: true,
      canBranch: true,
    },
    composer: {
      sessionId: "history-session",
      draft: "Current unsaved task 🌿",
      attachments: [original],
      provider: "openai",
      providerLabel: "OpenAI",
      model: "model",
      modelLabel: "Model",
      modelCatalogLoading: false,
      modelCatalog: [],
      mode: "ask",
      defaultMode: "ask",
      reasoning: "default",
      defaultReasoning: "default",
      reasoningOptions: ["default"],
      promptEnhancementMode: "off",
      interviewEnabled: false,
      interviewAvailable: false,
      workspaceLabel: "Fixture",
      canSend: true,
      isExecuting: false,
      sessionMemoryEnabled: false,
      sessionMemory: [],
      globalMemoryAvailable: false,
      globalMemoryEnabled: false,
      uiControlAvailable: false,
      uiControlEnabled: false,
      uiControlDescription: "",
      chooserProviders: [],
      matchedContextPackIds: [],
      history: [
        { index: 4, prompt: "Earlier prompt", attachments: [first] },
        { index: 5, prompt: "Latest prompt 🌿", attachments: [second] },
      ],
    },
    drafts: createComposerDraftStore(),
    onCommand: vi.fn().mockResolvedValue(true),
    pending: false,
    contextPacks: [],
    workspaces: [],
    webSearchAvailable: false,
    canCancel: false,
  };
}

let controls: ReturnType<typeof useRemoteComposerHistory>;
function Harness(properties: RemoteComposerProps) {
  controls = useRemoteComposerHistory(properties);
  const draft = useComposerDraft(
    controls.composer,
    controls.execute,
    properties.drafts,
  );
  return (
    <>
      <textarea
        aria-label="Task"
        value={draft.draft}
        onChange={(event) => draft.updateDraft(event.target.value)}
        onKeyDown={(event) =>
          controls.handleKeyDown(event, event.currentTarget.value)
        }
      />
      <output aria-label="Attachments">
        {controls.composer.attachments.map(({ name }) => name).join(", ")}
      </output>
    </>
  );
}

afterEach(() => cleanup());
const input = () =>
  screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Task" });
async function key(key: string, expected: string) {
  input().setSelectionRange(0, 0);
  fireEvent.keyDown(input(), { key });
  await waitFor(() => expect(input().value).toBe(expected));
}

it("previews historical prompts and their attachments without persisting them, then restores the original draft", async () => {
  const properties = props();
  render(<Harness {...properties} />);
  await key("ArrowUp", "Latest prompt 🌿");
  expect(screen.getByRole("status", { name: "Attachments" }).textContent).toBe(
    "Pose",
  );
  await key("ArrowUp", "Earlier prompt");
  expect(screen.getByRole("status", { name: "Attachments" }).textContent).toBe(
    "Notes",
  );
  await key("ArrowDown", "Latest prompt 🌿");
  await key("ArrowDown", properties.composer.draft);
  expect(screen.getByRole("status", { name: "Attachments" }).textContent).toBe(
    "Current.md",
  );
  expect(properties.onCommand).not.toHaveBeenCalled();
});

it("commits an edited history preview and its native context before persisting the edit", async () => {
  const properties = props();
  render(<Harness {...properties} />);
  await key("ArrowUp", "Latest prompt 🌿");
  fireEvent.change(input(), { target: { value: "Edited history 🌿\n" } });
  await waitFor(() => expect(properties.onCommand).toHaveBeenCalledTimes(1));
  expect(properties.onCommand).toHaveBeenCalledWith({
    kind: "restore-prompt-history",
    sessionId: "history-session",
    prompt: "Edited history 🌿\n",
    history: {
      index: 5,
      prompt: "Latest prompt 🌿",
      attachmentIds: [second.id],
      previousDraft: properties.composer.draft,
      previousAttachmentIds: [original.id],
    },
  });
  expect(input().value).toBe("Edited history 🌿\n");
});

it("waits for draft persistence and preserves a newer edit while history navigation is waiting", async () => {
  const properties = props();
  let complete!: () => void;
  const entry = {
    text: properties.composer.draft,
    revision: 1,
    pending: new Promise<void>((resolve) => {
      complete = resolve;
    }),
    error: null,
    failedSubmission: null,
  };
  properties.drafts.sessions.set(properties.session.id, entry);
  render(<Harness {...properties} />);
  input().setSelectionRange(0, 0);
  fireEvent.keyDown(input(), { key: "ArrowUp" });
  await act(async () => {});
  expect(input().value).toBe(properties.composer.draft);
  entry.text = "Newer edit";
  entry.revision += 1;
  await act(async () => {
    properties.drafts.changed();
    complete();
  });
  expect(input().value).toBe("Newer edit");
  expect(properties.onCommand).not.toHaveBeenCalled();
});

it("rejects the dependent action when native history restoration fails", async () => {
  const properties = props();
  vi.mocked(properties.onCommand).mockResolvedValue(false);
  render(<Harness {...properties} />);
  await key("ArrowUp", "Latest prompt 🌿");
  let accepted;
  await act(async () => {
    accepted = await controls.execute({
      kind: "clear-attachments",
      sessionId: properties.session.id,
    });
  });
  expect(accepted).toBe(false);
  expect(properties.onCommand).toHaveBeenCalledTimes(1);
  expect(
    properties.drafts.sessions.get(properties.session.id)?.error,
  ).toContain("Select the prompt again");
  expect(input().value).toBe("Latest prompt 🌿");
});

it("shares one pending native restore and persists a newer concurrent edit afterward", async () => {
  const properties = props();
  let complete!: (accepted: boolean) => void;
  vi.mocked(properties.onCommand).mockImplementation((command) =>
    command.kind === "restore-prompt-history"
      ? new Promise<boolean>((resolve) => {
          complete = resolve;
        })
      : Promise.resolve(true),
  );
  render(<Harness {...properties} />);
  await key("ArrowUp", "Latest prompt 🌿");
  const first = controls.execute({
    kind: "update-draft",
    sessionId: properties.session.id,
    prompt: "First edit",
  });
  const second = controls.execute({
    kind: "update-draft",
    sessionId: properties.session.id,
    prompt: "Newer edit",
  });
  expect(properties.onCommand).toHaveBeenCalledTimes(1);
  await act(async () => {
    complete(true);
    await Promise.all([first, second]);
  });
  expect(properties.onCommand).toHaveBeenLastCalledWith({
    kind: "update-draft",
    sessionId: properties.session.id,
    prompt: "Newer edit",
  });
  expect(properties.onCommand).toHaveBeenCalledTimes(2);
});

it("discards a pure preview on session changes and restores its saved browser draft", async () => {
  const properties = props();
  const view = render(<Harness {...properties} />);
  await key("ArrowUp", "Latest prompt 🌿");
  view.rerender(
    <Harness
      {...properties}
      session={{ ...properties.session, id: "next-session" }}
      composer={{
        ...properties.composer,
        sessionId: "next-session",
        draft: "Next draft",
      }}
    />,
  );
  expect(input().value).toBe("Next draft");
  expect(properties.drafts.sessions.get(properties.session.id)?.text).toBe(
    properties.composer.draft,
  );
  expect(properties.onCommand).not.toHaveBeenCalled();
});

it("keeps cursor movement and IME input out of prompt history", async () => {
  const properties = props();
  render(<Harness {...properties} />);
  input().setSelectionRange(3, 3);
  fireEvent.keyDown(input(), { key: "ArrowUp" });
  input().setSelectionRange(0, 0);
  fireEvent.keyDown(input(), { key: "ArrowUp", isComposing: true });
  await act(async () => {});
  expect(input().value).toBe(properties.composer.draft);
});

it("restores the original browser draft when leaving a pure history preview", async () => {
  const properties = props();
  const view = render(<Harness {...properties} />);
  await key("ArrowUp", "Latest prompt 🌿");
  view.unmount();
  expect(properties.drafts.sessions.get(properties.session.id)?.text).toBe(
    properties.composer.draft,
  );
  expect(properties.onCommand).not.toHaveBeenCalled();
});

it("discards a pure preview when another client changes the native draft and context", async () => {
  const properties = props();
  const view = render(<Harness {...properties} />);
  await key("ArrowUp", "Latest prompt 🌿");
  view.rerender(<Harness {...properties} composer={{ ...properties.composer, draft: "Newer native draft", attachments: [first] }} />);
  expect(input().value).toBe("Newer native draft");
  expect(screen.getByRole("status", { name: "Attachments" }).textContent).toBe("Notes");
  expect(properties.onCommand).not.toHaveBeenCalled();
});

it("does not start a history preview after leaving while draft persistence is pending", async () => {
  const properties = props();
  let complete!: () => void;
  const entry = {
    text: properties.composer.draft,
    revision: 1,
    pending: new Promise<void>((resolve) => {
      complete = resolve;
    }),
    error: null,
    failedSubmission: null,
  };
  properties.drafts.sessions.set(properties.session.id, entry);
  const view = render(<Harness {...properties} />);
  input().setSelectionRange(0, 0);
  fireEvent.keyDown(input(), { key: "ArrowUp" });
  await act(async () => {});
  view.unmount();
  await act(async () => {
    complete();
  });
  expect(entry.text).toBe(properties.composer.draft);
  expect(properties.onCommand).not.toHaveBeenCalled();
});
