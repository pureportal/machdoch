import { useEffect, useMemo, useRef, useState } from "react";
import {
  createAudioSequencePlaybackHandle,
  parseSpeechReadingPosition,
  speechPlayback,
  speechReadingCues,
  speechReadingSequence,
  type PlaybackState,
  type SpeechProject,
  type SpeechTake,
  type SpeechReadingSequence,
  type SpeechReadingBookmark,
} from "@machdoch/speech";
import { Field, OWNER, errorText, type Run } from "./controls.tsx";
import { ReadingBookmarks } from "./reading-bookmarks.tsx";

export function ReadingPlayer({
  project,
  takes,
  segments,
  ready,
  visible,
  assetUrl,
  run,
  busy,
  rate,
  onReadingBookmarksChange,
}: {
  project: SpeechProject;
  takes: SpeechTake[];
  segments: string[];
  ready: boolean;
  visible: boolean;
  assetUrl(path: string): string;
  run: Run;
  busy: boolean;
  rate: number;
  onReadingBookmarksChange(bookmarks: SpeechReadingBookmark[]): void;
}) {
  const [state, setState] = useState<PlaybackState>(() =>
    speechPlayback.snapshot(),
  );
  const [resume, setResume] = useState<number | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [follow, setFollow] = useState(true);
  const active = useRef<HTMLButtonElement>(null);
  const readingRegion = useRef<HTMLElement>(null);
  const [prepared, setPrepared] = useState<{
    error: string | null;
    sequence: SpeechReadingSequence | null;
  }>({ error: "Analyzing script…", sequence: null });
  useEffect(() => {
    if (!ready) {
      setPrepared({ error: "Analyzing script…", sequence: null });
      return;
    }
    let disposed = false;
    void speechReadingSequence(project, takes, segments)
      .then((sequence) => {
        if (!disposed) setPrepared({ error: null, sequence });
      })
      .catch((error) => {
        if (!disposed) setPrepared({ error: errorText(error), sequence: null });
      });
    return () => {
      disposed = true;
    };
  }, [project, takes, segments.join("\0"), ready]);
  const sequence = prepared.sequence;
  const signature = sequence?.signature;
  const itemId = signature ? `reading:${signature}` : null;
  const storageKey = `machdoch:speech:reading:${project.id}`;
  const own = !!itemId && state.owner === OWNER && state.itemId === itemId;
  const position = own ? state.position : (resume ?? 0);
  let takeIndex = 0;
  if (sequence)
    for (let index = 1; index < sequence.offsets.length; index++) {
      if (sequence.offsets[index]! > position) break;
      takeIndex = index;
    }
  const take = sequence?.takes[takeIndex];
  const offset = sequence?.offsets[takeIndex] ?? 0;
  const measured = useMemo(() => {
    try {
      return { cues: take ? speechReadingCues(take) : [], error: null };
    } catch (error) {
      return { cues: [], error: errorText(error) };
    }
  }, [take]);
  const cueIndex = measured.cues.findIndex(
    (cue) => position - offset >= cue.start && position - offset < cue.end,
  );
  const chapters =
    sequence?.takes.flatMap((take, index) =>
      take.chapter &&
      (!index || sequence.takes[index - 1]!.chapter?.id !== take.chapter.id)
        ? [{ ...take.chapter, start: sequence.offsets[index]! }]
        : [],
    ) ?? [];

  useEffect(() => speechPlayback.subscribe(setState), []);
  useEffect(() => {
    setFailure(null);
    setResume(null);
    if (!sequence || !itemId) return;
    try {
      const stored = localStorage.getItem(storageKey);
      if (stored !== null)
        setResume(parseSpeechReadingPosition(JSON.parse(stored), sequence));
    } catch (error) {
      setFailure(errorText(error));
    }
    let lastWritten = 0;
    let pending: number | null = null;
    const flush = () => {
      if (pending === null) return;
      try {
        localStorage.setItem(
          storageKey,
          JSON.stringify({ signature, seconds: pending }),
        );
        setResume(pending);
        pending = null;
        lastWritten = performance.now();
      } catch (error) {
        setFailure(errorText(error));
      }
    };
    const unsubscribe = speechPlayback.subscribe((value) => {
      if (value.owner !== OWNER || value.itemId !== itemId || !value.seekable)
        return;
      pending = Math.min(value.position, sequence.duration);
      if (
        (value.status !== "playing" && value.status !== "loading") ||
        performance.now() - lastWritten >= 500
      )
        flush();
    });
    window.addEventListener("pagehide", flush);
    return () => {
      flush();
      unsubscribe();
      window.removeEventListener("pagehide", flush);
      if (speechPlayback.snapshot().itemId === itemId)
        speechPlayback.stop(OWNER);
    };
  }, [signature, storageKey, itemId]);
  useEffect(() => {
    if (visible && own && follow && cueIndex >= 0)
      active.current?.scrollIntoView({ block: "nearest" });
  }, [visible, own, follow, takeIndex, cueIndex]);

  async function play(seconds: number): Promise<void> {
    if (!sequence || !itemId)
      throw new Error(
        prepared.error ?? "Select production takes before reading.",
      );
    const current = speechPlayback.snapshot();
    if (current.owner === OWNER && current.itemId === itemId) {
      if (current.loop) speechPlayback.setLoop(null);
      speechPlayback.seek(seconds);
      await speechPlayback.resume();
      return;
    }
    await speechPlayback.play({
      owner: OWNER,
      itemId,
      open: async (signal) => {
        const handle = createAudioSequencePlaybackHandle(
          sequence.takes.map((take) => ({
            url: assetUrl(take.asset.path),
            duration: take.asset.duration,
          })),
          { signal, rate },
        );
        if (seconds > 0) handle.seek(seconds);
        return handle;
      },
    });
  }
  const previous =
    cueIndex >= 0
      ? measured.cues[cueIndex - 1]
      : measured.cues.filter((cue) => cue.start < position - offset).at(-1);
  const next = measured.cues.find(
    (cue) => cue.start > position - offset + 0.001,
  );
  return (
    <section ref={readingRegion} tabIndex={-1} className="tts-stack" aria-label="Reading audio">
      <h2>Reading</h2>
      <div className="tts-row">
        <button
          disabled={busy || !sequence}
          onClick={() => void run(() => play(0))}
        >
          Read project
        </button>
        {sequence &&
          resume !== null &&
          resume > 0 &&
          resume < sequence.duration && (
            <button
              disabled={busy}
              onClick={() => void run(() => play(resume))}
            >
              Resume reading
            </button>
          )}
        <button
          disabled={busy || !sequence || takeIndex === 0}
          onClick={() =>
            void run(() => play(sequence!.offsets[takeIndex - 1]!))
          }
        >
          Previous take
        </button>
        <button
          disabled={busy || !sequence || takeIndex >= sequence.takes.length - 1}
          onClick={() =>
            void run(() => play(sequence!.offsets[takeIndex + 1]!))
          }
        >
          Next take
        </button>
        {!!chapters.length && (
          <Field label="Reading chapter">
            <select
              value=""
              onChange={(event) => {
                if (event.target.value !== "")
                  void run(() => play(Number(event.target.value)));
              }}
            >
              <option value="">Choose chapter</option>
              {chapters.map((chapter, index) => (
                <option key={`${chapter.id}:${index}`} value={chapter.start}>
                  {chapter.title}
                </option>
              ))}
            </select>
          </Field>
        )}
      </div>
      <ReadingBookmarks
        key={project.id}
        bookmarks={project.readingBookmarks ?? []}
        sequence={sequence}
        itemId={itemId}
        state={state}
        busy={busy}
        run={run}
        onRead={play}
        onChange={onReadingBookmarksChange}
        onEmpty={() => readingRegion.current?.focus()}
      />
      {prepared.error && <p>{prepared.error}</p>}
      {measured.error && <p role="alert">{measured.error}</p>}
      {!!measured.cues.length && (
        <>
          <div className="tts-row">
            <button
              disabled={busy || !previous}
              onClick={() => void run(() => play(offset + previous!.start))}
            >
              Previous passage
            </button>
            <button
              disabled={busy || !next}
              onClick={() => void run(() => play(offset + next!.start))}
            >
              Next passage
            </button>
            <label className="tts-check">
              <input
                type="checkbox"
                checked={follow}
                onChange={(event) => setFollow(event.target.checked)}
              />
              Follow transcript
            </label>
          </div>
          <ol
            dir="auto"
            aria-label="Measured reading transcript"
            style={{ maxHeight: 320, overflow: "auto" }}
          >
            {measured.cues
              .slice(
                Math.max(0, cueIndex - 15),
                Math.max(0, cueIndex - 15) + 31,
              )
              .map((cue, index) => (
                <li key={`${cue.start}:${index}`}>
                  <button
                    ref={
                      own && cueIndex === Math.max(0, cueIndex - 15) + index
                        ? active
                        : undefined
                    }
                    aria-current={
                      own && cueIndex === Math.max(0, cueIndex - 15) + index
                        ? "step"
                        : undefined
                    }
                    onClick={() => void run(() => play(offset + cue.start))}
                  >
                    {cue.text}
                  </button>
                </li>
              ))}
          </ol>
        </>
      )}
      {take && !measured.cues.length && <p dir="auto">{take.spokenText}</p>}
      {failure && <p role="alert">{failure}</p>}
      {resume !== null || failure ? (
        <button
          onClick={() => {
            try {
              localStorage.removeItem(storageKey);
              setResume(null);
              setFailure(null);
            } catch (error) {
              setFailure(errorText(error));
            }
          }}
        >
          Clear reading position
        </button>
      ) : null}
    </section>
  );
}
