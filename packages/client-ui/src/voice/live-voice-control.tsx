import { useEffect, useRef, useState, type JSX } from "react";
import { AudioLines, Square } from "lucide-react";
import {
  createSystemSpeechHandle,
  markdownToSpeech,
  speechPlayback,
} from "@machdoch/speech";
import type {
  LiveVoiceRequest,
  LiveVoiceSession,
} from "@machdoch/fleet-protocol/live-voice";
import { connectLiveTranscription } from "./live-connection";
import { startLiveVoiceCapture, supportsLiveVoice } from "./live-capture";

export interface LiveVoiceControlProps {
  identity: string;
  workspaceRoot: string;
  disabled?: boolean | undefined;
  inputDeviceId?: string | null | undefined;
  invoke: <T>(input: LiveVoiceRequest) => Promise<T>;
  onTranscript: (text: string) => Promise<void>;
  onSpeechStart: () => void;
  onActiveChange?: ((active: boolean) => void) | undefined;
  replyPlayback?:
    | { enabled: boolean; onChange: (enabled: boolean) => void }
    | undefined;
  browserReply?: { id: string; text: string } | null | undefined;
}

export function LiveVoiceControl(props: LiveVoiceControlProps): JSX.Element {
  return (
    <LiveVoiceSessionControl
      key={JSON.stringify([props.identity, props.workspaceRoot])}
      {...props}
    />
  );
}

function LiveVoiceSessionControl(props: LiveVoiceControlProps): JSX.Element {
  const current = useRef(props);
  current.current = props;
  const controller = useRef<AbortController | null>(null);
  const [state, setState] = useState<"idle" | "connecting" | "listening">(
    "idle",
  );
  const [partial, setPartial] = useState("");
  const partialText = useRef("");
  const [unsent, setUnsent] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [delivering, setDelivering] = useState(false);
  const [speakReplies, setSpeakReplies] = useState(true);
  const lastReply = useRef<string | undefined>(undefined);
  const queuedTranscripts = useRef<string[]>([]);
  const owner = `live-voice:${props.identity}`;
  useEffect(() => {
    current.current.onActiveChange?.(state !== "idle");
  }, [state]);
  useEffect(
    () => () => {
      current.current.onActiveChange?.(false);
    },
    [],
  );
  const stop = (): void => {
    const unfinished = partialText.current.trim();
    if (unfinished) queuedTranscripts.current.push(unfinished);
    partialText.current = "";
    setUnsent(queuedTranscripts.current.join("\n\n"));
    controller.current?.abort();
    controller.current = null;
    speechPlayback.stop(owner);
    setState("idle");
    setPartial("");
  };
  useEffect(
    () => () => {
      controller.current?.abort();
      controller.current = null;
      speechPlayback.stop(owner);
    },
    [owner],
  );
  useEffect(() => {
    if (
      state !== "listening" ||
      !speakReplies ||
      !props.browserReply ||
      props.browserReply.id === lastReply.current
    )
      return;
    lastReply.current = props.browserReply.id;
    const text = markdownToSpeech(props.browserReply.text).slice(0, 12_000);
    if (text)
      void speechPlayback.play({
        owner,
        itemId: props.browserReply.id,
        open: async (signal) => createSystemSpeechHandle(text, { signal }),
      });
  }, [owner, props.browserReply, speakReplies, state]);
  useEffect(
    () =>
      speechPlayback.subscribe((playback) => {
        if (playback.owner === owner && playback.error)
          setError(playback.error);
      }),
    [owner],
  );

  const start = async (): Promise<void> => {
    if (!supportsLiveVoice()) {
      setError(
        "Live voice needs microphone access in a secure browser or the desktop app.",
      );
      return;
    }
    const active = new AbortController();
    controller.current = active;
    setError(null);
    setState("connecting");
    lastReply.current = current.current.browserReply?.id;
    let pending = 0;
    let submissions = Promise.resolve();
    const queued: string[] = [];
    queuedTranscripts.current = queued;
    const fail = (cause: unknown): void => {
      if (active.signal.aborted) return;
      setUnsent(queued.join("\n\n"));
      setError(cause instanceof Error ? cause.message : String(cause));
      stop();
    };
    try {
      const session = await current.current.invoke<LiveVoiceSession>({
        action: "session",
      });
      active.signal.throwIfAborted();
      const connection = await connectLiveTranscription(session, {
        signal: active.signal,
        onPartial: (text) => {
          if (active.signal.aborted) return;
          partialText.current = text;
          setPartial(text);
        },
        onError: fail,
        onTranscript: (value) => {
          const text = value.trim();
          if (!text || active.signal.aborted) return;
          partialText.current = "";
          setPartial("");
          queued.push(text);
          if (++pending > 4) {
            fail(
              new Error(
                "Voice messages are arriving too quickly. Send the remaining text below.",
              ),
            );
            return;
          }
          submissions = submissions
            .then(async () => {
              active.signal.throwIfAborted();
              const result = await current.current.invoke<{ text: string }>({
                action: "process",
                text,
              });
              active.signal.throwIfAborted();
              if (
                typeof result.text !== "string" ||
                !result.text.trim() ||
                result.text.length > 20_000
              )
                throw new Error(
                  "The edited transcript is invalid. Send the original text below.",
                );
              setDelivering(true);
              try {
                await current.current.onTranscript(result.text);
                queued.shift();
                pending--;
                if (active.signal.aborted && !controller.current)
                  setUnsent(queued.join("\n\n"));
              } finally {
                setDelivering(false);
              }
            })
            .catch(fail);
        },
      });
      await startLiveVoiceCapture({
        signal: active.signal,
        sampleRate: session.sampleRate,
        inputDeviceId: current.current.inputDeviceId,
        onSpeechStart: () => {
          speechPlayback.stop(owner);
          current.current.onSpeechStart();
          connection.start();
        },
        onAudio: connection.append,
        onSpeechEnd: connection.commit,
        onError: fail,
      });
      active.signal.throwIfAborted();
      setState("listening");
    } catch (cause) {
      fail(cause);
    }
  };
  return (
    <div className="grid gap-2 text-sm">
      <div className="flex items-center gap-3">
        <button
          type="button"
          className="inline-flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-slate-500/15 disabled:opacity-50"
          aria-pressed={state !== "idle"}
          disabled={
            state === "idle" &&
            (props.disabled || retrying || delivering || Boolean(unsent))
          }
          onClick={() => {
            if (state === "idle") void start();
            else stop();
          }}
        >
          {state === "idle" ? (
            <AudioLines size={16} aria-hidden="true" />
          ) : (
            <Square size={16} aria-hidden="true" />
          )}
          {state === "idle"
            ? "Live voice"
            : state === "connecting"
              ? "Cancel connection"
              : "Stop listening"}
        </button>
        {state === "listening" &&
        (props.replyPlayback || props.browserReply !== undefined) ? (
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={props.replyPlayback?.enabled ?? speakReplies}
              onChange={(event) => {
                if (props.replyPlayback)
                  props.replyPlayback.onChange(event.target.checked);
                else setSpeakReplies(event.target.checked);
                if (!event.target.checked) {
                  speechPlayback.stop(owner);
                  props.onSpeechStart();
                }
              }}
            />
            Speak replies
          </label>
        ) : null}
      </div>
      {partial ? (
        <p role="status" className="max-h-24 overflow-auto px-2">
          {partial}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="px-2 text-red-500">
          {error}
        </p>
      ) : null}
      {unsent ? (
        <div className="grid gap-2">
          <textarea
            aria-label="Unsent voice message"
            disabled={retrying || delivering}
            value={unsent}
            onChange={(event) => setUnsent(event.target.value)}
            rows={3}
            className="rounded-md border border-current/20 bg-transparent p-2"
          />
          {delivering && <p role="status">Sending voice message…</p>}
          <div className="flex gap-3">
            <button
              type="button"
              disabled={
                retrying || delivering || props.disabled || !unsent.trim()
              }
              onClick={() => {
                setRetrying(true);
                void current.current
                  .onTranscript(unsent)
                  .then(() => {
                    setUnsent("");
                    setError(null);
                  })
                  .catch((cause: unknown) => setError(String(cause)))
                  .finally(() => setRetrying(false));
              }}
            >
              Send text
            </button>
            <button
              type="button"
              disabled={retrying || delivering}
              onClick={() => {
                setUnsent("");
                setError(null);
              }}
            >
              Discard
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
