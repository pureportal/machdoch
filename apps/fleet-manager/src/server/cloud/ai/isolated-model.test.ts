import { afterEach, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import {
  createIsolatedModelAdapter,
  validateInferenceTools,
} from "./isolated-model";
import type { AgentModelToolSpec } from "@machdoch/model-runtime/types";

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
const tool: AgentModelToolSpec = {
  name: "read_file",
  description: "Read a file",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
    additionalProperties: false,
  },
};

it("validates tool arguments in a bounded worker", async () => {
  const signal = new AbortController().signal;
  expect(
    await validateInferenceTools(
      [tool],
      [{ id: "call", name: "read_file", arguments: { path: "README" } }],
      signal,
    ),
  ).toBe(true);
  expect(
    await validateInferenceTools(
      [tool],
      [{ id: "call", name: "read_file", arguments: {} }],
      signal,
    ),
  ).toBe(false);
});

it("terminates pathological validation while the server event loop remains responsive", async () => {
  const unsafe: AgentModelToolSpec = {
    ...tool,
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", pattern: "^(a+)+$" } },
    },
  };
  let ticks = 0;
  const timer = setInterval(() => {
    ticks++;
  }, 20);
  try {
    await expect(
      validateInferenceTools(
        [unsafe],
        [
          {
            id: "call",
            name: "read_file",
            arguments: { path: "a".repeat(100) + "!" },
          },
        ],
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "worker_timeout" });
    expect(ticks).toBeGreaterThan(10);
    expect(
      await validateInferenceTools(
        [tool],
        [{ id: "next", name: "read_file", arguments: { path: "README" } }],
        new AbortController().signal,
      ),
    ).toBe(true);
  } finally {
    clearInterval(timer);
  }
}, 10000);

it("streams a real SDK request through an isolated provider worker and honors cancellation", async () => {
  let started!: () => void;
  const requested = new Promise<void>((resolve) => {
    started = resolve;
  });
  const requests: Record<string, unknown>[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests.push(body);
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    if (body.input === "hold") {
      response.flushHeaders();
      started();
      return;
    }
    response.write(
      `data: ${JSON.stringify({ type: "response.created", sequence_number: 0, response: { id: "fixture", status: "in_progress", output: [] } })}\n\n`,
    );
    response.end(
      `data: ${JSON.stringify({ type: "response.completed", sequence_number: 1, response: { id: "fixture", status: "completed", output: [{ type: "message", id: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: body.input === "oversized" ? "x".repeat(256 * 1024 + 1) : "Worker response", annotations: [] }] }], usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 } } })}\n\n`,
    );
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing test address");
  const adapter = await createIsolatedModelAdapter(
    {
      provider: "openai",
      model: "gpt-5.5",
      apiKey: "controlled-fixture-key",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
    },
    [tool],
  );
  const parameters = {
    model: "gpt-5.5",
    systemPrompt: "Test",
    userPrompt: "answer",
    tools: [tool],
    maxRequestAttempts: 1,
  };
  const answer = await adapter.startTurn(parameters);
  expect(answer.text).toBe("Worker response");
  expect(answer.usage?.totalTokens).toBe(12);
  const oversized = await adapter
    .startTurn({ ...parameters, userPrompt: "oversized" })
    .then(
      () => null,
      (error: unknown) => error,
    );
  expect(oversized).toMatchObject({ code: "output_limit" });
  const controller = new AbortController();
  const held = adapter.startTurn({
    ...parameters,
    userPrompt: "hold",
    signal: controller.signal,
  });
  const canceled = expect(held).rejects.toThrow("Worker canceled");
  await requested;
  controller.abort(new Error("Worker canceled"));
  await canceled;
  expect(requests).toHaveLength(3);
}, 10000);

it("stops SDK argument normalization when an untrusted pattern blocks its event loop", async () => {
  const server = createServer(async (request, response) => {
    for await (const _ of request) {
    }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write(
      `data: ${JSON.stringify({ type: "response.created", sequence_number: 0, response: { id: "pattern", status: "in_progress", output: [] } })}\n\n`,
    );
    response.end(
      `data: ${JSON.stringify({ type: "response.completed", sequence_number: 1, response: { id: "pattern", status: "completed", output: [{ type: "function_call", id: "item", call_id: "call", name: "read_file", arguments: JSON.stringify({ path: "a".repeat(100) + "!" }), status: "completed" }], usage: { total_tokens: 32, input_tokens: 24, output_tokens: 8 } } })}\n\n`,
    );
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing test address");
  const unsafe = {
    ...tool,
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", pattern: "^(a+)+$" } },
      required: ["path"],
    },
  };
  const adapter = await createIsolatedModelAdapter(
    {
      provider: "openai",
      model: "gpt-5.5",
      apiKey: "controlled-fixture-key",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
    },
    [unsafe],
  );
  let ticks = 0;
  const timer = setInterval(() => {
    ticks++;
  }, 20);
  try {
    await expect(
      adapter.startTurn({
        model: "gpt-5.5",
        systemPrompt: "Test",
        userPrompt: "Test",
        tools: [unsafe],
        maxRequestAttempts: 1,
      }),
    ).rejects.toMatchObject({ code: "worker_timeout" });
    expect(ticks).toBeGreaterThan(10);
  } finally {
    clearInterval(timer);
  }
}, 10000);
