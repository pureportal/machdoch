import {
  operationResponseSchema,
  type OperationResponse,
} from "@machdoch/fleet-protocol";
import { trackOperation } from "@machdoch/analytics/operations";
import { invocationOperation } from "@machdoch/analytics/catalog";

export interface FleetOperationTransport {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  listen<T>(
    name: string,
    handler: (event: { payload: T }) => void,
  ): Promise<() => void>;
}

type FleetOperationRequest = {
  kind: string;
  id?: string;
  command?: string;
  args?: Record<string, unknown>;
  offset?: number;
  after?: number;
};

const transientStatuses = new Set([408, 429, 502, 503, 504]);
const retryDelaysMs = [400, 1_000, 2_500];
const eventPollMs = 750;
const maximumEventPollMs = 15_000;

function isTransient(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  const status =
    error && typeof error === "object" && "status" in error
      ? error.status
      : undefined;
  return typeof status === "number" && transientStatuses.has(status);
}

function pendingDelay(pendingReads: number): number {
  return Math.min(1_000, 100 * 2 ** Math.floor(pendingReads / 4));
}

function decodeBase64(content: string): Uint8Array {
  const binary = atob(content);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++)
    bytes[index] = binary.charCodeAt(index);
  return bytes;
}

const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export function createFleetOperationTransport(
  send: (request: FleetOperationRequest) => Promise<unknown>,
): FleetOperationTransport {
  const listeners = new Map<
    string,
    Set<(event: { payload: unknown }) => void>
  >();
  let cursor = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let polling = false;
  let eventFailures = 0;
  const exchange = async (
    request: FleetOperationRequest,
  ): Promise<OperationResponse> => {
    for (let attempt = 0; ; attempt++) {
      try {
        return operationResponseSchema.parse(await send(request));
      } catch (error) {
        const delay = retryDelaysMs[attempt];
        if (delay === undefined || !isTransient(error)) throw error;
        await wait(delay);
      }
    }
  };
  const poll = async (): Promise<void> => {
    if (polling || !listeners.size) return;
    polling = true;
    try {
      const response = await exchange({ kind: "events", after: cursor });
      if (response.state !== "events")
        throw new Error("Progress is unavailable.");
      cursor = response.cursor;
      eventFailures = 0;
      for (const event of response.events)
        for (const listener of listeners.get(event.name) ?? [])
          listener({ payload: event.payload });
    } catch (error) {
      if (eventFailures === 0)
        console.error("Could not refresh remote progress", error);
      eventFailures += 1;
    } finally {
      polling = false;
      if (listeners.size)
        timer = setTimeout(
          () => void poll(),
          Math.min(maximumEventPollMs, eventPollMs * 2 ** eventFailures),
        );
    }
  };
  return {
    async invoke<T>(
      command: string,
      args: Record<string, unknown> = {},
    ): Promise<T> {
      return trackOperation(invocationOperation(command, args), async () => {
        const id = crypto.randomUUID();
        const started = await exchange({
          kind: "invoke",
          id,
          command,
          args: JSON.parse(JSON.stringify(args)),
        });
        if (started.state === "failed")
          throw typeof started.error === "string"
            ? new Error(started.error)
            : started.error;
        let content = "";
        let pendingReads = 0;
        try {
          for (;;) {
            const response = await exchange({
              kind: "read",
              id,
              offset: content.length,
            });
            if (response.state === "failed")
              throw typeof response.error === "string"
                ? new Error(response.error)
                : response.error;
            if (response.state === "pending") {
              await wait(pendingDelay(pendingReads++));
              continue;
            }
            if (
              response.state !== "complete" ||
              response.offset !== content.length
            )
              throw new Error("Invalid remote response.");
            content += response.chunk;
            if (content.length === response.total) break;
          }
          return JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(
              decodeBase64(content),
            ),
          ) as T;
        } finally {
          void exchange({ kind: "release", id }).catch((error: unknown) => {
            console.error("Could not release remote operation", error);
          });
        }
      });
    },
    async listen<T>(
      name: string,
      handler: (event: { payload: T }) => void,
    ): Promise<() => void> {
      const listener = handler as (event: { payload: unknown }) => void;
      let group = listeners.get(name);
      if (!group) {
        group = new Set();
        listeners.set(name, group);
      }
      group.add(listener);
      void poll();
      return () => {
        group.delete(listener);
        if (!group.size) listeners.delete(name);
        if (!listeners.size) clearTimeout(timer);
      };
    },
  };
}
