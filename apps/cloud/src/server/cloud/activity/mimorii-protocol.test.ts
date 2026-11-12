import { describe, expect, it } from "vitest";
import { inferenceActivity, runActivity, stepActivity } from "./journal";
import {
  MimoriiDeliveryError,
  mimoriiLogBatch,
  sendMimoriiBatch,
  type ExportedActivity,
} from "./mimorii-protocol";

const activity = (
  change: Partial<ExportedActivity> = {},
): ExportedActivity => ({
  id: "4b3bd6d8-35c0-4f53-b4f3-46e7a3bd7c1a",
  organizationId: "7bd5a3f4-0e4a-4c3b-8a0f-6d3f1b8e2c11",
  kind: "task",
  status: "failed",
  title: "Task failed",
  detail: "Runner lease expired",
  occurredAt: "2026-11-12T10:00:00.123456Z",
  actorName: "Ada",
  model: null,
  provider: null,
  tokens: null,
  durationMs: null,
  runId: "c1e0a1b2-3c4d-4e5f-8a9b-0c1d2e3f4a5b",
  runTitle: "Fix login",
  issueIdentifier: "PLAT-12",
  chatId: null,
  instanceId: null,
  instanceName: null,
  ...change,
});

describe("activity text", () => {
  it("names state changes and keeps repeated states as notes", () => {
    expect(runActivity("succeeded", "running", "Runner stopped")).toEqual({
      kind: "task",
      status: "succeeded",
      title: "Task succeeded",
      detail: "Runner stopped",
    });
    expect(runActivity("queued", null, "Task queued").detail).toBe("");
    expect(runActivity("running", "running", "Task file stored")).toEqual({
      kind: "task",
      status: "info",
      title: "Task file stored",
      detail: "",
    });
    expect(stepActivity("passed", "Unit tests", "12 passed").status).toBe(
      "succeeded",
    );
  });

  it("summarizes Agent questions, proposals and failures", () => {
    const progress = {
      steps: [
        { id: "1", tool: "search_issues", label: "Search", failed: false },
        { id: "2", tool: "search_issues", label: "Search", failed: false },
      ],
      actions: [{ title: "Create issue" }, { title: "Comment on PLAT-3" }],
      question: null,
    } as never;
    expect(inferenceActivity("agent", "complete", null, progress)).toEqual({
      kind: "agent",
      status: "succeeded",
      title: "Agent proposed 2 changes",
      detail: "Create issue; Comment on PLAT-3 · Used search_issues",
    });
    expect(
      inferenceActivity("agent", "complete", null, {
        steps: [],
        actions: [],
        question: { text: "Which team?", options: [] },
      }).title,
    ).toBe("Agent asked a question");
    expect(
      inferenceActivity("task", "failed", "provider_rate_limited"),
    ).toEqual({
      kind: "model",
      status: "failed",
      title: "Model call failed",
      detail: "The provider is rate limited. Wait and retry.",
    });
    expect(inferenceActivity("agent", "unknown", "interrupted").title).toBe(
      "Agent request interrupted",
    );
  });
});

describe("Mimorii log batches", () => {
  it("writes one readable line per activity with low-cardinality labels", () => {
    const batch = mimoriiLogBatch([
      activity(),
      activity({
        kind: "model",
        status: "succeeded",
        title: "Model call completed",
        detail: "",
        model: "sonnet",
        provider: "claude-code-cli",
        tokens: 1835,
        durationMs: 3200,
      }),
      activity({ status: "canceled", runTitle: null, issueIdentifier: null }),
    ]);
    expect(batch.labels).toEqual({ service: "machdoch-cloud" });
    expect(batch.entries.map((entry) => [entry.level, entry.message])).toEqual([
      ["error", "Task failed · PLAT-12 Fix login · Runner lease expired"],
      ["info", "Model call completed · PLAT-12 Fix login"],
      ["warn", "Task failed · Runner lease expired"],
    ]);
    expect(batch.entries[1]).toMatchObject({
      timestamp: "2026-11-12T10:00:00.123456Z",
      labels: { activity: "model" },
      attributes: {
        model: "sonnet",
        provider: "claude-code-cli",
        tokens: 1835,
        duration_ms: 3200,
        task: "Fix login",
        issue: "PLAT-12",
      },
    });
    expect(Object.values(batch.entries[0]!.attributes)).not.toContain(null);
  });

  it("reports partial rejections and keeps rate limits retryable", async () => {
    const batch = mimoriiLogBatch([activity()]);
    const accepted = await sendMimoriiBatch(
      "https://mimorii.example.test",
      "mim_log_token",
      batch,
      (async () =>
        Response.json(
          {
            accepted: 0,
            duplicates: 0,
            rejected: 1,
            errors: [{ index: 0, reason: "The message is too long" }],
          },
          { status: 400 },
        )) as unknown as typeof fetch,
    );
    expect(accepted).toMatchObject({ accepted: 0, rejected: 1 });
    const limited = sendMimoriiBatch(
      "https://mimorii.example.test",
      "mim_log_token",
      batch,
      (async () =>
        new Response("{}", {
          status: 429,
          headers: { "retry-after": "30" },
        })) as unknown as typeof fetch,
    );
    await expect(limited).rejects.toBeInstanceOf(MimoriiDeliveryError);
    await expect(limited).rejects.toMatchObject({ retryAfterSeconds: 30 });
    await expect(
      sendMimoriiBatch(
        "https://mimorii.example.test",
        "mim_log_token",
        batch,
        (async () => {
          throw new TypeError("fetch failed");
        }) as unknown as typeof fetch,
      ),
    ).rejects.toThrow("Mimorii is unreachable");
  });
});
