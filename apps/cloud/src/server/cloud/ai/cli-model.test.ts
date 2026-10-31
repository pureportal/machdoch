import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CliModelFailure, createCliModelAdapter } from "./cli-model";

const parameters = {
  model: "fixture",
  systemPrompt: "Answer briefly.",
  userPrompt: "What is planned?",
  tools: [],
};
let directory: string;

async function fixture(name: string, source: string) {
  const path = join(directory, name);
  await writeFile(path, source);
  return { file: process.execPath, prefixArgs: [path] };
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "cli-model-test-"));
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("cloud CLI model adapter", () => {
  it("streams Claude Code text, sends no tools and reports total usage", async () => {
    const command = await fixture(
      "claude.mjs",
      `import { readFileSync } from "node:fs";
      const args = process.argv.slice(2);
      const prompt = readFileSync(0, "utf8");
      const write = (value) => console.log(JSON.stringify(value));
      const system = readFileSync(args[args.indexOf("--system-prompt-file") + 1], "utf8");
      const leaked = process.env.MACHDOCH_CLOUD_DATABASE_URL ?? "";
      write({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } } });
      write({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "lo" } } });
      write({ type: "result", subtype: "success", is_error: false, stop_reason: "end_turn",
        result: JSON.stringify({ prompt, system, tools: args[args.indexOf("--tools") + 1], leaked, key: process.env.ANTHROPIC_API_KEY }),
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 3 } });`,
    );
    process.env.MACHDOCH_CLOUD_DATABASE_URL = "postgres://secret";
    const deltas: string[] = [];
    const turn = await createCliModelAdapter(
      { provider: "claude-code-cli", model: "sonnet", apiKey: "key-1" },
      command,
    ).startTurn({
      ...parameters,
      onStreamEvent: (event) => {
        if (event.type === "text-delta") deltas.push(event.delta);
      },
    });
    delete process.env.MACHDOCH_CLOUD_DATABASE_URL;
    expect(deltas.join("")).toBe("Hello");
    expect(JSON.parse(turn.text)).toEqual({
      prompt: "What is planned?",
      system: "Answer briefly.",
      tools: "",
      leaked: "",
      key: "key-1",
    });
    expect(turn.usage?.totalTokens).toBe(20);
    expect(turn.toolCalls).toEqual([]);
  });

  it("collects Codex messages and token usage", async () => {
    const command = await fixture(
      "codex.mjs",
      `const write = (value) => console.log(JSON.stringify(value));
      write({ type: "thread.started", thread_id: "t" });
      write({ type: "item.completed", item: { type: "agent_message", text: "Done" } });
      write({ type: "turn.completed", usage: { input_tokens: 7, cached_input_tokens: 2, output_tokens: 3 } });`,
    );
    const turn = await createCliModelAdapter(
      { provider: "codex-cli", model: "gpt", apiKey: "" },
      command,
    ).startTurn(parameters);
    expect(turn.text).toBe("Done");
    expect(turn.usage?.totalTokens).toBe(10);
  });

  it("classifies a missing binary and authentication failures", async () => {
    await expect(
      createCliModelAdapter(
        { provider: "codex-cli", model: "gpt", apiKey: "" },
        { file: join(directory, "missing-binary"), prefixArgs: [] },
      ).startTurn(parameters),
    ).rejects.toMatchObject({ code: "cli_unavailable" });
    const command = await fixture(
      "unauthenticated.mjs",
      `console.log(JSON.stringify({ type: "result", is_error: true, result: "Invalid API key · Please run /login" }));`,
    );
    const failure = await createCliModelAdapter(
      { provider: "claude-code-cli", model: "sonnet", apiKey: "" },
      command,
    )
      .startTurn(parameters)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CliModelFailure);
    expect((failure as CliModelFailure).code).toBe("cli_authentication");
  });

  it("stops the process tree on cancellation", async () => {
    const marker = join(directory, "alive");
    const command = await fixture(
      "slow.mjs",
      `import { writeFileSync } from "node:fs";
      writeFileSync(${JSON.stringify(marker)}, "1");
      setInterval(() => {}, 1000);`,
    );
    const controller = new AbortController();
    const pending = createCliModelAdapter(
      { provider: "codex-cli", model: "gpt", apiKey: "" },
      command,
    ).startTurn({ ...parameters, signal: controller.signal });
    setTimeout(() => controller.abort(new Error("stop")), 500);
    await expect(pending).rejects.toThrow("stop");
  }, 15_000);
});
