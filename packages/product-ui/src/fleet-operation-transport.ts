import {
  operationResponseSchema,
  type OperationResponse,
} from "@machdoch/fleet-protocol";

export interface FleetOperationTransport {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  listen<T>(
    name: string,
    handler: (event: { payload: T }) => void,
  ): Promise<() => void>;
}

export function createFleetOperationTransport(
  send: (request: {
    kind: string;
    id?: string;
    command?: string;
    args?: Record<string, unknown>;
    offset?: number;
    after?: number;
  }) => Promise<unknown>,
): FleetOperationTransport {
  const listeners = new Map<
    string,
    Set<(event: { payload: unknown }) => void>
  >();
  let cursor = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let polling = false;
  const exchange = async (
    request: Parameters<typeof send>[0],
  ): Promise<OperationResponse> =>
    operationResponseSchema.parse(await send(request));
  const poll = async (): Promise<void> => {
    if (polling || !listeners.size) return;
    polling = true;
    try {
      const response = await exchange({ kind: "events", after: cursor });
      if (response.state !== "events")
        throw new Error("Progress is unavailable.");
      cursor = response.cursor;
      for (const event of response.events)
        for (const listener of listeners.get(event.name) ?? [])
          listener({ payload: event.payload });
    } catch (error) {
      console.error("Could not refresh remote progress", error);
    } finally {
      polling = false;
      if (listeners.size) timer = setTimeout(() => void poll(), 750);
    }
  };
  return {
    async invoke<T>(
      command: string,
      args: Record<string, unknown> = {},
    ): Promise<T> {
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
      let complete = false;
      try {
        for (;;) {
          const response = await exchange({
            kind: "read",
            id,
            offset: content.length,
          });
          if (response.state === "failed") {
            complete = true;
            throw typeof response.error === "string"
              ? new Error(response.error)
              : response.error;
          }
          if (response.state === "pending") {
            await new Promise<void>((resolve) => setTimeout(resolve, 250));
            continue;
          }
          if (
            response.state !== "complete" ||
            response.offset !== content.length
          )
            throw new Error("Invalid remote response.");
          content += response.chunk;
          if (content.length === response.total) {
            complete = true;
            break;
          }
        }
        const bytes = Uint8Array.from(atob(content), (character) =>
          character.charCodeAt(0),
        );
        return JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        ) as T;
      } finally {
        if (complete) {
          try {
            await exchange({ kind: "release", id });
          } catch (error) {
            console.error("Could not release remote operation", error);
          }
        }
      }
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
