import { useCallback, useEffect, useRef, useState } from "react";
import {
  EMPTY_MEDIA_RUNTIME_SETUP,
  getMediaRuntimeSetup,
  isMediaRuntimeSetupActive,
  startMediaRuntimeSetup,
  type MediaRuntimeSetupStatus,
} from "./media-runtime-setup";

export const useMediaRuntimeSetup = (onReady: () => Promise<void>) => {
  const [status, setStatus] = useState(EMPTY_MEDIA_RUNTIME_SETUP);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [statusUnavailable, setStatusUnavailable] = useState(false);
  const mounted = useRef(false);
  const starting = useRef(false);
  const sequence = useRef(0);
  const completionHandled = useRef(false);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  const refresh = useCallback(async (): Promise<void> => {
    try {
      await onReadyRef.current();
      if (mounted.current) setRefreshFailed(false);
    } catch {
      if (mounted.current) setRefreshFailed(true);
    }
  }, []);

  const accept = useCallback(
    (next: MediaRuntimeSetupStatus): void => {
      setStatus(next);
      if (next.phase !== "ready") completionHandled.current = false;
      if (next.phase === "ready" && !completionHandled.current) {
        completionHandled.current = true;
        void refresh();
      }
    },
    [refresh],
  );

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (
      ![
        "idle",
        "checking",
        "downloading",
        "python",
        "dependencies",
        "verifying",
        "models",
      ].includes(status.phase)
    )
      return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async (): Promise<void> => {
      const request = sequence.current;
      try {
        const next = await getMediaRuntimeSetup();
        if (disposed || !mounted.current) return;
        if (request !== sequence.current || starting.current) {
          timer = setTimeout(() => void poll(), 1000);
          return;
        }
        setStatusUnavailable(false);
        accept(next);
        if (isMediaRuntimeSetupActive(next))
          timer = setTimeout(() => void poll(), 1000);
      } catch {
        if (!disposed && mounted.current && !starting.current) {
          setStatusUnavailable(true);
          timer = setTimeout(() => void poll(), 1000);
        }
      }
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [accept, status.phase]);

  const start = useCallback(async (): Promise<void> => {
    if (starting.current || isMediaRuntimeSetupActive(status)) return;
    starting.current = true;
    sequence.current += 1;
    setRefreshFailed(false);
    setStatus({ ...EMPTY_MEDIA_RUNTIME_SETUP, phase: "checking" });
    try {
      const next = await startMediaRuntimeSetup();
      if (mounted.current) {
        setStatusUnavailable(false);
        accept(next);
      }
    } catch (error: unknown) {
      if (mounted.current)
        setStatus({
          ...EMPTY_MEDIA_RUNTIME_SETUP,
          phase: "failed",
          message: "Setup could not start. Retry setup.",
          diagnostic: error instanceof Error ? error.message : String(error),
        });
    } finally {
      starting.current = false;
    }
  }, [accept, status]);

  return { status, start, refresh, refreshFailed, statusUnavailable };
};
