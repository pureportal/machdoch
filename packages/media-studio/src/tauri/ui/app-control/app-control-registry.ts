import type {
  AppControlActionDescriptor,
  AppControlSnapshot,
} from "./app-control-contract";
import { validateAppControlInput } from "./app-control-input";

export interface AppControlActionContext {
  signal: AbortSignal;
}

export interface AppControlAction extends AppControlActionDescriptor {
  timeoutMs?: number;
  run: (
    input: Record<string, unknown>,
    context: AppControlActionContext,
  ) => unknown;
}

export interface AppControlView {
  location: readonly string[];
  workspaceRoot?: string | null;
  state?: () => unknown;
  actions?: readonly AppControlAction[];
}

export interface AppControlRunOptions {
  mode: "ask" | "machdoch";
  signal?: AbortSignal;
}

interface AppControlEntry {
  id: string;
  level: number;
  sequence: number;
  read: () => AppControlView;
}

export const DEFAULT_APP_CONTROL_TIMEOUT_MS = 30_000;
export const MAX_APP_CONTROL_TIMEOUT_MS = 15 * 60_000;
const MAX_VIEW_STATE_CHARS = 16_000;

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const readViewState = (view: AppControlView): unknown => {
  if (!view.state) return undefined;
  try {
    const state = view.state();
    const serialized = JSON.stringify(state);
    if (serialized === undefined) return undefined;
    return serialized.length > MAX_VIEW_STATE_CHARS
      ? { omitted: `State exceeds ${MAX_VIEW_STATE_CHARS} characters.` }
      : (JSON.parse(serialized) as unknown);
  } catch (error) {
    return { unavailable: errorText(error) };
  }
};

export class AppControlRegistry {
  private readonly entries = new Map<string, AppControlEntry>();
  private readonly listeners = new Set<() => void>();
  private sequence = 0;
  private revision = 0;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getRevision = (): number => this.revision;

  register(id: string, level: number, read: () => AppControlView): () => void {
    const entry = { id, level, sequence: ++this.sequence, read };
    this.entries.set(id, entry);
    this.notify();
    return () => {
      if (this.entries.get(id) !== entry) return;
      this.entries.delete(id);
      this.notify();
    };
  }

  notify(): void {
    this.revision += 1;
    for (const listener of this.listeners) listener();
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  location(): string[] {
    return this.views().flatMap(({ view }) => [...view.location]);
  }

  snapshot(): AppControlSnapshot {
    const views = this.views();
    const state: Record<string, unknown> = {};
    for (const { id, view } of views) {
      const viewState = readViewState(view);
      if (viewState !== undefined) state[id] = viewState;
    }
    return {
      location: views.flatMap(({ view }) => [...view.location]),
      workspaceRoot:
        views
          .map(({ view }) => view.workspaceRoot)
          .filter((root): root is string => Boolean(root))
          .at(-1) ?? null,
      state,
      actions: this.describeActions(views),
    };
  }

  describeActions(views = this.views()): AppControlActionDescriptor[] {
    return this.actions(views).map(({ id, description, effect, input }) => ({
      id,
      description,
      effect,
      input,
    }));
  }

  async run(
    actionId: string,
    input: Record<string, unknown>,
    options: AppControlRunOptions,
  ): Promise<unknown> {
    const actions = this.actions();
    const action = actions.find((candidate) => candidate.id === actionId);
    if (!action) {
      throw new Error(
        `"${actionId}" is not available in the current view. Available actions: ${actions.map(({ id }) => id).join(", ") || "none"}. Call get_machdoch_view for the live view.`,
      );
    }
    if (options.mode === "ask" && action.effect === "write") {
      throw new Error(
        `"${actionId}" changes Machdoch and needs Machdoch mode.`,
      );
    }
    const inputError = validateAppControlInput(action.input, input);
    if (inputError)
      throw new Error(`Invalid input for ${actionId}: ${inputError}`);

    const timeoutMs = Math.min(
      action.timeoutMs ?? DEFAULT_APP_CONTROL_TIMEOUT_MS,
      MAX_APP_CONTROL_TIMEOUT_MS,
    );
    const controller = new AbortController();
    const abort = (): void => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", abort, { once: true });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(() => {
          controller.signal.throwIfAborted();
          return action.run(input, { signal: controller.signal });
        }),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            reject(
              new Error(
                `${actionId} did not finish within ${Math.round(timeoutMs / 1000)} seconds.`,
              ),
            );
            controller.abort();
          }, timeoutMs);
        }),
        new Promise<never>((_, reject) => {
          controller.signal.addEventListener(
            "abort",
            () => reject(new Error(`${actionId} was cancelled.`)),
            { once: true },
          );
        }),
      ]);
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
    }
  }

  waitForView(
    id: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.has(id)) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const finish = (error?: Error): void => {
        clearTimeout(timeout);
        unsubscribe();
        signal?.removeEventListener("abort", cancel);
        if (error) reject(error);
        else resolve();
      };
      const cancel = (): void =>
        finish(new Error("The request was cancelled."));
      const timeout = setTimeout(
        () => finish(new Error(`The ${id} view did not open in time.`)),
        timeoutMs,
      );
      const unsubscribe = this.subscribe(() => {
        if (this.has(id)) finish();
      });
      signal?.addEventListener("abort", cancel, { once: true });
    });
  }

  private views(): { id: string; view: AppControlView }[] {
    return [...this.entries.values()]
      .sort(
        (left, right) =>
          left.level - right.level || left.sequence - right.sequence,
      )
      .flatMap(({ id, read }) => {
        try {
          return [{ id, view: read() }];
        } catch (error) {
          console.error(`App control view ${id} could not be read`, error);
          return [];
        }
      });
  }

  private actions(views = this.views()): AppControlAction[] {
    const seen = new Set<string>();
    return views.flatMap(({ view }) =>
      (view.actions ?? []).filter((action) => {
        if (seen.has(action.id)) return false;
        seen.add(action.id);
        return true;
      }),
    );
  }
}

export const appControl = new AppControlRegistry();
