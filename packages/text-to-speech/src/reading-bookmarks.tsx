import { useRef, useState } from "react";
import {
  createSpeechReadingBookmark,
  resolveSpeechReadingBookmark,
  speechPlayback,
  type PlaybackState,
  type SpeechReadingBookmark,
  type SpeechReadingSequence,
} from "@machdoch/speech";
import { Field, OWNER, type Run } from "./controls.tsx";

const PAGE_SIZE = 20;

export function ReadingBookmarks({
  bookmarks,
  sequence,
  itemId,
  state,
  busy,
  run,
  onRead,
  onChange,
  onEmpty,
}: {
  bookmarks: SpeechReadingBookmark[];
  sequence: SpeechReadingSequence | null;
  itemId: string | null;
  state: PlaybackState;
  busy: boolean;
  run: Run;
  onRead(seconds: number): Promise<void>;
  onChange(bookmarks: SpeechReadingBookmark[]): void;
  onEmpty(): void;
}) {
  const [name, setName] = useState("");
  const [page, setPage] = useState(0);
  const section = useRef<HTMLElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const pageCount = Math.max(1, Math.ceil(bookmarks.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const canCapture =
    !!sequence &&
    !!itemId &&
    state.owner === OWNER &&
    state.itemId === itemId &&
    state.seekable &&
    Number.isFinite(state.position) &&
    state.position >= 0 &&
    state.position <= sequence.duration;

  if (!canCapture && !bookmarks.length) return null;

  return (
    <section ref={section} tabIndex={-1} className="tts-stack" aria-label="Reading bookmarks">
      <h3>Reading bookmarks</h3>
      {canCapture && <form
        className="tts-row"
        onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            const current = speechPlayback.snapshot();
            if (
              !sequence ||
              !itemId ||
              current.owner !== OWNER ||
              current.itemId !== itemId ||
              !current.seekable
            )
              throw new Error("Read the project before adding a bookmark.");
            const bookmark = createSpeechReadingBookmark(
              sequence,
              current.position,
              crypto.randomUUID(),
              name,
            );
            onChange([...bookmarks, bookmark]);
            setName("");
            setPage(Math.floor(bookmarks.length / PAGE_SIZE));
            nameInput.current?.focus();
          });
        }}
      >
        <Field label="Bookmark name">
          <input
            ref={nameInput}
            required
            maxLength={1024}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <button type="submit" disabled={busy || !canCapture || !name.trim()}>
          Add bookmark
        </button>
      </form>}
      {!!bookmarks.length && (
        <ol start={currentPage * PAGE_SIZE + 1}>
          {bookmarks
            .slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE)
            .map((bookmark) => {
              const resolved = sequence
                ? resolveSpeechReadingBookmark(sequence, bookmark)
                : {
                    available: false as const,
                    reason:
                      "Select production takes with measured audio before reading this bookmark.",
                  };
              return (
                <li key={bookmark.id}>
                  <div className="tts-row">
                    <span dir="auto">{bookmark.label}</span>
                    <button
                      disabled={busy || !resolved.available}
                      aria-label={`Read bookmark ${bookmark.label}`}
                      onClick={() =>
                        void run(async () => {
                          if (!resolved.available) throw new Error(resolved.reason);
                          await onRead(resolved.seconds);
                        })
                      }
                    >
                      Read
                    </button>
                    <button
                      disabled={busy}
                      aria-label={`Remove bookmark ${bookmark.label}`}
                      onClick={() =>
                        void run(async () => {
                          onChange(bookmarks.filter((entry) => entry.id !== bookmark.id));
                          if (bookmarks.length === 1 && !canCapture) onEmpty();
                          else if (bookmarks.length === 1) nameInput.current?.focus();
                          else section.current?.focus();
                        })
                      }
                    >
                      Remove
                    </button>
                  </div>
                  {!resolved.available && <p>{resolved.reason}</p>}
                </li>
              );
            })}
        </ol>
      )}
      {pageCount > 1 && (
        <nav className="tts-row" aria-label="Reading bookmark pages">
          <button
            disabled={busy || currentPage === 0}
            onClick={() => { setPage(currentPage - 1); section.current?.focus(); }}
          >
            Previous bookmarks
          </button>
          <span>{currentPage + 1} / {pageCount}</span>
          <button
            disabled={busy || currentPage === pageCount - 1}
            onClick={() => { setPage(currentPage + 1); section.current?.focus(); }}
          >
            Next bookmarks
          </button>
        </nav>
      )}
    </section>
  );
}
