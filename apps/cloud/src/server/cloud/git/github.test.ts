import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import {
  defaultEstimateScale,
  issueInputSchema,
  type CloudActor,
} from "../../../lib/cloud-contract";
import { SettingsCipher } from "../../settings-crypto";
import { handleCloudApi } from "../api";
import { createCloudRuntime, type CloudRuntime } from "../runtime";
import { createTestCloudDatabase } from "../test-database";
import { githubWebhookEvents } from "./github-client";

interface FakePullRequest {
  number: number;
  title: string;
  body: string;
  html_url: string;
  state: "open" | "closed";
  draft: boolean;
  merged_at: string | null;
  user: { login: string };
  head: { ref: string; sha: string };
  base: { ref: string };
  mergeable: boolean | null;
  mergeable_state: string;
  updated_at: string;
}

interface FakeCheckRun {
  name: string;
  status: string;
  conclusion: string | null;
}

interface GitHubCall {
  method: string;
  path: string;
  body: unknown;
  authorization: string | null;
}

let database: Awaited<ReturnType<typeof createTestCloudDatabase>>;
let runtime: CloudRuntime;
let owner: CloudActor;
let member: CloudActor;
let viewer: CloudActor;
let pulls: Map<number, FakePullRequest>;
let reviews: Map<number, string[]>;
let checkRuns: Map<string, FakeCheckRun[]>;
let calls: GitHubCall[];
let clock: number;
const cipher = new SettingsCipher(randomBytes(32));
const token = `github_pat_${"b".repeat(60)}`;
const apiUrl = "https://api.github.test";
const passing = [{ name: "unit", status: "completed", conclusion: "success" }];

function later(): string {
  clock += 60_000;
  return new Date(clock).toISOString();
}

function sha(seed: number): string {
  return seed.toString(16).padStart(40, "0");
}

function addPullRequest(
  number: number,
  fields: Partial<FakePullRequest> & { head: FakePullRequest["head"] },
) {
  pulls.set(number, {
    number,
    title: `Change ${number}`,
    body: "",
    html_url: `https://github.test/acme/app/pull/${number}`,
    state: "open",
    draft: false,
    merged_at: null,
    user: { login: "octocat" },
    base: { ref: "main" },
    mergeable: true,
    mergeable_state: "clean",
    updated_at: later(),
    ...fields,
  });
}

function updatePullRequest(number: number, fields: Partial<FakePullRequest>) {
  Object.assign(pulls.get(number)!, fields, { updated_at: later() });
}

function mergePullRequest(number: number) {
  updatePullRequest(number, {
    state: "closed",
    merged_at: new Date(clock).toISOString(),
  });
}

const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const body: unknown = init?.body ? JSON.parse(String(init.body)) : null;
  calls.push({
    method,
    path: url.pathname,
    body,
    authorization: new Headers(init?.headers).get("authorization"),
  });
  const json = (value: unknown, status = 200) =>
    Response.json(value, { status });
  if (url.pathname === "/user") return json({ login: "octocat" });
  if (url.pathname === "/repos/acme/app")
    return json({
      id: 7,
      full_name: "acme/app",
      private: true,
      default_branch: "main",
      html_url: "https://github.test/acme/app",
    });
  if (method === "POST" && url.pathname === "/repos/acme/app/hooks")
    return json({ id: 99 }, 201);
  if (method === "DELETE" && url.pathname === "/repos/acme/app/hooks/99")
    return new Response(null, { status: 204 });
  if (url.pathname === "/repos/acme/app/pulls")
    return json(
      [...pulls.values()].sort((left, right) =>
        right.updated_at.localeCompare(left.updated_at),
      ),
    );
  const checks =
    /^\/repos\/acme\/app\/commits\/([0-9a-f]{40})\/check-runs$/u.exec(
      url.pathname,
    );
  if (checks) {
    const runs = checkRuns.get(checks[1]!) ?? passing;
    return json({
      total_count: runs.length,
      check_runs: runs.map((run) => ({
        ...run,
        html_url: `https://github.test/runs/${run.name}`,
      })),
    });
  }
  const match = /^\/repos\/acme\/app\/pulls\/(\d+)(?:\/([\w-]+))?$/u.exec(
    url.pathname,
  );
  const pull = match ? pulls.get(Number(match[1])) : undefined;
  if (!match || !pull) return json({ message: "Not Found" }, 404);
  if (!match[2]) return json({ ...pull, additions: 12, deletions: 3 });
  if (match[2] === "merge") {
    if ((body as { sha: string }).sha !== pull.head.sha)
      return json({ message: "Head branch was modified." }, 409);
    mergePullRequest(pull.number);
    return json({ merged: true });
  }
  if (match[2] === "update-branch")
    return (body as { expected_head_sha: string }).expected_head_sha ===
      pull.head.sha
      ? json({ message: "Updating pull request branch." }, 202)
      : json({ message: "expected head sha didn't match" }, 422);
  if (match[2] === "reviews")
    return json(
      (reviews.get(pull.number) ?? []).map((state, index) => ({
        user: { login: `reviewer-${index}` },
        state,
        submitted_at: "2026-11-01T10:00:00Z",
      })),
    );
  if (match[2] === "files")
    return json([
      {
        filename: "src/sign-in.ts",
        status: "modified",
        additions: 2,
        deletions: 1,
        patch: "@@ -1 +1,2 @@\n-old\n+new\n+more",
      },
      {
        filename: "assets/logo.png",
        status: "added",
        additions: 0,
        deletions: 0,
      },
    ]);
  if (match[2] === "comments")
    return json([
      {
        id: 5,
        user: { login: "reviewer" },
        body: "Rename this value.",
        path: "src/sign-in.ts",
        line: 3,
        diff_hunk: "@@ -1,3 +1,3 @@",
        html_url: "https://github.test/acme/app/pull/1#discussion_r5",
        created_at: "2026-11-01T10:00:00Z",
      },
    ]);
  return json({ message: "Not Found" }, 404);
}) as typeof fetch;

async function createTeam(key: string, visibility: "organization" | "private") {
  return runtime.planning.createTeam(owner, randomUUID(), {
    name: key,
    key,
    visibility,
    estimateScale: defaultEstimateScale,
  });
}

async function createIssue(teamId: string, title: string) {
  return runtime.planning.createIssue(
    owner,
    randomUUID(),
    issueInputSchema.parse({ teamId, title }),
  );
}

async function issueStatus(issueId: string) {
  return (await runtime.planning.getIssue(owner, issueId)).statusName;
}

async function connect() {
  await runtime.git.connections.connect(owner, randomUUID(), "github", {
    revision: 0,
    apiUrl,
    token,
    automate: true,
  });
  await runtime.git.connections.addRepository(owner, "github", "acme/app");
}

async function sync() {
  await runtime.git.connections.requestSync(owner, "github");
  for (let round = 0; round < 50; round++)
    if (!(await runtime.git.sync.tick())) return;
  throw new Error("GitHub sync did not settle.");
}

async function webhook() {
  const connection = (await runtime.git.connections.get(owner)).connections
    .github!;
  return {
    id: connection.webhookUrl.split("/").at(-1)!,
    secret: connection.webhookSecret,
  };
}

function signed(secret: string, body: string) {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function deliver(
  hook: { id: string },
  event: string,
  delivery: string,
  body: string,
  signature: string,
) {
  return handleCloudApi(
    new Request(
      `https://cloud.example.test/api/v1/integrations/github/webhooks/${hook.id}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": event,
          "x-github-delivery": delivery,
          "x-hub-signature-256": signature,
        },
        body,
      },
    ),
    "127.0.0.1",
    runtime,
  );
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
  pulls = new Map();
  reviews = new Map();
  checkRuns = new Map();
  calls = [];
  clock = Date.now() + 60_000;
  const organizationId = randomUUID();
  owner = { userId: randomUUID(), organizationId };
  member = { userId: randomUUID(), organizationId };
  viewer = { userId: randomUUID(), organizationId };
  await database.engine.query(
    "INSERT INTO cloud_organizations (id,name) VALUES ($1,'Organization')",
    [organizationId],
  );
  for (const [actor, role] of [
    [owner, "owner"],
    [member, "member"],
    [viewer, "viewer"],
  ] as const) {
    await database.engine.query(
      "INSERT INTO cloud_users (id,email,name,password_hash) VALUES ($1,$2,$3,'test')",
      [actor.userId, `${role}@example.test`, role],
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
});

it("keeps the token encrypted, lets only administrators connect and requires a token for a new API address", async () => {
  await expect(
    runtime.git.connections.connect(member, randomUUID(), "github", {
      revision: 0,
      apiUrl,
      token,
      automate: true,
    }),
  ).rejects.toMatchObject({ status: 403 });
  await connect();
  const administration = await runtime.git.connections.get(owner);
  expect(administration.connections.github).toMatchObject({
    apiUrl,
    account: "octocat",
    tokenPrefix: token.slice(0, 12),
    repositories: [{ fullName: "acme/app", private: true, webhook: true }],
  });
  expect(JSON.stringify(administration)).not.toContain(token);
  const stored = await database.engine.query<{ secret: Uint8Array }>(
    "SELECT secret FROM cloud_git_connections",
  );
  expect(Buffer.from(stored.rows[0]!.secret).toString("utf8")).not.toContain(
    token,
  );
  expect(calls.find((call) => call.path === "/repos/acme/app/hooks")).toEqual(
    expect.objectContaining({
      authorization: `Bearer ${token}`,
      body: expect.objectContaining({
        events: githubWebhookEvents,
        config: expect.objectContaining({
          url: administration.connections.github!.webhookUrl,
          secret: administration.connections.github!.webhookSecret,
        }),
      }),
    }),
  );
  await expect(runtime.git.connections.get(member)).rejects.toMatchObject({
    status: 403,
  });
  await expect(
    runtime.git.connections.connect(owner, randomUUID(), "github", {
      revision: administration.connections.github!.revision,
      apiUrl: "https://github.example.test/api/v3",
      automate: true,
    }),
  ).rejects.toMatchObject({ code: "git_token_required" });
  await runtime.git.connections.disconnect(
    owner,
    "github",
    administration.connections.github!.revision,
  );
  expect(calls.at(-1)).toMatchObject({
    method: "DELETE",
    path: "/repos/acme/app/hooks/99",
  });
  expect(
    (await runtime.git.connections.get(owner)).connections.github,
  ).toBeUndefined();
});

it("links existing pull requests without moving issues, then moves issues forward as pull requests change", async () => {
  const team = await createTeam("PLAT", "organization");
  const signIn = await createIssue(team.id, "Sign in");
  const tidy = await createIssue(team.id, "Tidy");
  const reviewed = await createIssue(team.id, "Reviewed");
  const shipped = await createIssue(team.id, "Shipped");
  await runtime.issueChanges.apply(owner, randomUUID(), {
    issues: [{ id: reviewed.id }],
    changes: { statusCategory: "review" },
  });
  addPullRequest(1, {
    head: { ref: "octo/plat-1-sign-in", sha: sha(1) },
    draft: true,
  });
  addPullRequest(2, {
    head: { ref: "cleanup", sha: sha(2) },
    body: "Refs PLAT-2. See PLAT-9.",
  });
  addPullRequest(3, {
    head: { ref: "feature", sha: sha(3) },
    title: "PLAT-3 polish",
    draft: true,
  });
  addPullRequest(4, { head: { ref: "plat-4-ship", sha: sha(4) } });
  mergePullRequest(4);
  await connect();
  await sync();
  expect(await issueStatus(signIn.id)).toBe("Backlog");
  expect(await issueStatus(shipped.id)).toBe("Backlog");
  expect(await runtime.git.pullRequests.forIssue(owner, signIn.id)).toEqual([
    expect.objectContaining({
      repository: "acme/app",
      number: 1,
      draft: true,
      stage: "draft",
      checks: "success",
      review: "none",
      closes: true,
    }),
  ]);
  expect(await runtime.git.pullRequests.forIssue(owner, tidy.id)).toEqual([
    expect.objectContaining({ number: 2, closes: false, stage: "review" }),
  ]);
  expect(await runtime.git.pullRequests.forIssue(owner, shipped.id)).toEqual([
    expect.objectContaining({ stage: "merged" }),
  ]);

  updatePullRequest(1, { draft: false });
  updatePullRequest(3, { draft: false });
  mergePullRequest(2);
  await sync();
  expect(await issueStatus(signIn.id)).toBe("In review");
  expect(await issueStatus(reviewed.id)).toBe("In review");
  expect(await issueStatus(tidy.id)).toBe("Backlog");

  await runtime.issueChanges.apply(owner, randomUUID(), {
    issues: [{ id: signIn.id }],
    changes: { statusCategory: "active" },
  });
  updatePullRequest(1, { title: "Sign in with passkeys" });
  await sync();
  expect(await issueStatus(signIn.id)).toBe("In progress");

  mergePullRequest(1);
  await sync();
  expect(await issueStatus(signIn.id)).toBe("Done");
});

it("follows each team's rules, including approvals and switched-off steps", async () => {
  const team = await createTeam("PLAT", "organization");
  const other = await createTeam("OPS", "organization");
  const issue = await createIssue(team.id, "Sign in");
  await connect();
  await sync();
  const workspace = await runtime.planning.workspace(owner);
  const statuses = workspace.workflows.find(
    (workflow) => workflow.teamId === team.id,
  )!.statuses;
  const id = (name: string) =>
    statuses.find((status) => status.name === name)!.id;
  const rules = (await runtime.git.connections.get(owner)).automations.find(
    (entry) => entry.team.id === team.id,
  )!;
  expect(rules.rules).toEqual({
    draft: id("In progress"),
    open: id("In review"),
    approved: null,
    merged: id("Done"),
  });
  expect(rules.statuses.map((status) => status.name)).not.toContain("Canceled");
  await expect(
    runtime.git.statusRules.set(member, {
      teamId: team.id,
      event: "open",
      statusId: null,
    }),
  ).rejects.toMatchObject({ status: 403 });
  const otherReview = (await runtime.planning.workspace(owner)).workflows
    .find((workflow) => workflow.teamId === other.id)!
    .statuses.find((status) => status.name === "In review")!.id;
  await expect(
    runtime.git.statusRules.set(owner, {
      teamId: team.id,
      event: "approved",
      statusId: otherReview,
    }),
  ).rejects.toMatchObject({ code: "status_unavailable" });
  await runtime.git.statusRules.set(owner, {
    teamId: team.id,
    event: "open",
    statusId: null,
  });
  await runtime.git.statusRules.set(owner, {
    teamId: team.id,
    event: "approved",
    statusId: id("In review"),
  });

  addPullRequest(5, { head: { ref: "plat-1-sign-in", sha: sha(5) } });
  await sync();
  expect(await issueStatus(issue.id)).toBe("Backlog");
  reviews.set(5, ["CHANGES_REQUESTED", "APPROVED"]);
  updatePullRequest(5, {});
  await sync();
  expect(await issueStatus(issue.id)).toBe("Backlog");
  expect(
    (await runtime.git.pullRequests.forIssue(owner, issue.id))[0],
  ).toMatchObject({ review: "changes_requested", stage: "attention" });
  reviews.set(5, ["APPROVED"]);
  updatePullRequest(5, {});
  await sync();
  expect(await issueStatus(issue.id)).toBe("In review");
  expect(
    (await runtime.git.pullRequests.forIssue(owner, issue.id))[0],
  ).toMatchObject({ review: "approved", stage: "ready" });
});

it("accepts only signed webhooks, processes each delivery once and refreshes checks from check events", async () => {
  const team = await createTeam("PLAT", "organization");
  const issue = await createIssue(team.id, "Sign in");
  await connect();
  await sync();
  const hook = await webhook();
  const payload = (title: string) =>
    JSON.stringify({
      action: "opened",
      repository: { id: 7 },
      pull_request: {
        number: 4,
        title,
        body: null,
        html_url: "https://github.test/acme/app/pull/4",
        state: "open",
        draft: false,
        merged_at: null,
        user: { login: "octocat" },
        head: { ref: "plat-1", sha: sha(4) },
        base: { ref: "main" },
        updated_at: later(),
      },
    });
  addPullRequest(4, { head: { ref: "plat-1", sha: sha(4) }, title: "Sign in" });
  const first = payload("Sign in");
  expect(
    (
      await deliver(
        hook,
        "pull_request",
        "delivery-1",
        first,
        signed("wrong-secret", first),
      )
    ).status,
  ).toBe(401);
  expect(await runtime.git.pullRequests.forIssue(owner, issue.id)).toEqual([]);
  expect(
    (
      await deliver(
        hook,
        "pull_request",
        "delivery-1",
        first,
        signed(hook.secret, first),
      )
    ).status,
  ).toBe(204);
  const repeated = payload("Changed title");
  expect(
    (
      await deliver(
        hook,
        "pull_request",
        "delivery-1",
        repeated,
        signed(hook.secret, repeated),
      )
    ).status,
  ).toBe(204);
  await sync();
  expect(await runtime.git.pullRequests.forIssue(owner, issue.id)).toEqual([
    expect.objectContaining({
      number: 4,
      title: "Sign in",
      checks: "success",
      stage: "review",
    }),
  ]);
  expect(await issueStatus(issue.id)).toBe("In review");

  checkRuns.set(sha(4), [
    ...passing,
    { name: "lint", status: "completed", conclusion: "failure" },
  ]);
  const check = JSON.stringify({
    action: "completed",
    repository: { id: 7 },
    check_run: { head_sha: sha(4) },
  });
  expect(
    (
      await deliver(
        hook,
        "check_run",
        "delivery-2",
        check,
        signed(hook.secret, check),
      )
    ).status,
  ).toBe(204);
  await sync();
  expect(
    (await runtime.git.pullRequests.forIssue(owner, issue.id))[0],
  ).toMatchObject({ checks: "failure", stage: "attention" });
  const unknown = await handleCloudApi(
    new Request(
      `https://cloud.example.test/api/v1/integrations/github/webhooks/${randomUUID()}`,
      {
        method: "POST",
        headers: {
          "x-github-event": "pull_request",
          "x-github-delivery": "delivery-3",
          "x-hub-signature-256": signed(hook.secret, first),
        },
        body: first,
      },
    ),
    "127.0.0.1",
    runtime,
  );
  expect(unknown.status).toBe(404);
});

it("lists, details and changes pull requests only for people who can see a linked issue and may write", async () => {
  const shared = await createTeam("PLAT", "organization");
  const secret = await createTeam("SEC", "private");
  const visible = await createIssue(shared.id, "Sign in");
  const hidden = await createIssue(secret.id, "Rotate keys");
  await connect();
  addPullRequest(1, {
    head: { ref: "plat-1", sha: sha(1) },
    mergeable_state: "behind",
  });
  addPullRequest(2, { head: { ref: "sec-1", sha: sha(2) } });
  checkRuns.set(sha(2), [
    { name: "unit", status: "completed", conclusion: "failure" },
  ]);
  await sync();
  const [open] = await runtime.git.pullRequests.forIssue(owner, visible.id);
  const [restricted] = await runtime.git.pullRequests.forIssue(
    owner,
    hidden.id,
  );
  const everything = await runtime.git.pullRequests.list(owner, undefined);
  expect(everything.counts).toMatchObject({ attention: 1, review: 1 });
  expect(
    (await runtime.git.pullRequests.list(owner, "attention")).pullRequests,
  ).toEqual([
    expect.objectContaining({
      pullRequest: expect.objectContaining({ number: 2 }),
      issues: [expect.objectContaining({ identifier: "SEC-1" })],
    }),
  ]);
  const loose = await createIssue(shared.id, "No code yet");
  const summaries = await runtime.planning.listIssueSummaries(owner, {});
  expect(
    summaries.find((summary) => summary.id === hidden.id)?.pullRequest,
  ).toEqual({ stage: "attention", reference: "acme/app#2", count: 1 });
  expect(
    summaries.find((summary) => summary.id === loose.id)?.pullRequest,
  ).toBeNull();
  const filtered = (values: string[], negated = false) =>
    runtime.planning
      .listIssueSummaries(owner, {
        conditions: [{ field: "pullRequest", negated, values }],
      })
      .then((issues) => issues.map((entry) => entry.identifier).sort());
  expect(await filtered(["attention"])).toEqual(["SEC-1"]);
  expect(await filtered(["review", "none"])).toEqual(["PLAT-1", "PLAT-2"]);
  expect(await filtered(["none"], true)).toEqual(["PLAT-1", "SEC-1"]);
  const shown = await runtime.git.pullRequests.list(member, undefined);
  expect(shown.pullRequests.map((entry) => entry.pullRequest.number)).toEqual([
    1,
  ]);
  expect(shown.counts.attention).toBe(0);
  await expect(
    runtime.git.pullRequests.forIssue(member, hidden.id),
  ).rejects.toMatchObject({ status: 404 });
  for (const call of [
    () => runtime.git.pullRequests.details(member, restricted!.id),
    () => runtime.git.pullRequests.files(member, restricted!.id),
  ])
    await expect(call()).rejects.toMatchObject({ status: 404 });

  reviews.set(1, ["APPROVED"]);
  const details = await runtime.git.pullRequests.details(viewer, open!.id);
  expect(details).toMatchObject({
    pullRequest: {
      number: 1,
      additions: 12,
      deletions: 3,
      closes: true,
      review: "approved",
      stage: "review",
    },
    mergeable: true,
    checks: {
      conclusion: "success",
      runs: [
        {
          name: "unit",
          state: "success",
          url: "https://github.test/runs/unit",
        },
      ],
    },
    reviews: [{ author: "reviewer-0", state: "APPROVED" }],
    comments: [{ author: "reviewer", path: "src/sign-in.ts", line: 3 }],
    issues: [{ identifier: "PLAT-1", statusName: "Backlog" }],
    canMerge: false,
  });
  expect(await runtime.git.pullRequests.files(viewer, open!.id)).toEqual([
    expect.objectContaining({
      filename: "src/sign-in.ts",
      patch: "@@ -1 +1,2 @@\n-old\n+new\n+more",
    }),
    expect.objectContaining({ filename: "assets/logo.png", patch: null }),
  ]);

  for (const call of [
    () => runtime.git.pullRequests.updateBranch(viewer, open!.id, sha(1)),
    () =>
      runtime.git.pullRequests.merge(viewer, open!.id, {
        method: "squash",
        headSha: sha(1),
      }),
  ])
    await expect(call()).rejects.toMatchObject({ status: 403 });
  await expect(
    runtime.git.pullRequests.updateBranch(member, open!.id, sha(9)),
  ).rejects.toMatchObject({ status: 422 });
  await runtime.git.pullRequests.updateBranch(member, open!.id, sha(1));
  await expect(
    runtime.git.pullRequests.merge(member, open!.id, {
      method: "squash",
      headSha: sha(9),
    }),
  ).rejects.toMatchObject({ status: 409 });
  const merged = await runtime.git.pullRequests.merge(member, open!.id, {
    method: "squash",
    headSha: sha(1),
  });
  expect(merged).toMatchObject({ state: "merged", stage: "merged" });
  expect(
    calls
      .filter((call) => call.method === "PUT")
      .map((call) => [call.path, call.body]),
  ).toEqual([
    ["/repos/acme/app/pulls/1/update-branch", { expected_head_sha: sha(9) }],
    ["/repos/acme/app/pulls/1/update-branch", { expected_head_sha: sha(1) }],
    ["/repos/acme/app/pulls/1/merge", { merge_method: "squash", sha: sha(9) }],
    ["/repos/acme/app/pulls/1/merge", { merge_method: "squash", sha: sha(1) }],
  ]);
  expect(await issueStatus(visible.id)).toBe("Done");
  await expect(
    runtime.git.pullRequests.updateBranch(member, open!.id, sha(1)),
  ).rejects.toMatchObject({ code: "git_closed" });
});
