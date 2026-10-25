import { randomUUID } from "node:crypto";
import { createModelAdapter } from "@machdoch/model-runtime/connections";
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
    "CREATE TABLE IF NOT EXISTS verification_model_requests (id uuid PRIMARY KEY,prompt text NOT NULL,body jsonb NOT NULL,state text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp())",
  ),
);

const transport: typeof fetch = async (_url, options) => {
  const body = JSON.parse(String(options?.body)) as {
    input: string;
    stream: boolean;
  };
  const conversation = JSON.parse(body.input) as {
    role: string;
    content: string;
  }[];
  const prompt = conversation.at(-1)!.content;
  const id = randomUUID();
  const prior = await database.transaction(async (sql) => {
    const count = (
      await sql.query<{ count: number }>(
        "SELECT count(*)::integer AS count FROM verification_model_requests WHERE prompt=$1",
        [prompt],
      )
    ).rows[0]!.count;
    await sql.query(
      "INSERT INTO verification_model_requests (id,prompt,body,state) VALUES ($1,$2,$3,'received')",
      [id, prompt, JSON.stringify(body)],
    );
    return count;
  });
  if (prompt.startsWith("Fail once") && prior === 0) {
    await database.transaction((sql) =>
      sql.query(
        "UPDATE verification_model_requests SET state='failed' WHERE id=$1",
        [id],
      ),
    );
    return Response.json(
      { error: { message: "Controlled provider failure" } },
      { status: 503 },
    );
  }
  const responseId = `response-${id}`;
  const messageId = `message-${id}`;
  const responseText = prompt.startsWith("Hold")
    ? "Working on the answer. Final response."
    : `**Answer:** ${prompt}\n\nFollow-up context: ${conversation.length} messages.\n\n<script>window.modelScriptExecuted = true</script>\n\n<img src=x onerror="window.modelScriptExecuted=true">\n\n![External image](https://example.invalid/image.png)`;
  const response = {
    id: responseId,
    status: "completed",
    output: [
      {
        id: messageId,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: responseText, annotations: [] }],
      },
    ],
    usage: { input_tokens: 15, output_tokens: 8, total_tokens: 23 },
  };
  if (!body.stream) return Response.json(response);
  const encoder = new TextEncoder();
  let canceled = false;
  let cancelWait: (() => void) | undefined;
  let onAbort: (() => void) | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: Record<string, unknown>) => {
        if (!canceled)
          controller.enqueue(
            encoder.encode(
              `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
            ),
          );
      };
      onAbort = () => {
        if (!canceled) {
          canceled = true;
          cancelWait?.();
          controller.error(new DOMException("Request aborted", "AbortError"));
        }
      };
      options?.signal?.addEventListener("abort", onAbort, { once: true });
      if (options?.signal?.aborted) onAbort();
      void (async () => {
        send({
          type: "response.created",
          sequence_number: 0,
          response: { id: responseId, status: "in_progress", output: [] },
        });
        send({
          type: "response.output_item.added",
          sequence_number: 1,
          output_index: 0,
          item: {
            id: messageId,
            type: "message",
            role: "assistant",
            status: "in_progress",
            content: [],
          },
        });
        send({
          type: "response.content_part.added",
          sequence_number: 2,
          item_id: messageId,
          output_index: 0,
          content_index: 0,
          part: { type: "output_text", text: "", annotations: [] },
        });
        send({
          type: "response.output_text.delta",
          sequence_number: 3,
          item_id: messageId,
          output_index: 0,
          content_index: 0,
          delta: prompt.startsWith("Hold")
            ? "Working on the answer."
            : responseText,
        });
        if (prompt.startsWith("Hold")) {
          await database.transaction((sql) =>
            sql.query(
              "UPDATE verification_model_requests SET state='held' WHERE id=$1",
              [id],
            ),
          );
          await new Promise<void>((resolve, reject) => {
            let timer: ReturnType<typeof setTimeout>;
            cancelWait = () => {
              clearTimeout(timer);
              resolve();
            };
            const check = async () => {
              if (canceled) {
                resolve();
                return;
              }
              try {
                const row = await database.transaction(
                  async (sql) =>
                    (
                      await sql.query<{ state: string }>(
                        "SELECT state FROM verification_model_requests WHERE id=$1",
                        [id],
                      )
                    ).rows[0],
                );
                if (row?.state === "release") resolve();
                else timer = setTimeout(() => void check(), 100);
              } catch (error) {
                reject(error);
              }
            };
            void check();
          });
        }
        if (canceled) {
          await database.transaction((sql) =>
            sql.query(
              "UPDATE verification_model_requests SET state='aborted' WHERE id=$1",
              [id],
            ),
          );
          return;
        }
        if (prompt.startsWith("Hold"))
          send({
            type: "response.output_text.delta",
            sequence_number: 4,
            item_id: messageId,
            output_index: 0,
            content_index: 0,
            delta: " Final response.",
          });
        send({
          type: "response.output_text.done",
          sequence_number: 5,
          item_id: messageId,
          output_index: 0,
          content_index: 0,
          text: responseText,
        });
        send({
          type: "response.content_part.done",
          sequence_number: 6,
          item_id: messageId,
          output_index: 0,
          content_index: 0,
          part: response.output[0]!.content[0],
        });
        send({
          type: "response.output_item.done",
          sequence_number: 7,
          output_index: 0,
          item: response.output[0],
        });
        send({ type: "response.completed", sequence_number: 8, response });
        controller.close();
        await database.transaction((sql) =>
          sql.query(
            "UPDATE verification_model_requests SET state='complete' WHERE id=$1",
            [id],
          ),
        );
      })()
        .catch((error: unknown) => {
          if (!canceled) controller.error(error);
        })
        .finally(() => {
          if (onAbort) options?.signal?.removeEventListener("abort", onAbort);
        });
    },
    cancel() {
      canceled = true;
      cancelWait?.();
      if (onAbort) options?.signal?.removeEventListener("abort", onAbort);
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream" },
  });
};

const runtime = createCloudRuntime(
  database,
  process.env.MACHDOCH_CLOUD_ORIGIN!,
  {
    credentialsCipher: cloudCredentialsCipher(
      process.env.MACHDOCH_CLOUD_ENCRYPTION_KEY,
    ),
    modelAdapterFactory: (connection, tools) =>
      createModelAdapter({ ...connection, fetch: transport }, tools),
  },
);
setCloudRuntimeForTests(runtime);
await import("../src/server");
