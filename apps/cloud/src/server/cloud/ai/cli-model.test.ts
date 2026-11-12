import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CliModelFailure,
  createCliModelAdapter,
  parseCliToolCalls,
} from "./cli-model";

const parameters = {
  model: "fixture",
  systemPrompt: "Answer briefly.",
  userPrompt: "What is planned?",
  tools: [],
};
let directory: string;
let home: string;

async function fixture(name: string, source: string) {
  const path = join(directory, name);
  await writeFile(path, source);
  return { file: process.execPath, prefixArgs: [path] };
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "cli-model-test-"));
  home = join(directory, "provider-home");
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
      const leaked = (process.env.MACHDOCH_CLOUD_DATABASE_URL ?? "") + (process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR ?? "");
      write({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } } });
      write({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "lo" } } });
      write({ type: "result", subtype: "success", is_error: false, stop_reason: "end_turn",
        result: JSON.stringify({ prompt, system, tools: args[args.indexOf("--tools") + 1], leaked, key: process.env.ANTHROPIC_API_KEY, home: process.env.CLAUDE_CONFIG_DIR }),
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 3 } });`,
    );
    process.env.MACHDOCH_CLOUD_DATABASE_URL = "postgres://secret";
    const inheritedStorage = process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
    process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR = "/operator/claude";
    const deltas: string[] = [];
    const turn = await createCliModelAdapter(
      { provider: "claude-code-cli", model: "sonnet", apiKey: "key-1", home },
      command,
    ).startTurn({
      ...parameters,
      onStreamEvent: (event) => {
        if (event.type === "text-delta") deltas.push(event.delta);
      },
    });
    delete process.env.MACHDOCH_CLOUD_DATABASE_URL;
    if (inheritedStorage === undefined)
      delete process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
    else process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR = inheritedStorage;
    expect(deltas.join("")).toBe("Hello");
    expect(JSON.parse(turn.text)).toEqual({
      prompt: "What is planned?",
      system: "Answer briefly.",
      tools: "",
      leaked: "",
      key: "key-1",
      home,
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
      { provider: "codex-cli", model: "gpt", apiKey: "", home },
      command,
    ).startTurn(parameters);
    expect(turn.text).toBe("Done");
    expect(turn.usage?.totalTokens).toBe(10);
  });

  it("sends Copilot one prompt with the instructions and joins chunked final messages", async () => {
    const command = await fixture(
      "copilot.mjs",
      `import { readFileSync } from "node:fs";
      const args = process.argv.slice(2);
      const prompt = readFileSync(0, "utf8");
      const write = (value) => console.log(JSON.stringify(value));
      write({ type: "session.mcp_server_status_changed", data: { status: "pending" } });
      write({ type: "assistant.message", agentId: "sub", data: { content: "ignored" } });
      write({ type: "assistant.message", data: { content: "Looking", toolRequests: [{ id: "t" }] } });
      const answer = JSON.stringify({ prompt, home: process.env.COPILOT_HOME, token: process.env.COPILOT_GITHUB_TOKEN, plugins: process.env.COPILOT_PLUGIN_DIR_ONLY, tools: args.includes("--available-tools="), model: args.find((arg) => arg.startsWith("--model=")) });
      write({ type: "assistant.message", data: { messageId: "m", chunkIndex: 1, chunkCount: 2, content: answer.slice(10) } });
      write({ type: "assistant.message", data: { messageId: "m", chunkIndex: 0, chunkCount: 2, content: answer.slice(0, 10) } });
      write({ type: "session.usage_checkpoint", data: { accountingSnapshot: { lastCallInputTokens: 12, lastCallOutputTokens: 4 } } });
      write({ type: "result", exitCode: 0 });`,
    );
    const turn = await createCliModelAdapter(
      { provider: "copilot-cli", model: "auto", apiKey: "github_pat_1", home },
      command,
    ).startTurn(parameters);
    const answer = JSON.parse(turn.text);
    expect(answer).toMatchObject({
      home,
      token: "github_pat_1",
      plugins: "true",
      tools: true,
      model: "--model=auto",
    });
    expect(answer.prompt).toContain("Answer briefly.");
    expect(answer.prompt).toContain("What is planned?");
    expect(turn.usage?.totalTokens).toBe(16);
  });

  it("reports a failed Copilot result", async () => {
    const command = await fixture(
      "copilot-failed.mjs",
      `console.log(JSON.stringify({ type: "session.error", data: { message: "No authentication information found." } }));
      console.log(JSON.stringify({ type: "result", exitCode: 1 }));
      process.exit(1);`,
    );
    const failure = await createCliModelAdapter(
      { provider: "copilot-cli", model: "auto", apiKey: "", home },
      command,
    )
      .startTurn(parameters)
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "cli_authentication" });
  });

  it("classifies a missing binary and authentication failures", async () => {
    await expect(
      createCliModelAdapter(
        { provider: "codex-cli", model: "gpt", apiKey: "", home },
        { file: join(directory, "missing-binary"), prefixArgs: [] },
      ).startTurn(parameters),
    ).rejects.toMatchObject({ code: "cli_unavailable" });
    const command = await fixture(
      "unauthenticated.mjs",
      `console.log(JSON.stringify({ type: "result", is_error: true, result: "Invalid API key · Please run /login" }));`,
    );
    const failure = await createCliModelAdapter(
      { provider: "claude-code-cli", model: "sonnet", apiKey: "", home },
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
      { provider: "codex-cli", model: "gpt", apiKey: "", home },
      command,
    ).startTurn({ ...parameters, signal: controller.signal });
    setTimeout(() => controller.abort(new Error("stop")), 500);
    await expect(pending).rejects.toThrow("stop");
  }, 15_000);

  it("describes tools in the instructions and parses a tool call block without streaming it", async () => {
    const fence = "`".repeat(3);
    const command = await fixture(
      "claude-tools.mjs",
      `import { readFileSync } from "node:fs";
      const args = process.argv.slice(2);
      const system = readFileSync(args[args.indexOf("--system-prompt-file") + 1], "utf8");
      const write = (value) => console.log(JSON.stringify(value));
      const text = "Checking.\\n${fence}tool_calls\\n" + JSON.stringify([{ name: "search_issues", arguments: { query: "login" } }]) + "\\n${fence}";
      for (const piece of [text.slice(0, 12), text.slice(12)])
        write({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: piece } } });
      write({ type: "result", subtype: "success", is_error: false, result: system.includes("### search_issues") ? text : "missing tools" });`,
    );
    const deltas: string[] = [];
    const turn = await createCliModelAdapter(
      { provider: "claude-code-cli", model: "sonnet", apiKey: "", home },
      command,
    ).startTurn({
      ...parameters,
      tools: [
        {
          name: "search_issues",
          description: "Search issues.",
          inputSchema: { type: "object", properties: {} },
        },
      ],
      onStreamEvent: (event) => {
        if (event.type === "text-delta") deltas.push(event.delta);
      },
    });
    expect(deltas.join("")).toBe("Checking.\n");
    expect(turn.text).toBe("Checking.");
    expect(turn.toolCalls).toEqual([
      {
        id: expect.stringMatching(/^cli_/),
        name: "search_issues",
        arguments: { query: "login" },
      },
    ]);
  });

  it("requests structured output in the instructions and returns the bare JSON answer", async () => {
    const fence = "`".repeat(3);
    const command = await fixture(
      "claude-structured.mjs",
      `import { readFileSync } from "node:fs";
      const args = process.argv.slice(2);
      const system = readFileSync(args[args.indexOf("--system-prompt-file") + 1], "utf8");
      const requested = system.includes("## Response format") && system.includes('"required":["approved"]');
      console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false,
        result: requested ? "${fence}json\\n" + JSON.stringify({ approved: true }) + "\\n${fence}" : "missing format" }));`,
    );
    const turn = await createCliModelAdapter(
      { provider: "claude-code-cli", model: "sonnet", apiKey: "", home },
      command,
    ).startTurn({
      ...parameters,
      structuredOutput: {
        name: "review",
        schema: {
          type: "object",
          properties: { approved: { type: "boolean" } },
          required: ["approved"],
        },
      },
    });
    expect(JSON.parse(turn.text)).toEqual({ approved: true });
  });

  it("treats malformed tool blocks as text", () => {
    expect(
      parseCliToolCalls("```tool_calls\nnot json\n```", ["search_issues"]),
    ).toEqual({
      text: "```tool_calls\nnot json\n```",
      toolCalls: [],
    });
    expect(parseCliToolCalls("Plain answer", ["search_issues"])).toEqual({
      text: "Plain answer",
      toolCalls: [],
    });
    expect(
      parseCliToolCalls("Use search_issues(query) to look it up.", [
        "search_issues",
      ]),
    ).toEqual({
      text: "Use search_issues(query) to look it up.",
      toolCalls: [],
    });
  });

  it("accepts unfenced tool call arrays but keeps other JSON as text", () => {
    expect(
      parseCliToolCalls(
        '[{"name":"get_issue","arguments":{"issue":"PLAT-2"}},{"name":"list_comments","arguments":{"issue":"PLAT-2"}}]',
        ["get_issue", "list_comments"],
      ),
    ).toEqual({
      text: "",
      toolCalls: [
        {
          id: expect.stringMatching(/^cli_/),
          name: "get_issue",
          arguments: { issue: "PLAT-2" },
        },
        {
          id: expect.stringMatching(/^cli_/),
          name: "list_comments",
          arguments: { issue: "PLAT-2" },
        },
      ],
    });
    expect(
      parseCliToolCalls('```json\n{"name":"get_issue","arguments":{}}\n```', [
        "get_issue",
      ]).toolCalls,
    ).toHaveLength(1);
    for (const text of [
      '[{"name":"Ada"},{"name":"get_issue"}]',
      '{"total":3}',
      "[]",
    ])
      expect(parseCliToolCalls(text, ["get_issue"])).toEqual({
        text,
        toolCalls: [],
      });
  });

  it("accepts call-expression tool syntax and drops surrounding markup", () => {
    const text = [
      "<parameter_length_error_guard>",
      "</invoke>",
      'ask_user({"question":"Which project (exactly)?","options":["Lambda migration (at risk)","Fleet appraisal"]})',
      "</invoke>",
    ].join("\n");
    expect(parseCliToolCalls(text, ["ask_user", "search_issues"])).toEqual({
      text: "",
      toolCalls: [
        {
          id: expect.stringMatching(/^cli_/),
          name: "ask_user",
          arguments: {
            question: "Which project (exactly)?",
            options: ["Lambda migration (at risk)", "Fleet appraisal"],
          },
        },
      ],
    });
  });
});
