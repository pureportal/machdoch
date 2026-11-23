import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import {
  comments,
  createIssue,
  createLoop,
  database,
  failure,
  loops,
  member,
  owner,
  providerId,
  run,
  runtime,
  settle,
  teamId,
  useLoopTestRuntime,
  webhookFetch,
} from "./loop-test-harness";

useLoopTestRuntime();

it("keeps memory between runs and records context and revisions", async () => {
  const id = await createLoop(
    [
      { kind: "comment", body: "Seen {{memory.count}}" },
      { kind: "remember", key: "count", value: "2" },
    ],
    (config) => ({
      ...config,
      contextSources: [
        { kind: "trigger_payload" },
        { kind: "previous_runs", runCount: 3 },
      ],
    }),
  );
  const configured = await loops().setMemory(owner, randomUUID(), id, {
    key: "count",
    value: "1",
  });
  expect(configured.memory).toEqual([{ key: "count", value: "1" }]);
  expect(configured.revisions.length).toBeGreaterThanOrEqual(2);
  expect(
    await failure(
      loops().setMemory(member, randomUUID(), id, { key: "x", value: "y" }),
    ),
  ).toMatchObject({ status: 403 });
  const issue = await createIssue("Remember");
  const first = await run(id, issue.id);
  const second = await run(id, issue.id);
  expect((await comments(issue.id)).sort()).toEqual(["Seen 1", "Seen 2"]);
  const loop = await loops().get(owner, id);
  expect(loop.memory).toEqual([{ key: "count", value: "2" }]);
  const detail = await loops().runDetail(owner, second);
  expect(detail).toMatchObject({
    state: "succeeded",
    loopRevision: loop.revision,
  });
  expect(detail.resolvedContext?.map((entry) => entry.title)).toEqual([
    "Trigger",
    "Earlier runs",
  ]);
  expect(detail.resolvedContext?.[1]?.items).toEqual([
    expect.stringContaining("succeeded · Comment added · Remembered count"),
  ]);
  expect((await loops().runDetail(owner, first)).resolvedContext?.[1]).toEqual({
    kind: "previous_runs",
    title: "Earlier runs",
    items: [],
  });
  const cleared = await loops().deleteMemory(owner, randomUUID(), id, "count");
  expect(cleared.memory).toEqual([]);
}, 60_000);

it("waits for approval before consequential outputs", async () => {
  const id = await createLoop(
    [{ kind: "comment", body: "Approved change" }],
    (config) => ({
      ...config,
      guardrails: { ...config.guardrails, approvalRequired: true },
    }),
  );
  const issue = await createIssue("Gate");
  const runId = await run(id, issue.id);
  expect(await loops().runDetail(owner, runId)).toMatchObject({
    state: "waiting",
    awaitingApproval: true,
    approvedByName: null,
  });
  expect(await comments(issue.id)).toEqual([]);
  await loops().approve(owner, randomUUID(), runId);
  await settle();
  expect(await comments(issue.id)).toEqual(["Approved change"]);
  expect(await loops().runDetail(owner, runId)).toMatchObject({
    state: "succeeded",
    awaitingApproval: false,
    approvedByName: "owner",
  });
  expect(
    await failure(loops().approve(owner, randomUUID(), runId)),
  ).toMatchObject({ status: 409, code: "loop_approval" });
}, 60_000);

it("asks for human input through the inbox and resumes with the answer", async () => {
  const id = await createLoop([
    { kind: "request_input", prompt: "Which version?", key: "version" },
    { kind: "comment", body: "Shipping {{memory.version}}" },
  ]);
  const issue = await createIssue("Ask");
  const runId = await run(id, issue.id);
  expect(await loops().runDetail(owner, runId)).toMatchObject({
    state: "waiting",
    awaitingInput: "version",
  });
  const inbox = await database.engine.query<{ kind: string }>(
    "SELECT kind FROM cloud_notifications WHERE organization_id=$1 AND automation_run_id=$2",
    [owner.organizationId, runId],
  );
  expect(inbox.rows.map((row) => row.kind)).toEqual(["loop_input"]);
  await loops().answer(owner, randomUUID(), runId, "1.2.0");
  await settle();
  expect(await comments(issue.id)).toEqual(["Shipping 1.2.0"]);
  expect(await loops().runDetail(owner, runId)).toMatchObject({
    state: "succeeded",
    awaitingInput: null,
  });
  expect(
    await failure(loops().answer(owner, randomUUID(), runId, "again")),
  ).toMatchObject({ status: 409, code: "loop_input" });
}, 60_000);

it("stops killed loops and pauses after repeated failures", async () => {
  webhookFetch.mockResolvedValue(new Response("", { status: 500 }));
  const id = await createLoop(
    [{ kind: "send_webhook", url: "https://hooks.example.test/loop" }],
    (config) => ({
      ...config,
      guardrails: { ...config.guardrails, pauseAfterFailures: 2 },
    }),
  );
  expect(
    await failure(loops().setKilled(member, randomUUID(), id, true)),
  ).toMatchObject({ status: 403 });
  expect((await loops().setKilled(owner, randomUUID(), id, true)).killed).toBe(
    true,
  );
  expect(
    await failure(
      runtime.automations.service.run(owner, randomUUID(), id, {
        issueId: null,
      }),
    ),
  ).toMatchObject({ status: 429, code: "automation_killed" });
  expect(webhookFetch).not.toHaveBeenCalled();
  await loops().setKilled(owner, randomUUID(), id, false);
  await run(id, null);
  expect((await loops().get(owner, id)).enabled).toBe(true);
  await run(id, null);
  const paused = await loops().get(owner, id);
  expect(paused).toMatchObject({ enabled: false, consecutiveFailures: 2 });
  expect(webhookFetch).toHaveBeenCalledTimes(2);
  const gated = await createLoop(
    [{ kind: "comment", body: "Never" }],
    (config) => ({
      ...config,
      guardrails: { ...config.guardrails, approvalRequired: true },
    }),
  );
  const issue = await createIssue("Stop");
  const waiting = await run(gated, issue.id);
  await loops().setKilled(owner, randomUUID(), gated, true);
  await settle();
  expect(await loops().runDetail(owner, waiting)).toMatchObject({
    state: "skipped",
    error: "The loop was stopped.",
  });
  expect(await comments(issue.id)).toEqual([]);
}, 60_000);

it("replays a run and dry-runs a recorded event without side effects", async () => {
  const id = await createLoop([
    { kind: "comment", body: "On {{issue.title}}" },
  ]);
  const issue = await createIssue("Replay");
  const original = await run(id, issue.id);
  const { runId: replayed } = await loops().replay(
    owner,
    randomUUID(),
    original,
  );
  await settle();
  expect(await loops().runDetail(owner, replayed)).toMatchObject({
    state: "succeeded",
    replayOf: original,
    dryRun: false,
  });
  expect(await comments(issue.id)).toEqual(["On Replay", "On Replay"]);
  const loop = await loops().get(owner, id);
  await runtime.automations.service.setEnabled(owner, randomUUID(), id, {
    revision: (await runtime.automations.service.get(owner, id)).revision,
    enabled: false,
  });
  expect(loop.enabled).toBe(true);
  const { runId: rehearsal } = await loops().dryRun(
    owner,
    randomUUID(),
    id,
    original,
  );
  await settle();
  const detail = await loops().runDetail(owner, rehearsal);
  expect(detail).toMatchObject({
    state: "succeeded",
    dryRun: true,
    replayOf: original,
    steps: [{ state: "succeeded", detail: "Would comment: On Replay" }],
  });
  expect(await comments(issue.id)).toHaveLength(2);
  expect(
    await failure(loops().dryRun(member, randomUUID(), id, null)),
  ).toMatchObject({ status: 403 });
}, 60_000);

it("enforces workspace loop settings, code access and usage", async () => {
  const id = await createLoop([{ kind: "comment", body: "Counted" }]);
  await run(id, (await createIssue("Usage")).id);
  expect(await failure(loops().getSettings(member))).toMatchObject({
    status: 403,
  });
  const settings = await loops().getSettings(owner);
  expect(settings).toMatchObject({
    enabled: true,
    codeAccess: "all",
    usage: { runs: 1 },
  });
  const { revision, centsPerThousandTokens, usage, ...input } = settings;
  expect(centsPerThousandTokens).toBeGreaterThan(0);
  expect(usage.costCents).toBeGreaterThanOrEqual(0);
  expect(
    await failure(
      loops().updateSettings(owner, randomUUID(), {
        revision: revision + 1,
        settings: input,
      }),
    ),
  ).toMatchObject({ status: 409 });
  const selected = await loops().updateSettings(owner, randomUUID(), {
    revision,
    settings: {
      ...input,
      codeAccess: "selected",
      repositoryIds: [],
      retentionDays: 30,
      monthBudgetCapCents: 5_000,
    },
  });
  expect(selected).toMatchObject({
    codeAccess: "selected",
    repositoryIds: [],
    retentionDays: 30,
    monthBudgetCapCents: 5_000,
  });
  expect(
    await failure(
      loops().updateSettings(owner, randomUUID(), {
        revision: selected.revision,
        settings: { ...input, repositoryIds: [randomUUID()] },
      }),
    ),
  ).toMatchObject({ status: 422, code: "repository_unavailable" });
  const loop = await loops().get(owner, id);
  expect(
    await failure(
      loops().updateConfig(owner, randomUUID(), id, {
        revision: loop.revision,
        config: {
          ...loop.config,
          contextSources: [{ kind: "repository", repositoryId: randomUUID() }],
        },
      }),
    ),
  ).toMatchObject({ status: 422, code: "loop_code_access" });
  expect(
    await failure(
      loops().updateConfig(owner, randomUUID(), id, {
        revision: loop.revision - 1,
        config: loop.config,
      }),
    ),
  ).toMatchObject({ status: 409 });
}, 60_000);

it("installs templates disabled and dry-runs them against fixtures", async () => {
  const install = {
    templateId: "monthly-security-report",
    teamId,
    executor: {
      placement: "automatic" as const,
      targetId: null,
      harness: "machdoch" as const,
      model: "",
      capabilities: [],
    },
    providerId,
    model: "fixture-model",
    documentId: null,
    timeZone: "UTC",
  };
  expect(
    await failure(
      loops().installTemplate(
        {
          ...owner,
          delegation: { tokenHash: "token", scope: "cloud:write" },
        },
        randomUUID(),
        install,
      ),
    ),
  ).toMatchObject({ status: 403 });
  expect(
    await failure(
      loops().installTemplate(owner, randomUUID(), {
        ...install,
        templateId: "quarterly-team-report",
      }),
    ),
  ).toMatchObject({ status: 422, code: "loop_template" });
  const loop = await loops().installTemplate(owner, randomUUID(), install);
  expect(loop).toMatchObject({ enabled: false, kind: "automation" });
  expect(loop.trigger).toContain("schedule");
  const { runId } = await loops().dryRun(owner, randomUUID(), loop.id, null);
  await settle();
  const detail = await loops().runDetail(owner, runId);
  expect(detail.state).toBe("succeeded");
  expect(detail.steps.length).toBeGreaterThan(0);
  for (const step of detail.steps) expect(step.detail).toMatch(/^Would /);
  const created = await database.engine.query(
    "SELECT 1 FROM cloud_issues WHERE organization_id=$1",
    [owner.organizationId],
  );
  expect(created.rows).toEqual([]);
}, 60_000);
