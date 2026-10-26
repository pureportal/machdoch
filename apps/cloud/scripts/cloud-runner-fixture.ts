import { FleetDatabase } from "../src/server/database";
import { randomUUID } from "node:crypto";
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
    "CREATE TABLE IF NOT EXISTS verification_runner_calls(id uuid PRIMARY KEY,title text NOT NULL,prompt text NOT NULL,state text NOT NULL)",
  ),
);
setCloudRuntimeForTests(
  createCloudRuntime(database, process.env.MACHDOCH_CLOUD_ORIGIN!, {
    credentialsCipher: cloudCredentialsCipher(
      process.env.MACHDOCH_CLOUD_ENCRYPTION_KEY,
    ),
    modelAdapterFactory: async () => ({
      async startTurn(parameters) {
        const boundary = parameters.userPrompt.indexOf("\n\n");
        const input = JSON.parse(parameters.userPrompt.slice(0, boundary)) as {
          task: { title: string };
        };
        const context = JSON.parse(
          parameters.userPrompt.slice(boundary + 2),
        ) as {
          messages: { role: string; name?: string; content?: string }[];
        };
        const held = input.task.title.startsWith("Hold");
        await database.transaction((sql) =>
          sql.query(
            "INSERT INTO verification_runner_calls VALUES ($1,$2,$3,$4)",
            [
              randomUUID(),
              input.task.title,
              parameters.userPrompt,
              held ? "held" : "complete",
            ],
          ),
        );
        if (held)
          await new Promise<void>((_resolve, reject) => {
            if (parameters.signal?.aborted) reject(parameters.signal.reason);
            else
              parameters.signal?.addEventListener(
                "abort",
                () => reject(parameters.signal!.reason),
                { once: true },
              );
          });
        if (
          input.task.title.startsWith("Fail after edit") &&
          context.messages.some(
            (message) =>
              message.role === "tool" && message.name === "replace_in_file",
          )
        )
          throw new Error("Controlled provider failure after an edit");
        if (!parameters.tools.length)
          return {
            text: JSON.stringify({
              outcome: "success",
              helpfulLessonIds: [],
              harmfulLessonIds: [],
              lessons: [
                {
                  title: "Keep task learning private",
                  description:
                    "Persist learned context outside source changes.",
                  content:
                    "Keep generated task learning in private runtime storage, separate from source artifacts.",
                  triggerTerms: ["task learning"],
                  confidence: 0.9,
                  applicability: {
                    taskTerms: [],
                    excludedTaskTerms: [],
                    maxAgeDays: null,
                  },
                },
              ],
            }),
            toolCalls: [],
            usage: { totalTokens: 32 },
          };
        if (
          parameters.tools.some(
            (tool) => tool.name === "report_autopilot_decision",
          )
        )
          return {
            text: "",
            toolCalls: [
              {
                id: randomUUID(),
                name: "report_autopilot_decision",
                arguments: {
                  decision: "complete",
                  confidence: "high",
                  rationale: "Ready for independent verification",
                  missingRequirements: [],
                  requiredActions: [],
                },
              },
            ],
            usage: { totalTokens: 32 },
          };
        if (
          input.task.title.startsWith("Verify existing") ||
          context.messages.some(
            (message) =>
              message.role === "tool" && message.name === "replace_in_file",
          )
        )
          return {
            text: "",
            toolCalls: [
              {
                id: randomUUID(),
                name: "submit_final_response",
                arguments: {
                  summary: "README is ready for verification.",
                  status: "completed",
                  blockerReason: "",
                  markdown: "README is ready for verification.",
                  highlights: [],
                  relatedFiles: [],
                  verification: [],
                  followUps: [],
                },
              },
            ],
            usage: { totalTokens: 32 },
          };
        const read = context.messages.some(
          (message) => message.role === "tool" && message.name === "read_file",
        );
        const repair =
          context.messages[0]?.content?.includes('"verificationFeedback"') ===
          true;
        return {
          text: "",
          toolCalls: [
            {
              id: randomUUID(),
              name: read ? "replace_in_file" : "read_file",
              arguments: read
                ? {
                    path: "README",
                    oldText: repair ? "BROKEN_CANDIDATE" : "Hello World!",
                    newText: repair
                      ? "MACHDOCH_RUNNER_VERIFIED"
                      : "Hello World!\nBROKEN_CANDIDATE",
                    replaceAll: false,
                  }
                : { path: "README", startLine: 1, endLine: 30 },
            },
          ],
          usage: { totalTokens: 32 },
        };
      },
      async continueTurn() {
        throw new Error("Unexpected provider continuation");
      },
    }),
  }),
);
await import("../src/server");
