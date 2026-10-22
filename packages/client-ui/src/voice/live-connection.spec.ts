import { setImmediate } from "node:timers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectLiveTranscription } from "./live-connection";

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readyState: number = MockWebSocket.CONNECTING;
  bufferedAmount = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: Event) => void) | null = null;
  send = vi.fn<(data: string) => void>();
  close = vi.fn(() => {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.(new Event("close"));
  });

  constructor(
    readonly url: string,
    readonly protocols?: string | string[],
  ) {
    MockWebSocket.instances.push(this);
  }

  open(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.(new Event("open"));
  }

  async receive(data: unknown): Promise<void> {
    this.onmessage?.(
      new MessageEvent("message", {
        data: typeof data === "string" ? data : JSON.stringify(data),
      }),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

type VoiceSession = Parameters<typeof connectLiveTranscription>[0];
const token = "fixture-voice-token-not-a-real-secret";
const controllers: AbortController[] = [];

function beginConnection(provider: VoiceSession["provider"] = "openai") {
  const controller = new AbortController();
  controllers.push(controller);
  const session: VoiceSession =
    provider === "openai"
      ? { provider, token, expiresAt: Date.now() + 60_000, sampleRate: 24000 }
      : {
          provider,
          token,
          expiresAt: Date.now() + 60_000,
          sampleRate: 16000,
          setup: {
            model: "models/test-live",
            realtimeInputConfig: {
              automaticActivityDetection: { disabled: true },
            },
          },
        };
  const callbacks = {
    signal: controller.signal,
    onPartial: vi.fn<(text: string) => void>(),
    onTranscript: vi.fn<(text: string) => void>(),
    onError: vi.fn<(error: Error) => void>(),
  };
  const connected = vi.fn();
  const rejected = vi.fn();
  const connection = connectLiveTranscription(session, callbacks);
  void connection.then(connected, rejected);
  const socket = MockWebSocket.instances.at(-1)!;
  return {
    session,
    controller,
    callbacks,
    connected,
    rejected,
    connection,
    socket,
  };
}

async function readyConnection(provider: VoiceSession["provider"] = "openai") {
  const pending = beginConnection(provider);
  pending.socket.open();
  await pending.socket.receive(
    provider === "openai"
      ? { type: "session.created", session: { type: "transcription" } }
      : { setupComplete: {} },
  );
  return { ...pending, controls: await pending.connection };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(new Date("2026-10-22T12:00:00Z"));
  vi.stubGlobal("WebSocket", MockWebSocket);
  MockWebSocket.instances = [];
  controllers.length = 0;
});

afterEach(() => {
  controllers.forEach((controller) => controller.abort());
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("OpenAI live transcription", () => {
  it("waits for session.created with a transcription session", async () => {
    const { socket, connection, connected, callbacks } = beginConnection();
    socket.open();

    await socket.receive({
      type: "session.created",
      session: { type: "realtime" },
    });
    await socket.receive({ type: "session.created" });

    expect(connected).not.toHaveBeenCalled();
    expect(callbacks.onError).not.toHaveBeenCalled();
    expect(socket.send).not.toHaveBeenCalled();
    expect(socket.url).toBe(
      "wss://api.openai.com/v1/realtime?intent=transcription",
    );
    expect(socket.protocols).toEqual([
      "realtime",
      "openai-insecure-api-key." + token,
    ]);

    await socket.receive({
      type: "session.created",
      session: { type: "transcription" },
    });

    await expect(connection).resolves.toEqual({
      start: expect.any(Function),
      append: expect.any(Function),
      commit: expect.any(Function),
    });
    expect(connected).toHaveBeenCalledOnce();
  });

  it("sends append and commit messages for manually segmented PCM audio", async () => {
    const { socket, controls } = await readyConnection();

    controls.start();
    controls.append("AAABAA==");
    controls.append("AgADAA==");
    controls.commit();

    expect(socket.send.mock.calls.map(([data]) => JSON.parse(data))).toEqual([
      { type: "input_audio_buffer.append", audio: "AAABAA==" },
      { type: "input_audio_buffer.append", audio: "AgADAA==" },
      { type: "input_audio_buffer.commit" },
    ]);
  });

  it("drains out-of-order finals in committed order and ignores duplicate events", async () => {
    const { socket, callbacks } = await readyConnection();

    await socket.receive({
      type: "input_audio_buffer.committed",
      item_id: "first",
    });
    await socket.receive({
      type: "input_audio_buffer.committed",
      item_id: "second",
    });
    await socket.receive({
      type: "input_audio_buffer.committed",
      item_id: "second",
    });
    await socket.receive({
      type: "conversation.item.input_audio_transcription.delta",
      item_id: "first",
      delta: "Hello",
    });
    await socket.receive({
      type: "conversation.item.input_audio_transcription.delta",
      item_id: "first",
      delta: " world",
    });
    expect(callbacks.onPartial.mock.calls).toEqual([
      ["Hello"],
      ["Hello world"],
    ]);

    const secondFinal = {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "second",
      transcript: "Second utterance",
    };
    await socket.receive(secondFinal);
    await socket.receive(secondFinal);
    expect(callbacks.onTranscript).not.toHaveBeenCalled();

    const firstFinal = {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "first",
      transcript: "Hello world",
    };
    await socket.receive(firstFinal);

    expect(callbacks.onTranscript.mock.calls).toEqual([
      ["Hello world"],
      ["Second utterance"],
    ]);
    expect(callbacks.onPartial.mock.calls).toEqual([
      ["Hello"],
      ["Hello world"],
      ["Hello world\n\nSecond utterance"],
      [""],
    ]);

    await socket.receive(firstFinal);
    await socket.receive(secondFinal);
    await socket.receive({
      type: "input_audio_buffer.committed",
      item_id: "first",
    });
    await socket.receive({
      type: "conversation.item.input_audio_transcription.delta",
      item_id: "first",
      delta: "late duplicate",
    });

    expect(callbacks.onTranscript).toHaveBeenCalledTimes(2);
    expect(callbacks.onPartial).toHaveBeenCalledTimes(4);
    expect(callbacks.onError).not.toHaveBeenCalled();
  });

  it("retains a final received before its commit acknowledgement", async () => {
    const { socket, callbacks } = await readyConnection();
    await socket.receive({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "early",
      transcript: "Already complete",
    });
    expect(callbacks.onTranscript).not.toHaveBeenCalled();

    await socket.receive({
      type: "input_audio_buffer.committed",
      item_id: "early",
    });

    expect(callbacks.onTranscript).toHaveBeenCalledExactlyOnceWith(
      "Already complete",
    );
    expect(callbacks.onPartial.mock.calls).toEqual([
      ["Already complete"],
      [""],
    ]);
  });

  it("keeps later partials recoverable when an earlier utterance finishes", async () => {
    const { socket, callbacks, controller } = await readyConnection();
    for (const item_id of ["first", "second"])
      await socket.receive({ type: "input_audio_buffer.committed", item_id });
    await socket.receive({
      type: "conversation.item.input_audio_transcription.delta",
      item_id: "second",
      delta: "Keep this correction",
    });
    await socket.receive({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "first",
      transcript: "Start the research",
    });
    expect(callbacks.onTranscript).toHaveBeenCalledExactlyOnceWith(
      "Start the research",
    );
    expect(callbacks.onPartial).toHaveBeenLastCalledWith(
      "Keep this correction",
    );
    controller.abort();
    expect(callbacks.onPartial).toHaveBeenLastCalledWith(
      "Keep this correction",
    );
  });

  it("retains buffered finals and partials in spoken order after disconnection", async () => {
    const { socket, callbacks } = await readyConnection();
    for (const item_id of ["first", "second"])
      await socket.receive({ type: "input_audio_buffer.committed", item_id });
    await socket.receive({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "second",
      transcript: "Then save it",
    });
    await socket.receive({
      type: "conversation.item.input_audio_transcription.delta",
      item_id: "first",
      delta: "Research the subject",
    });
    socket.close();
    expect(callbacks.onTranscript).not.toHaveBeenCalled();
    expect(callbacks.onPartial).toHaveBeenLastCalledWith(
      "Research the subject\n\nThen save it",
    );
    expect(callbacks.onError).toHaveBeenCalledOnce();
  });

  it("closes when more than four committed utterances are waiting for finals", async () => {
    const { socket, callbacks } = await readyConnection();
    for (const item_id of ["one", "two", "three", "four"]) {
      await socket.receive({ type: "input_audio_buffer.committed", item_id });
    }
    expect(callbacks.onError).not.toHaveBeenCalled();

    await socket.receive({
      type: "input_audio_buffer.committed",
      item_id: "five",
    });

    expect(callbacks.onError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        message: expect.stringContaining("falling behind"),
      }),
    );
    expect(socket.close).toHaveBeenCalledOnce();
  });
});

describe("Google live transcription", () => {
  it("sends setup on open and waits for setupComplete", async () => {
    const { session, socket, callbacks, connected, connection } =
      beginConnection("google");
    if (session.provider !== "google")
      throw new Error("Expected a Google voice session.");
    expect(socket.send).not.toHaveBeenCalled();
    socket.open();
    expect(socket.send.mock.calls.map(([data]) => JSON.parse(data))).toEqual([
      { setup: session.setup },
    ]);

    await socket.receive({
      serverContent: { inputTranscription: { text: "before setup" } },
    });
    expect(connected).not.toHaveBeenCalled();
    expect(callbacks.onTranscript).not.toHaveBeenCalled();

    await socket.receive({ setupComplete: {} });

    await expect(connection).resolves.toEqual({
      start: expect.any(Function),
      append: expect.any(Function),
      commit: expect.any(Function),
    });
    expect(new URL(socket.url).searchParams.get("access_token")).toBe(token);
  });

  it("sends activityStart, PCM audio, and activityEnd in order", async () => {
    const { socket, controls } = await readyConnection("google");
    socket.send.mockClear();

    controls.start();
    controls.append("AAABAA==");
    controls.commit();

    expect(socket.send.mock.calls.map(([data]) => JSON.parse(data))).toEqual([
      { realtimeInput: { activityStart: {} } },
      {
        realtimeInput: {
          audio: { data: "AAABAA==", mimeType: "audio/pcm;rate=16000" },
        },
      },
      { realtimeInput: { activityEnd: {} } },
    ]);
  });

  it("keeps interim text partial and emits only final input transcriptions", async () => {
    const { socket, callbacks } = await readyConnection("google");
    await socket.receive({
      serverContent: { interimInputTranscription: { text: "Turn" } },
    });
    await socket.receive({
      serverContent: { interimInputTranscription: { text: "Turn left" } },
    });

    expect(callbacks.onPartial.mock.calls).toEqual([["Turn"], ["Turn left"]]);
    expect(callbacks.onTranscript).not.toHaveBeenCalled();

    await socket.receive({
      serverContent: { inputTranscription: { text: "Turn left now." } },
    });

    expect(callbacks.onTranscript).toHaveBeenCalledExactlyOnceWith(
      "Turn left now.",
    );
    expect(callbacks.onPartial.mock.calls).toEqual([
      ["Turn"],
      ["Turn left"],
      [""],
    ]);
  });

  it("reports goAway and closes the connection", async () => {
    const { socket, callbacks } = await readyConnection("google");
    await socket.receive({ goAway: { timeLeft: "10s" } });

    expect(callbacks.onError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        message: expect.stringContaining("ending this session"),
      }),
    );
    expect(socket.close).toHaveBeenCalledOnce();
  });
});

describe.each(["openai", "google"] as const)(
  "%s connection lifecycle",
  (provider) => {
    it("rejects a socket error before readiness without calling onError", async () => {
      const { socket, connection, callbacks } = beginConnection(provider);
      const rejected = expect(connection).rejects.toThrow(
        "Live voice could not connect",
      );

      socket.onerror?.(new Event("error"));

      await rejected;
      expect(callbacks.onError).not.toHaveBeenCalled();
      expect(socket.close).toHaveBeenCalledOnce();
    });

    it("times out if the provider never becomes ready", async () => {
      const { socket, connection, callbacks } = beginConnection(provider);
      const rejected = expect(connection).rejects.toThrow(
        "connection timed out",
      );
      socket.open();

      await vi.advanceTimersByTimeAsync(20_000);

      await rejected;
      expect(callbacks.onError).not.toHaveBeenCalled();
      expect(socket.close).toHaveBeenCalledOnce();
    });

    it("aborts a pending connection and closes the socket", async () => {
      const { socket, controller, connection, callbacks } =
        beginConnection(provider);
      const reason = new Error("Capture cancelled");
      const rejected = expect(connection).rejects.toBe(reason);

      controller.abort(reason);

      await rejected;
      expect(socket.close).toHaveBeenCalledOnce();
      expect(callbacks.onError).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("aborts an active connection and ignores later provider messages", async () => {
      const { socket, controller, controls, callbacks } =
        await readyConnection(provider);
      socket.send.mockClear();

      controller.abort();
      await socket.receive({ error: { message: "late provider error" } });
      await socket.receive({
        serverContent: { inputTranscription: { text: "late transcript" } },
      });
      await vi.advanceTimersByTimeAsync(25 * 60_000);

      expect(socket.close).toHaveBeenCalledOnce();
      expect(callbacks.onError).not.toHaveBeenCalled();
      expect(callbacks.onTranscript).not.toHaveBeenCalled();
      expect(() => controls.append("AAAA")).toThrow("disconnected");
      expect(() => controls.commit()).toThrow("disconnected");
      expect(socket.send).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("reports a transport failure only once after readiness", async () => {
      const { socket, callbacks } = await readyConnection(provider);

      socket.onerror?.(new Event("error"));
      socket.onerror?.(new Event("error"));
      socket.onclose?.(new Event("close"));

      expect(callbacks.onError).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          message: expect.stringContaining("could not connect"),
        }),
      );
      expect(socket.close).toHaveBeenCalledOnce();
    });

    it("reports an unexpected close after readiness", async () => {
      const { socket, callbacks } = await readyConnection(provider);
      socket.readyState = MockWebSocket.CLOSED;

      socket.onclose?.(new Event("close"));

      expect(callbacks.onError).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          message: expect.stringContaining("disconnected"),
        }),
      );
      expect(socket.close).toHaveBeenCalledOnce();
    });

    it("rejects append and commit above the backpressure limit", async () => {
      const { socket, controls } = await readyConnection(provider);
      socket.send.mockClear();
      socket.bufferedAmount = 512_000;
      controls.append("AAABAA==");
      expect(socket.send).toHaveBeenCalledOnce();

      socket.send.mockClear();
      socket.bufferedAmount = 512_001;
      expect(() => controls.append("AAABAA==")).toThrow("cannot keep up");
      expect(() => controls.commit()).toThrow("cannot keep up");
      if (provider === "google")
        expect(() => controls.start()).toThrow("cannot keep up");
      expect(socket.send).not.toHaveBeenCalled();
    });

    it.each([
      ["malformed JSON", "invalid-json"],
      ["non-object JSON", "null"],
      ["provider error", { error: { message: "transcription unavailable" } }],
      [
        "failed transcription",
        { type: "conversation.item.input_audio_transcription.failed" },
      ],
      ["oversized event", "x".repeat(256_001)],
    ])("closes on %s after readiness", async (_label, event) => {
      const { socket, callbacks } = await readyConnection(provider);

      await socket.receive(event);

      expect(callbacks.onError).toHaveBeenCalledExactlyOnceWith(
        expect.any(Error),
      );
      expect(socket.close).toHaveBeenCalledOnce();
      expect(callbacks.onTranscript).not.toHaveBeenCalled();
    });

    it("does not log or surface credentials from provider diagnostics", async () => {
      const logs = [
        vi.spyOn(console, "log").mockImplementation(() => undefined),
        vi.spyOn(console, "info").mockImplementation(() => undefined),
        vi.spyOn(console, "debug").mockImplementation(() => undefined),
        vi.spyOn(console, "warn").mockImplementation(() => undefined),
        vi.spyOn(console, "error").mockImplementation(() => undefined),
      ];
      const { socket, callbacks } = await readyConnection(provider);

      await socket.receive({
        error: {
          message: "Rejected credential: " + token,
          token,
          endpoint: socket.url,
        },
      });

      expect(callbacks.onError).toHaveBeenCalledOnce();
      expect(callbacks.onError.mock.calls[0]![0].message).not.toContain(token);
      logs.forEach((log) => expect(log).not.toHaveBeenCalled());
    });
  },
);
