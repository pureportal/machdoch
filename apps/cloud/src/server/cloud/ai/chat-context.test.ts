import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { automationInputSchema } from "../../../lib/cloud-automation-contract";
import type {
  ChatContextReference,
  CloudChat,
} from "../../../lib/cloud-chat-contract";
import { issueInputSchema, type CloudActor } from "../../../lib/cloud-contract";
import { pipelineInputSchema } from "../../../lib/cloud-release-pipeline-contract";
import { productInputSchema } from "../../../lib/cloud-release-contract";
import { SettingsCipher } from "../../settings-crypto";
import { cloudMigrations } from "../database";
import { githubApiUrl } from "../git/test-git-server";
import { createCloudRuntime, type CloudRuntime } from "../runtime";
import { createTestCloudDatabase } from "../test-database";
import { agentContext } from "./agent-context";

let database: Awaited<ReturnType<typeof createTestCloudDatabase>>;
let runtime: CloudRuntime;
let owner: CloudActor;
let member: CloudActor;
let outsider: CloudActor;
let providerId: string;

beforeAll(async () => {
  database = await createTestCloudDatabase();
}, 120_000);
afterAll(async () => {
  await database?.close();
});
afterEach(async () => {
  await runtime?.inference.worker.close();
});
beforeEach(async () => {
  await database.engine.exec(
    "TRUNCATE cloud_organizations,cloud_users CASCADE; TRUNCATE cloud_credential_key_checks",
  );
  const organizationId = randomUUID();
  owner = { userId: randomUUID(), organizationId };
  member = { userId: randomUUID(), organizationId };
  outsider = { userId: randomUUID(), organizationId };
  await database.engine.query(
    "INSERT INTO cloud_organizations (id,name) VALUES ($1,'Organization')",
    [organizationId],
  );
  for (const [actor, role, name] of [
    [owner, "owner", "Olga Owner"],
    [member, "member", "Mia Member"],
    [outsider, "member", "Otto Outsider"],
  ] as const) {
    await database.engine.query(
      "INSERT INTO cloud_users (id,email,name,password_hash) VALUES ($1,$2,$3,'test')",
      [actor.userId, `${randomUUID()}@example.test`, name],
    );
    await database.engine.query(
      "INSERT INTO cloud_memberships (organization_id,user_id,role) VALUES ($1,$2,$3)",
      [organizationId, actor.userId, role],
    );
  }
  runtime = createCloudRuntime(database, "https://cloud.example.test", {
    credentialsCipher: new SettingsCipher(randomBytes(32)),
  });
  providerId = (
    await runtime.aiProviders.create(owner, randomUUID(), {
      name: "Provider",
      provider: "openai",
      region: null,
      models: ["fixture-model"],
      apiKey: "private-fixture-key",
      maxOutputTokens: 256,
      dailyTokenBudget: 1_000_000,
      maxConcurrentRequests: 4,
    })
  ).id;
});

async function workspaceEntities() {
  const organization = owner.organizationId;
  const query = (text: string, values: unknown[]) =>
    database.engine.query(text, values);
  const team = await runtime.planning.createTeam(owner, randomUUID(), {
    name: "Product",
    key: "PRD",
    visibility: "private",
    estimateScale: [
      { label: "1", points: 1 },
      { label: "3", points: 3 },
    ],
  });
  await query(
    "INSERT INTO cloud_team_memberships (organization_id,team_id,user_id) VALUES ($1,$2,$3)",
    [organization, team.id, member.userId],
  );
  const issue = await runtime.planning.createIssue(
    owner,
    randomUUID(),
    issueInputSchema.parse({
      teamId: team.id,
      title: "Checkout loses the basket",
    }),
  );
  const connection = randomUUID();
  const repository = randomUUID();
  const pullRequest = randomUUID();
  await query(
    `INSERT INTO cloud_git_connections (organization_id,id,provider,api_url,secret,token_prefix,account,webhook_id,webhook_secret,actor_id)
    VALUES ($1,$2,'github',$3,'\\x00','ghp','acme',$4,'\\x00',$5)`,
    [organization, connection, githubApiUrl, randomUUID(), owner.userId],
  );
  await query(
    "INSERT INTO cloud_git_repositories (organization_id,id,connection_id,provider,external_id,full_name,default_branch,private) VALUES ($1,$2,$3,'github',7,'acme/app','main',true)",
    [organization, repository, connection],
  );
  await query(
    `INSERT INTO cloud_git_pull_requests (organization_id,id,repository_id,number,title,url,state,draft,author,head_ref,head_sha,base_ref,checks,review,stage,updated_at,requested_reviewers)
    VALUES ($1,$2,$3,12,'Keep the basket on reload','https://github.com/acme/app/pull/12','open',false,'ada','fix/basket',$4,'main','failure','none','attention',clock_timestamp(),'{grace}')`,
    [organization, pullRequest, repository, "a".repeat(40)],
  );
  await query(
    "INSERT INTO cloud_git_pull_request_issues (organization_id,pull_request_id,issue_id,closes) VALUES ($1,$2,$3,true)",
    [organization, pullRequest, issue.id],
  );
  const view = randomUUID();
  const personalView = randomUUID();
  await query(
    "INSERT INTO cloud_saved_views (organization_id,id,user_id,name,scope,filters) VALUES ($1,$2,$3,'Basket bugs','workspace',$4),($1,$5,$6,'Olga only','personal','{}')",
    [
      organization,
      view,
      member.userId,
      JSON.stringify({ teamId: team.id, query: "basket" }),
      personalView,
      owner.userId,
    ],
  );
  const product = await runtime.releases.products.create(
    owner,
    randomUUID(),
    productInputSchema.parse({
      name: "machdoch",
      key: "machdoch",
      website: "https://machdoch.app",
      brand: {
        primary: "#6356cf",
        accent: "#7bc8ef",
        background: "#141519",
        foreground: "#eeedf2",
      },
      teamIds: [team.id],
    }),
  );
  const release = await runtime.releases.releases.create(owner, randomUUID(), {
    productId: product.id,
    version: "1.2.0",
    name: "Spring",
    since: null,
    targetDate: null,
  });
  await query(
    "UPDATE cloud_releases SET notes='Faster checkout for everyone.' WHERE organization_id=$1 AND id=$2",
    [organization, release.id],
  );
  await query(
    "INSERT INTO cloud_release_items (organization_id,release_id,issue_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",
    [organization, release.id, issue.id],
  );
  const pipeline = await runtime.releases.pipelines.create(
    owner,
    randomUUID(),
    pipelineInputSchema.parse({
      name: "Web",
      teamIds: [team.id],
      repositoryId: repository,
      paths: [],
      type: "continuous",
      source: "deployment",
      environments: ["production"],
    }),
  );
  const deployment = randomUUID();
  await query(
    "INSERT INTO cloud_pipeline_releases (organization_id,id,pipeline_id,environment,version,external_id) VALUES ($1,$2,$3,'production','2026.05.1','d1')",
    [organization, deployment, pipeline.id],
  );
  await query(
    "INSERT INTO cloud_pipeline_release_issues (organization_id,release_id,issue_id,source) VALUES ($1,$2,$3,'manual')",
    [organization, deployment, issue.id],
  );
  const loop = await runtime.automations.service.create(
    owner,
    randomUUID(),
    automationInputSchema.parse({
      name: "Nightly triage",
      teamId: team.id,
      trigger: { kind: "manual" },
      actions: [{ kind: "comment", body: "Hello" }],
    }),
  );
  await query(
    "INSERT INTO cloud_automation_runs (organization_id,id,automation_id,dedupe_key,trigger,state,error) VALUES ($1,$2,$3,'run-1','manual','failed','Model unavailable')",
    [organization, randomUUID(), loop.id],
  );
  const document = randomUUID();
  await query(
    "INSERT INTO cloud_documents (organization_id,id,team_id,title) VALUES ($1,$2,$3,'Runbook')",
    [organization, document, team.id],
  );
  await query(
    "INSERT INTO cloud_document_sections (organization_id,id,document_id,position,heading,body) VALUES ($1,$2,$3,1,'Deploy','Run the web pipeline after merging.')",
    [organization, randomUUID(), document],
  );
  return {
    team,
    issue,
    repository,
    pullRequest,
    view,
    personalView,
    release: release.id,
    deployment,
    pipeline: pipeline.id,
    loop: loop.id,
    document,
  };
}

async function attach(
  actor: CloudActor,
  context: ChatContextReference[],
): Promise<CloudChat> {
  const submission = await runtime.chat.store.submit(actor, randomUUID(), {
    chatId: null,
    revision: null,
    providerId,
    model: "fixture-model",
    prompt: "What should I know?",
    context,
    attachmentIds: [],
  });
  return (await runtime.chat.store.get(actor, submission.chatId)).chat;
}

it("attaches pull requests, views, releases, loops, documents and repositories as agent context", async () => {
  const entities = await workspaceEntities();
  const chat = await attach(member, [
    { kind: "pull_request", id: entities.pullRequest },
    { kind: "view", id: entities.view },
    { kind: "release", id: entities.release },
    { kind: "release", id: entities.deployment },
    { kind: "loop", id: entities.loop },
    { kind: "document", id: entities.document },
    { kind: "repository", id: entities.repository },
  ]);
  expect(
    chat.context.map(({ kind, label, title }) => ({ kind, label, title })),
  ).toEqual([
    {
      kind: "pull_request",
      label: "acme/app#12",
      title: "Keep the basket on reload",
    },
    { kind: "view", label: "Basket bugs", title: null },
    { kind: "release", label: "machdoch 1.2.0", title: "Spring" },
    { kind: "release", label: "Web 2026.05.1", title: "production" },
    { kind: "loop", label: "Nightly triage", title: null },
    { kind: "document", label: "Runbook", title: null },
    { kind: "repository", label: "acme/app", title: null },
  ]);
  const prompt = await database.transaction((sql) =>
    agentContext(sql, member, chat.context),
  );
  const issueLink = `[PRD-1](/cloud/issues/${entities.issue.id}) Checkout loses the basket`;
  for (const expected of [
    `## Pull request [acme/app#12](/cloud/pull-requests/${entities.pullRequest}): Keep the basket on reload`,
    "Stage attention; author ada; fix/basket into main; checks failure; review none; requested reviewers grace;",
    `- ${issueLink} (Backlog)`,
    `## View [Basket bugs](/cloud/views/${entities.view})`,
    "Matching issues (1):",
    `## Release [machdoch 1.2.0](/cloud/releases/${entities.release}): Spring`,
    "Faster checkout for everyone.",
    `## Release [Web 2026.05.1](/cloud/releases/pipelines/${entities.pipeline}/${entities.deployment})`,
    "Deployed to production at",
    `## Automation [Nightly triage](/cloud/automations/${entities.loop})`,
    "failed: Model unavailable",
    `## Document [Runbook](/cloud/documents/${entities.document})\n### Deploy\nRun the web pipeline after merging.`,
    "## Repository acme/app\ngithub; default branch main; private.",
    `- [#12](/cloud/pull-requests/${entities.pullRequest}) Keep the basket on reload (attention)`,
  ])
    expect(prompt).toContain(expected);
});

it("refuses context the member cannot see and hides it once access is gone", async () => {
  const entities = await workspaceEntities();
  for (const reference of [
    { kind: "loop", id: entities.loop },
    { kind: "document", id: entities.document },
  ] as const)
    await expect(attach(outsider, [reference])).rejects.toMatchObject({
      code: "context_unavailable",
    });
  const shared = await attach(outsider, [{ kind: "view", id: entities.view }]);
  expect(
    await database.transaction((sql) =>
      agentContext(sql, outsider, shared.context),
    ),
  ).toContain("Matching issues: none");
  await expect(
    attach(member, [{ kind: "view", id: entities.personalView }]),
  ).rejects.toMatchObject({ code: "context_unavailable" });
  const chat = await attach(member, [
    { kind: "pull_request", id: entities.pullRequest },
    { kind: "release", id: entities.release },
    { kind: "document", id: entities.document },
  ]);
  expect(chat.context).toHaveLength(3);
  await database.engine.query(
    "UPDATE cloud_roles SET permissions=array_remove(array_remove(permissions,'git.view'),'releases.view') WHERE organization_id=$1 AND key='member'",
    [member.organizationId],
  );
  for (const reference of [
    { kind: "pull_request", id: entities.pullRequest },
    { kind: "repository", id: entities.repository },
    { kind: "release", id: entities.deployment },
  ] as const)
    await expect(attach(member, [reference])).rejects.toMatchObject({
      code: "context_unavailable",
    });
  const remaining = (await runtime.chat.store.get(member, chat.id)).chat
    .context;
  expect(remaining.map((entry) => entry.kind)).toEqual(["document"]);
  const prompt = await database.transaction((sql) =>
    agentContext(sql, member, [
      ...remaining,
      {
        kind: "pull_request",
        id: entities.pullRequest,
        label: "acme/app#12",
        title: null,
        turnSequence: 1,
      },
    ]),
  );
  expect(prompt).toContain("## Document [Runbook]");
  expect(prompt).not.toContain("Keep the basket on reload");
});

it("accepts the new context kinds in existing installations", async () => {
  const engine = new PGlite();
  try {
    await engine.exec(
      await readFile(new URL("../schema.sql", import.meta.url), "utf8"),
    );
    for (const name of cloudMigrations)
      await engine.exec(
        await readFile(
          new URL(`../migrations/${name}`, import.meta.url),
          "utf8",
        ),
      );
    const definition = (
      await engine.query<{ definition: string }>(
        "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname='cloud_chat_context_kind_check'",
      )
    ).rows[0]!.definition;
    for (const kind of [
      "issue",
      "pull_request",
      "view",
      "release",
      "loop",
      "document",
      "repository",
    ])
      expect(definition).toContain(`'${kind}'`);
  } finally {
    await engine.close();
  }
});
