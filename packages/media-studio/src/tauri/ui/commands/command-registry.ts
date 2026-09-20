import type { CommandDefinition } from "./command-types";
import { parseShortcut } from "./shortcut";

export interface CommandRegistrySnapshot {
  commands: readonly CommandDefinition[];
  duplicateIds: ReadonlySet<string>;
  invalidIds: ReadonlyMap<string, string>;
  revision: number;
}

interface Registration {
  token: symbol;
  command: CommandDefinition;
}

export interface CommandRegistration {
  (): void;
  update: (commands: readonly CommandDefinition[]) => void;
}

export class CommandRegistry {
  readonly #registrations = new Map<string, Registration[]>();
  readonly #listeners = new Set<() => void>();
  #revision = 0;
  #snapshot: CommandRegistrySnapshot = {
    commands: [],
    duplicateIds: new Set(),
    invalidIds: new Map(),
    revision: 0,
  };

  register(commands: readonly CommandDefinition[]): CommandRegistration {
    let registrations = this.#createRegistrations(commands);
    let disposed = false;
    this.#addRegistrations(registrations);
    this.#emit();
    const dispose = (() => {
      if (disposed) return;
      disposed = true;
      if (this.#removeRegistrations(registrations)) this.#emit();
    }) as CommandRegistration;
    dispose.update = (nextCommands) => {
      if (disposed) return;
      if (
        registrations.length === nextCommands.length &&
        registrations.every(
          ({ command }, index) => command === nextCommands[index],
        )
      ) {
        return;
      }
      this.#removeRegistrations(registrations);
      registrations = this.#createRegistrations(nextCommands);
      this.#addRegistrations(registrations);
      this.#emit();
    };
    return dispose;
  }

  getSnapshot = (): CommandRegistrySnapshot => this.#snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  find(id: string): CommandDefinition | undefined {
    if (this.#snapshot.invalidIds.has(id)) return undefined;
    const registrations = this.#registrations.get(id);
    return registrations?.length === 1 ? registrations[0]?.command : undefined;
  }

  #createRegistrations(commands: readonly CommandDefinition[]): Registration[] {
    return commands.map((command) => ({
      command,
      token: Symbol(command.id),
    }));
  }

  #addRegistrations(registrations: readonly Registration[]): void {
    for (const registration of registrations) {
      const current = this.#registrations.get(registration.command.id) ?? [];
      this.#registrations.set(registration.command.id, [
        ...current,
        registration,
      ]);
    }
  }

  #removeRegistrations(registrations: readonly Registration[]): boolean {
    let changed = false;
    for (const registration of registrations) {
      const current = this.#registrations.get(registration.command.id);
      if (!current) continue;
      const next = current.filter(
        (entry) => entry.token !== registration.token,
      );
      if (next.length === current.length) continue;
      changed = true;
      if (next.length === 0)
        this.#registrations.delete(registration.command.id);
      else this.#registrations.set(registration.command.id, next);
    }
    return changed;
  }

  #emit(): void {
    this.#revision += 1;
    const duplicateIds = new Set<string>();
    const invalidIds = new Map<string, string>();
    const commands: CommandDefinition[] = [];
    for (const [id, registrations] of this.#registrations) {
      if (registrations.length !== 1) {
        duplicateIds.add(id);
        continue;
      }
      const command = registrations[0]?.command;
      if (command) {
        const invalidReason = this.#getInvalidReason(command);
        if (invalidReason) invalidIds.set(id, invalidReason);
        else commands.push(command);
      }
    }
    this.#snapshot = {
      commands,
      duplicateIds,
      invalidIds,
      revision: this.#revision,
    };
    for (const listener of this.#listeners) listener();
  }

  #getInvalidReason(command: CommandDefinition): string | null {
    if (!command.id.trim()) return "Command ID is empty";
    if (!command.title.trim()) return "Command title is empty";
    if (!command.group.trim()) return "Command group is empty";
    if (!command.scope.ownerId.trim()) return "Command scope owner is empty";
    if (command.overrideOf === command.id) {
      return "Command cannot override itself";
    }
    try {
      for (const shortcut of command.shortcuts ?? []) parseShortcut(shortcut);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    return null;
  }
}
