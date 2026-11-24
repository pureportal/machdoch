import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import {
  defaultEstimateScale,
  issueInputSchema,
  type CloudActor,
} from "../../../lib/cloud-contract";
import { issueFilterConditionSchema } from "../../../lib/issue-filter-model";
import { productInputSchema } from "../../../lib/cloud-release-contract";
import {
  pipelineInputSchema,
  pipelineUpdateSchema,
} from "../../../lib/cloud-release-pipeline-contract";
import { SettingsCipher } from "../../settings-crypto";
import { handleCloudApi } from "../api";
import { FakeGitServer, githubApiUrl, sha } from "../git/test-git-server";
import { createCloudRuntime, type CloudRuntime } from "../runtime";
import { createTestCloudDatabase } from "../test-database";

const cipher = new SettingsCipher(randomBytes(32));
const organizationToken = `github_pat_${"o".repeat(40)}`;

let database: Awaited<ReturnType<typeof createTestCloudDatabase>>;
let runtime: CloudRuntime;
let server: FakeGitServer;
let owner: CloudActor;
let viewer: CloudActor;
let teamId: string;
let deliveries = 0;

async function createIssue(title: string) {
  return runtime.planning.createIssue(
    owner,
    randomUUID(),
    issueInputSchema.parse({ teamId, title }),
  );
}

let connectionId: string;

async function sync() {
  await runtime.git.connections.requestSync(owner, connectionId);
  for (let round = 0; round < 50; round++)
    if (!(await runtime.git.sync.tick())) return;
  throw new Error("Git sync did not settle.");
}

async function connect(): Promise<string> {
  ({ id: connectionId } = await runtime.git.connections.connect(
    owner,
    randomUUID(),
    "github",
    {
      revision: 0,
      apiUrl: githubApiUrl,
      token: organizationToken,
      automate: true,
      codeAccess: true,
    },
  ));
  await runtime.git.connections.addRepository(owner, connectionId, "acme/app");
  await sync();
  return (await runtime.git.connections.repositories(owner))[0]!.id;
}

async function createPipeline(input: Record<string, unknown>) {
  return runtime.releases.pipelines.create(
    owner,
    randomUUID(),
    pipelineInputSchema.parse({
      teamIds: [teamId],
      repositoryId: null,
      paths: [],
      type: "continuous",
      source: "deployment",
      environments: ["production"],
      ...input,
    }),
  );
}

async function deliverGitHub(event: string, payload: unknown) {
  const connection = (await runtime.git.connections.get(owner)).connections[0]!;
  const body = JSON.stringify(payload);
  const response = await handleCloudApi(
    new Request(
      `https://cloud.example.test/api/v1/integrations/github/webhooks/${connection.webhookUrl.split("/").at(-1)}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": event,
          "x-github-delivery": randomUUID(),
          "x-hub-signature-256": `sha256=${createHmac("sha256", connection.webhookSecret).update(body).digest("hex")}`,
        },
        body,
      },
    ),
    "127.0.0.1",
    runtime,
  );
  expect(response.status).toBeLessThan(300);
}

async function deploy(environment: string, commit: string, id = ++deliveries) {
  await deliverGitHub("deployment_status", {
    repository: { id: 7 },
    sender: { login: "deploy-bot" },
    deployment_status: {
      state: "success",
      environment_url: `https://${environment}.example.test`,
    },
    deployment: { id, sha: commit, ref: "main", environment },
  });
}

function changedFile(filename: string) {
  return {
    filename,
    status: "modified",
    additions: 1,
    deletions: 0,
    patch: "",
  };
}

async function releasedIn(value: string) {
  return (
    await runtime.planning.listIssueSummaries(owner, {
      conditions: [
        issueFilterConditionSchema.parse({
          field: "releasedIn",
          negated: false,
          values: [value],
        }),
      ],
    })
  )
    .map((issue) => issue.identifier)
    .sort();
}

async function issueState(issueId: string) {
  return (
    await database.engine.query<{ state: string }>(
      "SELECT state FROM cloud_issues WHERE id=$1",
      [issueId],
    )
  ).rows[0]!.state;
}

async function deliverPipelineHook(token: string, payload: unknown) {
  return handleCloudApi(
    new Request(
      `https://cloud.example.test/api/v1/release-pipelines/hooks/${token}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      },
    ),
    "203.0.113.9",
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
  const organizationId = randomUUID();
  owner = { userId: randomUUID(), organizationId };
  viewer = { userId: randomUUID(), organizationId };
  await database.engine.query(
    "INSERT INTO cloud_organizations (id,name) VALUES ($1,'Organization')",
    [organizationId],
  );
  for (const [actor, role] of [
    [owner, "owner"],
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

it("attaches each merged pull request only to monorepo pipelines whose paths it touched", async () => {
  await createIssue("Web checkout");
  await createIssue("API rate limits");
  await createIssue("Shared button");
  const repositoryId = await connect();
  const web = await createPipeline({
    name: "Web",
    repositoryId,
    paths: ["apps/web"],
  });
  const api = await createPipeline({
    name: "API",
    repositoryId,
    paths: ["apps/api"],
  });
  const packages = await createPipeline({
    name: "Packages",
    repositoryId,
    paths: ["packages/**"],
  });
  server.add(server.github, 1, { headRef: "plat-1-checkout", state: "merged" });
  server.add(server.github, 2, { headRef: "plat-2-limits", state: "merged" });
  server.add(server.github, 3, { headRef: "plat-3-button", state: "merged" });
  server.pullFiles.set(1, [changedFile("apps/web/checkout.tsx")]);
  server.pullFiles.set(2, [changedFile("apps/api/limits.ts")]);
  server.pullFiles.set(3, [
    changedFile("packages/ui/button.tsx"),
    changedFile("apps/web/home.tsx"),
  ]);
  await sync();

  await deploy("production", sha(90));

  const issuesOf = async (pipelineId: string) => {
    const [release] = (await runtime.releases.pipelines.get(owner, pipelineId))
      .releases;
    return (
      await runtime.releases.pipelineReleases.get(owner, release!.id)
    ).issues
      .map((issue) => issue.identifier)
      .sort();
  };
  expect(await issuesOf(web.id)).toEqual(["PLAT-1", "PLAT-3"]);
  expect(await issuesOf(api.id)).toEqual(["PLAT-2"]);
  expect(await issuesOf(packages.id)).toEqual(["PLAT-3"]);
  const release = (await runtime.releases.pipelines.get(owner, web.id))
    .releases[0]!;
  expect(release).toMatchObject({
    environment: "production",
    version: "main",
    toSha: sha(90),
    fromSha: null,
    evidenceUrl: "https://production.example.test",
    issueCount: 2,
  });
  expect(
    (await runtime.releases.pipelineReleases.get(owner, release.id)).issues[0]!
      .pullRequests[0],
  ).toMatchObject({ number: 1 });
});

it("never creates duplicate releases for repeated deployment events", async () => {
  await createIssue("Web checkout");
  const repositoryId = await connect();
  const web = await createPipeline({ name: "Web", repositoryId });
  server.add(server.github, 1, { headRef: "plat-1-checkout", state: "merged" });
  await sync();

  await deploy("production", sha(90), 41);
  await deploy("production", sha(90), 41);
  await Promise.all([
    deploy("production", sha(91), 42),
    deploy("production", sha(91), 42),
  ]);

  const releases = (await runtime.releases.pipelines.get(owner, web.id))
    .releases;
  expect(releases).toHaveLength(2);
  expect(new Set(releases.map((release) => release.toSha))).toEqual(
    new Set([sha(90), sha(91)]),
  );
});

it("links commits in the deployed range and completes released issues by team policy", async () => {
  const checkout = await createIssue("Web checkout");
  const hotfix = await createIssue("Hotfix");
  const repositoryId = await connect();
  const web = await createPipeline({
    name: "Web",
    repositoryId,
    paths: ["apps/web/**"],
    environments: ["staging", "production"],
  });
  expect(await runtime.releases.pipelines.releasePolicy(owner, teamId)).toBe(
    false,
  );
  await expect(
    runtime.releases.pipelines.setReleasePolicy(viewer, teamId, true),
  ).rejects.toMatchObject({ status: 403 });
  await runtime.releases.pipelines.setReleasePolicy(owner, teamId, true);
  server.add(server.github, 1, { headRef: "plat-1-checkout", state: "merged" });
  server.pullFiles.set(1, [changedFile("apps/web/checkout.tsx")]);
  await sync();

  await deploy("staging", sha(90));
  expect(await issueState(checkout.id)).not.toBe("complete");
  expect(await releasedIn(web.id)).toEqual(["PLAT-1"]);
  expect(await releasedIn("none")).toEqual(["PLAT-2"]);

  await deploy("production", sha(90));
  expect(await issueState(checkout.id)).toBe("complete");
  expect(await issueState(hotfix.id)).not.toBe("complete");

  server.comparisons.set(`${sha(90)}...${sha(91)}`, {
    commits: [{ sha: sha(91), message: "PLAT-2 patch checkout" }],
    files: ["apps/web/checkout.tsx"],
  });
  await deploy("production", sha(91));
  const latest = (await runtime.releases.pipelines.get(owner, web.id))
    .releases[0]!;
  expect(latest).toMatchObject({ fromSha: sha(90), toSha: sha(91) });
  expect(
    (await runtime.releases.pipelineReleases.get(owner, latest.id)).issues,
  ).toMatchObject([{ identifier: "PLAT-2", source: "automatic" }]);
  expect(await issueState(hotfix.id)).toBe("complete");
});

it("lets issues be added and removed by hand and turns a release into notes and a launch post", async () => {
  await createIssue("Web checkout");
  const manual = await createIssue("Docs refresh");
  const repositoryId = await connect();
  const web = await createPipeline({ name: "Web", repositoryId });
  server.add(server.github, 1, {
    headRef: "plat-1-checkout",
    state: "merged",
    title: "Speed up checkout",
  });
  await sync();
  await deploy("production", sha(90));
  const releaseId = (await runtime.releases.pipelines.get(owner, web.id))
    .releases[0]!.id;
  const automatic = (
    await runtime.releases.pipelineReleases.get(owner, releaseId)
  ).issues[0]!;

  await runtime.releases.pipelineReleases.addIssue(owner, releaseId, manual.id);
  await expect(
    runtime.releases.pipelineReleases.addIssue(viewer, releaseId, manual.id),
  ).rejects.toMatchObject({ status: 403 });
  let detail = await runtime.releases.pipelineReleases.get(owner, releaseId);
  expect(
    detail.issues.map((issue) => [issue.identifier, issue.source]),
  ).toEqual([
    ["PLAT-1", "automatic"],
    ["PLAT-2", "manual"],
  ]);
  expect(detail.notes.internal).toContain("PLAT-1");
  expect(detail.notes.internal).toContain(
    "https://github.test/acme/app/pull/1",
  );
  expect(detail.notes.external).toContain("Docs refresh");
  expect(detail.notes.external).not.toContain("PLAT-");

  await runtime.releases.pipelineReleases.removeIssue(
    owner,
    releaseId,
    automatic.issueId,
  );
  await runtime.releases.pipelineReleases.removeIssue(
    owner,
    releaseId,
    manual.id,
  );
  detail = await runtime.releases.pipelineReleases.get(owner, releaseId);
  expect(detail.issues).toEqual([]);
  expect(await releasedIn(web.id)).toEqual([]);
  await runtime.releases.pipelineReleases.addIssue(
    owner,
    releaseId,
    automatic.issueId,
  );
  await runtime.releases.pipelineReleases.addIssue(owner, releaseId, manual.id);

  const productId = (
    await runtime.releases.products.create(
      owner,
      randomUUID(),
      productInputSchema.parse({
        name: "machdoch",
        key: "machdoch",
        website: "https://machdoch.app",
        hashtags: ["machdoch"],
        brand: {
          primary: "#6356cf",
          accent: "#7bc8ef",
          background: "#141519",
          foreground: "#eeedf2",
        },
        teamIds: [teamId],
      }),
    )
  ).id;
  const launch = await runtime.releases.pipelineReleases.createLaunch(
    owner,
    randomUUID(),
    releaseId,
    productId,
  );
  const studio = await runtime.releases.releases.get(owner, launch.id);
  expect(studio.version).toBe("main");
  expect(studio.items.map((item) => item.identifier).sort()).toEqual([
    "PLAT-1",
    "PLAT-2",
  ]);
});

it("lists pipelines by name and archive state with release columns and no count limit", async () => {
  const repositoryId = await connect();
  const created = [];
  for (let index = 0; index < 60; index++)
    created.push(
      await createPipeline({
        name: `Service ${String(index).padStart(2, "0")}`,
        repositoryId,
        paths: [`services/${index}`],
        type: index % 2 ? "scheduled" : "continuous",
        environments: ["staging", "production"],
      }),
    );
  await deploy("production", sha(90));

  const active = await runtime.releases.pipelines.list(owner, {
    query: "",
    archived: false,
  });
  expect(active).toHaveLength(60);
  expect(active[1]).toMatchObject({
    name: "Service 01",
    type: "scheduled",
    source: "deployment",
    repository: "acme/app",
    environments: ["staging", "production"],
    teams: [{ id: teamId, key: "PLAT" }],
    releaseCount: 1,
    latestRelease: { environment: "production", version: "main" },
  });

  const detail = await runtime.releases.pipelines.get(owner, created[7]!.id);
  await runtime.releases.pipelines.update(
    owner,
    randomUUID(),
    created[7]!.id,
    pipelineUpdateSchema.parse({
      name: detail.name,
      teamIds: [teamId],
      repositoryId,
      paths: detail.paths,
      type: detail.type,
      source: detail.source,
      environments: detail.environments,
      revision: detail.revision,
      archived: true,
    }),
  );
  expect(
    (
      await runtime.releases.pipelines.list(owner, {
        query: "service 0",
        archived: false,
      })
    ).map((pipeline) => pipeline.name),
  ).toEqual(
    Array.from({ length: 10 }, (_, index) => `Service 0${index}`).filter(
      (name) => name !== "Service 07",
    ),
  );
  expect(
    await runtime.releases.pipelines.list(owner, {
      query: "",
      archived: true,
    }),
  ).toMatchObject([{ name: "Service 07", archived: true }]);
  expect(
    await runtime.releases.pipelines.list(viewer, {
      query: "Service 1",
      archived: false,
    }),
  ).toHaveLength(10);
  await expect(
    createPipeline({ name: "Missing repository", source: "tag" }),
  ).rejects.toThrow();
  await expect(
    runtime.releases.pipelines.create(
      viewer,
      randomUUID(),
      pipelineInputSchema.parse({
        name: "Viewer",
        teamIds: [teamId],
        repositoryId,
        paths: [],
        type: "continuous",
        source: "deployment",
        environments: ["production"],
      }),
    ),
  ).rejects.toMatchObject({ status: 403 });
});

it("accepts generic CI webhooks with a rotating secret", async () => {
  await createIssue("Billing handler");
  await createIssue("Other service");
  const billing = await createPipeline({
    name: "Billing Lambda",
    source: "webhook",
    paths: ["services/billing"],
    environments: ["staging", "production"],
  });
  expect(billing.webhookToken).toEqual(expect.any(String));
  const payload = {
    environment: "Production",
    version: "v1.2.0",
    url: "https://ci.example.test/runs/1",
    commits: [
      {
        sha: sha(70),
        message: "PLAT-1 handle refunds",
        paths: ["services/billing/handler.ts"],
      },
      {
        sha: sha(71),
        message: "PLAT-2 tidy",
        paths: ["services/other/index.ts"],
      },
    ],
  };

  const first = await deliverPipelineHook(billing.webhookToken!, payload);
  expect(first.status).toBe(200);
  const { releaseId } = (await first.json()) as { releaseId: string };
  expect(
    await runtime.releases.pipelineReleases.get(owner, releaseId),
  ).toMatchObject({
    version: "v1.2.0",
    environment: "production",
    evidenceUrl: "https://ci.example.test/runs/1",
    issues: [{ identifier: "PLAT-1" }],
  });
  expect(
    await (await deliverPipelineHook(billing.webhookToken!, payload)).json(),
  ).toEqual({ releaseId: null });
  expect(
    (
      await deliverPipelineHook(billing.webhookToken!, {
        ...payload,
        environment: "qa",
      })
    ).status,
  ).toBe(422);

  await expect(
    runtime.releases.pipelines.rotateWebhook(viewer, billing.id),
  ).rejects.toMatchObject({ status: 403 });
  const rotated = await runtime.releases.pipelines.rotateWebhook(
    owner,
    billing.id,
  );
  expect(
    (await deliverPipelineHook(billing.webhookToken!, payload)).status,
  ).toBe(404);
  expect(
    (
      await deliverPipelineHook(rotated.webhookToken!, {
        ...payload,
        version: "v1.3.0",
      })
    ).status,
  ).toBe(200);
  expect(
    (await runtime.releases.pipelines.get(owner, billing.id)).releases,
  ).toHaveLength(2);
});

it("records workflow runs and tags as releases for matching pipelines", async () => {
  await createIssue("Web checkout");
  const repositoryId = await connect();
  const workflow = await createPipeline({
    name: "Workflow",
    repositoryId,
    source: "workflow_run",
    environments: ["Deploy"],
  });
  const tags = await createPipeline({
    name: "Tags",
    repositoryId,
    source: "tag",
    type: "scheduled",
  });
  server.add(server.github, 1, { headRef: "plat-1-checkout", state: "merged" });
  await sync();

  await deliverGitHub("workflow_run", {
    action: "completed",
    repository: { id: 7 },
    sender: { login: "ci" },
    workflow_run: {
      id: 5,
      name: "Deploy",
      head_sha: sha(90),
      head_branch: "main",
      conclusion: "success",
      html_url: "https://github.test/acme/app/actions/runs/5",
    },
  });
  await deliverGitHub("workflow_run", {
    action: "completed",
    repository: { id: 7 },
    sender: { login: "ci" },
    workflow_run: {
      id: 6,
      name: "Lint",
      head_sha: sha(91),
      head_branch: "main",
      conclusion: "success",
      html_url: "https://github.test/acme/app/actions/runs/6",
    },
  });
  await deliverGitHub("push", {
    ref: "refs/tags/v2.0.0",
    before: "0".repeat(40),
    after: sha(92),
    created: true,
    repository: { id: 7 },
    sender: { login: "octo" },
    commits: [],
  });

  expect(
    (await runtime.releases.pipelines.get(owner, workflow.id)).releases,
  ).toMatchObject([
    {
      environment: "Deploy",
      evidenceUrl: "https://github.test/acme/app/actions/runs/5",
      issueCount: 1,
    },
  ]);
  expect(
    (await runtime.releases.pipelines.get(owner, tags.id)).releases,
  ).toMatchObject([
    { version: "v2.0.0", environment: "production", toSha: sha(92) },
  ]);
  expect(await releasedIn(tags.id)).toEqual(["PLAT-1"]);
});
