import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { GuestChannel } from "../../../../packages/cloud-client/src/worker/sandbox/guest-channel.ts";
import type { RepositoryTransport } from "@machdoch/fleet-protocol/cloud-repository";

const inferenceRequest = () => ({
  requestId: randomUUID(),
  runtimePrompt: "Runtime",
  tools: [],
  modelOptions: {},
  context: "Context",
});

await test("binds shared-agent inference to the pending operation and returns its correlated reply", async (context) => {
  const request = inferenceRequest();
  let operationId: unknown;
  const channel = await fixture(context, (input, socket) => {
    if (input.tool === "run_agent") {
      operationId = input.id;
      socket.write(
        `\x1e${JSON.stringify({ kind: "agent_inference", operationId, request })}\n`,
      );
    } else {
      assert.equal(input.kind, "agent_inference_reply");
      assert.equal(input.operationId, operationId);
      assert.deepEqual(input.reply, {
        kind: "inference_result",
        requestId: request.requestId,
        response: { text: "Done", toolCalls: [] },
      });
      socket.write(
        `\x1e${JSON.stringify({ id: operationId, ok: true, result: "stopped" })}\n`,
      );
    }
  });
  const result = await channel.call(
    "run_agent",
    {},
    new AbortController().signal,
    undefined,
    async (received) => {
      assert.deepEqual(received, request);
      return {
        kind: "inference_result",
        requestId: received.requestId,
        response: { text: "Done", toolCalls: [] },
      };
    },
  );
  assert.deepEqual(result.ok && result.result, "stopped");
});

await test("rejects inference for another operation before contacting the model broker", async (context) => {
  let invoked = false;
  const channel = await fixture(context, (_input, socket) => {
    socket.write(
      `\x1e${JSON.stringify({ kind: "agent_inference", operationId: randomUUID(), request: inferenceRequest() })}\n`,
    );
  });
  await assert.rejects(
    channel.call(
      "run_agent",
      {},
      new AbortController().signal,
      undefined,
      async (request) => {
        invoked = true;
        return {
          kind: "inference_error",
          requestId: request.requestId,
          error: "Denied",
        };
      },
    ),
    /Invalid sandbox/,
  );
  assert.equal(invoked, false);
});

await test("rejects premature agent completion and cancels outstanding broker work", async (context) => {
  let release!: () => void;
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const finish = new Promise<void>((resolve) => {
    release = resolve;
  });
  let connection: Socket | undefined,
    operationId: unknown,
    brokerSignal: AbortSignal | undefined;
  const channel = await fixture(context, (input, socket) => {
    connection = socket;
    operationId = input.id;
    socket.write(
      `\x1e${JSON.stringify({ kind: "agent_inference", operationId, request: inferenceRequest() })}\n`,
    );
  });
  const operation = channel.call(
    "run_agent",
    {},
    new AbortController().signal,
    undefined,
    async (request, signal) => {
      brokerSignal = signal;
      started();
      await finish;
      return {
        kind: "inference_result",
        requestId: request.requestId,
        response: { text: "Late", toolCalls: [] },
      };
    },
  );
  await entered;
  connection!.write(
    `\x1e${JSON.stringify({ id: operationId, ok: true, result: "premature" })}\n`,
  );
  await assert.rejects(operation, /Invalid sandbox/);
  assert.equal(brokerSignal!.aborted, true);
  release();
});

async function fixture(
  context: TestContext,
  receive: (request: Record<string, unknown>, socket: Socket) => void,
  repositoryTransport?: RepositoryTransport,
  version = 6,
) {
  const pipe =
    process.platform === "win32"
      ? `\\\\.\\pipe\\machdoch-channel-test-${randomUUID()}`
      : join(tmpdir(), `machdoch-${randomUUID()}.sock`);
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let buffer = "";
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const request = JSON.parse(buffer.slice(0, end)) as Record<
          string,
          unknown
        >;
        buffer = buffer.slice(end + 1);
        receive(request, socket);
      }
    });
    socket.write(
      `\x1e${JSON.stringify({ kind: "ready", version, controllerUid: 0, toolUid: 1000 })}\n`,
    );
  });
  await new Promise<void>((resolve) => server.listen(pipe, resolve));
  let channel: GuestChannel | undefined;
  context.after(async () => {
    channel?.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  channel = await GuestChannel.open(
    pipe,
    new AbortController().signal,
    repositoryTransport,
  );
  return channel;
}

await test("rejects an incompatible image with an actionable error before sending commands", async (context) => {
  let received = false;
  await assert.rejects(
    fixture(
      context,
      () => {
        received = true;
      },
      undefined,
      4,
    ),
    /Install matching worker and sandbox image versions/,
  );
  assert.equal(received, false);
});

await test("streams repository bytes in acknowledged chunks while a guest tool waits", async (context) => {
  const bytes = Buffer.alloc(100000, 127);
  const received: Buffer[] = [];
  let toolId: unknown;
  let chunks = 0;
  const channel = await fixture(
    context,
    (request, socket) => {
      if (request.kind !== "repository_response") {
        toolId = request.id;
        socket.write(
          `\x1e${JSON.stringify({ kind: "repository_request", id: randomUUID(), operation: "advertise", body: "" })}\n`,
        );
      } else {
        assert.equal(request.sequence, chunks++);
        assert.equal(request.error, undefined);
        const part = Buffer.from(String(request.chunk), "base64");
        assert.ok(part.length <= 32768);
        received.push(part);
        socket.write(
          `\x1e${JSON.stringify({ kind: "repository_ack", id: request.id, sequence: request.sequence, closed: false })}\n`,
        );
        if (request.done)
          socket.write(
            `\x1e${JSON.stringify({ id: toolId, ok: true, result: "cloned" })}\n`,
          );
      }
    },
    async (request) => {
      assert.equal(request.operation, "advertise");
      return bytes;
    },
  );
  assert.equal(
    (await channel.call("prepare_repository", {}, new AbortController().signal))
      .ok,
    true,
  );
  assert.deepEqual(Buffer.concat(received), bytes);
  assert.equal(chunks, 5);
});

await test(
  "accepts the next repository request in the same frame batch as the final acknowledgment",
  { timeout: 5000 },
  async (context) => {
    let toolId: unknown;
    let completed = 0,
      transfers = 0;
    const requestId = randomUUID();
    const channel = await fixture(
      context,
      (request, socket) => {
        if (request.kind !== "repository_response") {
          toolId = request.id;
          socket.write(
            `\x1e${JSON.stringify({ kind: "repository_request", id: requestId, operation: "advertise", body: "" })}\n`,
          );
          return;
        }
        const ack = `\x1e${JSON.stringify({ kind: "repository_ack", id: request.id, sequence: request.sequence, closed: false })}\n`;
        if (request.done && ++completed === 1)
          socket.write(
            ack +
              `\x1e${JSON.stringify({ kind: "repository_request", id: randomUUID(), operation: "fetch", body: "" })}\n`,
          );
        else if (request.done)
          socket.write(
            ack +
              `\x1e${JSON.stringify({ id: toolId, ok: true, result: "cloned" })}\n`,
          );
        else socket.write(ack);
      },
      async () => {
        transfers++;
        return Buffer.from("fixture");
      },
    );
    const response = await channel.call(
      "prepare_repository",
      {},
      new AbortController().signal,
    );
    assert.deepEqual(response, { id: toolId, ok: true, result: "cloned" });
    assert.equal(transfers, 2);
  },
);

await test("stops sending repository bytes after the Git consumer closes", async (context) => {
  let toolId: unknown;
  let chunks = 0;
  const channel = await fixture(
    context,
    (request, socket) => {
      if (request.kind !== "repository_response") {
        toolId = request.id;
        socket.write(
          `\x1e${JSON.stringify({ kind: "repository_request", id: randomUUID(), operation: "fetch", body: "" })}\n`,
        );
      } else {
        chunks++;
        socket.write(
          `\x1e${JSON.stringify({ kind: "repository_ack", id: request.id, sequence: request.sequence, closed: true })}\n` +
            `\x1e${JSON.stringify({ id: toolId, ok: true, result: "cloned" })}\n`,
        );
      }
    },
    async () => Buffer.alloc(100000),
  );
  const response = await channel.call(
    "prepare_repository",
    {},
    new AbortController().signal,
  );
  assert.equal(response.ok, true);
  assert.equal(chunks, 1);
});

await test("rejects a guest request for a write service before invoking the broker", async (context) => {
  let invoked = false;
  const channel = await fixture(
    context,
    (_request, socket) => {
      socket.write(
        `\x1e${JSON.stringify({ kind: "repository_request", id: randomUUID(), operation: "push", body: "" })}\n`,
      );
    },
    async () => {
      invoked = true;
      return Buffer.alloc(0);
    },
  );
  await assert.rejects(
    channel.call("prepare_repository", {}, new AbortController().signal),
    /Invalid sandbox/,
  );
  assert.equal(invoked, false);
});

await test(
  "keeps a successor transfer owned after its predecessor finishes even with a reused guest ID",
  { timeout: 5000 },
  async (context) => {
    let socket: Socket | undefined, started!: () => void;
    const secondStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const requestId = randomUUID();
    let transfers = 0;
    const channel = await fixture(
      context,
      (request, connection) => {
        socket = connection;
        if (request.kind !== "repository_response") {
          connection.write(
            `\x1e${JSON.stringify({ kind: "repository_request", id: requestId, operation: "advertise", body: "" })}\n`,
          );
          return;
        }
        const ack = `\x1e${JSON.stringify({ kind: "repository_ack", id: request.id, sequence: request.sequence, closed: false })}\n`;
        connection.write(
          ack +
            (request.done
              ? `\x1e${JSON.stringify({ kind: "repository_request", id: requestId, operation: "fetch", body: "" })}\n`
              : ""),
        );
      },
      async (_request, signal) => {
        if (++transfers === 1) return Buffer.from("fixture");
        started();
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        return Buffer.alloc(0);
      },
    );
    const pending = channel.call(
      "prepare_repository",
      {},
      new AbortController().signal,
    );
    const rejected = assert.rejects(pending, /Invalid sandbox tool response/);
    await secondStarted;
    await new Promise<void>((resolve) => setImmediate(resolve));
    socket!.write(
      `\x1e${JSON.stringify({ kind: "repository_request", id: randomUUID(), operation: "advertise", body: "" })}\n`,
    );
    await rejected;
    assert.equal(transfers, 2);
  },
);

await test("aborts repository transport when its parent tool is interrupted", async (context) => {
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  let brokerSignal: AbortSignal | undefined;
  const channel = await fixture(
    context,
    (_request, socket) => {
      socket.write(
        `\x1e${JSON.stringify({ kind: "repository_request", id: randomUUID(), operation: "advertise", body: "" })}\n`,
      );
    },
    async (_request, signal) => {
      brokerSignal = signal;
      started();
      await new Promise<void>((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        }),
      );
      return Buffer.alloc(0);
    },
  );
  const controller = new AbortController();
  const pending = channel.call("prepare_repository", {}, controller.signal);
  const rejected = assert.rejects(pending, /closed/);
  await ready;
  controller.abort();
  await rejected;
  assert.equal(brokerSignal?.aborted, true);
});

await test("routes bounded tool responses and preserves caller request identities", async (context) => {
  const id = randomUUID();
  const channel = await fixture(context, (request, socket) => {
    assert.equal(request.id, id);
    const result = JSON.stringify({
      id,
      ok: true,
      result: { content: "a😀b" },
    });
    socket.write("\x1e" + result.slice(0, 10), () =>
      socket.write(result.slice(10) + "\n"),
    );
  });
  assert.deepEqual(
    await channel.call(
      "read_file",
      { path: "file.txt" },
      new AbortController().signal,
      id,
    ),
    { id, ok: true, result: { content: "a😀b" } },
  );
});

await test("rejects concurrent commands without sending a second request", async (context) => {
  let count = 0;
  let release!: () => void;
  let received!: () => void;
  const ready = new Promise<void>((resolve) => {
    received = resolve;
  });
  const channel = await fixture(context, (request, socket) => {
    count++;
    release = () =>
      socket.write(
        `\x1e${JSON.stringify({ id: request.id, ok: true, result: "done" })}\n`,
      );
    received();
  });
  const pending = channel.call(
    "shell",
    { command: "test" },
    new AbortController().signal,
  );
  await ready;
  await assert.rejects(
    channel.call("shell", {}, new AbortController().signal),
    /already running/,
  );
  release();
  await pending;
  assert.equal(count, 1);
});

await test("closes an interrupted channel and never replays an uncertain command", async (context) => {
  let received!: () => void;
  const ready = new Promise<void>((resolve) => {
    received = resolve;
  });
  let count = 0;
  const channel = await fixture(context, () => {
    count++;
    received();
  });
  const controller = new AbortController();
  const pending = channel.call(
    "shell",
    { command: "write-file" },
    controller.signal,
  );
  const rejected = assert.rejects(pending, /closed/);
  await ready;
  controller.abort();
  await rejected;
  await assert.rejects(
    channel.call("shell", {}, new AbortController().signal),
    /closed/,
  );
  assert.equal(count, 1);
});

await test("fails closed on a response for another request", async (context) => {
  const channel = await fixture(context, (_request, socket) => {
    socket.write(
      `\x1e${JSON.stringify({ id: randomUUID(), ok: true, result: "wrong" })}\n`,
    );
  });
  await assert.rejects(
    channel.call("read_file", {}, new AbortController().signal),
    /Invalid sandbox tool response/,
  );
});

await test("bounds an unterminated guest response", async (context) => {
  const channel = await fixture(context, (_request, socket) => {
    socket.write(Buffer.alloc(1024 * 1024 + 1, 65));
  });
  await assert.rejects(
    channel.call("read_file", {}, new AbortController().signal),
    /exceeds its limit/,
  );
});

await test("rejects oversized commands before writing to the guest", async (context) => {
  let count = 0;
  const channel = await fixture(context, () => {
    count++;
  });
  await assert.rejects(
    channel.call(
      "write_file",
      { content: "a".repeat(1024 * 1024) },
      new AbortController().signal,
    ),
    /exceeds its limit/,
  );
  assert.equal(count, 0);
});

await test("reports guest disconnection without waiting for a tool timeout", async (context) => {
  const channel = await fixture(context, (_request, socket) => {
    socket.destroy();
  });
  await assert.rejects(
    channel.call("shell", {}, new AbortController().signal),
    /closed/,
  );
});

await test("cancels readiness when the guest cannot finish booting", async () => {
  const pipe =
    process.platform === "win32"
      ? `\\\\.\\pipe\\machdoch-channel-test-${randomUUID()}`
      : join(tmpdir(), `machdoch-${randomUUID()}.sock`);
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(pipe, resolve));
  const controller = new AbortController();
  const connection = once(server, "connection");
  const opening = GuestChannel.open(pipe, controller.signal);
  const rejected = assert.rejects(opening, /closed/);
  const [socket] = (await connection) as [Socket];
  controller.abort();
  await rejected;
  socket.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
