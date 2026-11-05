import { describe, expect, it } from "vitest";
import { loadRuntimeConfig } from "../config.js";
import { CodexAppServerSession } from "./codex-app-server-session.js";
import { runExternalAgentCommand } from "./external-agent-provider.js";

describe("Codex app-server process", () => {
  it("resumes a large history without returning its turns", async () => {
    const source = String.raw`
      import { createInterface } from "node:readline";
      const send = (event) => process.stdout.write(JSON.stringify(event) + "\n");
      for await (const line of createInterface({ input: process.stdin })) {
        const request = JSON.parse(line);
        if (request.method === "initialize") send({ id: request.id, result: {} });
        if (request.method === "thread/resume") {
          const turns = request.params.excludeTurns
            ? [] : [{ text: "x".repeat(28_000_000) }];
          send({ id: request.id, result: { thread: { id: "stored-thread", turns } } });
        }
        if (request.method !== "turn/start") continue;
        send({ id: request.id, result: { turn: { id: "new-turn" } } });
        send({ method: "item/completed", params: { threadId: "stored-thread", item: { id: "answer", type: "agentMessage", text: "Resumed successfully." } } });
        send({ method: "turn/completed", params: { threadId: "stored-thread", turn: { id: "new-turn", status: "completed" } } });
      }
    `;
    const config = await loadRuntimeConfig(process.cwd());
    const result = await runExternalAgentCommand(
      process.execPath,
      ["--input-type=module", "-e", source],
      undefined,
      config,
      "codex-cli",
      {},
      AbortSignal.timeout(15_000),
      undefined,
      false,
      {
        create: (io) => new CodexAppServerSession(
          { prompt: "Continue.", imagePaths: [], thread: { cwd: config.workspaceRoot }, turn: {}, resumeThreadId: "stored-thread" },
          io,
          () => undefined,
          { model: config.model, captureEvidence: false },
        ),
      },
    );
    expect(result).toMatchObject({ exitCode: 0, stdout: "Resumed successfully." });
    expect(result.stdoutBytes).toBeLessThan(8192);
  }, 30_000);
});
