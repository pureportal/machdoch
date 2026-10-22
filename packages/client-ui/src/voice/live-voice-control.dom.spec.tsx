import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markdownToSpeech, speechPlayback } from "@machdoch/speech";
import type { LiveVoiceRequest } from "@machdoch/fleet-protocol/live-voice";
import { connectLiveTranscription } from "./live-connection";
import { startLiveVoiceCapture, supportsLiveVoice } from "./live-capture";
import {
  LiveVoiceControl,
  type LiveVoiceControlProps,
} from "./live-voice-control";

vi.mock("./live-connection", () => ({
  connectLiveTranscription: vi.fn(),
}));
vi.mock("./live-capture", () => ({
  startLiveVoiceCapture: vi.fn(),
  supportsLiveVoice: vi.fn(),
}));
vi.mock("@machdoch/speech", () => ({
  createSystemSpeechHandle: vi.fn(),
  markdownToSpeech: vi.fn(),
  speechPlayback: {
    play: vi.fn(),
    stop: vi.fn(),
    subscribe: vi.fn(),
  },
}));

const liveConnection = {
  start: vi.fn(),
  append: vi.fn(),
  commit: vi.fn(),
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(supportsLiveVoice).mockReturnValue(true);
  vi.mocked(connectLiveTranscription).mockResolvedValue(liveConnection);
  vi.mocked(startLiveVoiceCapture).mockResolvedValue(vi.fn());
  vi.mocked(markdownToSpeech).mockImplementation((text) => text);
  vi.mocked(speechPlayback.subscribe).mockReturnValue(vi.fn());
});

afterEach(cleanup);

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function harness() {
  const invoke = vi
    .fn<(input: LiveVoiceRequest) => Promise<unknown>>()
    .mockResolvedValue({ sampleRate: 24_000 });
  const onTranscript = vi
    .fn<LiveVoiceControlProps["onTranscript"]>()
    .mockResolvedValue(undefined);
  const onSpeechStart = vi.fn();
  const onActiveChange = vi.fn();
  const props: LiveVoiceControlProps = {
    identity: "chat-1",
    workspaceRoot: "C:/workspace",
    inputDeviceId: "microphone-1",
    invoke: <T,>(input: LiveVoiceRequest) => invoke(input) as Promise<T>,
    onTranscript,
    onSpeechStart,
    onActiveChange,
  };
  return {
    ...render(<LiveVoiceControl {...props} />),
    props,
    invoke,
    onTranscript,
    onSpeechStart,
    onActiveChange,
  };
}

async function startListening() {
  fireEvent.click(screen.getByRole("button", { name: "Live voice" }));
  await screen.findByRole("button", { name: "Stop listening" });
  return {
    transcription: vi.mocked(connectLiveTranscription).mock.calls.at(-1)![1],
    capture: vi.mocked(startLiveVoiceCapture).mock.calls.at(-1)![0],
  };
}

describe("LiveVoiceControl", () => {
  it("retains repeated speech while an identical earlier message is being delivered", async () => {
    const { invoke, onTranscript } = harness();
    const { transcription } = await startListening();
    invoke.mockResolvedValueOnce({ text: "Try again." });
    const submission = deferred<void>();
    onTranscript.mockReturnValueOnce(submission.promise);
    act(() => transcription.onTranscript("Try again."));
    await waitFor(() => expect(onTranscript).toHaveBeenCalledOnce());
    act(() => transcription.onPartial("Try again."));
    fireEvent.click(screen.getByRole("button", { name: "Stop listening" }));
    const unsent = screen.getByRole("textbox", {
      name: "Unsent voice message",
    }) as HTMLTextAreaElement;
    expect(unsent.value).toBe("Try again.\n\nTry again.");
    await act(async () => submission.resolve());
    expect(unsent.value).toBe("Try again.");
    fireEvent.click(screen.getByRole("button", { name: "Send text" }));
    await waitFor(() => expect(onTranscript).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(
        screen.queryByRole("textbox", { name: "Unsent voice message" }),
      ).toBeNull(),
    );
  });
  it("prevents duplicate sends while a stopped session is still delivering its message", async () => {
    const { invoke, onTranscript } = harness();
    const { transcription } = await startListening();
    invoke.mockResolvedValueOnce({ text: "Keep this correction." });
    const submission = deferred<void>();
    onTranscript.mockReturnValueOnce(submission.promise);
    act(() => transcription.onTranscript("Keep this correction."));
    await waitFor(() => expect(onTranscript).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "Stop listening" }));
    expect(
      (screen.getByRole("button", { name: "Send text" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Discard" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (
        screen.getByRole("textbox", {
          name: "Unsent voice message",
        }) as HTMLTextAreaElement
      ).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Send text" }));
    await act(async () => {
      submission.resolve();
      await submission.promise;
    });
    expect(onTranscript).toHaveBeenCalledOnce();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(
      (screen.getByRole("button", { name: "Live voice" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it.each([
    { identity: "chat-2", workspaceRoot: "C:/workspace" },
    { identity: "chat-1", workspaceRoot: "C:/another-workspace" },
  ])(
    "stops the old session when switching to $identity in $workspaceRoot and ignores its late speech",
    async (target) => {
      const { props, rerender, invoke, onTranscript } = harness();
      const { transcription } = await startListening();
      const processing = deferred<{ text: string }>();
      invoke.mockReturnValueOnce(processing.promise);
      act(() => transcription.onTranscript("Old conversation correction."));
      await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
      const nextTranscript = vi.fn().mockResolvedValue(undefined);
      rerender(
        <LiveVoiceControl
          {...props}
          {...target}
          onTranscript={nextTranscript}
        />,
      );
      expect(transcription.signal.aborted).toBe(true);
      expect(screen.getByRole("button", { name: "Live voice" })).toBeTruthy();
      await act(async () => {
        processing.resolve({ text: "Old conversation correction." });
        await processing.promise;
        transcription.onPartial("Late partial");
        transcription.onTranscript("Late final");
      });
      expect(onTranscript).not.toHaveBeenCalled();
      expect(nextTranscript).not.toHaveBeenCalled();
      expect(screen.queryByRole("status")).toBeNull();
      expect(screen.queryByRole("textbox")).toBeNull();
    },
  );

  it("retains the unfinished transcript when listening stops", async () => {
    const { onTranscript } = harness();
    const { transcription } = await startListening();
    act(() => transcription.onPartial("Keep the original goal"));
    fireEvent.click(screen.getByRole("button", { name: "Stop listening" }));
    expect(
      (
        screen.getByRole("textbox", {
          name: "Unsent voice message",
        }) as HTMLTextAreaElement
      ).value,
    ).toBe("Keep the original goal");
    expect(onTranscript).not.toHaveBeenCalled();
  });
  it("previews partial speech and submits the final transcript only after processing", async () => {
    const { invoke, onTranscript } = harness();
    const { transcription, capture } = await startListening();
    const processing = deferred<{ text: string }>();
    invoke.mockReturnValueOnce(processing.promise);

    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith({ action: "session" });
    expect(capture.sampleRate).toBe(24_000);
    expect(capture.inputDeviceId).toBe("microphone-1");
    expect(capture.signal).toBe(transcription.signal);

    act(() => {
      transcription.onPartial("Unfinished speech");
      transcription.onTranscript("   ");
    });
    expect(screen.getByRole("status").textContent).toBe("Unfinished speech");
    expect(invoke).toHaveBeenCalledOnce();
    expect(onTranscript).not.toHaveBeenCalled();

    act(() => {
      transcription.onTranscript("  Please revise the current task.  ");
      transcription.onPartial("");
    });
    await waitFor(() =>
      expect(invoke).toHaveBeenLastCalledWith({
        action: "process",
        text: "Please revise the current task.",
      }),
    );
    expect(screen.queryByRole("status")).toBeNull();
    expect(onTranscript).not.toHaveBeenCalled();

    await act(async () => {
      processing.resolve({ text: "Revise the current task." });
      await processing.promise;
    });
    expect(onTranscript).toHaveBeenCalledOnce();
    expect(onTranscript).toHaveBeenCalledWith("Revise the current task.");
    fireEvent.click(screen.getByRole("button", { name: "Stop listening" }));
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Send text" })).toBeNull();
  });

  it("interrupts reply playback and notifies the active task when speech starts", async () => {
    const { props, rerender, onSpeechStart } = harness();
    const { capture } = await startListening();

    rerender(
      <LiveVoiceControl
        {...props}
        browserReply={{ id: "reply-1", text: "The task is running." }}
      />,
    );
    expect(speechPlayback.play).toHaveBeenCalledWith({
      owner: "live-voice:chat-1",
      itemId: "reply-1",
      open: expect.any(Function),
    });
    expect(onSpeechStart).not.toHaveBeenCalled();

    act(() => capture.onSpeechStart());

    expect(speechPlayback.stop).toHaveBeenCalledOnce();
    expect(speechPlayback.stop).toHaveBeenCalledWith("live-voice:chat-1");
    expect(onSpeechStart).toHaveBeenCalledOnce();
    expect(liveConnection.start).toHaveBeenCalledOnce();
  });

  it("preserves the unsent final transcript when stopped during processing", async () => {
    const { invoke, onTranscript, onActiveChange } = harness();
    const { transcription, capture } = await startListening();
    const processing = deferred<{ text: string }>();
    invoke.mockReturnValueOnce(processing.promise);

    act(() => {
      transcription.onTranscript("  Keep this final message.  ");
      transcription.onPartial("An unfinished next message");
    });
    await waitFor(() =>
      expect(invoke).toHaveBeenLastCalledWith({
        action: "process",
        text: "Keep this final message.",
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Stop listening" }));
    expect(transcription.signal.aborted).toBe(true);
    expect(capture.signal.aborted).toBe(true);
    expect(onActiveChange).toHaveBeenLastCalledWith(false);
    expect(screen.queryByRole("status")).toBeNull();
    expect(
      (
        screen.getByRole("textbox", {
          name: "Unsent voice message",
        }) as HTMLTextAreaElement
      ).value,
    ).toBe("Keep this final message.\n\nAn unfinished next message");
    expect(
      (screen.getByRole("button", { name: "Live voice" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    await act(async () => {
      processing.resolve({ text: "A late processing result." });
      await processing.promise;
      transcription.onTranscript("A late provider transcript.");
    });
    expect(onTranscript).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(
      (
        screen.getByRole("textbox", {
          name: "Unsent voice message",
        }) as HTMLTextAreaElement
      ).value,
    ).toBe("Keep this final message.\n\nAn unfinished next message");
  });

  it("offers Send text after submission fails and clears the message after retry", async () => {
    const { invoke, onTranscript } = harness();
    const { transcription } = await startListening();
    invoke.mockResolvedValueOnce({ text: "Processed voice message." });
    onTranscript.mockRejectedValueOnce(new Error("Task submission failed."));

    act(() => transcription.onTranscript("Original voice message."));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Task submission failed.",
    );
    expect(onTranscript).toHaveBeenCalledOnce();
    expect(onTranscript).toHaveBeenCalledWith("Processed voice message.");
    expect(transcription.signal.aborted).toBe(true);
    const unsent = screen.getByRole("textbox", {
      name: "Unsent voice message",
    }) as HTMLTextAreaElement;
    expect(unsent.value).toBe("Original voice message.");

    const retry = deferred<void>();
    onTranscript.mockReturnValueOnce(retry.promise);
    fireEvent.change(unsent, { target: { value: "Corrected voice message." } });
    fireEvent.click(screen.getByRole("button", { name: "Send text" }));
    expect(onTranscript).toHaveBeenCalledTimes(2);
    expect(onTranscript).toHaveBeenLastCalledWith("Corrected voice message.");
    expect(
      (screen.getByRole("button", { name: "Send text" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Discard" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    await act(async () => {
      retry.resolve(undefined);
      await retry.promise;
    });
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: "Send text" })).toBeNull();
    expect(
      (screen.getByRole("button", { name: "Live voice" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("reports active state while connecting and listening, then clears it on stop and unmount", async () => {
    const { onActiveChange, unmount } = harness();
    const connecting = deferred<typeof liveConnection>();
    vi.mocked(connectLiveTranscription).mockReturnValueOnce(connecting.promise);
    expect(onActiveChange).toHaveBeenLastCalledWith(false);

    fireEvent.click(screen.getByRole("button", { name: "Live voice" }));
    expect(
      screen
        .getByRole("button", { name: "Cancel connection" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(onActiveChange).toHaveBeenLastCalledWith(true);
    await waitFor(() =>
      expect(connectLiveTranscription).toHaveBeenCalledOnce(),
    );
    expect(startLiveVoiceCapture).not.toHaveBeenCalled();

    await act(async () => {
      connecting.resolve(liveConnection);
      await connecting.promise;
    });
    const stop = screen.getByRole("button", { name: "Stop listening" });
    expect(stop.getAttribute("aria-pressed")).toBe("true");
    expect(onActiveChange).toHaveBeenLastCalledWith(true);
    const firstCapture = vi.mocked(startLiveVoiceCapture).mock.calls[0]![0];

    fireEvent.click(stop);
    expect(firstCapture.signal.aborted).toBe(true);
    expect(onActiveChange).toHaveBeenLastCalledWith(false);
    expect(
      screen
        .getByRole("button", { name: "Live voice" })
        .getAttribute("aria-pressed"),
    ).toBe("false");

    const { capture } = await startListening();
    expect(onActiveChange).toHaveBeenLastCalledWith(true);
    expect(capture.signal).not.toBe(firstCapture.signal);
    expect(capture.signal.aborted).toBe(false);
    unmount();
    expect(capture.signal.aborted).toBe(true);
    expect(onActiveChange).toHaveBeenLastCalledWith(false);
    expect(speechPlayback.stop).toHaveBeenLastCalledWith("live-voice:chat-1");
  });
});
