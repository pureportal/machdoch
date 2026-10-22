import {
  liveVoiceSessionSchema,
  type LiveVoiceSession,
} from "@machdoch/fleet-protocol/live-voice";

interface VoiceEvent {
  type?: string;
  item_id?: string;
  delta?: string;
  transcript?: string;
  session?: { type?: string };
  error?: unknown;
  setupComplete?: unknown;
  goAway?: unknown;
  serverContent?: {
    interimInputTranscription?: { text?: string };
    inputTranscription?: { text?: string };
  };
}

export interface LiveTranscriptionCallbacks {
  signal: AbortSignal;
  onPartial: (text: string) => void;
  onTranscript: (text: string) => void;
  onError: (error: Error) => void;
}

export async function connectLiveTranscription(
  input: LiveVoiceSession,
  options: LiveTranscriptionCallbacks,
): Promise<{
  start: () => void;
  append: (audio: string) => void;
  commit: () => void;
}> {
  const session = liveVoiceSessionSchema.parse(input);
  options.signal.throwIfAborted();
  if (session.expiresAt <= Date.now())
    throw new Error("The voice session expired. Start live voice again.");
  const socket =
    session.provider === "openai"
      ? new WebSocket("wss://api.openai.com/v1/realtime?intent=transcription", [
          "realtime",
          `openai-insecure-api-key.${session.token}`,
        ])
      : new WebSocket(
          `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained?access_token=${encodeURIComponent(session.token)}`,
        );
  let ready = false;
  let stopped = false;
  let segments = 0;
  const order: string[] = [];
  const transcripts = new Map<string, string>();
  const partials = new Map<string, string>();
  const completed = new Set<string>();
  let pendingText = "";
  const publishPendingText = (force = false): void => {
    const ids = new Set([...order, ...partials.keys(), ...transcripts.keys()]);
    const text = [...ids]
      .map((id) => transcripts.get(id) ?? partials.get(id) ?? "")
      .filter(Boolean)
      .join("\n\n");
    if (force || text !== pendingText) options.onPartial(text);
    pendingText = text;
  };
  const send = (message: unknown): void => {
    if (stopped || socket.readyState !== WebSocket.OPEN)
      throw new Error("Live voice disconnected. Start it again.");
    if (socket.bufferedAmount > 512_000)
      throw new Error(
        "Live voice cannot keep up with the connection. Start it again when the connection improves.",
      );
    socket.send(JSON.stringify(message));
  };
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => fail(new Error("Live voice connection timed out. Start it again.")),
      20_000,
    );
    const lifetime = setTimeout(
      () =>
        fail(
          new Error(
            "The live voice session ended. Start it again to continue.",
          ),
        ),
      25 * 60_000,
    );
    const close = (): void => {
      stopped = true;
      clearTimeout(timeout);
      clearTimeout(lifetime);
      options.signal.removeEventListener("abort", abort);
      socket.close();
    };
    const abort = (): void => {
      close();
      reject(options.signal.reason);
    };
    const fail = (error: Error): void => {
      if (stopped) return;
      close();
      if (!ready) reject(error);
      else options.onError(error);
    };
    options.signal.addEventListener("abort", abort, { once: true });
    if (options.signal.aborted) {
      abort();
      return;
    }
    socket.onopen = () => {
      try {
        if (session.provider === "google") send({ setup: session.setup });
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    };
    socket.onerror = () =>
      fail(
        new Error(
          "Live voice could not connect. Check the provider and your network, then try again.",
        ),
      );
    socket.onclose = (event) => {
      if (stopped) return;
      const reason = typeof event?.reason === "string" ? event.reason : "";
      fail(
        new Error(
          /credit|billing|quota/iu.test(reason)
            ? `${session.provider === "google" ? "Google" : "OpenAI"} speech credits are unavailable. Check the provider's billing, then start live voice again.`
            : "Live voice disconnected. Start it again to continue.",
        ),
      );
    };
    let events = Promise.resolve();
    const receive = async (event: MessageEvent): Promise<void> => {
      if (event.data instanceof Blob && event.data.size > 256_000)
        throw new Error("The voice provider returned an oversized event.");
      const raw =
        typeof event.data === "string"
          ? event.data
          : event.data instanceof Blob
            ? await event.data.text()
            : "";
      if (stopped) return;
      if (raw.length > 256_000)
        throw new Error("The voice provider returned an oversized event.");
      const data = JSON.parse(raw) as VoiceEvent;
      if (!data || typeof data !== "object")
        throw new Error("The voice provider returned an invalid event.");
      if (
        data.error ||
        data.type === "conversation.item.input_audio_transcription.failed"
      )
        throw new Error(
          "The voice provider could not transcribe the audio. Check model access and start live voice again.",
        );
      if (
        !ready &&
        (session.provider === "openai"
          ? data.type === "session.created" &&
            data.session?.type === "transcription"
          : data.setupComplete)
      ) {
        ready = true;
        clearTimeout(timeout);
        resolve();
      }
      if (!ready) return;
      if (session.provider === "google") {
        const content = data.serverContent;
        if (typeof content?.interimInputTranscription?.text === "string")
          options.onPartial(
            content.interimInputTranscription.text.slice(0, 20_000),
          );
        if (typeof content?.inputTranscription?.text === "string") {
          if (content.inputTranscription.text.length > 20_000)
            throw new Error(
              "The voice transcript is too long. Use shorter utterances.",
            );
          options.onTranscript(content.inputTranscription.text);
          options.onPartial("");
        }
        if (data.goAway)
          fail(
            new Error(
              "The voice provider is ending this session. Start live voice again.",
            ),
          );
        return;
      }
      const id = data.item_id;
      if (typeof id !== "string" || id.length > 200 || completed.has(id))
        return;
      if (data.type === "input_audio_buffer.committed" && !order.includes(id))
        order.push(id);
      if (
        data.type === "conversation.item.input_audio_transcription.delta" &&
        typeof data.delta === "string"
      ) {
        const text = (partials.get(id) ?? "") + data.delta;
        if (text.length > 20_000)
          throw new Error(
            "The voice transcript is too long. Use shorter utterances.",
          );
        partials.set(id, text);
        publishPendingText();
      }
      if (
        data.type === "conversation.item.input_audio_transcription.completed" &&
        typeof data.transcript === "string"
      ) {
        if (data.transcript.length > 20_000)
          throw new Error(
            "The voice transcript is too long. Use shorter utterances.",
          );
        transcripts.set(id, data.transcript);
      }
      let delivered = false;
      while (order.length && transcripts.has(order[0]!)) {
        const next = order.shift()!;
        const text = transcripts.get(next)!;
        transcripts.delete(next);
        partials.delete(next);
        completed.add(next);
        options.onTranscript(text);
        delivered = true;
      }
      if (
        data.type === "conversation.item.input_audio_transcription.completed" ||
        data.type === "input_audio_buffer.committed"
      )
        publishPendingText(delivered);
      if (order.length > 4 || transcripts.size > 4 || partials.size > 4)
        throw new Error(
          "Transcription is falling behind. Start live voice again.",
        );
    };
    socket.onmessage = (event: MessageEvent): void => {
      events = events
        .then(() => receive(event))
        .catch((error: unknown) =>
          fail(error instanceof Error ? error : new Error(String(error))),
        );
    };
  });
  return {
    start: () => {
      if (++segments > 1000)
        throw new Error("Start a new live voice session to continue.");
      if (session.provider === "google")
        send({ realtimeInput: { activityStart: {} } });
    },
    append: (audio) =>
      send(
        session.provider === "openai"
          ? { type: "input_audio_buffer.append", audio }
          : {
              realtimeInput: {
                audio: { data: audio, mimeType: "audio/pcm;rate=16000" },
              },
            },
      ),
    commit: () =>
      send(
        session.provider === "openai"
          ? { type: "input_audio_buffer.commit" }
          : { realtimeInput: { activityEnd: {} } },
      ),
  };
}
