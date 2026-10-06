import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProductMessage, ProductSession } from "@machdoch/fleet-protocol";
import type { FilePreview } from "../file-preview/dialog";
import { RemoteConversationHost } from "./remote-conversation-host";
import { useOptionalRegisterCommands } from "@machdoch/media-studio/tauri/ui/commands/command-context.js";
import type {
  CommandDefinition,
  CommandContextSnapshot,
} from "@machdoch/media-studio/tauri/ui/commands/command-types.js";

vi.mock("@machdoch/media-studio/tauri/ui/commands/command-context.js", () => ({
  useOptionalRegisterCommands: vi.fn(),
}));

vi.mock("../file-preview/dialog", () => ({
  FilePreviewDialog: ({ preview }: { preview: FilePreview | null }) =>
    preview ? (
      <div
        role="dialog"
        aria-label={preview.title}
        data-target-line={preview.targetLine}
      >
        {preview.content}
        {preview.error}
      </div>
    ) : null,
}));

const commandContext: CommandContextSnapshot = {
  windowKind: "main",
  platform: "windows",
  runtime: "browser",
  activeView: "chat",
  focus: { kind: "document", ownerPath: [] },
  overlays: [],
  singleKeyShortcutsEnabled: true,
  busyCommands: new Set(),
};
const commandSignal = new AbortController().signal;

const message: ProductMessage = {
  id: "message",
  role: "user",
  content: "# Grüße 🌿\n\n**Answer**",
  workspace: "C:\\Project",
  presentation: "message",
  attachments: [],
  actions: {
    canRetry: false,
    canContinue: false,
    canSaveAsContextPack: true,
    canSpeak: false,
    isSpeaking: false,
  },
};
const session = {
  id: "session",
  title: "Session",
  workspace: "C:\\Project",
} as ProductSession;
const invoke = vi.fn();
const onCommand = vi.fn().mockResolvedValue(true);
const writeText = vi.fn().mockResolvedValue(undefined);
const createObjectURL = vi.fn().mockReturnValue("blob:preview");
const transport = {
  invoke,
  listen: vi.fn().mockResolvedValue(() => undefined),
};
const mediaTransport = { invoke } as unknown as Parameters<
  typeof RemoteConversationHost
>[0]["mediaTransport"];
const props = {
  session,
  messages: [message],
  pending: false,
  historyAvailable: false,
  onCommand,
  workspaceTransport: transport,
  mediaTransport,
};

it("applies the native timeout acknowledgment before another snapshot arrives", async () => {
  const thinking = {
    status: "running",
    mode: "ask",
    startedAt: Date.now(),
    timelineEvents: [],
    timeout: {
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
      idleTimeoutMs: 1_200_000,
      absoluteTimeoutMs: null,
    },
  };
  const runningMessage = {
    ...message,
    role: "agent",
    taskId: "task",
    thinking,
  };
  const history = {
    sessionId: session.id,
    revision: "a".repeat(64),
    messages: [runningMessage],
    total: 1,
    hasEarlier: false,
  };
  invoke.mockResolvedValueOnce(history).mockResolvedValueOnce({
    ...thinking.timeout,
    idleTimeoutMs: 180_000,
  });
  render(
    <RemoteConversationHost
      {...props}
      historyAvailable
      session={{ ...session, status: "running" }}
    />,
  );
  await screen.findByRole("button", { name: "Adjust chat timeout" });
  expect(
    screen.getByRole("progressbar", { name: "AI chat timeout progress" }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Adjust chat timeout" }));
  fireEvent.change(
    screen.getByRole("spinbutton", { name: "Inactivity (minutes)" }),
    { target: { value: "3" } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Apply and reset" }));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("reset_desktop_task_timeout", {
      taskId: "task",
      idleTimeoutMinutes: 3,
    }),
  );
  await waitFor(() => expect(screen.queryByRole("spinbutton")).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "Adjust chat timeout" }));
  expect(
    (
      screen.getByRole("spinbutton", {
        name: "Inactivity (minutes)",
      }) as HTMLInputElement
    ).value,
  ).toBe("3");
});

beforeEach(() => {
  vi.mocked(useOptionalRegisterCommands).mockClear();
  invoke.mockReset();
  onCommand.mockReset().mockResolvedValue(true);
  writeText.mockReset().mockResolvedValue(undefined);
  createObjectURL.mockReset().mockReturnValue("blob:preview");
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  vi.stubGlobal("URL", { createObjectURL, revokeObjectURL: vi.fn() });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("shared remote message interactions", () => {
  it("opens a historical file in its recorded workspace after the active workspace changes", async () => {
    invoke.mockResolvedValue({
      dataBase64: btoa("Historical file"),
      mediaType: "text/markdown",
    });
    render(
      <RemoteConversationHost
        {...props}
        session={{ ...session, workspace: "C:\\Other" }}
        messages={[{ ...message, content: "[Source](notes/answer.md#L3)" }]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Source" }));
    await waitFor(() =>
      expect(
        screen.getByRole("dialog", { name: "answer.md" }).textContent,
      ).toBe("Historical file"),
    );
    expect(invoke).toHaveBeenCalledWith("read_context_attachment_preview", {
      sessionId: session.id,
      messageId: message.id,
      path: "C:/Project/notes/answer.md",
    });
  });
  const command = (id: string): CommandDefinition => {
    const definitions = vi
      .mocked(useOptionalRegisterCommands)
      .mock.calls.at(-1)?.[0];
    const found = definitions?.find((definition) => definition.id === id);
    if (!found) throw new Error(`Missing conversation command ${id}.`);
    return found;
  };

  it("uses the canonical edit commands with the visible editor and retains a rejected edit", async () => {
    render(
      <RemoteConversationHost
        {...props}
        messages={[
          { ...message, actions: { ...message.actions, canEdit: true } },
        ]}
      />,
    );
    const editPage = await command("chat.message.edit").children?.(
      commandContext,
      commandSignal,
    );
    act(() => {
      void editPage?.groups[0]?.items[0]?.execute?.(
        commandContext,
        commandSignal,
      );
    });
    const editor = screen.getByRole("textbox", {
      name: "Edit message",
    });
    fireEvent.change(editor, { target: { value: "Command edit 🌿" } });
    onCommand.mockResolvedValueOnce(false);
    act(() => {
      void command("chat.message.edit.submit").execute?.(
        commandContext,
        commandSignal,
      );
    });
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        "could not be submitted",
      ),
    );
    expect(onCommand).toHaveBeenLastCalledWith({
      kind: "edit-message",
      sessionId: session.id,
      messageId: message.id,
      prompt: "Command edit 🌿",
    });
    expect((editor as HTMLTextAreaElement).value).toBe("Command edit 🌿");
    act(() => {
      void command("chat.message.edit.cancel").execute?.(
        commandContext,
        commandSignal,
      );
    });
    expect(screen.queryByRole("textbox", { name: "Edit message" })).toBeNull();
  });

  it("uses canonical navigation and original-prompt commands without submitting a task", async () => {
    const scroll = vi.fn();
    vi.stubGlobal("HTMLElement", HTMLElement);
    HTMLElement.prototype.scrollIntoView = scroll;
    render(
      <RemoteConversationHost
        {...props}
        messages={[
          { ...message, originalPrompt: "Original request 🌿" },
          {
            ...message,
            id: "reply",
            role: "agent",
            content: "Reply 🌿",
            actions: { ...message.actions, canSaveAsContextPack: false },
          },
        ]}
      />,
    );
    act(() => {
      void command("chat.messages.previous").execute?.(
        commandContext,
        commandSignal,
      );
    });
    expect(scroll).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
    expect(
      document
        .querySelector('[data-message-id="message"]')
        ?.getAttribute("data-navigation-target"),
    ).toBe("true");
    const page = await command(
      "chat.message.original-prompt.toggle",
    ).children?.(commandContext, commandSignal);
    act(() => {
      void page?.groups[0]?.items[0]?.execute?.(commandContext, commandSignal);
    });
    expect(screen.getByText("Original request 🌿")).toBeTruthy();
    act(() => {
      void page?.groups[0]?.items[0]?.execute?.(commandContext, commandSignal);
    });
    expect(screen.queryByText("Original request 🌿")).toBeNull();
    expect(onCommand).not.toHaveBeenCalled();
  });

  it("targets projected replay and recovery capabilities in the canonical commands", async () => {
    const reply = {
      ...message,
      id: "reply",
      role: "agent",
      taskId: "native-task",
      actions: {
        ...message.actions,
        canSaveAsContextPack: false,
        canReplay: true,
        canRetry: true,
        canContinue: true,
      },
    };
    const view = render(
      <RemoteConversationHost {...props} messages={[message, reply]} />,
    );
    const page = await command("chat.message.retry").children?.(
      commandContext,
      commandSignal,
    );
    act(() => {
      void page?.groups[0]?.items[0]?.execute?.(commandContext, commandSignal);
    });
    expect(onCommand).toHaveBeenLastCalledWith({
      kind: "replay-message",
      sessionId: session.id,
      messageId: "reply",
    });
    act(() => {
      void command("chat.message.continue").execute?.(
        commandContext,
        commandSignal,
      );
    });
    expect(onCommand).toHaveBeenLastCalledWith({
      kind: "continue",
      taskId: "native-task",
    });
    view.rerender(
      <RemoteConversationHost {...props} pending messages={[message, reply]} />,
    );
    expect(
      command("chat.message.retry").availability?.(commandContext),
    ).toMatchObject({
      state: "disabled",
    });
  });
  it("edits and submits through the native message command while retaining a rejected edit", async () => {
    render(
      <RemoteConversationHost
        {...props}
        messages={[
          { ...message, actions: { ...message.actions, canEdit: true } },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit message" }));
    const editor = screen.getByRole("textbox", { name: "Edit message" });
    expect((editor as HTMLTextAreaElement).value).toBe(message.content);
    fireEvent.change(editor, { target: { value: "Edited request 🌿" } });
    onCommand.mockResolvedValueOnce(false);
    fireEvent.click(screen.getByRole("button", { name: "Save and submit" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        "could not be submitted",
      ),
    );
    expect((editor as HTMLTextAreaElement).value).toBe("Edited request 🌿");
    expect(onCommand).toHaveBeenLastCalledWith({
      kind: "edit-message",
      sessionId: session.id,
      messageId: message.id,
      prompt: "Edited request 🌿",
    });
    fireEvent.click(screen.getByRole("button", { name: "Save and submit" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("textbox", { name: "Edit message" }),
      ).toBeNull(),
    );
  });

  it("replays a native reply by message identity without requiring a task id", async () => {
    render(
      <RemoteConversationHost
        {...props}
        messages={[
          {
            ...message,
            role: "agent",
            actions: { ...message.actions, canReplay: true },
          },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onCommand).toHaveBeenCalledWith({
      kind: "replay-message",
      sessionId: session.id,
      messageId: message.id,
    });
  });

  it.each([
    "C:\\Project",
    "\\\\?\\C:\\Project",
    "\\\\?\\UNC\\server\\share\\Project",
  ])(
    "opens native Markdown file links from %s and preserves their target line",
    async (workspace) => {
      invoke.mockResolvedValue({
        dataBase64: btoa("Linked file"),
        mediaType: "text/markdown",
      });
      render(
        <RemoteConversationHost
          {...props}
          session={{ ...session, workspace }}
          messages={[
            { ...message, workspace, content: "[Source](notes/answer.md#L42)" },
          ]}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Source" }));
      await waitFor(() =>
        expect(
          screen.getByRole("dialog", { name: "answer.md" }).textContent,
        ).toBe("Linked file"),
      );
      expect(invoke).toHaveBeenCalledWith("read_context_attachment_preview", {
        sessionId: session.id,
        messageId: message.id,
        path: workspace.includes("UNC")
          ? "//server/share/Project/notes/answer.md"
          : "C:/Project/notes/answer.md",
      });
      expect(
        screen
          .getByRole("dialog", { name: "answer.md" })
          .getAttribute("data-target-line"),
      ).toBe("42");
    },
  );

  it("shows the original enhanced prompt on demand and copies the native raw content", async () => {
    const originalPrompt = "Original request 🌿";
    const rawContent = "  Native raw content\n\tline\n";
    const view = render(
      <RemoteConversationHost
        {...props}
        messages={[{ ...message, originalPrompt, rawContent }]}
      />,
    );
    expect(
      view.container.querySelector(".app-original-prompt-panel"),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "View original prompt" }),
    );
    expect(
      view.container.querySelector(".app-original-prompt-panel")?.textContent,
    ).toContain(originalPrompt);
    fireEvent.click(
      screen.getByRole("button", { name: "Hide original prompt" }),
    );
    expect(
      view.container.querySelector(".app-original-prompt-panel"),
    ).toBeNull();
    fireEvent.contextMenu(
      view.container.querySelector(".m-product-message-bubble")!,
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy as raw text" }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledExactlyOnceWith(rawContent),
    );
    view.rerender(
      <RemoteConversationHost
        {...props}
        messages={[{ ...message, originalPrompt: message.content }]}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "View original prompt" }),
    ).toBeNull();
  });
  it("copies Unicode Markdown using the canonical menu and keeps failed context saves recoverable", async () => {
    const view = render(<RemoteConversationHost {...props} />);
    const open = () =>
      fireEvent.contextMenu(
        view.container.querySelector(".m-product-message-bubble")!,
        { clientX: 100, clientY: 100 },
      );
    open();
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy Markdown" }));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(writeText).toHaveBeenCalledExactlyOnceWith(message.content);
    open();
    onCommand.mockResolvedValueOnce(false);
    fireEvent.click(screen.getByRole("menuitem", { name: "Save as pack" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        "could not be saved",
      ),
    );
    expect(onCommand).toHaveBeenCalledWith({
      kind: "save-message-context-pack",
      sessionId: session.id,
      messageId: message.id,
    });
    fireEvent.click(screen.getByRole("menuitem", { name: "Save as pack" }));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("downloads the displayed Markdown from the canonical export action", async () => {
    let downloaded: { name: string; content: Blob } | undefined;
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(
      function (this: HTMLAnchorElement) {
        downloaded = {
          name: this.download,
          content: createObjectURL.mock.calls[0]![0],
        };
      },
    );
    const view = render(<RemoteConversationHost {...props} />);
    fireEvent.contextMenu(
      view.container.querySelector(".m-product-message-bubble")!,
    );
    const save = screen.getByRole("menuitem", { name: "Save Markdown" });
    const documentPointer = new Event("pointerdown");
    Object.defineProperty(documentPointer, "target", { value: save });
    fireEvent(document, documentPointer);
    expect(screen.getByRole("menuitem", { name: "Save Markdown" })).toBe(save);
    fireEvent.click(save);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(downloaded?.name).toBe("machdoch-user-message-message.md");
    const contents = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(downloaded!.content);
    });
    expect(contents).toBe(message.content);
  });

  it("opens message files through native previews and discards responses from the previous session", async () => {
    const file = {
      id: "file",
      source: "path" as const,
      kind: "file" as const,
      name: "answer.md",
      path: "C:\\Project\\answer.md",
    };
    let resolvePrevious!: (value: unknown) => void;
    invoke.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePrevious = resolve;
        }),
    );
    const view = render(
      <RemoteConversationHost
        {...props}
        messages={[{ ...message, attachments: [file] }]}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Show file answer.md" }),
    );
    expect(invoke).toHaveBeenCalledWith("read_context_attachment_preview", {
      sessionId: session.id,
      messageId: message.id,
      path: file.path,
    });
    view.rerender(
      <RemoteConversationHost
        {...props}
        session={{ ...session, id: "next" }}
        messages={[{ ...message, attachments: [file] }]}
      />,
    );
    await act(async () => {
      resolvePrevious({
        dataBase64: btoa("stale"),
        mediaType: "text/markdown",
      });
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(createObjectURL).not.toHaveBeenCalled();
    invoke.mockResolvedValueOnce({
      dataBase64: btoa("Current file"),
      mediaType: "text/markdown",
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Show file answer.md" }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("dialog", { name: "answer.md" }).textContent,
      ).toBe("Current file"),
    );
    expect(invoke).toHaveBeenLastCalledWith("read_context_attachment_preview", {
      sessionId: "next",
      messageId: message.id,
      path: file.path,
    });
  });

  it("browses message folders within the session root and opens their files", async () => {
    const folder = {
      id: "folder",
      source: "path" as const,
      kind: "directory" as const,
      name: "notes",
      path: "C:\\Project\\notes",
    };
    invoke.mockResolvedValueOnce({
      path: "notes",
      entries: [{ path: "notes/answer.md", name: "answer.md", kind: "file" }],
      nextOffset: null,
    });
    render(
      <RemoteConversationHost
        {...props}
        messages={[{ ...message, attachments: [folder] }]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open folder notes" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "answer.md" })).toBeTruthy(),
    );
    expect(invoke).toHaveBeenCalledWith("list_workspace_directory", {
      workspaceRoot: session.workspace,
      relativePath: "notes",
      offset: 0,
    });
    invoke.mockResolvedValueOnce({
      dataBase64: btoa("Folder file"),
      mediaType: "text/markdown",
    });
    fireEvent.click(screen.getByRole("button", { name: "answer.md" }));
    await waitFor(() =>
      expect(
        screen.getByRole("dialog", { name: "answer.md" }).textContent,
      ).toBe("Folder file"),
    );
    expect(invoke).toHaveBeenLastCalledWith("read_context_attachment_preview", {
      sessionId: session.id,
      messageId: message.id,
      path: "C:/Project/notes/answer.md",
    });
  });

  it("rejects a folder outside the session root without contacting the host", async () => {
    const folder = {
      id: "folder",
      source: "path" as const,
      kind: "directory" as const,
      name: "Other",
      path: "C:\\Project-other",
    };
    render(
      <RemoteConversationHost
        {...props}
        messages={[{ ...message, attachments: [folder] }]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open folder Other" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        "outside the session workspace",
      ),
    );
    expect(invoke).not.toHaveBeenCalled();
  });
});
