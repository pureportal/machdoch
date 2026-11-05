import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect } from "react";
import type {
  AppControlActionOutcome,
  AppControlRequest,
} from "@machdoch/media-studio/tauri/ui/app-control/app-control-contract.js";
import { appControl } from "@machdoch/media-studio/tauri/ui/app-control/app-control-registry.js";
import { getCurrentShellWindowLabel } from "../lib/shell-store";

interface AppControlRequestEvent {
  id: string;
  request: AppControlRequest;
}

const settleRender = async (): Promise<void> => {
  for (let pass = 0; pass < 2; pass += 1) {
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  }
};

const answer = async (
  request: AppControlRequest,
  signal: AbortSignal,
): Promise<unknown> => {
  if (request.kind === "snapshot") return appControl.snapshot();
  const knownActions = new Set(
    appControl.describeActions().map(({ id }) => id),
  );
  const result = await appControl.run(request.actionId, request.input, {
    mode: request.mode,
    signal,
  });
  await settleRender();
  const newActions = appControl
    .describeActions()
    .filter(({ id }) => !knownActions.has(id));
  return {
    result: result ?? null,
    location: appControl.location(),
    ...(newActions.length > 0 ? { newActions } : {}),
  } satisfies AppControlActionOutcome;
};

export function useAppControlBridge(): void {
  useEffect(() => {
    if (!isTauri() || getCurrentShellWindowLabel() !== "main") return;
    let disposed = false;
    const running = new Map<string, AbortController>();
    const stops: (() => void)[] = [];
    const handle = async ({ id, request }: AppControlRequestEvent) => {
      const controller = new AbortController();
      running.set(id, controller);
      let result: unknown = null;
      let error: string | null = null;
      try {
        result = await answer(request, controller.signal);
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
      } finally {
        running.delete(id);
      }
      if (!controller.signal.aborted)
        await invoke("complete_app_control_request", { id, result, error });
    };
    void Promise.all([
      listen<AppControlRequestEvent>(
        "machdoch://app-control-request",
        ({ payload }) => {
          void handle(payload).catch((cause: unknown) =>
            console.error("Machdoch app control could not answer", cause),
          );
        },
      ),
      listen<{ id: string }>("machdoch://app-control-cancel", ({ payload }) =>
        running.get(payload.id)?.abort(),
      ),
    ])
      .then(async (listeners) => {
        if (disposed) {
          for (const stop of listeners) stop();
          return;
        }
        stops.push(...listeners);
        await invoke("attach_app_control");
      })
      .catch((cause: unknown) =>
        console.error("Machdoch app control could not connect", cause),
      );
    return () => {
      disposed = true;
      for (const stop of stops) stop();
      for (const controller of running.values()) controller.abort();
      running.clear();
      void invoke("detach_app_control").catch((cause: unknown) =>
        console.error("Machdoch app control could not disconnect", cause),
      );
    };
  }, []);
}
