import assert from "node:assert/strict";
import test from "node:test";
import { taskThinkingTraceSchema } from "@machdoch/fleet-protocol/task-thinking";

await test("native activity preserves tool details, output, usage, unconfigured providers and timeout state", () => {
  const trace = { status: "running", mode: "ask", startedAt: 1, timeout: { startedAt: 1, lastActivityAt: 2, idleTimeoutMs: 1_200_000, absoluteTimeoutMs: null }, timelineEvents: [{ id: "call", kind: "tool-call", phase: "completed", label: "Tool", detail: "Grüße 🌿".repeat(2_000), tone: "success", timestamp: 3, elapsedMs: 2, provider: "unconfigured", tokenUsage: { totalTokens: 100 }, metadata: { argumentsPreview: "Native tool arguments", callNumber: 1 } }], actionOutputLines: [{ id: "line", toolName: "shell", stream: "stdout", text: "Unicode 🌿", timestamp: 3 }] };
  assert.deepEqual(taskThinkingTraceSchema.parse(trace), trace);
  assert.equal(taskThinkingTraceSchema.safeParse({ ...trace, timelineEvents: [{ ...trace.timelineEvents[0], kind: "unknown" }] }).success, false);
});
