import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ProductMessage } from "@machdoch/fleet-protocol";
import { useRemoteConversationHistory } from "./use-remote-conversation-history";

afterEach(cleanup);
const message = (id: string, content = id): ProductMessage => ({
  id,
  role: "user",
  content,
  presentation: "message",
  attachments: [],
  actions: {
    canEdit: true,
    canRetry: false,
    canContinue: false,
    canSaveAsContextPack: true,
    canSpeak: false,
    isSpeaking: false,
  },
});
const page = (messages: ProductMessage[], values = {}) => ({
  sessionId: "session",
  revision: "a".repeat(64),
  messages,
  total: 85,
  hasEarlier: true,
  ...values,
});
const options = (
  invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>,
) => ({
  sessionId: "session",
  messages: [message("latest", "Short live projection")],
  running: false,
  enabled: true,
  transport: {
    invoke: async <T,>(
      command: string,
      args?: Record<string, unknown>,
    ): Promise<T> => (await invoke(command, args)) as T,
    listen: vi.fn(),
  },
});

it("loads lossless native message text and earlier chronological pages with the exact revision", async () => {
  const content = "Grüße 🌿\n".repeat(2_000);
  const invoke = vi
    .fn()
    .mockResolvedValueOnce(page([message("latest", content)]))
    .mockResolvedValueOnce(page([message("earlier")], { hasEarlier: false }));
  const initial = options(invoke);
  const { result } = renderHook(() => useRemoteConversationHistory(initial));
  await waitFor(() => expect(result.current.ready).toBe(true));
  expect(result.current.messages[0]!.content).toBe(content);
  await act(async () => {
    await result.current.loadEarlier();
  });
  expect(invoke).toHaveBeenLastCalledWith("get_session_message_page", {
    sessionId: "session",
    limit: 80,
    beforeMessageId: "latest",
    expectedRevision: "a".repeat(64),
  });
  expect(result.current.messages.map(({ id }) => id)).toEqual([
    "earlier",
    "latest",
  ]);
  expect(result.current.hasEarlier).toBe(false);
});

it("discards late responses from a previous session", async () => {
  let resolvePrevious!: (value: unknown) => void;
  const invoke = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePrevious = resolve;
        }),
    )
    .mockResolvedValueOnce(page([message("current")], { sessionId: "next" }));
  const { result, rerender } = renderHook(
    (props) => useRemoteConversationHistory(props),
    { initialProps: options(invoke) },
  );
  rerender({ ...options(invoke), sessionId: "next" });
  await waitFor(() => expect(result.current.messages[0]!.id).toBe("current"));
  await act(async () => {
    resolvePrevious(page([message("stale")]));
  });
  expect(result.current.messages[0]!.id).toBe("current");
});

it("retains loaded text when an older page fails and reloads the latest history on retry", async () => {
  const invoke = vi
    .fn()
    .mockResolvedValueOnce(page([message("latest", "Full native text")]))
    .mockRejectedValueOnce(
      new Error("The conversation changed. Reload its history."),
    )
    .mockResolvedValueOnce(page([message("new")], { hasEarlier: false }));
  const initial = options(invoke);
  const { result } = renderHook(() => useRemoteConversationHistory(initial));
  await waitFor(() => expect(result.current.ready).toBe(true));
  await act(async () => {
    await result.current.loadEarlier();
  });
  expect(result.current.error).toContain("The conversation changed");
  expect(result.current.messages[0]!.content).toBe("Full native text");
  await act(async () => {
    await result.current.reload();
  });
  expect(result.current.messages[0]!.id).toBe("new");
  expect(result.current.error).toBeNull();
});

it("coalesces repeated older-page actions and retains full history during an active task", async () => {
  let resolveOlder!: (value: unknown) => void;
  const invoke = vi
    .fn()
    .mockResolvedValueOnce(page([message("latest")]))
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOlder = resolve;
        }),
    )
    .mockResolvedValueOnce(
      page([message("older"), message("latest", "Full live native text")], {
        hasEarlier: false,
      }),
    );
  const initial = options(invoke);
  const { result, rerender } = renderHook(
    (props) => useRemoteConversationHistory(props),
    { initialProps: initial },
  );
  await waitFor(() => expect(result.current.ready).toBe(true));
  let pending!: Promise<void>;
  await act(async () => {
    pending = result.current.loadEarlier();
    await result.current.loadEarlier();
  });
  expect(invoke).toHaveBeenCalledTimes(2);
  await act(async () => {
    resolveOlder(page([message("older")], { hasEarlier: false }));
    await pending;
  });
  rerender({ ...initial, running: true });
  expect(result.current.messages[0]!.id).toBe("older");
  await waitFor(() =>
    expect(result.current.messages[1]!.content).toBe("Full live native text"),
  );
  expect(invoke).toHaveBeenCalledTimes(3);
  expect(invoke).toHaveBeenLastCalledWith("get_session_message_page", {
    sessionId: "session",
    limit: 80,
  });
});

it("keeps all loaded pages when the native snapshot refreshes", async () => {
  const first = Array.from({ length: 80 }, (_, index) =>
    message(`first-${index}`),
  );
  const latest = Array.from({ length: 80 }, (_, index) =>
    message(`latest-${index}`),
  );
  const revision = "b".repeat(64);
  const invoke = vi
    .fn()
    .mockResolvedValueOnce(page(latest, { total: 160 }))
    .mockResolvedValueOnce(page(first, { total: 160, hasEarlier: false }))
    .mockResolvedValueOnce(page(latest, { total: 160, revision }))
    .mockResolvedValueOnce(
      page(first, { total: 160, revision, hasEarlier: false }),
    );
  const initial = options(invoke);
  const { result, rerender } = renderHook(
    (props) => useRemoteConversationHistory(props),
    { initialProps: initial },
  );
  await waitFor(() => expect(result.current.messages).toHaveLength(80));
  await act(async () => {
    await result.current.loadEarlier();
  });
  expect(result.current.messages).toHaveLength(160);
  rerender({ ...initial, messages: [message("updated")] });
  await waitFor(() => expect(invoke).toHaveBeenCalledTimes(4));
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.messages.map(({ id }) => id)).toEqual(
    [...first, ...latest].map(({ id }) => id),
  );
  expect(invoke).toHaveBeenLastCalledWith("get_session_message_page", {
    sessionId: "session",
    limit: 80,
    beforeMessageId: "latest-0",
    expectedRevision: revision,
  });
});

it("rejects empty continuation pages instead of repeatedly fetching them", async () => {
  const invoke = vi.fn().mockResolvedValue(page([]));
  const initial = options(invoke);
  const { result } = renderHook(() => useRemoteConversationHistory(initial));
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.error).toBe(
    "Could not load the conversation. Reload its history.",
  );
  expect(result.current.ready).toBe(false);
  expect(invoke).toHaveBeenCalledTimes(1);
});

it("keeps acknowledged timeouts against stale reads and refreshes timeout-only native changes", async () => {
  const timeout = {
    startedAt: 1,
    lastActivityAt: 2,
    idleTimeoutMs: 1_200_000,
    absoluteTimeoutMs: null,
  };
  const nativeMessage = (value: typeof timeout) => ({
    ...message("latest"),
    source: { kind: "thinking", entries: [], timeline: [], timeout: value },
    thinking: {
      status: "running",
      mode: "ask",
      startedAt: 1,
      timelineEvents: [],
      timeout: value,
    },
  });
  const acknowledged = {
    ...timeout,
    lastActivityAt: 3,
    idleTimeoutMs: 180_000,
  };
  const external = { ...timeout, lastActivityAt: 4, idleTimeoutMs: 240_000 };
  let resolveStale!: (value: unknown) => void;
  const invoke = vi
    .fn()
    .mockResolvedValueOnce(
      page([nativeMessage(timeout)], { hasEarlier: false }),
    )
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveStale = resolve;
        }),
    )
    .mockResolvedValueOnce(
      page([nativeMessage(external)], { hasEarlier: false }),
    );
  const initial = {
    ...options(invoke),
    running: true,
    messages: [nativeMessage(timeout)],
  };
  const { result, rerender } = renderHook(
    (props) => useRemoteConversationHistory(props),
    { initialProps: initial },
  );
  await waitFor(() => expect(result.current.ready).toBe(true));
  let pending!: Promise<void>;
  await act(async () => {
    pending = result.current.reload();
  });
  act(() => result.current.updateTimeout("latest", acknowledged));
  await act(async () => {
    resolveStale(page([nativeMessage(timeout)], { hasEarlier: false }));
    await pending;
  });
  expect(result.current.thinking.get("latest")?.timeout).toEqual(acknowledged);
  rerender({ ...initial, messages: [nativeMessage(external)] });
  await waitFor(() =>
    expect(result.current.thinking.get("latest")?.timeout).toEqual(external),
  );
  expect(invoke).toHaveBeenCalledTimes(3);
});
