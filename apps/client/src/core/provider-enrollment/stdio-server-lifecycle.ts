import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Readable, Writable } from "node:stream";

/** Own the stdio server and its upstream processes until the parent disconnects. */
export const runManagedStdioServer = async (
  createServer: (signal: AbortSignal) => Server | Promise<Server>,
  options: {
    cleanup?: () => Promise<void>;
    stdin?: Readable;
    stdout?: Writable;
  } = {},
): Promise<void> => {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const controller = new AbortController();
  let server: Server | undefined;
  let closingServer: Promise<void> | undefined;
  let closingUpstream: Promise<void> | undefined;
  let notifyStopped = () => {};
  const stopped = new Promise<void>((resolve) => {
    notifyStopped = resolve;
  });
  const close = async (): Promise<void> => {
    // If shutdown happened during catalog loading, a server created later must
    // still be closed by the final cleanup. Only memoize an actual server close.
    if (server && !closingServer)
      closingServer = Promise.resolve().then(() => server!.close());
    closingUpstream ??= Promise.resolve().then(() => options.cleanup?.());
    await Promise.allSettled([closingServer, closingUpstream]);
  };
  const stop = (): void => {
    controller.abort();
    notifyStopped();
    void close();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  stdin.once("end", stop);
  stdin.once("close", stop);
  stdin.on("error", stop);
  stdout.once("close", stop);
  stdout.on("error", stop);

  try {
    if (stdin.readableEnded || stdin.destroyed || stdout.destroyed) return;
    server = await createServer(controller.signal);
    if (controller.signal.aborted) return;
    const previousOnClose = server.onclose;
    server.onclose = () => {
      stop();
      previousOnClose?.();
    };
    await server.connect(new StdioServerTransport(stdin, stdout));
    if (controller.signal.aborted) return;
    await stopped;
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally {
    controller.abort();
    await close();
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    stdin.off("end", stop);
    stdin.off("close", stop);
    stdin.off("error", stop);
    stdout.off("close", stop);
    stdout.off("error", stop);
  }
};
