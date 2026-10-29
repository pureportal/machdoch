/// <reference types="vite/client" />
import type { DesktopTaskProgressEvent, DesktopTaskRunResponse } from "./runtime";

/**
 * Runs chat tasks outside the desktop shell during development, so browser
 * tests can drive real provider CLIs. A harness either installs it on
 * `window.__MACHDOCH_DEV_TASK_BRIDGE__` or opens the UI with
 * `?devTaskBridge=http://127.0.0.1:<port>` pointing at a local bridge server.
 * Production builds never read either.
 */
export interface DevTaskBridge {
  run(request: Record<string, unknown>): Promise<DesktopTaskRunResponse>;
  listen(onProgress: (event: DesktopTaskProgressEvent) => void): () => void;
  cancel(taskId: string): Promise<void>;
}

const createHttpDevTaskBridge = (baseUrl: string): DevTaskBridge => ({
  async run(request) {
    const response = await fetch(`${baseUrl}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    const result = (await response.json()) as DesktopTaskRunResponse & { error?: string };
    if (!response.ok) throw new Error(result.error ?? "The dev task bridge failed.");
    return result;
  },
  listen(onProgress) {
    const source = new EventSource(`${baseUrl}/events`);
    source.onmessage = (event) => onProgress(JSON.parse(String(event.data)) as DesktopTaskProgressEvent);
    return () => source.close();
  },
  async cancel(taskId) {
    await fetch(`${baseUrl}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ taskId }),
    });
  },
});

let urlBridge: DevTaskBridge | null | undefined;

const readUrlBridge = (): DevTaskBridge | null => {
  const value = new URLSearchParams(globalThis.location?.search ?? "").get("devTaskBridge");
  if (!value) return null;
  try {
    const url = new URL(value);
    // Only a bridge on this machine may run tasks.
    return url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost")
      ? createHttpDevTaskBridge(url.origin)
      : null;
  } catch {
    return null;
  }
};

export const getDevTaskBridge = (): DevTaskBridge | undefined => {
  if (!import.meta.env.DEV) return undefined;
  const installed = (globalThis as { __MACHDOCH_DEV_TASK_BRIDGE__?: DevTaskBridge })
    .__MACHDOCH_DEV_TASK_BRIDGE__;
  if (installed) return installed;
  urlBridge ??= readUrlBridge();
  return urlBridge ?? undefined;
};
