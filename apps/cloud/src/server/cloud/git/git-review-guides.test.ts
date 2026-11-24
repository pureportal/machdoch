import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import type {
  AgentModelStartParams,
  AgentModelTurn,
} from "@machdoch/model-runtime/types";
import type { CloudActor } from "../../../lib/cloud-contract";
import { SettingsCipher } from "../../settings-crypto";
import { cloudMigrations } from "../database";
import { createCloudRuntime, type CloudRuntime } from "../runtime";
import { createTestCloudDatabase } from "../test-database";
import { parseReviewGuide, reviewGuidePrompt } from "./review-guides";
import { FakeGitServer, githubApiUrl, sha } from "./test-git-server";

const organizationToken = `github_pat_${"o".repeat(40)}`;
const guideAnswer = JSON.stringify({
  sections: [
    {
      title: "Session handling",
      purpose: "Refresh tokens before they expire.",
      impact: "Every signed-in request; check the expiry math.",
      files: ["src/session.ts", "src/invented.ts"],
    },
    {
      title: "Docs",
      purpose: "Describe the refresh.",
      impact: "None at runtime.",
      files: ["README.md", "src/session.ts"],
    },
  ],
});

let database: Awaited<ReturnType<typeof createTestCloudDatabase>>;
let runtime: CloudRuntime;
let server: FakeGitServer;
let owner: CloudActor;
let providerId: string;
let start: ReturnType<
  typeof vi.fn<(params: AgentModelStartParams) => Promise<AgentModelTurn>>
>;

async function sync(connectionId: string) {
  await runtime.git.connections.requestSync(owner, connectionId);
  for (let round = 0; round < 50; round++)
    if (!(await runtime.git.sync.tick())) return;
  throw new Error("Git sync did not settle.");
}

async function inferenceCalls() {
  return (
    await database.engine.query<{ id: string }>(
      "SELECT id FROM cloud_inference_calls ORDER BY created_at",
    )
  ).rows;
}

async function answerLatest() {
  const call = (await inferenceCalls()).at(-1)!;
  await runtime.inference.worker.runOne(owner.organizationId, call.id);
  await runtime.git.reviewGuides.tick();
}

async function enableGuides(reviewGuides: boolean) {
  const current = (await runtime.git.connections.get(owner)).settings;
  await runtime.git.reviewSettings.set(owner, { ...current, reviewGuides });
}

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
  server = new FakeGitServer();
  server.logins.set(organizationToken, "acme-bot");
  owner = { organizationId: randomUUID(), userId: randomUUID() };
  await database.engine.query(
    "INSERT INTO cloud_organizations (id,name) VALUES ($1,'Organization')",
    [owner.organizationId],
  );
  await database.engine.query(
    "INSERT INTO cloud_users (id,email,name,password_hash) VALUES ($1,'owner@example.test','Owner','test')",
    [owner.userId],
  );
  await database.engine.query(
    "INSERT INTO cloud_memberships (organization_id,user_id,role) VALUES ($1,$2,'owner')",
    [owner.organizationId, owner.userId],
  );
  start = vi.fn(async () => ({
    text: guideAnswer,
    toolCalls: [],
    usage: { totalTokens: 4 },
  }));
  runtime = createCloudRuntime(database, "https://cloud.example.test", {
    credentialsCipher: new SettingsCipher(randomBytes(32)),
    gitFetch: server.transport,
    modelAdapterFactory: async () => ({
      startTurn: start,
      continueTurn: async () => {
        throw new Error("Agent rounds restart with the full transcript.");
      },
    }),
  });
  providerId = (
    await runtime.aiProviders.create(owner, randomUUID(), {
      name: "Provider",
      provider: "openai",
      region: null,
      models: ["fixture-model"],
      apiKey: "private-fixture-key",
      maxOutputTokens: 256,
      dailyTokenBudget: 200000,
      maxConcurrentRequests: 4,
    })
  ).id;
});

it("builds the guide prompt within a patch budget and keeps each changed file in one section", () => {
  const prompt = reviewGuidePrompt(
    { repository: "acme/app", number: 5, title: "Refresh sessions" },
    [
      {
        filename: "src/session.ts",
        previousFilename: null,
        status: "modified",
        additions: 9000,
        deletions: 0,
        patch: `@@ -1 +1 @@\n${"+x\n".repeat(30_000)}`,
      },
      {
        filename: "assets/logo.png",
        previousFilename: null,
        status: "added",
        additions: 0,
        deletions: 0,
        patch: null,
      },
    ],
  );
  expect(prompt).toContain('pull request #5 "Refresh sessions" in acme/app');
  expect(prompt).toContain("### src/session.ts (modified, +9000 −0)");
  expect(prompt).toContain("### assets/logo.png (added, +0 −0)");
  expect(prompt.length).toBeLessThan(10_000);

  expect(
    parseReviewGuide(`Here you go:\n\`\`\`json\n${guideAnswer}\n\`\`\``, [
      "src/session.ts",
      "README.md",
    ]),
  ).toEqual([
    {
      title: "Session handling",
      purpose: "Refresh tokens before they expire.",
      impact: "Every signed-in request; check the expiry math.",
      files: ["src/session.ts"],
    },
    {
      title: "Docs",
      purpose: "Describe the refresh.",
      impact: "None at runtime.",
      files: ["README.md"],
    },
  ]);
  expect(parseReviewGuide("I could not do that.", [])).toBeNull();
  expect(parseReviewGuide('{"sections":[]}', [])).toBeNull();
  expect(parseReviewGuide("{not json}", [])).toBeNull();
});

it("generates a review guide only when review guides are on and caches it per head commit", async () => {
  const change = server.add(server.github, 5, {
    headRef: "refresh",
    title: "Refresh sessions",
  });
  server.pullFiles.set(5, [
    {
      filename: "src/session.ts",
      status: "modified",
      additions: 2,
      deletions: 1,
      patch: "@@ -1 +1,2 @@\n-expire()\n+refresh()\n+expire()",
    },
    {
      filename: "README.md",
      status: "modified",
      additions: 1,
      deletions: 0,
      patch: "@@ -1 +1,2 @@\n+Sessions refresh.",
    },
  ]);
  const connectionId = (
    await runtime.git.connections.connect(owner, randomUUID(), "github", {
      revision: 0,
      apiUrl: githubApiUrl,
      token: organizationToken,
      automate: true,
      codeAccess: false,
    })
  ).id;
  await runtime.git.connections.addRepository(owner, connectionId, "acme/app");
  await sync(connectionId);
  const pullRequestId = (await runtime.git.pullRequests.list(owner, undefined))
    .pullRequests[0]!.pullRequest.id;
  const model = { providerId, model: "fixture-model" };

  expect(await runtime.git.reviewGuides.get(owner, pullRequestId)).toEqual({
    enabled: false,
    guide: null,
  });
  await expect(
    runtime.git.reviewGuides.start(owner, randomUUID(), pullRequestId, model),
  ).rejects.toMatchObject({ code: "review_guides_off" });
  expect(await inferenceCalls()).toHaveLength(0);

  await enableGuides(true);
  const waiting = await runtime.git.reviewGuides.start(
    owner,
    randomUUID(),
    pullRequestId,
    model,
  );
  expect(waiting).toMatchObject({
    headSha: sha(5),
    state: "waiting",
    sections: [],
  });
  expect(
    await runtime.git.reviewGuides.start(
      owner,
      randomUUID(),
      pullRequestId,
      model,
    ),
  ).toMatchObject({ id: waiting.id });
  expect(await inferenceCalls()).toHaveLength(1);

  await answerLatest();
  expect(start.mock.calls[0]![0].userPrompt).toContain(
    "### src/session.ts (modified, +2 −1)",
  );
  expect(await runtime.git.reviewGuides.get(owner, pullRequestId)).toEqual({
    enabled: true,
    guide: expect.objectContaining({
      id: waiting.id,
      state: "ready",
      error: null,
      sections: [
        expect.objectContaining({
          title: "Session handling",
          files: ["src/session.ts"],
        }),
        expect.objectContaining({ title: "Docs", files: ["README.md"] }),
      ],
    }),
  });
  expect(
    (
      await runtime.git.reviewGuides.start(
        owner,
        randomUUID(),
        pullRequestId,
        model,
      )
    ).state,
  ).toBe("ready");
  expect(await inferenceCalls()).toHaveLength(1);
  expect(await runtime.chat.store.list(owner)).toEqual([]);

  server.update(change, { headSha: sha(6) });
  await sync(connectionId);
  expect(
    (await runtime.git.reviewGuides.get(owner, pullRequestId)).guide,
  ).toBeNull();
  start.mockResolvedValueOnce({
    text: "I could not read the diff.",
    toolCalls: [],
    usage: { totalTokens: 4 },
  });
  await runtime.git.reviewGuides.start(
    owner,
    randomUUID(),
    pullRequestId,
    model,
  );
  await answerLatest();
  const failed = (await runtime.git.reviewGuides.get(owner, pullRequestId))
    .guide!;
  expect(failed).toMatchObject({
    headSha: sha(6),
    state: "failed",
    error: "Agent did not return a guide.",
  });
  const retried = await runtime.git.reviewGuides.start(
    owner,
    randomUUID(),
    pullRequestId,
    model,
  );
  expect(retried.id).not.toBe(failed.id);
  await answerLatest();
  expect(
    (await runtime.git.reviewGuides.get(owner, pullRequestId)).guide,
  ).toMatchObject({ id: retried.id, state: "ready" });
  expect(await inferenceCalls()).toHaveLength(3);

  await enableGuides(false);
  expect(await runtime.git.reviewGuides.get(owner, pullRequestId)).toEqual({
    enabled: false,
    guide: expect.objectContaining({ id: retried.id }),
  });
});

it("adds review guide tables to existing installations", async () => {
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
    const tables = (
      await engine.query<{ table_name: string }>(
        "SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'cloud_git_review_guide%' ORDER BY table_name",
      )
    ).rows.map((row) => row.table_name);
    expect(tables).toEqual([
      "cloud_git_review_guide_files",
      "cloud_git_review_guide_sections",
      "cloud_git_review_guides",
    ]);
    expect(
      (
        await engine.query(
          "SELECT is_nullable FROM information_schema.columns WHERE table_name='cloud_chats' AND column_name='review_guide_id'",
        )
      ).rows,
    ).toEqual([{ is_nullable: "YES" }]);
  } finally {
    await engine.close();
  }
});
