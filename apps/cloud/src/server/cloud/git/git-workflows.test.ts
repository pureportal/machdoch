import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import {
  defaultEstimateScale,
  issueInputSchema,
  type CloudActor,
} from "../../../lib/cloud-contract";
import { automationInputSchema } from "../../../lib/cloud-automation-contract";
import { automationMarker } from "../../../lib/git-events";
import type { GitProvider } from "../../../lib/git-providers";
import { SettingsCipher } from "../../settings-crypto";
import { handleCloudApi } from "../api";
import { createCloudRuntime, type CloudRuntime } from "../runtime";
import { createTestCloudDatabase } from "../test-database";
import type { RunManifest } from "@machdoch/fleet-protocol/cloud-execution";
import { runPlanningChanged } from "../execution/planning-context";
import { repositoryAuthorization } from "./repository-access";
import {
  FakeGitServer,
  githubApiUrl,
  gitlabApiUrl,
  gitlabProject,
  sha,
} from "./test-git-server";

const cipher = new SettingsCipher(randomBytes(32));
const organizationToken = `github_pat_${"o".repeat(40)}`;
const ownerToken = `github_pat_${"w".repeat(40)}`;
const memberToken = `github_pat_${"m".repeat(40)}`;
const duplicateToken = `github_pat_${"d".repeat(40)}`;
const gitlabToken = `glpat-${"g".repeat(30)}`;

let database: Awaited<ReturnType<typeof createTestCloudDatabase>>;
let runtime: CloudRuntime;
let server: FakeGitServer;
let owner: CloudActor;
let member: CloudActor;
let teamId: string;

async function createIssue(title: string) {
  return runtime.planning.createIssue(
    owner,
    randomUUID(),
    issueInputSchema.parse({ teamId, title }),
  );
}

async function connect(provider: GitProvider) {
  await runtime.git.connections.connect(owner, randomUUID(), provider, {
    revision: 0,
    apiUrl: provider === "github" ? githubApiUrl : gitlabApiUrl,
    token: provider === "github" ? organizationToken : gitlabToken,
    automate: true,
  });
  await runtime.git.connections.addRepository(
    owner,
    provider,
    provider === "github" ? "acme/app" : gitlabProject,
  );
  await sync(provider);
}

async function sync(provider: GitProvider) {
  await runtime.git.connections.requestSync(owner, provider);
  for (let round = 0; round < 50; round++)
    if (!(await runtime.git.sync.tick())) return;
  throw new Error("Git sync did not settle.");
}

async function dispatch() {
  for (let round = 0; round < 20; round++)
    if (!(await runtime.automations.dispatcher.tick())) return;
}

async function automate(input: Record<string, unknown>) {
  return runtime.automations.service.create(
    owner,
    randomUUID(),
    automationInputSchema.parse({ name: "Automation", teamId, ...input }),
  );
}

async function runs(automationId: string) {
  return runtime.automations.service.runs(owner, { automationId });
}

async function webhook(provider: GitProvider) {
  const connection = (await runtime.git.connections.get(owner)).connections[
    provider
  ]!;
  return {
    id: connection.webhookUrl.split("/").at(-1)!,
    secret: connection.webhookSecret,
  };
}

async function deliverGitHub(event: string, payload: unknown) {
  const hook = await webhook("github");
  const body = JSON.stringify(payload);
  return handleCloudApi(
    new Request(
      `https://cloud.example.test/api/v1/integrations/github/webhooks/${hook.id}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": event,
          "x-github-delivery": randomUUID(),
          "x-hub-signature-256": `sha256=${createHmac("sha256", hook.secret).update(body).digest("hex")}`,
        },
        body,
      },
    ),
    "127.0.0.1",
    runtime,
  );
}

async function deliverGitLab(
  event: string,
  payload: unknown,
  options: { token?: string; delivery?: string } = {},
) {
  const hook = await webhook("gitlab");
  return handleCloudApi(
    new Request(
      `https://cloud.example.test/api/v1/integrations/gitlab/webhooks/${hook.id}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-gitlab-event": event,
          "x-gitlab-event-uuid": options.delivery ?? randomUUID(),
          "x-gitlab-token": options.token ?? hook.secret,
        },
        body: JSON.stringify(payload),
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
  server = new FakeGitServer();
  server.logins.set(organizationToken, "acme-bot");
  server.logins.set(ownerToken, "owner-gh");
  server.logins.set(memberToken, "member-gh");
  server.logins.set(duplicateToken, "member-gh");
  server.logins.set(gitlabToken, "acme-gitlab-bot");
  const organizationId = randomUUID();
  owner = { userId: randomUUID(), organizationId };
  member = { userId: randomUUID(), organizationId };
  await database.engine.query(
    "INSERT INTO cloud_organizations (id,name) VALUES ($1,'Organization')",
    [organizationId],
  );
  for (const [actor, role] of [
    [owner, "owner"],
    [member, "member"],
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
    gitFetch: server.transport,
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

it("lets every member connect an own account and act as themselves", async () => {
  await createIssue("Sign in");
  server.add(server.github, 1, { headRef: "plat-1-sign-in" });
  await connect("github");
  const [pullRequest] = (await runtime.git.pullRequests.list(owner, undefined))
    .pullRequests;
  expect(pullRequest!.pullRequest).toMatchObject({
    provider: "github",
    number: 1,
    defaultBranch: "main",
  });
  await runtime.git.accounts.connect(member, "github", {
    revision: 0,
    apiUrl: githubApiUrl,
    token: memberToken,
  });
  const accounts = await runtime.git.accounts.get(member);
  expect(accounts.accounts.github).toMatchObject({
    login: "member-gh",
    apiUrl: githubApiUrl,
    revision: 1,
  });
  expect(accounts.connections.github).toEqual({
    apiUrl: githubApiUrl,
    oauth: false,
  });
  expect(JSON.stringify(accounts)).not.toContain(memberToken);
  await expect(
    runtime.git.accounts.connect(owner, "github", {
      revision: 0,
      apiUrl: githubApiUrl,
      token: duplicateToken,
    }),
  ).rejects.toMatchObject({ code: "git_account_taken" });
  const id = pullRequest!.pullRequest.id;
  expect((await runtime.git.pullRequests.details(member, id)).actingAs).toBe(
    "member-gh",
  );
  expect((await runtime.git.pullRequests.details(owner, id)).actingAs).toBe(
    "acme-bot",
  );
  await runtime.git.pullRequests.merge(member, id, {
    method: "squash",
    headSha: sha(1),
  });
  expect(server.callsTo("/repos/acme/app/pulls/1/merge", "PUT")).toEqual([
    expect.objectContaining({ authorization: `Bearer ${memberToken}` }),
  ]);
  await runtime.git.accounts.disconnect(member, "github", 1);
  expect(
    (await runtime.git.accounts.get(member)).accounts.github,
  ).toBeUndefined();
});

it("runs automations for pushes on chosen branches and pull request comments", async () => {
  server.add(server.github, 4, { headRef: "feature/search", author: "ada" });
  await connect("github");
  const pushes = await automate({
    trigger: {
      kind: "git_event",
      events: ["push"],
      branches: ["!$default"],
    },
    actions: [
      { kind: "create_issue", title: "Pushed {{branch}} by {{sender}}" },
    ],
  });
  const push = (branch: string) =>
    deliverGitHub("push", {
      ref: `refs/heads/${branch}`,
      before: sha(10),
      after: sha(11),
      created: false,
      deleted: false,
      forced: false,
      compare: "https://github.test/acme/app/compare/a...b",
      commits: [
        {
          id: sha(11),
          message: "Add search",
          author: { name: "Ada", username: "ada" },
        },
      ],
      repository: { id: 7 },
      sender: { login: "ada" },
    });
  expect((await push("main")).status).toBe(204);
  expect((await push("feature/search")).status).toBe(204);
  await dispatch();
  const pushRuns = await runs(pushes.id);
  expect(pushRuns).toHaveLength(1);
  expect(pushRuns[0]).toMatchObject({ trigger: "push", state: "succeeded" });
  const created = await runtime.planning.listIssues(owner, { teamId });
  expect(created.map((issue) => issue.title)).toContain(
    "Pushed feature/search by ada",
  );

  const replies = await automate({
    trigger: {
      kind: "git_event",
      events: ["comment_created"],
      contains: "@bot",
    },
    actions: [
      {
        kind: "git_comment",
        body: "On it, {{comment.author}}. {{pullRequest.headRef}}",
        identity: "owner",
      },
    ],
  });
  const comment = (body: string) =>
    deliverGitHub("issue_comment", {
      action: "created",
      issue: { number: 4, pull_request: {} },
      comment: {
        body,
        user: { login: "ada" },
        html_url: "https://github.test/acme/app/pull/4#issuecomment-9",
      },
      repository: { id: 7 },
      sender: { login: "ada" },
    });
  await comment("@bot please look");
  await dispatch();
  expect((await runs(replies.id))[0]).toMatchObject({
    state: "failed",
    error: expect.stringContaining("Connect your GitHub account"),
  });
  await runtime.git.accounts.connect(owner, "github", {
    revision: 0,
    apiUrl: githubApiUrl,
    token: ownerToken,
  });
  await comment("@bot try again");
  await dispatch();
  expect((await runs(replies.id))[0]).toMatchObject({ state: "succeeded" });
  const posted = server.callsTo("/repos/acme/app/issues/4/comments", "POST");
  expect(posted).toEqual([
    expect.objectContaining({
      authorization: `Bearer ${ownerToken}`,
      body: {
        body: `On it, ada. feature/search\n\n${automationMarker}`,
      },
    }),
  ]);
  await comment(`@bot from automation\n\n${automationMarker}`);
  await dispatch();
  expect(await runs(replies.id)).toHaveLength(2);
});

it("tracks stacked pull requests, completes issues only on the default branch and retargets children", async () => {
  const base = await createIssue("Base");
  const top = await createIssue("Top");
  const side = await createIssue("Side");
  server.add(server.github, 1, { headRef: "feature/a", title: "PLAT-1 base" });
  server.add(server.github, 2, {
    headRef: "feature/b",
    baseRef: "feature/a",
    title: "PLAT-2 top",
  });
  const sideChange = server.add(server.github, 3, {
    headRef: "feature/c",
    baseRef: "feature/a",
    title: "PLAT-3 side",
  });
  await connect("github");
  const listed = new Map(
    (await runtime.git.pullRequests.list(owner, undefined)).pullRequests.map(
      (entry) => [entry.pullRequest.number, entry.pullRequest],
    ),
  );
  expect(listed.get(2)!.stack).toMatchObject({
    parent: { number: 1, state: "open" },
    depth: 1,
    retargetTo: null,
  });
  expect(
    listed
      .get(1)!
      .stack!.children.map((child) => child.number)
      .sort((left, right) => left - right),
  ).toEqual([2, 3]);
  await automate({
    trigger: { kind: "git_event", events: ["stack_base_merged"] },
    actions: [{ kind: "git_retarget", identity: "organization" }],
  });

  server.update(sideChange, { state: "merged" });
  await sync("github");
  expect((await runtime.planning.getIssue(owner, side.id)).state).not.toBe(
    "complete",
  );

  await runtime.git.pullRequests.merge(owner, listed.get(1)!.id, {
    method: "squash",
    headSha: sha(1),
  });
  expect((await runtime.planning.getIssue(owner, base.id)).state).toBe(
    "complete",
  );
  await dispatch();
  expect(server.callsTo("/repos/acme/app/pulls/2", "PATCH")).toEqual([
    expect.objectContaining({
      authorization: `Bearer ${organizationToken}`,
      body: { base: "main" },
    }),
  ]);
  expect(server.github.get(2)!.baseRef).toBe("main");
  const [retargeted] = await runtime.git.pullRequests.forIssue(owner, top.id);
  expect(retargeted).toMatchObject({ baseRef: "main", stack: null });
});

it("connects GitLab, syncs merge requests and accepts only verified webhooks", async () => {
  const login = await createIssue("Login");
  server.add(server.gitlab, 5, { headRef: "plat-1-login" });
  await connect("gitlab");
  const hook = server.callsTo(/\/hooks$/u, "POST")[0]!;
  const administration = await runtime.git.connections.get(owner);
  expect(hook.body).toMatchObject({
    url: administration.connections.gitlab!.webhookUrl,
    token: administration.connections.gitlab!.webhookSecret,
    push_events: true,
    merge_requests_events: true,
    note_events: true,
  });
  expect(administration.connections.gitlab).toMatchObject({
    account: "acme-gitlab-bot",
    repositories: [{ fullName: gitlabProject, webhook: true }],
  });
  const authorize = (url: string) =>
    database.transaction((sql) =>
      repositoryAuthorization(sql, cipher, owner.organizationId, url),
    );
  expect(await authorize(`https://gitlab.test/${gitlabProject}`)).toBe(
    `Basic ${Buffer.from(`oauth2:${gitlabToken}`).toString("base64")}`,
  );
  expect(await authorize("https://github.com/public/project")).toBeNull();
  await expect(
    authorize("https://github.com.evil.test/acme/app"),
  ).rejects.toMatchObject({ code: "repository_unconnected" });
  const [linked] = await runtime.git.pullRequests.forIssue(owner, login.id);
  expect(linked).toMatchObject({
    provider: "gitlab",
    repository: gitlabProject,
    number: 5,
    stage: "review",
    checks: "success",
  });

  const approvals = await automate({
    trigger: { kind: "git_event", events: ["review_approved"] },
    actions: [{ kind: "set_priority", priority: "urgent" }],
  });
  const approval = {
    user: { username: "reviewer" },
    project: { id: 42 },
    object_attributes: { iid: 5, action: "approval" },
  };
  expect(
    (await deliverGitLab("Merge Request Hook", approval, { token: "wrong" }))
      .status,
  ).toBe(401);
  const delivery = randomUUID();
  expect(
    (await deliverGitLab("Merge Request Hook", approval, { delivery })).status,
  ).toBe(204);
  await deliverGitLab("Merge Request Hook", approval, { delivery });
  await dispatch();
  expect(await runs(approvals.id)).toEqual([
    expect.objectContaining({ trigger: "review_approved", issueId: login.id }),
  ]);
  expect((await runtime.planning.getIssue(owner, login.id)).priority).toBe(
    "urgent",
  );

  const mainline = await automate({
    trigger: { kind: "git_event", events: ["push"], branches: ["$default"] },
    actions: [
      { kind: "create_issue", title: "Main moved {{push.compareUrl}}" },
    ],
  });
  await deliverGitLab("Push Hook", {
    ref: "refs/heads/main",
    before: sha(20),
    after: sha(21),
    user_username: "ada",
    project: { id: 42, web_url: `https://gitlab.test/${gitlabProject}` },
    commits: [{ id: sha(21), message: "Ship", author: { name: "Ada" } }],
  });
  await dispatch();
  expect((await runs(mainline.id))[0]).toMatchObject({ state: "succeeded" });
  expect(
    (await runtime.planning.listIssues(owner, { teamId })).map(
      (issue) => issue.title,
    ),
  ).toContain(
    `Main moved https://gitlab.test/${gitlabProject}/-/compare/${sha(20)}...${sha(21)}`,
  );

  await expect(
    runtime.git.pullRequests.merge(owner, linked!.id, {
      method: "rebase",
      headSha: sha(5),
    }),
  ).rejects.toMatchObject({ code: "git_merge_method" });
  await runtime.git.pullRequests.merge(owner, linked!.id, {
    method: "squash",
    headSha: sha(5),
  });
  expect(
    server.callsTo(/\/merge_requests\/5\/merge$/u, "PUT")[0]!.body,
  ).toEqual({ sha: sha(5), squash: true });
  expect((await runtime.planning.getIssue(owner, login.id)).state).toBe(
    "complete",
  );
});

it("lets members sign in with GitLab, rejects reused sign-ins and refreshes expired tokens", async () => {
  const login = await createIssue("Login");
  server.add(server.gitlab, 5, { headRef: "plat-1-login" });
  await connect("gitlab");
  await expect(runtime.git.oauth.start(member, "gitlab")).rejects.toMatchObject(
    { code: "git_oauth_unconfigured" },
  );
  const current = (await runtime.git.connections.get(owner)).connections
    .gitlab!;
  await expect(
    runtime.git.connections.connect(owner, randomUUID(), "gitlab", {
      revision: current.revision,
      apiUrl: gitlabApiUrl,
      automate: true,
      oauthClientId: "gitlab-app",
    }),
  ).rejects.toMatchObject({ code: "git_oauth_secret_required" });
  await runtime.git.connections.connect(owner, randomUUID(), "gitlab", {
    revision: current.revision,
    apiUrl: gitlabApiUrl,
    automate: true,
    oauthClientId: "gitlab-app",
    oauthClientSecret: "gitlab-app-secret",
  });
  const administration = await runtime.git.connections.get(owner);
  expect(administration.connections.gitlab).toMatchObject({
    oauthClientId: "gitlab-app",
    oauthCallbackUrl:
      "https://cloud.example.test/api/v1/integrations/gitlab/oauth/callback",
  });
  expect(JSON.stringify(administration)).not.toContain("gitlab-app-secret");
  expect((await runtime.git.accounts.get(member)).connections.gitlab).toEqual({
    apiUrl: gitlabApiUrl,
    oauth: true,
  });

  const { url } = await runtime.git.oauth.start(member, "gitlab");
  const authorize = new URL(url);
  expect(`${authorize.origin}${authorize.pathname}`).toBe(
    "https://gitlab.test/oauth/authorize",
  );
  expect(Object.fromEntries(authorize.searchParams)).toMatchObject({
    client_id: "gitlab-app",
    redirect_uri: administration.connections.gitlab!.oauthCallbackUrl,
    response_type: "code",
    scope: "api",
  });
  const state = authorize.searchParams.get("state")!;
  server.oauthGrants.push({ code: "code-1", login: "member-gl", expiresIn: 1 });
  const callback = (code: string, value: string) =>
    handleCloudApi(
      new Request(
        `https://cloud.example.test/api/v1/integrations/gitlab/oauth/callback?code=${code}&state=${value}`,
      ),
      "127.0.0.1",
      runtime,
    );
  const completed = await callback("code-1", state);
  expect(completed.status).toBe(303);
  expect(completed.headers.get("location")).toBe(
    "https://cloud.example.test/cloud/account?tab=git",
  );
  expect(server.callsTo("/oauth/token", "POST")[0]!.body).toEqual({
    client_id: "gitlab-app",
    client_secret: "gitlab-app-secret",
    grant_type: "authorization_code",
    code: "code-1",
    redirect_uri: administration.connections.gitlab!.oauthCallbackUrl,
  });
  expect(
    (await runtime.git.accounts.get(member)).accounts.gitlab,
  ).toMatchObject({ login: "member-gl" });
  expect((await callback("code-1", state)).headers.get("location")).toBe(
    "https://cloud.example.test/cloud/account?tab=git&gitError=expired",
  );

  const [linked] = await runtime.git.pullRequests.forIssue(owner, login.id);
  expect(
    (await runtime.git.pullRequests.details(member, linked!.id)).actingAs,
  ).toBe("member-gl");
  await runtime.git.pullRequests.merge(member, linked!.id, {
    method: "merge",
    headSha: sha(5),
  });
  expect(server.callsTo("/oauth/token", "POST")[1]!.body).toMatchObject({
    grant_type: "refresh_token",
    refresh_token: "oauth-refresh-1",
  });
  expect(
    server.callsTo(/\/merge_requests\/5\/merge$/u, "PUT")[0]!.authorization,
  ).toBe("Bearer oauth-access-2");
});

it("starts AI tasks on pull requests pinned to their head commit", async () => {
  await connect("github");
  const project = await runtime.projects.create(owner, randomUUID(), {
    teamId,
    name: "App",
    description: "",
  });
  const provider = await runtime.aiProviders.create(owner, randomUUID(), {
    name: "Provider",
    provider: "openai",
    region: null,
    models: ["fixture"],
    apiKey: "fixture-key",
    maxOutputTokens: 256,
    dailyTokenBudget: 100000,
    maxConcurrentRequests: 2,
  });
  const profile = (repository: string) =>
    runtime.execution.profiles.create(owner, randomUUID(), {
      projectId: project.id,
      name: repository,
      target: "cloud",
      repository,
      baseCommit: "a".repeat(40),
      providerId: provider.id,
      model: "fixture",
      maxDurationSeconds: 600,
      maxTokens: 10000,
      requiredChecks: [
        { name: "unit", command: "node --test", timeoutSeconds: 60 },
      ],
    });
  await expect(
    profile("https://git.unconnected.test/acme/app"),
  ).rejects.toMatchObject({ code: "repository_unconnected" });
  const matching = await profile("https://github.test/acme/app");
  const other = await profile("https://github.com/acme/other");
  const tasks = await automate({
    trigger: { kind: "git_event", events: ["pull_request_opened"] },
    actions: [
      {
        kind: "delegate",
        profileId: matching.id,
        instructions: "Review {{pullRequest.headRef}} for regressions.",
        acceptanceCriteria: "Regressions are fixed.",
      },
      { kind: "delegate", profileId: other.id },
    ],
  });
  const change = server.add(server.github, 9, {
    headRef: "feature/regressions",
    title: "Regression fixes",
  });
  await sync("github");
  await dispatch();
  const [run] = await runs(tasks.id);
  expect(run).toMatchObject({
    state: "failed",
    trigger: "pull_request_opened",
  });
  expect(run!.steps[0]).toMatchObject({
    state: "succeeded",
    detail: "AI task started on #9",
  });
  expect(run!.error).toContain("pull request's repository");
  const stored = (
    await database.engine.query<{
      manifest: RunManifest;
      issue_id: string | null;
    }>("SELECT manifest,issue_id FROM cloud_runs WHERE organization_id=$1", [
      owner.organizationId,
    ])
  ).rows;
  expect(stored).toHaveLength(1);
  const manifest = stored[0]!.manifest;
  expect(stored[0]!.issue_id).toBeNull();
  expect(manifest.subject).toMatchObject({
    kind: "pull_request",
    headSha: sha(9),
    acceptanceCriteria: "Regressions are fixed.",
  });
  expect(manifest.profile.baseCommit).toBe(sha(9));
  expect(manifest.title).toBe("acme/app#9 Regression fixes");
  expect(manifest.objective).toContain(
    "Review feature/regressions for regressions.",
  );
  expect(manifest.objective).toContain("https://github.test/acme/app/pull/9");
  const stale = () =>
    database.transaction((sql) =>
      runPlanningChanged(sql, owner.organizationId, {
        manifest,
        planningDigest: null,
      }),
    );
  expect(await stale()).toBe(false);
  server.update(change, { headSha: sha(10) });
  await sync("github");
  expect(await stale()).toBe(true);
});
