export type AppControlEffect = "read" | "write";

export type AppControlValueSchema =
  | {
      type: "string";
      description?: string;
      enum?: readonly string[];
      minLength?: number;
      maxLength?: number;
    }
  | {
      type: "number" | "integer";
      description?: string;
      minimum?: number;
      maximum?: number;
    }
  | { type: "boolean"; description?: string }
  | {
      type: "array";
      description?: string;
      items: AppControlValueSchema;
      maxItems?: number;
    };

export interface AppControlInputSchema {
  type: "object";
  properties: Readonly<Record<string, AppControlValueSchema>>;
  required?: readonly string[];
}

export interface AppControlActionDescriptor {
  id: string;
  description: string;
  effect: AppControlEffect;
  input: AppControlInputSchema;
}

export interface AppControlSnapshot {
  location: string[];
  workspaceRoot: string | null;
  state: Record<string, unknown>;
  actions: AppControlActionDescriptor[];
}

export type AppControlRequest =
  | { kind: "snapshot" }
  | {
      kind: "run";
      actionId: string;
      input: Record<string, unknown>;
      mode: "ask" | "machdoch";
    };

export interface AppControlActionOutcome {
  result: unknown;
  location: string[];
  newActions?: AppControlActionDescriptor[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isActionDescriptor = (value: unknown): boolean =>
  isRecord(value) &&
  typeof value.id === "string" &&
  typeof value.description === "string" &&
  (value.effect === "read" || value.effect === "write") &&
  isRecord(value.input) &&
  value.input.type === "object" &&
  isRecord(value.input.properties);

export const isAppControlSnapshot = (
  value: unknown,
): value is AppControlSnapshot =>
  isRecord(value) &&
  Array.isArray(value.location) &&
  value.location.every((segment) => typeof segment === "string") &&
  (value.workspaceRoot === null || typeof value.workspaceRoot === "string") &&
  isRecord(value.state) &&
  Array.isArray(value.actions) &&
  value.actions.every(isActionDescriptor);
