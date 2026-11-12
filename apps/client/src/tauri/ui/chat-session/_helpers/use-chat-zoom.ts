import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_CHAT_ZOOM_PERCENT,
  loadChatZoomPercent,
  saveChatZoomPercent,
} from "../../lib/shell-store";

const CHAT_ZOOM_SAVE_DELAY_MS = 400;

export interface ChatZoomController {
  zoomPercent: number;
  onZoomPercentChange: (zoomPercent: number) => void;
}

interface PendingChatZoomSave {
  timeoutId: number;
  zoomPercent: number;
}

const persistChatZoomPercent = async (zoomPercent: number): Promise<void> => {
  try {
    await saveChatZoomPercent(zoomPercent);
  } catch (error) {
    console.error("Failed to save chat zoom", error);
  }
};

export const useChatZoom = (): ChatZoomController => {
  const [zoomPercent, setZoomPercent] = useState(DEFAULT_CHAT_ZOOM_PERCENT);
  const changedRef = useRef(false);
  const pendingSaveRef = useRef<PendingChatZoomSave | null>(null);

  useEffect(() => {
    let cancelled = false;

    void loadChatZoomPercent()
      .then((storedZoomPercent) => {
        if (!cancelled && !changedRef.current) {
          setZoomPercent(storedZoomPercent);
        }
      })
      .catch((error: unknown) => {
        console.error("Failed to load chat zoom", error);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return () => {
      const pendingSave = pendingSaveRef.current;

      if (!pendingSave) {
        return;
      }

      pendingSaveRef.current = null;
      window.clearTimeout(pendingSave.timeoutId);
      void persistChatZoomPercent(pendingSave.zoomPercent);
    };
  }, []);

  const onZoomPercentChange = useCallback((nextZoomPercent: number) => {
    changedRef.current = true;
    setZoomPercent(nextZoomPercent);

    if (pendingSaveRef.current) {
      window.clearTimeout(pendingSaveRef.current.timeoutId);
    }

    pendingSaveRef.current = {
      zoomPercent: nextZoomPercent,
      timeoutId: window.setTimeout(() => {
        pendingSaveRef.current = null;
        void persistChatZoomPercent(nextZoomPercent);
      }, CHAT_ZOOM_SAVE_DELAY_MS),
    };
  }, []);

  return { zoomPercent, onZoomPercentChange };
};
