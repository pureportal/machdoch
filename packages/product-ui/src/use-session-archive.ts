import { useRef, useState } from "react";
import type { SessionDataSource } from "./session-data";

export function useSessionArchive({
  source,
  sessionIds,
  disabled,
  onImported,
}: {
  source: SessionDataSource | undefined;
  sessionIds: string[];
  disabled: boolean;
  onImported: () => Promise<void>;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const operationInFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const blocked = disabled || busy;
  const run = async (operation: () => Promise<void>): Promise<void> => {
    if (operationInFlight.current) return;
    operationInFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await operation();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      operationInFlight.current = false;
      setBusy(false);
    }
  };
  return {
    fileInput,
    error,
    disabled: blocked,
    canExport: sessionIds.length > 0,
    requestImport: () => {
      if (!blocked && source) fileInput.current?.click();
    },
    importFile: async (file: File): Promise<void> => {
      if (!source) return;
      await run(async () => {
        await source.import(file);
        await onImported();
      });
    },
    exportSessions: async (): Promise<void> => {
      if (!source || sessionIds.length === 0) return;
      await run(async () => {
        const payload = await source.export(sessionIds);
        const url = URL.createObjectURL(
          new Blob([JSON.stringify(payload, null, 2)], {
            type: "application/json",
          }),
        );
        try {
          const anchor = document.createElement("a");
          anchor.href = url;
          anchor.download = `machdoch-sessions-${new Date().toISOString().slice(0, 10)}.json`;
          document.body.append(anchor);
          anchor.click();
          anchor.remove();
        } finally {
          window.setTimeout(() => URL.revokeObjectURL(url), 0);
        }
      });
    },
  };
}

export type SessionArchiveController = ReturnType<typeof useSessionArchive>;
