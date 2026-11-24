import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import {
  defaultEstimateScale,
  issueInputSchema,
  type CloudActor,
} from "../../../lib/cloud-contract";
import { SettingsCipher } from "../../settings-crypto";
import { cloudMigrations } from "../database";
import { handleCloudApi } from "../api";
import { createCloudRuntime, type CloudRuntime } from "../runtime";
import { createTestCloudDatabase } from "../test-database";
import { FakeGitServer, githubApiUrl, sha } from "./test-git-server";

const cipher = new SettingsCipher(randomBytes(32));
const organizationToken = `github_pat_${"o".repeat(40)}`;

let database: Awaited<ReturnType<typeof createTestCloudDatabase>>;
let runtime: CloudRuntime;
let server: FakeGitServer;
let owner: CloudActor;
let member: CloudActor;
let teamId: string;
let connectionId: string;

async function createIssue(title: string) {
  return runtime.planning.createIssue(
    owner,
    randomUUID(),
    issueInputSchema.parse({ teamId, title }),
  );
}

async function connect() {
  connectionId = (
    await runtime.git.connections.connect(owner, randomUUID(), "github", {
      revision: 0,
      apiUrl: githubApiUrl,
      token: organizationToken,
      automate: true,
      codeAccess: false,
    })
  ).id;
  await runtime.git.connections.addRepository(owner, connectionId, "acme/app");
  await sync();
}

async function sync() {
  await runtime.git.connections.requestSync(owner, connectionId);
  for (let round = 0; round < 50; round++)
    if (!(await runtime.git.sync.tick())) return;
  throw new Error("Git sync did not settle.");
}

async function connection() {
  return (await runtime.git.connections.get(owner)).connections.find(
    (entry) => entry.id === connectionId,
  )!;
}

async function repositoryId() {
  return (await connection()).repositories[0]!.id;
}

async function deliverPush(
  branch: string,
  commits: { id: string; message: string }[],
) {
  const hook = await connection();
  const body = JSON.stringify({
    ref: `refs/heads/${branch}`,
    before: sha(100),
    after: commits.at(-1)!.id,
    created: false,
    deleted: false,
    forced: false,
    compare: null,
    commits: commits.map((commit) => ({
      ...commit,
      author: { name: "Ada", username: "ada" },
    })),
    repository: { id: 7 },
    sender: { login: "ada" },
  });
  const response = await handleCloudApi(
    new Request(hook.webhookUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "push",
        "x-github-delivery": randomUUID(),
        "x-hub-signature-256": `sha256=${createHmac("sha256", hook.webhookSecret).update(body).digest("hex")}`,
      },
      body,
    }),
    "127.0.0.1",
    runtime,
  );
  expect(response.status).toBe(204);
}

async function issueState(id: string) {
  return (await runtime.planning.getIssue(owner, id)).state;
}

async function setSettings(
  changes: Partial<{
    reviewGuides: boolean;
    mergeIssues: boolean;
    commitLinks: boolean;
  }>,
) {
  const current = (await runtime.git.connections.get(owner)).settings;
  return runtime.git.reviewSettings.set(owner, {
    reviewGuides: current.reviewGuides,
    mergeIssues: current.mergeIssues,
    commitLinks: current.commitLinks,
    revision: current.revision,
    ...changes,
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
  server.logins.set(organizationToken, "acme-bot");
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

it("links pushed commits to issues and completes closing references once they land on the default branch", async () => {
  const fixed = await createIssue("Fix login");
  const related = await createIssue("Search");
  const later = await createIssue("Billing");
  await connect();
  expect((await connection()).lastDeliveryAt).toBeNull();

  await deliverPush("main", [
    { id: sha(201), message: "Fix login redirect\n\nFixes PLAT-1" },
    { id: sha(202), message: "Prepare search, part of PLAT-2" },
  ]);
  expect((await connection()).lastDeliveryAt).not.toBeNull();
  expect(await issueState(fixed.id)).toBe("complete");
  expect(await issueState(related.id)).not.toBe("complete");
  expect(await runtime.git.pullRequests.issueCommits(owner, fixed.id)).toEqual([
    expect.objectContaining({
      sha: sha(201),
      repository: "acme/app",
      message: "Fix login redirect\n\nFixes PLAT-1",
      author: "ada",
      url: `https://github.test/acme/app/commit/${sha(201)}`,
      closes: true,
    }),
  ]);
  expect(
    await runtime.git.pullRequests.issueCommits(owner, related.id),
  ).toEqual([expect.objectContaining({ sha: sha(202), closes: false })]);

  await runtime.issueChanges.apply(owner, randomUUID(), {
    issues: [{ id: fixed.id }],
    changes: { statusCategory: "active" },
  });
  await deliverPush("main", [
    { id: sha(201), message: "Fix login redirect\n\nFixes PLAT-1" },
  ]);
  expect(await issueState(fixed.id)).toBe("active");

  await deliverPush("feature/billing", [
    { id: sha(203), message: "Closes PLAT-3" },
  ]);
  expect(await issueState(later.id)).not.toBe("complete");
  expect(
    await runtime.git.pullRequests.issueCommits(owner, later.id),
  ).toHaveLength(1);
  await deliverPush("main", [{ id: sha(203), message: "Closes PLAT-3" }]);
  expect(await issueState(later.id)).toBe("complete");
  expect(
    await runtime.git.pullRequests.issueCommits(owner, later.id),
  ).toHaveLength(1);
});

it("ignores commit references when commit linking is off", async () => {
  const fixed = await createIssue("Fix login");
  await connect();
  expect((await setSettings({ commitLinks: false })).revision).toBe(1);
  await deliverPush("main", [{ id: sha(301), message: "Fixes PLAT-1" }]);
  expect(await issueState(fixed.id)).not.toBe("complete");
  expect(await runtime.git.pullRequests.issueCommits(owner, fixed.id)).toEqual(
    [],
  );
});

it("guards review settings by permission and revision", async () => {
  await connect();
  expect((await runtime.git.connections.get(owner)).settings).toEqual({
    reviewGuides: false,
    mergeIssues: false,
    commitLinks: true,
    revision: 0,
  });
  await expect(
    runtime.git.reviewSettings.set(member, {
      reviewGuides: true,
      mergeIssues: true,
      commitLinks: true,
      revision: 0,
    }),
  ).rejects.toMatchObject({ status: 403 });
  expect(await setSettings({ reviewGuides: true })).toEqual({
    reviewGuides: true,
    mergeIssues: false,
    commitLinks: true,
    revision: 1,
  });
  await expect(
    runtime.git.reviewSettings.set(owner, {
      reviewGuides: false,
      mergeIssues: false,
      commitLinks: true,
      revision: 0,
    }),
  ).rejects.toMatchObject({ status: 409 });
});

it("assigns repositories to teams", async () => {
  await connect();
  const id = await repositoryId();
  await runtime.git.reviewSettings.setRepositorySettings(owner, id, {
    teamId,
    issueSync: false,
  });
  expect((await connection()).repositories[0]!.teamId).toBe(teamId);
  await expect(
    runtime.git.reviewSettings.setRepositorySettings(owner, id, {
      teamId: randomUUID(),
      issueSync: false,
    }),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    runtime.git.reviewSettings.setRepositorySettings(member, id, {
      teamId: null,
      issueSync: false,
    }),
  ).rejects.toMatchObject({ status: 403 });
  await runtime.git.reviewSettings.setRepositorySettings(owner, id, {
    teamId: null,
    issueSync: false,
  });
  expect((await connection()).repositories[0]!.teamId).toBeNull();
});

it("suggests an issue for merged work without one and creates it on request", async () => {
  const change = server.add(server.github, 5, {
    headRef: "fix-typo",
    title: "Fix typo in footer",
  });
  await connect();
  await runtime.git.reviewSettings.setRepositorySettings(
    owner,
    await repositoryId(),
    {
      teamId,
      issueSync: false,
    },
  );
  const pullRequestId = (await runtime.git.pullRequests.list(owner, undefined))
    .pullRequests[0]!.pullRequest.id;
  expect(
    (await runtime.git.pullRequests.details(owner, pullRequestId))
      .issueSuggestion,
  ).toBe(false);

  server.update(change, { state: "merged" });
  await sync();
  expect(await runtime.planning.listIssues(owner, { teamId })).toEqual([]);
  expect(
    (await runtime.git.pullRequests.details(owner, pullRequestId))
      .issueSuggestion,
  ).toBe(true);

  const { issueId } = await runtime.git.pullRequests.createIssue(
    owner,
    pullRequestId,
  );
  const issue = await runtime.planning.getIssue(owner, issueId);
  expect(issue).toMatchObject({
    title: "Fix typo in footer",
    state: "complete",
  });
  const details = await runtime.git.pullRequests.details(owner, pullRequestId);
  expect(details.issueSuggestion).toBe(false);
  expect(details.issues.map((entry) => entry.id)).toEqual([issueId]);
  server.update(change, { title: "Fix typo in the footer" });
  await sync();
  expect(
    (await runtime.git.pullRequests.forIssue(owner, issueId)).map(
      (pullRequest) => pullRequest.number,
    ),
  ).toEqual([5]);
  await expect(
    runtime.git.pullRequests.createIssue(owner, pullRequestId),
  ).rejects.toMatchObject({ status: 409, code: "git_issue_linked" });
});

it("records merged work as an issue automatically, reusing an open issue with the same title", async () => {
  const existing = await createIssue("Tidy release notes");
  const fresh = server.add(server.github, 6, {
    headRef: "cache-avatars",
    title: "Cache avatars",
  });
  const matching = server.add(server.github, 7, {
    headRef: "tidy-notes",
    title: "tidy release notes",
  });
  const elsewhere = server.add(server.github, 8, {
    headRef: "into-release",
    baseRef: "release",
    title: "Backport",
  });
  await connect();
  await runtime.git.reviewSettings.setRepositorySettings(
    owner,
    await repositoryId(),
    {
      teamId,
      issueSync: false,
    },
  );
  await setSettings({ mergeIssues: true });
  for (const change of [fresh, matching, elsewhere])
    server.update(change, { state: "merged" });
  await sync();

  const issues = await runtime.planning.listIssues(owner, { teamId });
  expect(issues.map((issue) => issue.title).sort()).toEqual([
    "Cache avatars",
    "Tidy release notes",
  ]);
  expect(issues.every((issue) => issue.state === "complete")).toBe(true);
  expect(issues.find((issue) => issue.title === "Tidy release notes")!.id).toBe(
    existing.id,
  );
  expect(
    (await runtime.git.pullRequests.forIssue(owner, existing.id)).map(
      (pullRequest) => pullRequest.number,
    ),
  ).toEqual([7]);
});

it("adds review settings, repository teams and commit links to existing installations", async () => {
  const engine = new PGlite();
  try {
    await engine.exec(
      await readFile(new URL("../schema.sql", import.meta.url), "utf8"),
    );
    const index = cloudMigrations.indexOf("080-git-review-settings.sql");
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
    const team = randomUUID();
    await engine.query(
      "INSERT INTO cloud_organizations (id,name) VALUES ($1,'Organization')",
      [organizationId],
    );
    await engine.query(
      "INSERT INTO cloud_users (id,email,name,password_hash) VALUES ($1,'a@example.test','A','test')",
      [userId],
    );
    const connection = randomUUID();
    await engine.query(
      `INSERT INTO cloud_git_connections (organization_id,id,provider,api_url,secret,token_prefix,account,webhook_id,webhook_secret,actor_id)
      VALUES ($1,$2,'github',$3,'\\x00','ghp','acme',$4,'\\x00',$5)`,
      [organizationId, connection, githubApiUrl, randomUUID(), userId],
    );
    await engine.query(
      "INSERT INTO cloud_git_repositories (organization_id,id,connection_id,provider,external_id,full_name,default_branch,private) VALUES ($1,$2,$3,'github',7,'acme/app','main',true)",
      [organizationId, repository, connection],
    );
    await apply(cloudMigrations.slice(index));
    expect(
      (
        await engine.query(
          "SELECT team_id FROM cloud_git_repositories WHERE id=$1",
          [repository],
        )
      ).rows,
    ).toEqual([{ team_id: null }]);
    await engine.query(
      "INSERT INTO cloud_teams (organization_id,id,name,key,visibility,estimate_scale) VALUES ($1,$2,'Platform','PLAT','organization',$3)",
      [organizationId, team, JSON.stringify(defaultEstimateScale)],
    );
    await engine.query(
      "UPDATE cloud_git_repositories SET team_id=$2 WHERE id=$1",
      [repository, team],
    );
    expect(
      (
        await engine.query(
          "SELECT team_id FROM cloud_git_repositories WHERE id=$1",
          [repository],
        )
      ).rows,
    ).toEqual([{ team_id: team }]);
    await expect(
      engine.query("UPDATE cloud_git_repositories SET team_id=$2 WHERE id=$1", [
        repository,
        randomUUID(),
      ]),
    ).rejects.toThrow(/foreign key/);
    await engine.query(
      "INSERT INTO cloud_git_settings (organization_id,review_guides,merge_issues,commit_links) VALUES ($1,true,false,true)",
      [organizationId],
    );
    expect(
      (await engine.query("SELECT revision FROM cloud_git_settings")).rows,
    ).toEqual([{ revision: 1 }]);
    expect(
      (
        await engine.query(
          "SELECT column_default,is_nullable FROM information_schema.columns WHERE table_name='cloud_git_pull_request_issues' AND column_name='recorded'",
        )
      ).rows,
    ).toEqual([{ column_default: "false", is_nullable: "NO" }]);
  } finally {
    await engine.close();
  }
});
