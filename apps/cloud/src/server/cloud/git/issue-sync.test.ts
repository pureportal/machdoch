import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import {
  defaultEstimateScale,
  issueInputSchema,
  type CloudActor,
} from "../../../lib/cloud-contract";
import { automationMarker } from "../../../lib/git-events";
import type { GitProvider } from "../../../lib/git-providers";
import { SettingsCipher } from "../../settings-crypto";
import { handleCloudApi } from "../api";
import { cloudMigrations } from "../database";
import { createCloudRuntime, type CloudRuntime } from "../runtime";
import { createTestCloudDatabase } from "../test-database";
import {
  FakeGitServer,
  githubApiUrl,
  gitlabApiUrl,
  gitlabProject,
} from "./test-git-server";

const cipher = new SettingsCipher(randomBytes(32));
const organizationToken = `github_pat_${"o".repeat(40)}`;
const memberToken = `github_pat_${"m".repeat(40)}`;
const gitlabToken = `glpat-${"g".repeat(30)}`;
const issuePath = "/repos/acme/app/issues/12";
const gitlabIssuePath = `/api/v4/projects/${encodeURIComponent(gitlabProject)}/issues/12`;

let database: Awaited<ReturnType<typeof createTestCloudDatabase>>;
let runtime: CloudRuntime;
let server: FakeGitServer;
let owner: CloudActor;
let member: CloudActor;
let teamId: string;
const connectionIds: Partial<Record<GitProvider, string>> = {};
const revoked = new Set<string>();

const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const authorization = new Headers(init?.headers).get("authorization") ?? "";
  if (
    String(input).includes("/issues/") &&
    [...revoked].some((token) => authorization.includes(token))
  ) {
    server.calls.push({
      method: init?.method ?? "GET",
      host: new URL(String(input)).host,
      path: new URL(String(input)).pathname,
      body: init?.body ? JSON.parse(String(init.body)) : null,
      authorization,
    });
    return Response.json({ message: "Bad credentials" }, { status: 401 });
  }
  return server.transport(input, init);
}) as typeof fetch;

async function connect(provider: GitProvider, issueSync = true) {
  const { id } = await runtime.git.connections.connect(
    owner,
    randomUUID(),
    provider,
    {
      revision: 0,
      apiUrl: provider === "github" ? githubApiUrl : gitlabApiUrl,
      token: provider === "github" ? organizationToken : gitlabToken,
      automate: true,
      codeAccess: false,
    },
  );
  connectionIds[provider] = id;
  await runtime.git.connections.addRepository(
    owner,
    id,
    provider === "github" ? "acme/app" : gitlabProject,
  );
  await runtime.git.connections.requestSync(owner, id);
  for (let round = 0; round < 50; round++)
    if (!(await runtime.git.sync.tick())) break;
  await runtime.git.reviewSettings.setRepositorySettings(
    owner,
    (await connection(provider)).repositories[0]!.id,
    { teamId, issueSync },
  );
}

async function connection(provider: GitProvider) {
  return (await runtime.git.connections.get(owner)).connections.find(
    (entry) => entry.id === connectionIds[provider],
  )!;
}

async function deliverGitHub(
  event: string,
  payload: unknown,
  delivery = randomUUID(),
) {
  const hook = await connection("github");
  const body = JSON.stringify(payload);
  const response = await handleCloudApi(
    new Request(hook.webhookUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": event,
        "x-github-delivery": delivery,
        "x-hub-signature-256": `sha256=${createHmac("sha256", hook.webhookSecret).update(body).digest("hex")}`,
      },
      body,
    }),
    "127.0.0.1",
    runtime,
  );
  expect(response.status).toBe(204);
}

async function deliverGitLab(event: string, payload: unknown) {
  const hook = await connection("gitlab");
  const response = await handleCloudApi(
    new Request(hook.webhookUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-gitlab-event": event,
        "x-gitlab-event-uuid": randomUUID(),
        "x-gitlab-token": hook.webhookSecret,
      },
      body: JSON.stringify(payload),
    }),
    "127.0.0.1",
    runtime,
  );
  expect(response.status).toBe(204);
}

function githubIssue(
  fields: Partial<{
    title: string;
    body: string;
    state: string;
    state_reason: string | null;
    labels: string[];
    assignee: string | null;
  }> = {},
) {
  const issue = {
    title: "Crash on start",
    body: "Steps to reproduce",
    state: "open",
    state_reason: null,
    labels: [] as string[],
    assignee: null as string | null,
    ...fields,
  };
  return {
    number: 12,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    state_reason: issue.state_reason,
    labels: issue.labels.map((name) => ({ name })),
    assignee: issue.assignee ? { login: issue.assignee } : null,
    html_url: "https://github.test/acme/app/issues/12",
  };
}

function issuesEvent(
  action: string,
  issue: ReturnType<typeof githubIssue>,
  extra: Record<string, unknown> = {},
) {
  return {
    action,
    issue,
    repository: { id: 7 },
    sender: { login: "octo" },
    ...extra,
  };
}

function commentEvent(
  id: number,
  body: string,
  login: string,
  issue = githubIssue(),
) {
  return {
    action: "created",
    issue,
    comment: { id, body, user: { login } },
    repository: { id: 7 },
    sender: { login },
  };
}

async function syncedIssues() {
  return (
    await database.engine.query<{ issue_id: string; number: number }>(
      "SELECT issue_id,number FROM cloud_git_synced_issues WHERE organization_id=$1",
      [owner.organizationId],
    )
  ).rows;
}

async function syncedIssueId() {
  const [synced] = await syncedIssues();
  return synced!.issue_id;
}

async function issueLabels(issueId: string) {
  return (
    await database.engine.query<{ name: string }>(
      `SELECT l.name FROM cloud_issue_labels a JOIN cloud_labels l ON l.organization_id=a.organization_id AND l.id=a.label_id
      WHERE a.organization_id=$1 AND a.issue_id=$2 ORDER BY l.name`,
      [owner.organizationId, issueId],
    )
  ).rows.map((row) => row.name);
}

async function labelRevision(issueId: string) {
  return (
    (
      await database.engine.query<{ revision: number }>(
        "SELECT revision FROM cloud_issue_label_sets WHERE organization_id=$1 AND issue_id=$2",
        [owner.organizationId, issueId],
      )
    ).rows[0]?.revision ?? 1
  );
}

async function comments(issueId: string) {
  return (await runtime.comments.list(owner, issueId))
    .map(({ authorId, body }) => ({ authorId, body }))
    .sort((left, right) => left.body.localeCompare(right.body));
}

async function drain() {
  let pushed = 0;
  for (let round = 0; round < 20; round++) {
    const claimed = await runtime.git.issueSync.tick();
    if (!claimed) return pushed;
    pushed += claimed;
  }
  throw new Error("Issue sync did not settle.");
}

async function addLabel(actor: CloudActor, issueId: string, name: string) {
  const label = await runtime.labels.create(actor, randomUUID(), teamId, {
    name,
    color: "green",
  });
  const current = await database.engine.query<{ label_id: string }>(
    "SELECT label_id FROM cloud_issue_labels WHERE organization_id=$1 AND issue_id=$2",
    [owner.organizationId, issueId],
  );
  await runtime.labels.setIssue(actor, randomUUID(), issueId, {
    revision: await labelRevision(issueId),
    labelIds: [...current.rows.map((row) => row.label_id), label.id],
  });
}

beforeAll(async () => {
  database = await createTestCloudDatabase();
}, 120_000);
afterAll(async () => {
  await database?.close();
});
beforeEach(async () => {
  await database.engine.exec(
    "TRUNCATE cloud_organizations,cloud_users CASCADE; TRUNCATE cloud_credential_key_checks",
  );
  server = new FakeGitServer();
  revoked.clear();
  server.logins.set(organizationToken, "acme-bot");
  server.logins.set(memberToken, "member-gh");
  server.logins.set(gitlabToken, "acme-gl");
  const organizationId = randomUUID();
  owner = { userId: randomUUID(), organizationId };
  member = { userId: randomUUID(), organizationId };
  await database.engine.query(
    "INSERT INTO cloud_organizations (id,name) VALUES ($1,'Organization')",
    [organizationId],
  );
  for (const [actor, role, name] of [
    [owner, "owner", "Olivia"],
    [member, "member", "Mia"],
  ] as const) {
    await database.engine.query(
      "INSERT INTO cloud_users (id,email,name,password_hash) VALUES ($1,$2,$3,'test')",
      [actor.userId, `${role}@example.test`, name],
    );
    await database.engine.query(
      "INSERT INTO cloud_memberships (organization_id,user_id,role) VALUES ($1,$2,$3)",
      [organizationId, actor.userId, role],
    );
  }
  runtime = createCloudRuntime(database, "https://cloud.example.test", {
    credentialsCipher: cipher,
    gitFetch: transport,
  });
  teamId = (
    await runtime.planning.createTeam(owner, randomUUID(), {
      name: "Platform",
      key: "PLAT",
      visibility: "organization",
      estimateScale: defaultEstimateScale,
    })
  ).id;
});

it("requires a team before syncing repository issues and ignores repositories without sync", async () => {
  await connect("github", false);
  const repositoryId = (await connection("github")).repositories[0]!.id;
  await expect(
    runtime.git.reviewSettings.setRepositorySettings(owner, repositoryId, {
      teamId: null,
      issueSync: true,
    }),
  ).rejects.toMatchObject({ status: 422, code: "team_required" });
  await expect(
    runtime.git.reviewSettings.setRepositorySettings(member, repositoryId, {
      teamId,
      issueSync: true,
    }),
  ).rejects.toMatchObject({ status: 403 });
  await deliverGitHub("issues", issuesEvent("opened", githubIssue()));
  expect(await syncedIssues()).toEqual([]);
  await runtime.git.reviewSettings.setRepositorySettings(owner, repositoryId, {
    teamId,
    issueSync: true,
  });
  expect((await connection("github")).repositories[0]).toMatchObject({
    teamId,
    issueSync: true,
  });
  await deliverGitHub("issues", issuesEvent("opened", githubIssue()));
  expect(await syncedIssues()).toHaveLength(1);
});

it("creates and updates issues from GitHub issue webhooks exactly once per delivery", async () => {
  await connect("github");
  await runtime.git.accounts.connect(member, "github", {
    revision: 0,
    apiUrl: githubApiUrl,
    token: memberToken,
  });
  const opened = issuesEvent(
    "opened",
    githubIssue({ labels: ["Bug"], assignee: "member-gh" }),
  );
  const delivery = randomUUID();
  await deliverGitHub("issues", opened, delivery);
  await deliverGitHub("issues", opened, delivery);
  await deliverGitHub("issues", opened);
  expect(await syncedIssues()).toMatchObject([{ number: 12 }]);
  const issueId = await syncedIssueId();
  expect(await runtime.planning.getIssue(owner, issueId)).toMatchObject({
    teamId,
    title: "Crash on start",
    description: "Steps to reproduce",
    assigneeId: member.userId,
  });
  expect(await issueLabels(issueId)).toEqual(["Bug"]);

  await deliverGitHub(
    "issues",
    issuesEvent("edited", githubIssue({ title: "Crash when starting" }), {
      changes: { title: { from: "Crash on start" } },
    }),
  );
  await deliverGitHub(
    "issues",
    issuesEvent(
      "closed",
      githubIssue({ state: "closed", state_reason: "not_planned" }),
    ),
  );
  await deliverGitHub(
    "issues",
    issuesEvent("unlabeled", githubIssue(), { label: { name: "bug" } }),
  );
  await deliverGitHub(
    "issues",
    issuesEvent("assigned", githubIssue({ assignee: "stranger" })),
  );
  expect(await runtime.planning.getIssue(owner, issueId)).toMatchObject({
    title: "Crash when starting",
    state: "canceled",
    assigneeId: member.userId,
  });
  expect(await issueLabels(issueId)).toEqual([]);

  const comment = commentEvent(900, "Seen it too", "stranger");
  await deliverGitHub("issue_comment", comment);
  await deliverGitHub("issue_comment", comment);
  await deliverGitHub(
    "issue_comment",
    commentEvent(901, "Mine as well", "member-gh"),
  );
  expect(await comments(issueId)).toEqual([
    { authorId: owner.userId, body: "**stranger** via GitHub\n\nSeen it too" },
    { authorId: member.userId, body: "Mine as well" },
  ]);

  expect(await drain()).toBeLessThanOrEqual(1);
  expect(server.callsTo(issuePath, "PATCH")).toEqual([]);
  expect(server.callsTo(/^\/repos\/acme\/app\/issues\/12\//u)).toEqual([]);

  await deliverGitHub("issues", issuesEvent("deleted", githubIssue()));
  expect(await syncedIssues()).toEqual([]);
  expect((await runtime.planning.getIssue(owner, issueId)).title).toBe(
    "Crash when starting",
  );
});

it("pushes cloud edits, labels, assignees and attributed comments to GitHub without echoing them back", async () => {
  await connect("github");
  await runtime.git.accounts.connect(member, "github", {
    revision: 0,
    apiUrl: githubApiUrl,
    token: memberToken,
  });
  await deliverGitHub(
    "issues",
    issuesEvent("opened", githubIssue({ labels: ["Bug"] })),
  );
  const issueId = await syncedIssueId();
  expect(await drain()).toBe(0);

  const issue = await runtime.planning.getIssue(owner, issueId);
  await runtime.issueChanges.apply(owner, randomUUID(), {
    issues: [{ id: issueId, revision: issue.revision }],
    changes: {
      title: "Crash on cold start",
      statusCategory: "complete",
      assigneeId: member.userId,
    },
  });
  await addLabel(member, issueId, "Ready");
  const bugLabelId = (
    await database.engine.query<{ id: string }>(
      "SELECT id FROM cloud_labels WHERE organization_id=$1 AND name='Bug'",
      [owner.organizationId],
    )
  ).rows[0]!.id;
  const kept = (await issueLabels(issueId)).length;
  expect(kept).toBe(2);
  const remaining = await database.engine.query<{ label_id: string }>(
    "SELECT label_id FROM cloud_issue_labels WHERE organization_id=$1 AND issue_id=$2 AND label_id<>$3",
    [owner.organizationId, issueId, bugLabelId],
  );
  await runtime.labels.setIssue(owner, randomUUID(), issueId, {
    revision: await labelRevision(issueId),
    labelIds: remaining.rows.map((row) => row.label_id),
  });
  await runtime.comments.create(member, randomUUID(), issueId, "On it");
  await runtime.comments.create(owner, randomUUID(), issueId, "Thanks");

  expect(await drain()).toBe(1);
  expect(server.callsTo(issuePath, "PATCH").map((call) => call.body)).toEqual([
    {
      title: "Crash on cold start",
      state: "closed",
      state_reason: "completed",
      assignees: ["member-gh"],
    },
  ]);
  expect(
    server.callsTo(`${issuePath}/labels`, "POST").map((call) => call.body),
  ).toEqual([{ labels: ["Ready"] }]);
  expect(server.callsTo(`${issuePath}/labels/bug`, "DELETE")).toHaveLength(1);
  const posted = server.callsTo(`${issuePath}/comments`, "POST");
  expect(posted.map((call) => call.body)).toEqual([
    { body: `On it\n\n${automationMarker}` },
    { body: `*Olivia* via machdoch\n\nThanks\n\n${automationMarker}` },
  ]);
  expect(posted[0]!.authorization).toContain(memberToken);
  expect(posted[1]!.authorization).toContain(organizationToken);

  const pushed = githubIssue({
    title: "Crash on cold start",
    state: "closed",
    state_reason: "completed",
    labels: ["Ready"],
    assignee: "member-gh",
  });
  await deliverGitHub("issues", issuesEvent("closed", pushed));
  await deliverGitHub(
    "issues",
    issuesEvent("labeled", pushed, { label: { name: "Ready" } }),
  );
  await deliverGitHub(
    "issues",
    issuesEvent("unlabeled", pushed, { label: { name: "Bug" } }),
  );
  await deliverGitHub(
    "issue_comment",
    commentEvent(1, `On it\n\n${automationMarker}`, "member-gh", pushed),
  );
  expect(await runtime.comments.list(owner, issueId)).toHaveLength(2);
  expect(await issueLabels(issueId)).toEqual(["Ready"]);
  expect((await runtime.planning.getIssue(owner, issueId)).state).toBe(
    "complete",
  );
  expect(await drain()).toBe(0);
  expect(server.callsTo(issuePath, "PATCH")).toHaveLength(1);
  expect(server.callsTo(`${issuePath}/comments`, "POST")).toHaveLength(2);
});

it("posts comments through the organization connection when the personal account is expired or rejected", async () => {
  await connect("github");
  await runtime.git.accounts.connect(member, "github", {
    revision: 0,
    apiUrl: githubApiUrl,
    token: memberToken,
  });
  await deliverGitHub("issues", issuesEvent("opened", githubIssue()));
  const issueId = await syncedIssueId();

  revoked.add(memberToken);
  await runtime.comments.create(member, randomUUID(), issueId, "Rejected");
  expect(await drain()).toBe(1);
  await database.engine.query(
    "UPDATE cloud_git_accounts SET expires_at=clock_timestamp()-interval '1 hour' WHERE organization_id=$1 AND user_id=$2",
    [owner.organizationId, member.userId],
  );
  await runtime.comments.create(member, randomUUID(), issueId, "Expired");
  expect(await drain()).toBe(1);

  const posted = server.callsTo(`${issuePath}/comments`, "POST");
  expect(
    posted.map((call) => [
      call.authorization?.includes(memberToken) ? "personal" : "organization",
      call.body,
    ]),
  ).toEqual([
    ["personal", { body: `Rejected\n\n${automationMarker}` }],
    [
      "organization",
      { body: `*Mia* via machdoch\n\nRejected\n\n${automationMarker}` },
    ],
    [
      "organization",
      { body: `*Mia* via machdoch\n\nExpired\n\n${automationMarker}` },
    ],
  ]);
  expect(
    (
      await database.engine.query(
        "SELECT count(*)::int AS count FROM cloud_git_synced_comments WHERE organization_id=$1",
        [owner.organizationId],
      )
    ).rows,
  ).toEqual([{ count: 2 }]);
  expect(await drain()).toBe(0);
});

it("keeps unsynced issues dirty and retries after a failed push", async () => {
  await connect("github");
  await deliverGitHub("issues", issuesEvent("opened", githubIssue()));
  const issueId = await syncedIssueId();
  revoked.add(organizationToken);
  await runtime.comments.create(owner, randomUUID(), issueId, "Retry me");
  expect(await drain()).toBe(1);
  const [failed] = (
    await database.engine.query<{
      last_error: string | null;
      attempted_at: Date | null;
    }>(
      "SELECT last_error,attempted_at FROM cloud_git_synced_issues WHERE organization_id=$1",
      [owner.organizationId],
    )
  ).rows;
  expect(failed!.last_error).toBeTruthy();
  expect(failed!.attempted_at).not.toBeNull();
  expect(await drain()).toBe(0);
  revoked.clear();
  await database.engine.query(
    "UPDATE cloud_git_synced_issues SET attempted_at=clock_timestamp()-interval '6 minutes' WHERE organization_id=$1",
    [owner.organizationId],
  );
  expect(await drain()).toBe(1);
  expect(
    (
      await database.engine.query(
        "SELECT last_error,attempted_at FROM cloud_git_synced_issues WHERE organization_id=$1",
        [owner.organizationId],
      )
    ).rows,
  ).toEqual([{ last_error: null, attempted_at: null }]);
});

it("syncs GitLab issues and notes in both directions", async () => {
  server.gitlabUsers.set("member-gl", 31);
  await connect("gitlab");
  await database.engine.query(
    `INSERT INTO cloud_git_accounts (organization_id,user_id,provider,api_url,secret,token_prefix,login)
    VALUES ($1,$2,'gitlab',$3,'\\x00','glpat','member-gl')`,
    [owner.organizationId, member.userId, gitlabApiUrl],
  );
  const project = { id: 42, path_with_namespace: gitlabProject };
  const attributes = {
    iid: 12,
    title: "Broken export",
    description: "CSV is empty",
    state: "opened",
    action: "open",
    url: `https://gitlab.test/${gitlabProject}/-/issues/12`,
  };
  await deliverGitLab("Issue Hook", {
    user: { username: "octo" },
    project,
    object_attributes: attributes,
    labels: [{ title: "Export" }],
    assignees: [{ username: "member-gl" }],
  });
  const issueId = await syncedIssueId();
  expect(await runtime.planning.getIssue(owner, issueId)).toMatchObject({
    title: "Broken export",
    description: "CSV is empty",
    assigneeId: member.userId,
  });
  expect(await issueLabels(issueId)).toEqual(["Export"]);
  await deliverGitLab("Issue Hook", {
    user: { username: "octo" },
    project,
    object_attributes: { ...attributes, state: "closed", action: "close" },
    labels: [],
    assignees: [{ username: "member-gl" }],
    changes: {
      labels: { previous: [{ title: "Export" }], current: [] },
    },
  });
  expect((await runtime.planning.getIssue(owner, issueId)).state).toBe(
    "complete",
  );
  expect(await issueLabels(issueId)).toEqual([]);
  await deliverGitLab("Note Hook", {
    user: { username: "octo" },
    project,
    object_attributes: { id: 77, note: "Reproduced", noteable_type: "Issue" },
    issue: { iid: 12 },
  });
  expect(await comments(issueId)).toEqual([
    { authorId: owner.userId, body: "**octo** via GitLab\n\nReproduced" },
  ]);
  expect(await drain()).toBeLessThanOrEqual(1);
  expect(server.callsTo(gitlabIssuePath, "PUT")).toEqual([]);

  const issue = await runtime.planning.getIssue(owner, issueId);
  await runtime.issueChanges.apply(owner, randomUUID(), {
    issues: [{ id: issueId, revision: issue.revision }],
    changes: { statusCategory: "backlog", assigneeId: null },
  });
  await runtime.issueChanges.apply(owner, randomUUID(), {
    issues: [{ id: issueId }],
    changes: { assigneeId: member.userId },
  });
  await addLabel(owner, issueId, "Urgent");
  await runtime.comments.create(owner, randomUUID(), issueId, "Reopened");
  expect(await drain()).toBe(1);
  expect(
    server.callsTo(gitlabIssuePath, "PUT").map((call) => call.body),
  ).toEqual([{ state_event: "reopen", add_labels: "Urgent" }]);
  expect(
    server.callsTo(`${gitlabIssuePath}/notes`, "POST").map((call) => call.body),
  ).toEqual([
    { body: `*Olivia* via machdoch\n\nReopened\n\n${automationMarker}` },
  ]);
});

it("keeps one synced issue per repository number, lowercase label snapshots and drops snapshots with their repository", async () => {
  await connect("github");
  await deliverGitHub(
    "issues",
    issuesEvent("opened", githubIssue({ labels: ["Bug"] })),
  );
  const issueId = await syncedIssueId();
  const repositoryId = (await connection("github")).repositories[0]!.id;
  const other = await runtime.planning.createIssue(
    owner,
    randomUUID(),
    issueInputSchema.parse({ teamId, title: "Other" }),
  );
  await expect(
    database.engine.query(
      `INSERT INTO cloud_git_synced_issues (organization_id,issue_id,repository_id,number,url,title,body,state,issue_revision)
      VALUES ($1,$2,$3,12,'https://github.test/acme/app/issues/12','Other','','open',1)`,
      [owner.organizationId, other.id, repositoryId],
    ),
  ).rejects.toThrow(/unique|duplicate/);
  await expect(
    database.engine.query(
      "INSERT INTO cloud_git_synced_issue_labels (organization_id,issue_id,name) VALUES ($1,$2,'Ready')",
      [owner.organizationId, issueId],
    ),
  ).rejects.toThrow(/check/);
  await runtime.git.connections.removeRepository(owner, repositoryId);
  expect(
    (
      await database.engine.query(
        "SELECT (SELECT count(*)::int FROM cloud_git_synced_issues WHERE organization_id=$1) AS issues,(SELECT count(*)::int FROM cloud_git_synced_issue_labels WHERE organization_id=$1) AS labels",
        [owner.organizationId],
      )
    ).rows,
  ).toEqual([{ issues: 0, labels: 0 }]);
});

it("adds issue sync tables to existing installations", async () => {
  const engine = new PGlite();
  try {
    await engine.exec(
      await readFile(new URL("../schema.sql", import.meta.url), "utf8"),
    );
    const index = cloudMigrations.indexOf("086-git-issue-sync.sql");
    const apply = async (names: string[]) => {
      for (const name of names)
        await engine.exec(
          await readFile(
            new URL(`../migrations/${name}`, import.meta.url),
            "utf8",
          ),
        );
    };
    await apply(cloudMigrations.slice(0, index));
    const organizationId = randomUUID();
    const userId = randomUUID();
    const repository = randomUUID();
    const connectionId = randomUUID();
    await engine.query(
      "INSERT INTO cloud_organizations (id,name) VALUES ($1,'Organization')",
      [organizationId],
    );
    await engine.query(
      "INSERT INTO cloud_users (id,email,name,password_hash) VALUES ($1,'a@example.test','A','test')",
      [userId],
    );
    await engine.query(
      `INSERT INTO cloud_git_connections (organization_id,id,provider,api_url,secret,token_prefix,account,webhook_id,webhook_secret,actor_id)
      VALUES ($1,$2,'github',$3,'\\x00','ghp','acme',$4,'\\x00',$5)`,
      [organizationId, connectionId, githubApiUrl, randomUUID(), userId],
    );
    await engine.query(
      "INSERT INTO cloud_git_repositories (organization_id,id,connection_id,provider,external_id,full_name,default_branch,private) VALUES ($1,$2,$3,'github',7,'acme/app','main',true)",
      [organizationId, repository, connectionId],
    );
    await apply(cloudMigrations.slice(index));
    expect(
      (
        await engine.query(
          "SELECT issue_sync FROM cloud_git_repositories WHERE id=$1",
          [repository],
        )
      ).rows,
    ).toEqual([{ issue_sync: false }]);
    expect(
      (
        await engine.query(
          "SELECT (SELECT count(*)::int FROM cloud_git_synced_issues) AS issues,(SELECT count(*)::int FROM cloud_git_synced_issue_labels) AS labels,(SELECT count(*)::int FROM cloud_git_synced_comments) AS comments",
        )
      ).rows,
    ).toEqual([{ issues: 0, labels: 0, comments: 0 }]);
  } finally {
    await engine.close();
  }
});
