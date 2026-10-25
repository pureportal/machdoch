import { createServer, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { runShell } from "./shell.ts";

interface Transfer {
  response: ServerResponse;
  timer: ReturnType<typeof setTimeout>;
  bytes: number;
  writing: boolean;
  controller: AbortController;
  sequence: number;
  finished: Promise<void>;
  finish: () => void;
}
const transfers = new Map<string, Transfer>();
let gateway: ReturnType<typeof createServer> | undefined;
let address: string | undefined;
let send: ((message: Record<string, unknown>) => void) | undefined;

export async function repositoryResponse(
  message: Record<string, unknown>,
): Promise<void> {
  if (typeof message.id !== "string")
    throw new Error("Invalid repository response identity");
  const transfer = transfers.get(message.id);
  if (!transfer) throw new Error("Unknown repository transfer");
  if (transfer.writing || message.sequence !== transfer.sequence++)
    throw new Error("Repository chunks require acknowledgment");
  transfer.writing = true;
  let closed = transfer.controller.signal.aborted;
  try {
    if (closed) return;
    if (message.error === true) throw new Error("Repository transfer failed");
    if (
      typeof message.chunk !== "string" ||
      message.chunk.length > 50000 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        message.chunk,
      ) ||
      typeof message.done !== "boolean"
    )
      throw new Error("Invalid repository data");
    const bytes = Buffer.from(message.chunk, "base64");
    transfer.bytes += bytes.length;
    if (transfer.bytes > 64 * 1024 * 1024)
      throw new Error("Repository transfer exceeds its limit");
    if (bytes.length && !transfer.response.write(bytes))
      await once(transfer.response, "drain", {
        signal: transfer.controller.signal,
      });
    if (message.done) {
      transfer.response.end();
    }
  } catch {
    closed = true;
    transfer.response.destroy();
  } finally {
    transfer.writing = false;
    send?.({
      kind: "repository_ack",
      id: message.id,
      sequence: message.sequence,
      closed,
    });
    if (closed || message.done === true || message.error === true) {
      transfers.delete(message.id);
      clearTimeout(transfer.timer);
      transfer.finish();
    }
  }
}

export async function openRepositoryGateway(
  emit: (message: Record<string, unknown>) => void,
): Promise<string> {
  if (address) return address;
  send = emit;
  gateway = createServer((request, response) => {
    void (async () => {
      const advertise =
        request.method === "GET" &&
        request.url === "/repository/info/refs?service=git-upload-pack";
      const fetch =
        request.method === "POST" &&
        request.url === "/repository/git-upload-pack";
      const encoding = request.headers["content-encoding"];
      if (encoding !== undefined && (encoding !== "gzip" || !fetch)) {
        response.writeHead(415).end();
        return;
      }
      if ((!advertise && !fetch) || transfers.size) {
        response.writeHead(403).end();
        return;
      }
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of request) {
        const bytes = Buffer.from(chunk);
        length += bytes.length;
        if (length > 32 * 1024) {
          response.writeHead(413).end();
          return;
        }
        chunks.push(bytes);
      }
      if (transfers.size) {
        response.writeHead(409).end();
        return;
      }
      const id = randomUUID();
      const controller = new AbortController();
      let finish!: () => void;
      const finished = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const timer = setTimeout(() => {
        transfers.delete(id);
        controller.abort();
        response.destroy();
        finish();
      }, 90000);
      response.on("close", () => {
        controller.abort();
      });
      response.writeHead(200, {
        "Content-Type": advertise
          ? "application/x-git-upload-pack-advertisement"
          : "application/x-git-upload-pack-result",
        "Cache-Control": "no-store",
      });
      transfers.set(id, {
        response,
        timer,
        bytes: 0,
        writing: false,
        controller,
        sequence: 0,
        finished,
        finish,
      });
      emit({
        kind: "repository_request",
        id,
        operation: advertise ? "advertise" : "fetch",
        ...(encoding === "gzip" ? { encoding } : {}),
        body: Buffer.concat(chunks).toString("base64"),
      });
    })().catch(() => response.destroy());
  });
  gateway.requestTimeout = 15000;
  gateway.headersTimeout = 10000;
  gateway.maxConnections = 2;
  await new Promise<void>((resolve, reject) => {
    gateway!.once("error", reject);
    gateway!.listen(0, "127.0.0.1", resolve);
  });
  const endpoint = gateway.address();
  if (!endpoint || typeof endpoint === "string")
    throw new Error("Repository gateway failed to bind");
  address = `http://127.0.0.1:${endpoint.port}/repository`;
  return address;
}

export async function closeRepositoryGateway(): Promise<void> {
  const current = gateway;
  gateway = undefined;
  address = undefined;
  if (!current) return;
  const closed = new Promise<void>((resolve, reject) =>
    current.close((error) => (error ? reject(error) : resolve())),
  );
  current.closeAllConnections();
  await closed;
  await Promise.all(
    [...transfers.values()].map((transfer) => transfer.finished),
  );
  send = undefined;
}

export async function prepareRepository(
  input: Record<string, unknown>,
  emit: (message: Record<string, unknown>) => void,
) {
  if (typeof input.commit !== "string" || !/^[a-f0-9]{40}$/.test(input.commit))
    throw new Error("Use a full commit SHA");
  const url = await openRepositoryGateway(emit);
  let result;
  try {
    result = await runShell({
      command: `test ! -e .git && git -c init.templateDir= init -q && git -c core.hooksPath=/dev/null -c protocol.version=2 -c credential.helper= -c http.followRedirects=false fetch --no-tags --depth=1 '${url}' '${input.commit}' && git -c core.hooksPath=/dev/null checkout --detach FETCH_HEAD && test "$(git rev-parse HEAD)" = '${input.commit}'`,
      timeoutMs: 300000,
    });
  } finally {
    await closeRepositoryGateway();
  }
  if (result.exitCode !== 0 || result.timedOut)
    throw new Error(
      "Repository preparation failed: " + result.stderr.slice(-2000),
    );
  return { baseCommit: input.commit };
}
