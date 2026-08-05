import type { CommandOverlaySnapshot } from "./command-types";

export interface CommandOverlayRegistration {
  id: string;
  kind: CommandOverlaySnapshot["kind"];
  allowGlobalCommands?: readonly string[];
  dismiss?: () => void | Promise<void>;
}

interface OverlayEntry extends CommandOverlaySnapshot {
  token: symbol;
}

export class CommandOverlayStore {
  readonly #entries = new Map<symbol, OverlayEntry>();
  readonly #listeners = new Set<() => void>();
  #sequence = 0;
  #snapshot: readonly CommandOverlaySnapshot[] = [];

  register(registration: CommandOverlayRegistration): () => void {
    const token = Symbol(registration.id);
    this.#entries.set(token, {
      token,
      id: registration.id,
      kind: registration.kind,
      openedAt: ++this.#sequence,
      allowGlobalCommands: registration.allowGlobalCommands ?? [],
      dismiss: registration.dismiss,
    });
    this.#emit();
    return () => {
      if (this.#entries.delete(token)) this.#emit();
    };
  }

  getSnapshot = (): readonly CommandOverlaySnapshot[] => this.#snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  async dismissTopNonModal(): Promise<boolean> {
    const top = this.#snapshot[this.#snapshot.length - 1];
    if (!top || top.kind !== "non-modal" || !top.dismiss) return false;
    await top.dismiss();
    return true;
  }

  #emit(): void {
    this.#snapshot = [...this.#entries.values()]
      .sort((left, right) => left.openedAt - right.openedAt)
      .map(({ token: _token, ...entry }) => entry);
    for (const listener of this.#listeners) listener();
  }
}

export const commandOverlayStore = new CommandOverlayStore();
