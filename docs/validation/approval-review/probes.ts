import assert from "node:assert/strict";
import { runtimeConfig } from "../../../apps/client/src/core/__test__/ralph-test-helpers.js";
import { CodexCliOutputDecoder } from "../../../apps/client/src/core/_helpers/external-agent-cli-output.js";
import { CodexNativeGoalDecoder } from "../../../apps/client/src/core/_helpers/codex-native-goal.js";
import { createShellNetworkToolDefinitions } from "../../../apps/client/src/core/_helpers/shell-network-tool-definitions.js";

const results: Record<string, unknown>[] = [];
const commandFailure = {
  type: "item.completed",
  item: {
    id: "cleanup-command",
    type: "command_execution",
    command: "synthetic cleanup command; never executed",
    status: "failed",
    exit_code: 1,
    aggregated_output: "rejected: blocked by policy",
  },
};
const mcpFailure = {
  type: "item.completed",
  item: {
    id: "cleanup-mcp",
    type: "mcp_tool_call",
    status: "failed",
    error: { message: "synthetic MCP policy rejection" },
  },
};

for (const captureEvidence of [false, true]) {
  const decoder = new CodexCliOutputDecoder(captureEvidence);
  const update = decoder.push(
    [
      commandFailure,
      mcpFailure,
      {
        type: "item.completed",
        item: { type: "agent_message", text: "Synthetic final answer." },
      },
      { type: "turn.completed" },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n") + "\n",
  );
  assert.equal(update.resultExitCode, 0);
  assert.equal(decoder.getFailureMessage(), undefined);
  assert.equal(decoder.getToolCallCount(), 2);
  assert.equal(decoder.getFinalOutput(), "Synthetic final answer.");
  assert.equal(Boolean(decoder.getToolEvidence()), captureEvidence);
  results.push({
    probe: "failed native command and MCP call followed by completed turn",
    captureEvidence,
    resultExitCode: update.resultExitCode,
    failureMessage: decoder.getFailureMessage() ?? null,
    toolEvidenceRetained: Boolean(decoder.getToolEvidence()),
  });
}

const messages: Record<string, unknown>[] = [];
const goal = new CodexNativeGoalDecoder(
  {
    objective: "Synthetic objective",
    prompt: "Synthetic prompt",
    imagePaths: [],
  },
  runtimeConfig,
  (message) => messages.push(JSON.parse(message) as Record<string, unknown>),
  () => undefined,
);
goal.start();
goal.push(`${JSON.stringify({ id: 1, result: {} })}\n`);
const requestedThread = messages.find(
  (message) => message.method === "thread/start",
);
assert.equal(
  (requestedThread?.params as Record<string, unknown>).approvalPolicy,
  "never",
);
goal.push(
  `${JSON.stringify({
    id: 2,
    result: {
      thread: { id: "synthetic-thread" },
      approvalPolicy: "on-request",
      sandbox: { type: "readOnly" },
    },
  })}\n`,
);
assert.equal(goal.getFailureMessage(), undefined);
assert.equal(messages.at(-1)?.method, "thread/goal/set");
results.push({
  probe: "native goal accepts thread response with mismatched permissions",
  responseValidated: false,
  nextRequest: messages.at(-1)?.method,
});

const approval = goal.push(
  `${JSON.stringify({
    id: "synthetic-approval",
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: "synthetic-thread",
      command: "synthetic cleanup command; never executed",
      reason: "synthetic policy reason",
    },
  })}\n`,
);
assert.equal(approval.resultExitCode, 1);
assert.equal(
  goal.getFailureMessage(),
  "Codex requested user input. Resume after resolving it.",
);
assert.equal(
  goal.getFailureMessage()?.includes("synthetic policy reason"),
  false,
);
results.push({
  probe: "native goal command approval request loses method and reason",
  failureMessage: goal.getFailureMessage(),
});

if (process.platform === "win32") {
  const shell = createShellNetworkToolDefinitions(runtimeConfig).find(
    (definition) => definition.spec.name === "run_shell_command",
  );
  assert.ok(shell);
  const result = await shell.execute(
    {
      command:
        "Write-Error 'synthetic nonterminating error'; Write-Output 'synthetic trailing success'",
    },
    {
      workspaceRoot: process.cwd(),
      memory: {
        sessionEnabled: false,
        sessionEntries: [],
        globalEnabled: false,
        globalEntries: [],
      },
    },
  );
  assert.equal(Boolean(result.toolResult.isError), false);
  assert.match(result.toolResult.output, /Exit code: 0/);
  assert.match(
    result.toolResult.output,
    /STDERR:[\s\S]*synthetic nonterminating error/,
  );
  results.push({
    probe: "PowerShell nonterminating error followed by successful statement",
    isError: Boolean(result.toolResult.isError),
    exitCode: 0,
    errorRetainedInStderr: true,
  });
}

process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
