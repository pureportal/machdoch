export const viewVisibilityMessage = "machdoch:view-visibility";

const listeners = new Set<() => void>();
let embeddedVisible = true;

function notify(): void {
  for (const listener of listeners) listener();
}

if (typeof window !== "undefined") {
  window.addEventListener("message", (event) => {
    if (
      window.parent === window ||
      event.origin !== window.location.origin ||
      event.source !== window.parent
    )
      return;
    const data = event.data as { type?: unknown; visible?: unknown } | null;
    if (data?.type !== viewVisibilityMessage || typeof data.visible !== "boolean")
      return;
    if (embeddedVisible === data.visible) return;
    embeddedVisible = data.visible;
    notify();
  });
  document.addEventListener("visibilitychange", notify);
}

export function isViewVisible(): boolean {
  return !document.hidden && embeddedVisible;
}

export function onViewVisibilityChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function pollWhileVisible(
  task: () => Promise<unknown>,
  intervalMs: number | (() => number),
  { immediate = true }: { immediate?: boolean } = {},
): () => void {
  let stopped = false;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const nextDelay = (): number =>
    typeof intervalMs === "number" ? intervalMs : intervalMs();
  const run = async (): Promise<void> => {
    clearTimeout(timer);
    if (stopped || running || !isViewVisible()) return;
    running = true;
    try {
      await task();
    } finally {
      running = false;
      if (!stopped) timer = setTimeout(() => void run(), nextDelay());
    }
  };
  const unsubscribe = onViewVisibilityChange(() => {
    if (isViewVisible()) void run();
  });
  if (immediate) void run();
  else timer = setTimeout(() => void run(), nextDelay());
  return () => {
    stopped = true;
    clearTimeout(timer);
    unsubscribe();
  };
}
