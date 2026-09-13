import type { ProductSession, ProductShell } from "@machdoch/fleet-protocol";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Composer } from "./composer";
import type { ProductCommandHandler } from "./product-runtime";
import { createComposerDraftStore } from "./use-composer-draft";

vi.mock("./responsive-layout", () => ({ useMediaQuery: () => false }));

function composer(
  sessionId: string,
  draft = "",
): NonNullable<ProductShell["composer"]> {
  return {
    sessionId,
    draft,
    provider: "openai",
    providerLabel: "OpenAI",
    model: "model",
    modelLabel: "Model",
    modelCatalogLoading: false,
    modelCatalog: [],
    mode: "machdoch",
    defaultMode: "machdoch",
    reasoning: "default",
    defaultReasoning: "default",
    reasoningOptions: ["default"],
    promptEnhancementMode: "off",
    interviewEnabled: false,
    interviewAvailable: true,
    workspaceLabel: "Workspace",
    canSend: true,
    isExecuting: false,
    sessionMemoryEnabled: false,
    sessionMemory: [],
    globalMemoryAvailable: false,
    globalMemoryEnabled: false,
    uiControlAvailable: false,
    uiControlEnabled: false,
    uiControlDescription: "",
    attachments: [],
    chooserProviders: [],
    matchedContextPackIds: [],
  };
}

function session(id: string): ProductSession {
  return {
    id,
    title: id,
    status: "idle",
    provider: "openai",
    model: "model",
    effectiveMode: "machdoch",
    createdAt: 1,
    updatedAt: 1,
    tags: [],
    messageCount: 0,
    promptHistoryCount: 0,
    attachmentCount: 0,
    canRename: true,
    canDelete: true,
    canArchive: true,
    canPin: true,
    canDuplicate: true,
    canBranch: true,
  };
}

function deferred() {
  let resolve!: (value: boolean) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<boolean>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const flush = async () => {
  await act(async () => {});
};
const input = () =>
  screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Task composer" });
const type = (value: string) =>
  fireEvent.change(input(), { target: { value } });
const send = async () => {
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await flush();
};

function harness(
  onCommand: ProductCommandHandler = vi.fn().mockResolvedValue(true),
  initial = "",
  options: {
    pending?: boolean;
    canSend?: boolean;
    runningTaskId?: string;
    canCancel?: boolean;
  } = {},
) {
  const drafts = createComposerDraftStore();
  const element = (
    id: string,
    draft: string,
    pending = options.pending ?? false,
  ) => (
    <Composer
      drafts={drafts}
      canCancel={options.canCancel ?? false}
      composer={{ ...composer(id, draft), canSend: options.canSend ?? true }}
      session={{
        ...session(id),
        ...(options.runningTaskId
          ? { runningTaskId: options.runningTaskId }
          : {}),
      }}
      contextPacks={[]}
      workspaces={[]}
      webSearchAvailable={false}
      pending={pending}
      onCommand={onCommand}
    />
  );
  const view = render(element("A", initial));
  return {
    hide: () => view.rerender(<div />),
    show: (id: string, draft = "", pending = options.pending ?? false) =>
      view.rerender(element(id, draft, pending)),
    onCommand,
  };
}

beforeEach(() => {
  vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("composer submission guards", () => {
  it("checks the current pointer before sending even before the responsive state updates", async () => {
    const onCommand = vi.fn<ProductCommandHandler>().mockResolvedValue(true);
    harness(onCommand, "Touch draft");
    vi.mocked(window.matchMedia).mockReturnValue({
      matches: true,
    } as MediaQueryList);
    expect(fireEvent.keyDown(input(), { key: "Enter" })).toBe(true);
    await flush();
    expect(input().value).toBe("Touch draft");
    expect(onCommand).not.toHaveBeenCalled();
  });

  it.each(["Add to draft", "Discard"])(
    "retains a failed message separately through view changes until %s",
    async (action) => {
      const submission = deferred();
      const onCommand = vi.fn<ProductCommandHandler>((command) =>
        command.kind === "submit-message"
          ? submission.promise
          : Promise.resolve(true),
      );
      const view = harness(onCommand, "Original message");
      await send();
      type("Next message");
      view.hide();
      await act(async () => submission.resolve(false));
      view.show("B");
      expect(screen.queryByText("Message not sent")).toBeNull();
      view.show("A");
      expect(input().value).toBe("Next message");
      expect(screen.getByRole("alert").textContent).toContain(
        "Original message",
      );
      expect(
        screen.getByRole<HTMLButtonElement>("button", { name: "Send message" })
          .disabled,
      ).toBe(true);
      await send();
      expect(
        onCommand.mock.calls.filter(
          ([command]) => command.kind === "submit-message",
        ),
      ).toHaveLength(1);
      fireEvent.click(screen.getByRole("button", { name: action }));
      await flush();
      expect(document.activeElement).toBe(input());
      const recovered =
        action === "Add to draft"
          ? "Original message\n\nNext message"
          : "Next message";
      expect(input().value).toBe(recovered);
      expect(screen.queryByText("Message not sent")).toBeNull();
      expect(
        screen.getByRole<HTMLButtonElement>("button", { name: "Send message" })
          .disabled,
      ).toBe(false);
      view.hide();
      view.show("A");
      expect(input().value).toBe(recovered);
    },
  );

  it("stops the current task without submitting or clearing a follow-up draft", async () => {
    const onCommand = vi.fn<ProductCommandHandler>().mockResolvedValue(true);
    harness(onCommand, "Keep this follow-up", {
      runningTaskId: "task-active",
      canCancel: true,
    });
    fireEvent.click(screen.getByRole("button", { name: "Stop task" }));
    await flush();
    expect(onCommand.mock.calls).toEqual([
      [{ kind: "cancel", taskId: "task-active" }],
    ]);
    expect(input().value).toBe("Keep this follow-up");
  });

  it("does not offer cancellation for a task the host cannot cancel", () => {
    harness(undefined, "Draft", { runningTaskId: "task-active" });
    expect(screen.queryByRole("button", { name: "Stop task" })).toBeNull();
  });
  it("leaves composition confirmation alone until composition ends", async () => {
    const onCommand = vi.fn<ProductCommandHandler>().mockResolvedValue(true);
    harness(onCommand, "Draft");
    fireEvent.compositionStart(input());
    fireEvent.compositionUpdate(input(), { data: "日本" });
    type("日本");
    expect(
      fireEvent.keyDown(input(), { key: "Enter", isComposing: false }),
    ).toBe(true);
    await flush();
    expect(
      onCommand.mock.calls.filter(
        ([command]) => command.kind === "submit-message",
      ),
    ).toHaveLength(0);
    expect(input().value).toBe("日本");
    fireEvent.compositionEnd(input(), { data: "日本" });
    fireEvent.keyDown(input(), { key: "Enter" });
    await flush();
    expect(
      onCommand.mock.calls.filter(
        ([command]) => command.kind === "submit-message",
      ),
    ).toHaveLength(1);
  });

  it.each([{ isComposing: true }, { keyCode: 229 }])(
    "leaves native IME Enter alone (%j)",
    async (event) => {
      const onCommand = vi.fn<ProductCommandHandler>().mockResolvedValue(true);
      harness(onCommand, "日本");
      expect(fireEvent.keyDown(input(), { key: "Enter", ...event })).toBe(true);
      await flush();
      expect(onCommand).not.toHaveBeenCalled();
      expect(input().value).toBe("日本");
    },
  );

  it.each(["keyboard", "button"])(
    "blocks %s submission while an external command is pending",
    async (action) => {
      const onCommand = vi.fn<ProductCommandHandler>().mockResolvedValue(true);
      const view = harness(onCommand, "Draft", { pending: true });
      const button = screen.getByRole<HTMLButtonElement>("button", {
        name: "Send message",
      });
      expect(button.disabled).toBe(true);
      if (action === "keyboard") fireEvent.keyDown(input(), { key: "Enter" });
      else fireEvent.click(button);
      await flush();
      expect(onCommand).not.toHaveBeenCalled();
      expect(input().value).toBe("Draft");
      view.show("A", "Draft", false);
      fireEvent.keyDown(input(), { key: "Enter" });
      await flush();
      expect(
        onCommand.mock.calls.filter(
          ([command]) => command.kind === "submit-message",
        ),
      ).toHaveLength(1);
    },
  );

  it("submits ordinary Enter exactly once for repeated events before rerender", async () => {
    const onCommand = vi.fn<ProductCommandHandler>().mockResolvedValue(true);
    harness(onCommand, "  Draft\n");
    act(() => {
      fireEvent.keyDown(input(), { key: "Enter" });
      fireEvent.keyDown(input(), { key: "Enter", repeat: true });
    });
    await flush();
    expect(
      onCommand.mock.calls.filter(
        ([command]) => command.kind === "submit-message",
      ),
    ).toEqual([
      [
        {
          kind: "submit-message",
          sessionId: "A",
          prompt: "Draft",
          promptEnhancementMode: "off",
          interviewEnabled: false,
        },
      ],
    ]);
    expect(input().value).toBe("");
  });

  it.each(["keyboard", "button"])(
    "blocks %s activation of a new draft before rerender and while submission is queued",
    async (action) => {
      const write = deferred();
      const submission = deferred();
      const onCommand = vi.fn<ProductCommandHandler>((command) => {
        if (command.kind === "submit-message") return submission.promise;
        if (command.kind === "update-draft" && command.prompt === "First")
          return write.promise;
        return Promise.resolve(true);
      });
      harness(onCommand, "Initial");
      type("First");
      await flush();
      const textarea = input();
      const button = screen.getByRole<HTMLButtonElement>("button", {
        name: "Send message",
      });
      act(() => {
        fireEvent.keyDown(textarea, { key: "Enter" });
        fireEvent.change(textarea, { target: { value: "Second" } });
        if (action === "keyboard")
          fireEvent.keyDown(textarea, { key: "Enter", repeat: true });
        else fireEvent.click(button);
      });
      expect(input().value).toBe("Second");
      expect(button.disabled).toBe(true);
      fireEvent.keyDown(input(), { key: "Enter" });
      fireEvent.click(button);
      await act(async () => {
        write.resolve(true);
      });
      expect(
        onCommand.mock.calls.filter(
          ([command]) => command.kind === "submit-message",
        ),
      ).toHaveLength(1);
      await act(async () => {
        submission.resolve(true);
      });
      expect(
        onCommand.mock.calls.filter(
          ([command]) => command.kind === "submit-message",
        ),
      ).toHaveLength(1);
      expect(input().value).toBe("Second");
      expect(button.disabled).toBe(false);
      await send();
      expect(
        onCommand.mock.calls.filter(
          ([command]) => command.kind === "submit-message",
        ),
      ).toHaveLength(2);
    },
  );

  it.each([false, "reject"])(
    "unlocks recovered text after submission settles (%s)",
    async (result) => {
      const submission = deferred();
      const onCommand = vi.fn<ProductCommandHandler>((command) =>
        command.kind === "submit-message"
          ? submission.promise
          : Promise.resolve(true),
      );
      harness(onCommand, "Draft");
      fireEvent.keyDown(input(), { key: "Enter" });
      await flush();
      await act(async () => {
        if (result === "reject") submission.reject(new Error("Send failed."));
        else submission.resolve(false);
      });
      expect(input().value).toBe("Draft");
      onCommand.mockResolvedValue(true);
      await send();
      expect(
        onCommand.mock.calls.filter(
          ([command]) => command.kind === "submit-message",
        ),
      ).toHaveLength(2);
    },
  );

  it("keeps submission locked across session switches until the original request settles", async () => {
    const submission = deferred();
    const onCommand = vi.fn<ProductCommandHandler>((command) =>
      command.kind === "submit-message"
        ? submission.promise
        : Promise.resolve(true),
    );
    const view = harness(onCommand, "Draft A");
    await send();
    view.show("B", "Draft B");
    fireEvent.keyDown(input(), { key: "Enter" });
    await send();
    expect(input().value).toBe("Draft B");
    expect(
      onCommand.mock.calls.filter(
        ([command]) => command.kind === "submit-message",
      ),
    ).toHaveLength(1);
    await act(async () => {
      submission.resolve(false);
    });
    expect(input().value).toBe("Draft B");
    view.show("A");
    expect(input().value).toBe("Draft A");
    view.show("B", "Draft B");
    onCommand.mockResolvedValue(true);
    await send();
    expect(
      onCommand.mock.calls.filter(
        ([command]) => command.kind === "submit-message",
      ),
    ).toHaveLength(2);
  });

  it.each(["shiftKey", "ctrlKey", "metaKey", "altKey"])(
    "preserves default editing for Enter with %s",
    async (modifier) => {
      const onCommand = vi.fn<ProductCommandHandler>().mockResolvedValue(true);
      harness(onCommand, "Draft");
      expect(
        fireEvent.keyDown(input(), { key: "Enter", [modifier]: true }),
      ).toBe(true);
      if (modifier === "shiftKey") {
        type("Draft\n");
        expect(input().value).toBe("Draft\n");
      }
      await flush();
      expect(
        onCommand.mock.calls.filter(
          ([command]) => command.kind === "submit-message",
        ),
      ).toHaveLength(0);
    },
  );

  it.each([
    { draft: "", canSend: true },
    { draft: " \n\t", canSend: true },
    { draft: "Draft", canSend: false },
  ])("does not submit an ineligible draft (%j)", async ({ draft, canSend }) => {
    const onCommand = vi.fn<ProductCommandHandler>().mockResolvedValue(true);
    harness(onCommand, draft, { canSend });
    fireEvent.keyDown(input(), { key: "Enter" });
    await send();
    expect(onCommand).not.toHaveBeenCalled();
    expect(input().value).toBe(draft);
  });
});

describe("session composer drafts", () => {
  it("keeps a failed original available across views and adds it before the follow-up without sending", async () => {
    const submission = deferred();
    const onCommand = vi.fn<ProductCommandHandler>((command) =>
      command.kind === "submit-message"
        ? submission.promise
        : Promise.resolve(true),
    );
    const view = harness(onCommand, "  Original\n");
    await send();
    type("Follow-up");
    await act(async () => submission.resolve(false));
    view.hide();
    view.show("B", "Other session");
    expect(screen.queryByText("Message not sent")).toBeNull();
    view.show("A");
    expect(screen.getByText("Message not sent")).toBeTruthy();
    expect(input().value).toBe("Follow-up");
    await send();
    expect(
      onCommand.mock.calls.filter(
        ([command]) => command.kind === "submit-message",
      ),
    ).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Add to draft" }));
    await flush();
    expect(input().value).toBe("  Original\n\n\nFollow-up");
    expect(document.activeElement).toBe(input());
    expect(onCommand).toHaveBeenLastCalledWith({
      kind: "update-draft",
      sessionId: "A",
      prompt: "  Original\n\n\nFollow-up",
    });
    expect(screen.queryByText("Message not sent")).toBeNull();
  });

  it("discards a failed original without erasing the newer draft and permits its submission", async () => {
    const submission = deferred();
    const onCommand = vi.fn<ProductCommandHandler>((command) =>
      command.kind === "submit-message"
        ? submission.promise
        : Promise.resolve(true),
    );
    harness(onCommand, "Original");
    await send();
    type("Follow-up");
    await act(async () => submission.reject(new Error("Request failed")));
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(input().value).toBe("Follow-up");
    expect(screen.queryByRole("alert")).toBeNull();
    onCommand.mockResolvedValue(true);
    await send();
    expect(
      onCommand.mock.calls
        .filter(([command]) => command.kind === "submit-message")
        .at(-1)?.[0],
    ).toMatchObject({ prompt: "Follow-up" });
  });

  it("restores a failed submission after leaving and reopening the chat view", async () => {
    const submission = deferred();
    const onCommand = vi.fn<ProductCommandHandler>((command) =>
      command.kind === "submit-message"
        ? submission.promise
        : Promise.resolve(true),
    );
    const view = harness(onCommand, "Recover this message");
    await send();
    view.hide();
    view.show("A");
    expect(input().value).toBe("");
    await act(async () => submission.resolve(false));
    expect(input().value).toBe("Recover this message");
  });

  it("keeps a submission blocked across view changes while a draft save is pending", async () => {
    const save = deferred();
    const onCommand = vi.fn<ProductCommandHandler>((command) =>
      command.kind === "update-draft" ? save.promise : Promise.resolve(true),
    );
    const view = harness(onCommand);
    type("First draft");
    await flush();
    await send();
    view.hide();
    view.show("A");
    type("Next message");
    await send();
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Send message" })
        .disabled,
    ).toBe(true);
    await act(async () => save.resolve(true));
    expect(
      onCommand.mock.calls.filter(
        ([command]) => command.kind === "submit-message",
      ),
    ).toHaveLength(1);
    expect(input().value).toBe("Next message");
  });

  it("keeps an unsaved draft when leaving and returning to the chat view", async () => {
    const view = harness(vi.fn().mockResolvedValue(false));
    type("Offline draft");
    await flush();
    view.hide();
    view.show("A", "Old server draft");
    expect(input().value).toBe("Offline draft");
  });
  it("coalesces superseded draft writes behind a slow request", async () => {
    const first = deferred();
    const onCommand = vi
      .fn<ProductCommandHandler>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue(true);
    harness(onCommand);
    type("First");
    await flush();
    type("Second");
    type("Third");
    type("Latest");
    await act(async () => first.resolve(true));
    expect(
      onCommand.mock.calls.map(([command]) =>
        command.kind === "update-draft" ? command.prompt : command.kind,
      ),
    ).toEqual(["First", "Latest"]);
    expect(input().value).toBe("Latest");
  });
  it("retains distinct session drafts while snapshots lag behind typing", async () => {
    const view = harness();
    type("Draft A");
    view.show("B");
    type("Draft B");
    view.show("A");
    expect(input().value).toBe("Draft A");
    view.show("B");
    expect(input().value).toBe("Draft B");
    await flush();
  });

  it("persists exact text with the session where it was typed", async () => {
    const view = harness();
    type("  Draft A\n");
    view.show("B");
    type("Draft B");
    await flush();
    expect(view.onCommand).toHaveBeenCalledWith({
      kind: "update-draft",
      sessionId: "A",
      prompt: "  Draft A\n",
    });
    expect(view.onCommand).toHaveBeenCalledWith({
      kind: "update-draft",
      sessionId: "B",
      prompt: "Draft B",
    });
  });

  it.each(["", "Draft B"])(
    "recovers a failed submission in A without changing B (%j)",
    async (draftB) => {
      const submission = deferred();
      const onCommand = vi.fn<ProductCommandHandler>((command) =>
        command.kind === "submit-message"
          ? submission.promise
          : Promise.resolve(true),
      );
      const view = harness(onCommand);
      type("  Draft A\n");
      await send();
      view.show("B", draftB);
      await act(async () => {
        submission.resolve(false);
      });
      expect(input().value).toBe(draftB);
      view.show("A");
      expect(input().value).toBe("  Draft A\n");
      expect(onCommand).toHaveBeenLastCalledWith({
        kind: "update-draft",
        sessionId: "A",
        prompt: "  Draft A\n",
      });
    },
  );

  it.each([false, true])(
    "preserves edits made during submission when success is %s",
    async (succeeded) => {
      const submission = deferred();
      const onCommand = vi.fn<ProductCommandHandler>((command) =>
        command.kind === "submit-message"
          ? submission.promise
          : Promise.resolve(true),
      );
      const view = harness(onCommand);
      type("Original");
      await send();
      type("New draft");
      await act(async () => {
        submission.resolve(succeeded);
      });
      expect(input().value).toBe("New draft");
      view.show("B");
      view.show("A", "Original");
      expect(input().value).toBe("New draft");
      expect(onCommand).toHaveBeenLastCalledWith({
        kind: "update-draft",
        sessionId: "A",
        prompt: "New draft",
      });
    },
  );

  it("does not restore a failed draft after a newer edit was deliberately erased", async () => {
    const submission = deferred();
    const view = harness((command) =>
      command.kind === "submit-message"
        ? submission.promise
        : Promise.resolve(true),
    );
    type("Original");
    await send();
    type("New draft");
    type("");
    await act(async () => {
      submission.resolve(false);
    });
    expect(input().value).toBe("");
    view.show("B");
    view.show("A", "Original");
    expect(input().value).toBe("");
  });

  it("clears a successful revision without resurrecting delayed snapshots", async () => {
    const submission = deferred();
    const onCommand = vi.fn<ProductCommandHandler>((command) =>
      command.kind === "submit-message"
        ? submission.promise
        : Promise.resolve(true),
    );
    const view = harness(onCommand, "Original");
    await send();
    view.show("B", "Draft B");
    await act(async () => {
      submission.resolve(true);
    });
    expect(input().value).toBe("Draft B");
    view.show("A", "Original");
    expect(input().value).toBe("");
    view.show("A", "");
    view.show("A", "Original");
    expect(input().value).toBe("");
    expect(onCommand).toHaveBeenLastCalledWith({
      kind: "update-draft",
      sessionId: "A",
      prompt: "",
    });
  });

  it("preserves a newer revision even when its text equals the submitted text", async () => {
    const submission = deferred();
    const onCommand = vi.fn<ProductCommandHandler>((command) =>
      command.kind === "submit-message"
        ? submission.promise
        : Promise.resolve(true),
    );
    harness(onCommand, "Original");
    await send();
    type("Original");
    await act(async () => {
      submission.resolve(true);
    });
    expect(input().value).toBe("Original");
    expect(onCommand).toHaveBeenLastCalledWith({
      kind: "update-draft",
      sessionId: "A",
      prompt: "Original",
    });
  });

  it("orders delayed draft writes before submission and its final clear", async () => {
    const write = deferred();
    const submission = deferred();
    let storedDraft = "";
    const onCommand = vi.fn<ProductCommandHandler>(async (command) => {
      if (command.kind === "submit-message") return submission.promise;
      if (command.kind === "update-draft") {
        if (command.prompt === "First") await write.promise;
        storedDraft = command.prompt;
      }
      return true;
    });
    const view = harness(onCommand);
    type("First");
    await flush();
    type("Second");
    await send();
    expect(onCommand.mock.calls.map(([command]) => command.kind)).toEqual([
      "update-draft",
    ]);
    await act(async () => {
      write.resolve(true);
    });
    expect(onCommand).toHaveBeenLastCalledWith({
      kind: "submit-message",
      sessionId: "A",
      prompt: "Second",
      promptEnhancementMode: "off",
      interviewEnabled: false,
    });
    await act(async () => {
      submission.resolve(true);
    });
    expect(storedDraft).toBe("");
    view.show("B");
    view.show("A", "Second");
    expect(input().value).toBe("");
  });

  it("recovers a rejected submission and exposes its error in the originating session", async () => {
    const submission = deferred();
    const view = harness(
      (command) =>
        command.kind === "submit-message"
          ? submission.promise
          : Promise.resolve(true),
      "  Original\n",
    );
    await send();
    view.show("B");
    await act(async () => {
      submission.reject(new Error("Submission failed."));
    });
    expect(input().value).toBe("");
    expect(screen.queryByRole("alert")).toBeNull();
    view.show("A");
    expect(input().value).toBe("  Original\n");
    expect(screen.getByRole("alert").textContent).toBe("Submission failed.");
  });

  it.each([false, true])(
    "saves B independently while A is submitting when success is %s",
    async (succeeded) => {
      const submission = deferred();
      const onCommand = vi.fn<ProductCommandHandler>((command) =>
        command.kind === "submit-message"
          ? submission.promise
          : Promise.resolve(true),
      );
      const view = harness(onCommand, "Draft A");
      await send();
      view.show("B");
      type("Draft B");
      await flush();
      expect(onCommand).toHaveBeenLastCalledWith({
        kind: "update-draft",
        sessionId: "B",
        prompt: "Draft B",
      });
      await act(async () => {
        submission.resolve(succeeded);
      });
      expect(input().value).toBe("Draft B");
      view.show("A", "Draft A");
      expect(input().value).toBe(succeeded ? "" : "Draft A");
      view.show("B");
      expect(input().value).toBe("Draft B");
    },
  );

  it("preserves edits made after returning to a session before its submission fails", async () => {
    const submission = deferred();
    const onCommand = vi.fn<ProductCommandHandler>((command) =>
      command.kind === "submit-message"
        ? submission.promise
        : Promise.resolve(true),
    );
    const view = harness(onCommand, "Original");
    await send();
    view.show("B", "Draft B");
    view.show("A", "Original");
    expect(input().value).toBe("");
    type("New draft");
    await act(async () => {
      submission.resolve(false);
    });
    expect(input().value).toBe("New draft");
    expect(onCommand).toHaveBeenLastCalledWith({
      kind: "update-draft",
      sessionId: "A",
      prompt: "New draft",
    });
  });

  it("orders newer edits after a delayed successful submission clear", async () => {
    const clear = deferred();
    let storedDraft = "Original";
    const onCommand = vi.fn<ProductCommandHandler>(async (command) => {
      if (command.kind === "update-draft") {
        if (command.prompt === "") await clear.promise;
        storedDraft = command.prompt;
      }
      return true;
    });
    const view = harness(onCommand, "Original");
    await send();
    expect(onCommand).toHaveBeenLastCalledWith({
      kind: "update-draft",
      sessionId: "A",
      prompt: "",
    });
    type("New draft");
    view.show("B");
    view.show("A", "Original");
    expect(input().value).toBe("New draft");
    await act(async () => {
      clear.resolve(true);
    });
    expect(storedDraft).toBe("New draft");
    view.show("A", "");
    expect(input().value).toBe("New draft");
    expect(onCommand).toHaveBeenLastCalledWith({
      kind: "update-draft",
      sessionId: "A",
      prompt: "New draft",
    });
  });

  it("retains text after a rejected draft write and allows the next write to complete", async () => {
    const write = deferred();
    const onCommand = vi
      .fn<ProductCommandHandler>()
      .mockReturnValueOnce(write.promise)
      .mockResolvedValue(true);
    const view = harness(onCommand);
    type("First");
    await flush();
    await act(async () => {
      write.reject(new Error("Save failed."));
    });
    view.show("B");
    view.show("A");
    expect(input().value).toBe("First");
    expect(screen.getByRole("alert").textContent).toBe("Save failed.");
    type("Second");
    await flush();
    expect(onCommand).toHaveBeenLastCalledWith({
      kind: "update-draft",
      sessionId: "A",
      prompt: "Second",
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
