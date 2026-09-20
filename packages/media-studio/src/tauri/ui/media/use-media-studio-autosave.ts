import { useCallback, useEffect, useRef, useState } from "react";
import type { MediaStudioState } from "../../../core/media/contracts.js";
import { saveMediaStudioState } from "./media-studio-store";

export function useMediaStudioAutosave(
  state: MediaStudioState,
  enabled: boolean,
) {
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<MediaStudioState | null>(null);
  const sequence = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(state);
  latest.current = state;

  const flush = useCallback(async () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    const value = pending.current;
    if (!value) return;
    pending.current = null;
    const saving = ++sequence.current;
    try {
      await saveMediaStudioState(value);
      if (saving === sequence.current) setError(null);
    } catch (failure: unknown) {
      if (saving === sequence.current) {
        setError(
          failure instanceof Error
            ? failure.message
            : "Media Studio settings could not be saved.",
        );
      }
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    pending.current = state;
    timer.current = setTimeout(() => void flush(), 250);
    return () => {
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, [enabled, flush, state]);

  useEffect(() => {
    const save = () => void flush();
    window.addEventListener("pagehide", save);
    return () => {
      window.removeEventListener("pagehide", save);
      save();
    };
  }, [flush]);

  const retry = useCallback(async () => {
    if (!enabled) return;
    pending.current = latest.current;
    await flush();
  }, [enabled, flush]);

  return { error, retry };
}
