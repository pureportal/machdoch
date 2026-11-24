import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { issueInputSchema } from "../../../lib/cloud-contract";
import { automationInputSchema } from "../../../lib/cloud-automation-contract";
import {
  createIssue,
  createLoop,
  database,
  failure,
  loops,
  modelReplies,
  owner,
  providerId,
  runtime,
  settle,
  teamId,
  useLoopTestRuntime,
} from "./loop-test-harness";

useLoopTestRuntime();

async function startRun(id: string, issueId: string | null) {
  const { runIds } = await runtime.automations.service.run(
    owner,
    randomUUID(),
    id,
    { issueId },
  );
  return runIds[0]!;
}

async function driveAgent(runId: string) {
  for (let round = 0; round < 20; round++) {
    await settle();
    const calls = (
      await database.engine.query<{ id: string }>(
        "SELECT id FROM cloud_inference_calls WHERE state='queued' ORDER BY created_at",
      )
    ).rows;
    if (!calls.length) break;
    for (const call of calls)
      await runtime.inference.worker.runOne(owner.organizationId, call.id);
  }
  return loops().runDetail(owner, runId);
}

function goal(maxIterations: number) {
  return {
    kind: "goal",
    objective: "Draft release notes",
    successCriteria: "Mentions every merged change",
    providerId,
    model: "fixture-model",
    maxIterations,
  };
}

async function urgentIssue(title: string) {
  return runtime.planning.createIssue(
    owner,
    randomUUID(),
    issueInputSchema.parse({ teamId, title, priority: "urgent" }),
  );
}

it("iterates a goal with evaluator feedback until it passes", async () => {
  const id = await createLoop([
    goal(3),
    { kind: "comment", body: "{{agent.answer}}" },
  ]);
  const issue = await createIssue("Release notes");
  modelReplies.push(
    "First draft",
    "FAIL\nAdd the checkout fix.",
    "Second draft with checkout fix",
    "PASS",
  );
  const detail = await driveAgent(await startRun(id, issue.id));
  expect(detail.state).toBe("succeeded");
  expect(detail.steps[0]!.detail).toBe("Goal met after 2 iterations");
  expect(
    (await runtime.comments.list(owner, issue.id)).map(
      (comment) => comment.body,
    ),
  ).toEqual(["Second draft with checkout fix"]);
}, 60_000);

it("fails a goal that is not met within the iteration limit", async () => {
  const id = await createLoop([goal(1)]);
  modelReplies.push("Draft", "FAIL\nMissing the API change.");
  const detail = await driveAgent(
    await startRun(id, (await createIssue("Notes")).id),
  );
  expect(detail.state).toBe("failed");
  expect(detail.error).toContain(
    "Goal not met after 1 iteration. Missing the API change.",
  );
}, 60_000);

it("fans out to matching issues with bounded concurrency", async () => {
  const target = await createLoop(
    [{ kind: "comment", body: "Triaged" }],
    (config) => config,
    "Triage",
  );
  const issues = [
    await urgentIssue("One"),
    await urgentIssue("Two"),
    await urgentIssue("Three"),
  ];
  await createIssue("Not urgent");
  const parent = await createLoop([
    {
      kind: "fan_out",
      automationId: target,
      conditions: [{ field: "priority", negated: false, values: ["urgent"] }],
      concurrency: 2,
    },
  ]);
  const runId = await startRun(parent, null);
  await runtime.automations.dispatcher.tick();
  const started = await database.engine.query<{ issue_id: string }>(
    "SELECT issue_id FROM cloud_automation_runs WHERE parent_run_id=$1",
    [runId],
  );
  expect(started.rows.length).toBe(2);
  for (let round = 0; round < 5; round++) await settle();
  const detail = await loops().runDetail(owner, runId);
  expect(detail.state).toBe("succeeded");
  expect(detail.steps[0]!.detail).toBe("Ran Triage on 3 issues");
  for (const issue of issues)
    expect(
      (await runtime.comments.list(owner, issue.id)).map(
        (comment) => comment.body,
      ),
    ).toEqual(["Triaged"]);
}, 60_000);

it("skips fanning out to itself", async () => {
  const id = await createLoop([{ kind: "comment", body: "Placeholder" }]);
  const { revision } = await runtime.automations.service.get(owner, id);
  await runtime.automations.service.update(owner, randomUUID(), id, {
    revision,
    automation: automationInputSchema.parse({
      name: "Loop",
      teamId,
      trigger: { kind: "manual" },
      actions: [{ kind: "fan_out", automationId: id }],
    }),
  });
  const runId = await startRun(id, null);
  await settle();
  expect((await loops().runDetail(owner, runId)).steps[0]).toMatchObject({
    state: "skipped",
    detail: "A loop cannot fan out to itself.",
  });
}, 60_000);

it("resolves view, filter, project, document and repository context", async () => {
  await createIssue("Checkout fails");
  await urgentIssue("Outage");
  const view = await runtime.views.create(owner, randomUUID(), {
    name: "Checkout work",
    filters: { query: "Checkout" },
    description: "",
    icon: "bookmark",
    scope: "personal",
    teamId: null,
  });
  await runtime.projects.create(owner, randomUUID(), {
    teamId,
    name: "Launch",
    description: "Ship v2",
  });
  const documentId = randomUUID();
  await database.engine.query(
    "INSERT INTO cloud_documents (organization_id,id,team_id,title) VALUES ($1,$2,$3,'Runbook')",
    [owner.organizationId, documentId, teamId],
  );
  await database.engine.query(
    "INSERT INTO cloud_document_sections (organization_id,id,document_id,position,heading,body) VALUES ($1,$2,$3,1,'Deploy','Use the pipeline')",
    [owner.organizationId, randomUUID(), documentId],
  );
  const connectionId = randomUUID();
  await database.engine.query(
    `INSERT INTO cloud_git_connections (organization_id,id,provider,api_url,secret,token_prefix,account,webhook_id,webhook_secret,actor_id)
    VALUES ($1,$4,'github','https://api.github.test','\\x00','ghp','acme',$2,'\\x00',$3)`,
    [owner.organizationId, randomUUID(), owner.userId, connectionId],
  );
  const repositoryId = randomUUID();
  await database.engine.query(
    "INSERT INTO cloud_git_repositories (organization_id,id,connection_id,provider,external_id,full_name,default_branch,private) VALUES ($1,$2,$3,'github',7,'acme/app','main',true)",
    [owner.organizationId, repositoryId, connectionId],
  );
  const id = await createLoop(
    [{ kind: "comment", body: "Read" }],
    (config) => ({
      ...config,
      contextSources: [
        { kind: "saved_view", savedViewId: view.id },
        {
          kind: "filter",
          conditions: [
            { field: "priority", negated: false, values: ["urgent"] },
          ],
        },
        { kind: "team_projects", teamId },
        { kind: "document", documentId },
        { kind: "repository", repositoryId },
      ],
    }),
  );
  const issue = await createIssue("Run");
  const context = async () => {
    const runId = await startRun(id, issue.id);
    await settle();
    return (await loops().runDetail(owner, runId)).resolvedContext!;
  };
  const resolved = await context();
  expect(resolved.map((entry) => entry.title)).toEqual([
    "Checkout work",
    "Issues",
    "Team projects",
    "Runbook",
    "acme/app",
  ]);
  expect(resolved[0]!.items).toEqual([
    expect.stringMatching(/^TM-\d+ · .+ · Checkout fails$/),
  ]);
  expect(resolved[1]!.items).toEqual([
    expect.stringMatching(/^TM-\d+ · .+ · Outage$/),
  ]);
  expect(resolved[2]!.items).toEqual([expect.stringMatching(/^Launch · /)]);
  expect(resolved[3]!.items).toEqual(["Deploy\nUse the pipeline"]);
  const settings = await loops().getSettings(owner);
  const {
    revision,
    centsPerThousandTokens: _rate,
    usage: _usage,
    ...input
  } = settings;
  await loops().updateSettings(owner, randomUUID(), {
    revision,
    settings: { ...input, codeAccess: "selected", repositoryIds: [] },
  });
  expect(await failure(context())).toMatchObject({
    message: "Loops may not access this repository.",
  });
  await database.engine.query(
    "DELETE FROM cloud_git_repositories WHERE id=$1",
    [repositoryId],
  );
  expect((await context()).map((entry) => entry.kind)).toEqual([
    "saved_view",
    "filter",
    "team_projects",
    "document",
  ]);
}, 60_000);
