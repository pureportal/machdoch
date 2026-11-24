import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import {
  defaultEstimateScale,
  issueInputSchema,
  type CloudActor,
} from "../../../lib/cloud-contract";
import type { GitReviewSettings } from "../../../lib/cloud-git-contract";
import { automationMarker } from "../../../lib/git-events";
import type { GitProvider } from "../../../lib/git-providers";
import { SettingsCipher } from "../../settings-crypto";
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
const gitlabToken = `glpat-${"g".repeat(30)}`;
const origin = "https://cloud.example.test";
const githubComments = /^\/repos\/acme\/app\/issues\/\d+\/comments$/u;
const githubEdits = /^\/repos\/acme\/app\/issues\/comments\/\d+$/u;
const gitlabNotes = /\/merge_requests\/\d+\/notes$/u;
const gitlabEdits = /\/merge_requests\/\d+\/notes\/\d+$/u;

let database: Awaited<ReturnType<typeof createTestCloudDatabase>>;
let runtime: CloudRuntime;
let server: FakeGitServer;
let owner: CloudActor;
let teamId: string;

async function connect(provider: GitProvider) {
  const { id } = await runtime.git.connections.connect(
    owner,
    randomUUID(),
    provider,
    {
      revision: 0,
      apiUrl: provider === "github" ? githubApiUrl : gitlabApiUrl,
      token: provider === "github" ? organizationToken : gitlabToken,
      automate: false,
      codeAccess: false,
    },
  );
  await runtime.git.connections.addRepository(
    owner,
    id,
    provider === "github" ? "acme/app" : gitlabProject,
  );
  await runtime.git.connections.requestSync(owner, id);
  for (let round = 0; round < 50; round++)
    if (!(await runtime.git.sync.tick())) return id;
  throw new Error("Git sync did not settle.");
}

async function resync(connectionId: string) {
  await runtime.git.connections.requestSync(owner, connectionId);
  for (let round = 0; round < 50; round++)
    if (!(await runtime.git.sync.tick())) return;
  throw new Error("Git sync did not settle.");
}

async function createIssue(title: string, description = "", team = teamId) {
  return runtime.planning.createIssue(
    owner,
    randomUUID(),
    issueInputSchema.parse({ teamId: team, title, description }),
  );
}

async function setSettings(changes: Partial<GitReviewSettings>) {
  const { settings } = await runtime.git.connections.get(owner);
  await runtime.git.reviewSettings.set(owner, { ...settings, ...changes });
}

async function drain() {
  let posted = 0;
  for (let round = 0; round < 20; round++) {
    const claimed = await runtime.git.backlinks.tick();
    if (!claimed) return posted;
    posted += claimed;
  }
  throw new Error("Back-links did not settle.");
}

async function pullRequestId(provider: GitProvider, number: number) {
  return (
    await database.engine.query<{ id: string }>(
      `SELECT p.id FROM cloud_git_pull_requests p JOIN cloud_git_repositories r ON r.organization_id=p.organization_id AND r.id=p.repository_id
      WHERE p.organization_id=$1 AND r.provider=$2 AND p.number=$3`,
      [owner.organizationId, provider, number],
    )
  ).rows[0]!.id;
}

async function allowRetry() {
  await database.engine.query(
    "UPDATE cloud_git_backlinks SET attempted_at=NULL WHERE organization_id=$1",
    [owner.organizationId],
  );
}

function bodies(path: RegExp, method: string) {
  return server
    .callsTo(path, method)
    .map((call) => (call.body as { body: string }).body);
}

async function linkedTask(pullRequest: string) {
  const project = await runtime.projects.create(owner, randomUUID(), {
    teamId,
    name: "App",
    description: "",
  });
  const profile = await runtime.execution.profiles.create(owner, randomUUID(), {
    projectId: project.id,
    name: "Linked client",
    target: "client",
    agent: "codex-cli",
    repository: "https://github.com/example/project",
    autopilot: false,
    maxDurationSeconds: 3600,
    maxTokens: 10000,
    requiredChecks: [
      { name: "unit", command: "node --test", timeoutSeconds: 60 },
    ],
  });
  const issue = await runtime.planning.createIssue(
    owner,
    randomUUID(),
    issueInputSchema.parse({ teamId, projectId: project.id, title: "Sign in" }),
  );
  const run = await runtime.execution.runs.create(owner, randomUUID(), {
    profileId: profile.id,
    subject: { kind: "issue", id: issue.id, revision: 1 },
  });
  await database.engine.query(
    `INSERT INTO cloud_run_deliveries (organization_id,run_id,repository,state,branch,base_branch,head_sha,pull_request_id,auto_merge)
    VALUES ($1,$2,'acme/app','open','plat-1-sign-in','main',$3,$4,false)`,
    [owner.organizationId, run.id, "a".repeat(40), pullRequest],
  );
  return run.id;
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
  server.logins.set(gitlabToken, "acme-gl");
  const organizationId = randomUUID();
  owner = { userId: randomUUID(), organizationId };
  await database.engine.query(
    "INSERT INTO cloud_organizations (id,name) VALUES ($1,'Organization')",
    [organizationId],
  );
  await database.engine.query(
    "INSERT INTO cloud_users (id,email,name,password_hash) VALUES ($1,'owner@example.test','Olivia','test')",
    [owner.userId],
  );
  await database.engine.query(
    "INSERT INTO cloud_memberships (organization_id,user_id,role) VALUES ($1,$2,'owner')",
    [organizationId, owner.userId],
  );
  runtime = createCloudRuntime(database, origin, {
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

it("posts one back-link comment per private pull request and edits it when links change", async () => {
  await createIssue("Sign in [beta]", "Users cannot sign in.");
  server.add(server.github, 1, { headRef: "plat-1-sign-in" });
  server.add(server.github, 2, { headRef: "feature/unlinked" });
  const connectionId = await connect("github");
  expect(await drain()).toBe(1);
  const pullRequest = await pullRequestId("github", 1);
  expect(bodies(githubComments, "POST")).toEqual([
    [
      `[PLAT-1 Sign in \\[beta\\]](${origin}/cloud/issues/PLAT-1)`,
      `[Review in machdoch](${origin}/cloud/pull-requests/${pullRequest})`,
      automationMarker,
    ].join("\n\n"),
  ]);
  expect(server.callsTo(githubComments, "POST")[0]!.path).toBe(
    "/repos/acme/app/issues/1/comments",
  );
  expect(await drain()).toBe(0);

  await createIssue("Session timeout");
  server.update(server.github.get(1)!, {
    body: "Fixes PLAT-2",
  });
  await resync(connectionId);
  expect(await drain()).toBe(1);
  expect(server.callsTo(githubComments, "POST")).toHaveLength(1);
  const [edit] = server.callsTo(githubEdits, "PATCH");
  expect(edit!.path).toBe("/repos/acme/app/issues/comments/1");
  expect((edit!.body as { body: string }).body).toContain(
    `[PLAT-2 Session timeout](${origin}/cloud/issues/PLAT-2)`,
  );
  expect(
    (
      await database.engine.query(
        "SELECT external_id,attempted_at,last_error FROM cloud_git_backlinks WHERE organization_id=$1",
        [owner.organizationId],
      )
    ).rows,
  ).toEqual([{ external_id: "1", attempted_at: null, last_error: null }]);
});

it("respects the repository visibility toggles and the description toggle", async () => {
  await createIssue("Sign in", "Users cannot sign in.");
  server.add(server.github, 1, { headRef: "plat-1-sign-in" });
  await setSettings({ backlinksPrivate: false });
  await connect("github");
  expect(await drain()).toBe(0);
  await database.engine.query(
    "UPDATE cloud_git_repositories SET private=false WHERE organization_id=$1",
    [owner.organizationId],
  );
  await setSettings({ backlinksPrivate: true });
  expect(await drain()).toBe(0);
  await setSettings({ backlinksPublic: true, backlinkDescriptions: true });
  expect(await drain()).toBe(1);
  expect(bodies(githubComments, "POST")[0]).toContain(
    "<details><summary>Description</summary>\n\nUsers cannot sign in.\n\n</details>",
  );
  await setSettings({ backlinkDescriptions: false });
  expect(await drain()).toBe(1);
  expect(bodies(githubEdits, "PATCH")[0]).not.toContain("<details>");
});

it("links agent sessions delivered on the pull request and leaves private team issues out", async () => {
  const security = await runtime.planning.createTeam(owner, randomUUID(), {
    name: "Security",
    key: "SEC",
    visibility: "private",
    estimateScale: defaultEstimateScale,
  });
  await createIssue("Rotate keys", "Secret plan", security.id);
  server.add(server.github, 1, { headRef: "sec-1-rotate" });
  await connect("github");
  expect(await drain()).toBe(0);
  const runId = await linkedTask(await pullRequestId("github", 1));
  expect(await drain()).toBe(1);
  const [body] = bodies(githubComments, "POST");
  expect(body).toContain(`(${origin}/cloud/tasks/${runId})`);
  expect(body).toContain("[Agent session: Sign in]");
  expect(body).not.toContain("SEC-1");
  expect(body).not.toContain("Rotate keys");
});

it("posts GitLab notes and reposts when the previous comment was deleted", async () => {
  await createIssue("Sign in");
  server.add(server.gitlab, 5, { headRef: "plat-1-sign-in" });
  await connect("gitlab");
  expect(await drain()).toBe(1);
  expect(bodies(gitlabNotes, "POST")[0]).toContain(
    `[PLAT-1 Sign in](${origin}/cloud/issues/PLAT-1)`,
  );
  server.deletedComments.add("5");
  await setSettings({ backlinkDescriptions: true });
  await createIssue("Session timeout", "Expires too early.");
  server.update(server.gitlab.get(5)!, { body: "Closes PLAT-2" });
  await resync((await runtime.git.connections.get(owner)).connections[0]!.id);
  expect(await drain()).toBe(1);
  expect(server.callsTo(gitlabEdits, "PUT")).toHaveLength(1);
  expect(bodies(gitlabNotes, "POST")).toHaveLength(2);
  expect(bodies(gitlabNotes, "POST")[1]).toContain("Expires too early.");
});

it("records failures and retries them after the delay", async () => {
  await createIssue("Sign in");
  server.add(server.github, 1, { headRef: "plat-1-sign-in" });
  await connect("github");
  const failing = createCloudRuntime(database, origin, {
    credentialsCipher: cipher,
    gitFetch: (async () =>
      Response.json(
        { message: "Bad credentials" },
        { status: 401 },
      )) as unknown as typeof fetch,
  });
  expect(await failing.git.backlinks.tick()).toBe(1);
  expect(await failing.git.backlinks.tick()).toBe(0);
  const [row] = (
    await database.engine.query<{
      external_id: string | null;
      last_error: string | null;
      attempted_at: Date | null;
    }>(
      "SELECT external_id,last_error,attempted_at FROM cloud_git_backlinks WHERE organization_id=$1",
      [owner.organizationId],
    )
  ).rows;
  expect(row).toMatchObject({ external_id: null });
  expect(row!.last_error).toBeTruthy();
  expect(row!.attempted_at).not.toBeNull();
  await allowRetry();
  expect(await drain()).toBe(1);
  expect(server.callsTo(githubComments, "POST")).toHaveLength(1);
});

it("adds back-link settings and records to existing installations", async () => {
  const engine = new PGlite();
  try {
    await engine.exec(
      await readFile(new URL("../schema.sql", import.meta.url), "utf8"),
    );
    const index = cloudMigrations.indexOf("087-git-backlinks.sql");
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
    await engine.query(
      "INSERT INTO cloud_organizations (id,name) VALUES ($1,'Organization')",
      [organizationId],
    );
    await engine.query(
      "INSERT INTO cloud_git_settings (organization_id,review_guides,merge_issues,commit_links) VALUES ($1,true,false,true)",
      [organizationId],
    );
    await apply(cloudMigrations.slice(index));
    expect(
      (
        await engine.query(
          "SELECT backlinks_private,backlinks_public,backlink_descriptions FROM cloud_git_settings WHERE organization_id=$1",
          [organizationId],
        )
      ).rows,
    ).toEqual([
      {
        backlinks_private: true,
        backlinks_public: false,
        backlink_descriptions: false,
      },
    ]);
    expect(
      (
        await engine.query(
          "SELECT count(*)::int AS count FROM cloud_git_backlinks",
        )
      ).rows,
    ).toEqual([{ count: 0 }]);
  } finally {
    await engine.close();
  }
});
