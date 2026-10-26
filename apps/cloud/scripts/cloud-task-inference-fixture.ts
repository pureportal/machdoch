import { FleetDatabase } from "../src/server/database";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { createIsolatedModelAdapter } from "../src/server/cloud/ai/isolated-model";
import { PostgresCloudDatabase } from "../src/server/cloud/database";
import { cloudCredentialsCipher } from "../src/server/cloud/credential-storage";
import {
  createCloudRuntime,
  setCloudRuntimeForTests,
} from "../src/server/cloud/runtime";

const database = new PostgresCloudDatabase(
  process.env.MACHDOCH_CLOUD_DATABASE_URL!,
);
await database.migrate();
await database.transaction((sql) =>
  sql.query(
    "CREATE TABLE IF NOT EXISTS verification_task_requests(id uuid PRIMARY KEY,context text NOT NULL,body jsonb NOT NULL,state text NOT NULL)",
  ),
);

const transport: typeof fetch = async (_url, options) => {
  const body = JSON.parse(String(options?.body)) as {
    input: string;
    tools: unknown[];
  };
  const input = { context: body.input.slice(body.input.indexOf("\n\n") + 2) };
  const id = randomUUID();
  const held = input.context.startsWith("Hold");
  await database.transaction((sql) =>
    sql.query("INSERT INTO verification_task_requests VALUES ($1,$2,$3,$4)", [
      id,
      input.context,
      JSON.stringify(body),
      held ? "held" : "received",
    ]),
  );
  const auxiliary = !body.tools.length;
  const item = auxiliary
    ? {
        id: `item-${id}`,
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: '{"outcome":"success"}',
            annotations: [],
          },
        ],
        status: "completed",
      }
    : {
        id: `item-${id}`,
        type: "function_call",
        call_id: `call-${id}`,
        name: "read_file",
        arguments: JSON.stringify({
          path: "package.json",
          offset: null,
          limit: null,
          encoding: null,
        }),
        status: "completed",
      };
  const response = {
    id: `response-${id}`,
    status: "completed",
    output: [item],
    usage: { input_tokens: 24, output_tokens: 8, total_tokens: 32 },
  };
  const encoder = new TextEncoder();
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let sequence = 0;
      const send = (event: Record<string, unknown>) => {
        if (!closed)
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ ...event, sequence_number: sequence++ })}\n\n`,
            ),
          );
      };
      void (async () => {
        try {
          send({
            type: "response.created",
            response: { ...response, status: "in_progress", output: [] },
          });
          if (!auxiliary)
            send({
              type: "response.output_item.added",
              output_index: 0,
              item: { ...item, arguments: "", status: "in_progress" },
            });
          if (held) {
            const deadline = performance.now() + 120000;
            while (!closed && performance.now() < deadline) {
              options?.signal?.throwIfAborted();
              const row = await database.transaction(
                async (sql) =>
                  (
                    await sql.query<{ state: string }>(
                      "SELECT state FROM verification_task_requests WHERE id=$1",
                      [id],
                    )
                  ).rows[0]!,
              );
              if (row.state === "release") break;
              await delay(50, undefined, {
                signal: options?.signal ?? undefined,
              });
            }
          }
          options?.signal?.throwIfAborted();
          if (closed) return;
          if (!auxiliary)
            send({
              type: "response.function_call_arguments.delta",
              item_id: item.id,
              output_index: 0,
              delta: item.arguments,
            });
          if (!auxiliary)
            send({
              type: "response.function_call_arguments.done",
              item_id: item.id,
              output_index: 0,
              arguments: item.arguments,
            });
          if (!auxiliary)
            send({ type: "response.output_item.done", output_index: 0, item });
          send({ type: "response.completed", response });
          controller.close();
          closed = true;
          await database.transaction((sql) =>
            sql.query(
              "UPDATE verification_task_requests SET state='complete' WHERE id=$1",
              [id],
            ),
          );
        } catch (error) {
          if (!closed) controller.error(error);
          closed = true;
          await database.transaction((sql) =>
            sql.query(
              "UPDATE verification_task_requests SET state='aborted' WHERE id=$1",
              [id],
            ),
          );
        }
      })().catch((error: unknown) =>
        console.error(
          "Task verification transport failed",
          error instanceof Error ? error.name : "Unknown error",
        ),
      );
    },
    cancel() {
      closed = true;
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream" },
  });
};

const providerServer = createServer(async (incoming, outgoing) => {
  const controller = new AbortController();
  outgoing.once("close", () => {
    if (!outgoing.writableEnded) controller.abort();
  });
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of incoming) {
      size += chunk.length;
      if (size > 1024 * 1024)
        throw new Error("Provider fixture input exceeded its limit");
      chunks.push(Buffer.from(chunk));
    }
    const response = await transport("http://fixture.invalid", {
      body: Buffer.concat(chunks).toString("utf8"),
      signal: controller.signal,
    });
    outgoing.writeHead(
      response.status,
      Object.fromEntries(response.headers.entries()),
    );
    const reader = response.body!.getReader();
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        if (!outgoing.write(part.value))
          await once(outgoing, "drain", { signal: controller.signal });
      }
      outgoing.end();
    } finally {
      try {
        await reader.cancel();
      } finally {
        reader.releaseLock();
      }
    }
  } catch (error) {
    if (!controller.signal.aborted)
      console.error(
        "Provider fixture connection failed",
        error instanceof Error ? error.name : "Unknown error",
      );
    outgoing.destroy();
  }
});
await new Promise<void>((resolve) =>
  providerServer.listen(0, "127.0.0.1", resolve),
);
const providerAddress = providerServer.address();
if (!providerAddress || typeof providerAddress === "string")
  throw new Error("Provider fixture did not listen");

setCloudRuntimeForTests(
  createCloudRuntime(database, process.env.MACHDOCH_CLOUD_ORIGIN!, {
    credentialsCipher: cloudCredentialsCipher(
      process.env.MACHDOCH_CLOUD_ENCRYPTION_KEY,
    ),
    modelAdapterFactory: (connection, tools) =>
      createIsolatedModelAdapter(
        {
          ...connection,
          baseUrl: `http://127.0.0.1:${providerAddress.port}/v1`,
        },
        tools,
      ),
  }),
);
await import("../src/server");
