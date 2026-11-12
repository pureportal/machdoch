import { randomBytes, randomUUID } from "node:crypto";
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
import {
  defaultEstimateScale,
  issueInputSchema,
  type CloudActor,
} from "../../../lib/cloud-contract";
import {
  channelInputSchema,
  productInputSchema,
  type ChannelInput,
} from "../../../lib/cloud-release-contract";
import { defaultChannelRules } from "../../../lib/release-posts";
import { SettingsCipher } from "../../settings-crypto";
import { handleCloudApi } from "../api";
import { createCloudRuntime, type CloudRuntime } from "../runtime";
import { createTestCloudDatabase, testStatusReference } from "../test-database";
import type { CloudVideoComposer } from "./video-composer";

let database: Awaited<ReturnType<typeof createTestCloudDatabase>>;
let runtime: CloudRuntime;
let owner: CloudActor;
let member: CloudActor;
let viewer: CloudActor;
let teamId: string;
let start: ReturnType<
  typeof vi.fn<(params: AgentModelStartParams) => Promise<AgentModelTurn>>
>;
const calls: { url: string; method: string; body: string; headers: Headers }[] =
  [];
let failingSubredditAttempts = 0;
const compose = vi.fn<CloudVideoComposer["compose"]>();

function json(value: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: { "Content-Type": "application/json", ...init.headers },
  });
}

const socialFetch: typeof fetch = async (input, init) => {
  const url = String(input);
  const body =
    init?.body instanceof URLSearchParams
      ? init.body.toString()
      : typeof init?.body === "string"
        ? init.body
        : "";
  calls.push({
    url,
    method: init?.method ?? "GET",
    body,
    headers: new Headers(init?.headers),
  });
  if (url === "https://www.linkedin.com/oauth/v2/accessToken")
    return json({ access_token: "li-token", expires_in: 5_184_000 });
  if (url === "https://api.linkedin.com/v2/userinfo")
    return json({ sub: "abc123", name: "Ada Owner" });
  if (url.startsWith("https://api.linkedin.com/rest/organizationAcls"))
    return json({ elements: [{ organization: "urn:li:organization:42" }] });
  if (url === "https://api.linkedin.com/rest/organizations/42")
    return json({ localizedName: "machdoch GmbH" });
  if (url === "https://api.linkedin.com/rest/images?action=initializeUpload")
    return json({
      value: {
        uploadUrl: "https://upload.linkedin.test/image",
        image: "urn:li:image:C1",
      },
    });
  if (url === "https://upload.linkedin.test/image")
    return new Response(null, { status: 201 });
  if (url === "https://api.linkedin.com/rest/posts")
    return new Response(null, {
      status: 201,
      headers: { "x-restli-id": "urn:li:share:7" },
    });
  if (url === "https://www.reddit.com/api/v1/access_token")
    return json({
      access_token: "rd-token",
      refresh_token: "rd-refresh",
      expires_in: 86_400,
    });
  if (url === "https://oauth.reddit.com/api/v1/me")
    return json({ name: "machdoch_bot" });
  if (url === "https://oauth.reddit.com/api/submit") {
    const subreddit = new URLSearchParams(body).get("sr");
    if (subreddit === "selfhosted" && failingSubredditAttempts++ === 0)
      return json({
        json: {
          errors: [["RATELIMIT", "You are doing that too much.", "ratelimit"]],
        },
      });
    return json({
      json: {
        errors: [],
        data: {
          name: "t3_abc",
          url: `https://www.reddit.com/r/${subreddit}/comments/abc/`,
        },
      },
    });
  }
  if (url === "https://hooks.slack.test/services/T1") return new Response("ok");
  return new Response("not found", { status: 404 });
};

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
  calls.length = 0;
  failingSubredditAttempts = 0;
  compose.mockReset();
  const organizationId = randomUUID();
  await database.engine.query(
    "INSERT INTO cloud_organizations (id,name) VALUES ($1,'Organization')",
    [organizationId],
  );
  const actors: CloudActor[] = [];
  for (const role of ["owner", "member", "viewer"]) {
    const userId = randomUUID();
    await database.engine.query(
      "INSERT INTO cloud_users (id,email,name,password_hash) VALUES ($1,$2,$3,'test')",
      [userId, `${role}@example.test`, role],
    );
    await database.engine.query(
      "INSERT INTO cloud_memberships (organization_id,user_id,role) VALUES ($1,$2,$3)",
      [organizationId, userId, role],
    );
    actors.push({ organizationId, userId });
  }
  [owner, member, viewer] = actors as [CloudActor, CloudActor, CloudActor];
  start = vi.fn(async () => ({
    text: "Done.",
    toolCalls: [],
    usage: { totalTokens: 4 },
  }));
  runtime = createCloudRuntime(database, "https://cloud.example.test", {
    credentialsCipher: new SettingsCipher(randomBytes(32)),
    socialFetch,
    videoComposer: {
      available: async () => true,
      compose,
    } as unknown as CloudVideoComposer,
    modelAdapterFactory: async () => ({
      startTurn: start,
      continueTurn: async () => {
        throw new Error("Agent rounds restart with the full transcript.");
      },
    }),
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

const brand = {
  primary: "#6356cf",
  accent: "#7bc8ef",
  background: "#141519",
  foreground: "#eeedf2",
};

async function createProduct(input: Record<string, unknown> = {}) {
  return (
    await runtime.releases.products.create(
      owner,
      randomUUID(),
      productInputSchema.parse({
        name: "machdoch",
        key: "machdoch",
        website: "https://machdoch.app",
        hashtags: ["machdoch"],
        brand,
        teamIds: [teamId],
        ...input,
      }),
    )
  ).id;
}

async function connect(network: "linkedin" | "reddit") {
  await runtime.releases.social.setApp(owner, network, {
    clientId: `${network}-client`,
    clientSecret: "secret",
    organizationPages: true,
  });
  const authorize = new URL(
    await runtime.releases.social.startConnect(owner, network),
  );
  return runtime.releases.social.completeConnect(
    owner,
    network,
    "code",
    authorize.searchParams.get("state")!,
  );
}

function channel(
  input: Record<string, unknown> & { kind: ChannelInput["kind"] },
) {
  return channelInputSchema.parse({
    name: input.kind,
    rules: defaultChannelRules(input.kind),
    requiresApproval: true,
    ...input,
  });
}

async function completeIssue(title: string) {
  const { id } = await runtime.planning.createIssue(
    owner,
    randomUUID(),
    issueInputSchema.parse({ teamId, title }),
  );
  await runtime.issueChanges.apply(owner, randomUUID(), {
    issues: [{ id }],
    changes: {
      status: await testStatusReference(database, owner, teamId, "complete"),
    },
  });
  return id;
}

async function publishAll(releaseId: string) {
  const release = await runtime.releases.releases.get(owner, releaseId);
  for (const post of release.posts) {
    const approved = await runtime.releases.releases.changePost(
      owner,
      randomUUID(),
      post.id,
      {
        action: "approve",
        revision: post.revision,
      },
    );
    await runtime.releases.releases.changePost(owner, randomUUID(), post.id, {
      action: "publish",
      revision: approved.revision,
    });
  }
  await runtime.releases.dispatcher.tick();
  return runtime.releases.releases.get(owner, releaseId);
}

it("lets only administrators manage products, channels and connections", async () => {
  await expect(
    runtime.releases.products.create(
      member,
      randomUUID(),
      productInputSchema.parse({ name: "x", key: "xx", brand }),
    ),
  ).rejects.toMatchObject({ code: "permission_denied" });
  const productId = await createProduct();
  await runtime.releases.products.createChannel(
    owner,
    randomUUID(),
    productId,
    channel({
      kind: "webhook",
      url: "https://hooks.slack.test/services/T1",
      format: "slack",
    }),
  );
  const { channels } = await runtime.releases.products.get(member, productId);
  expect(channels).toMatchObject([
    { kind: "webhook", webhookHost: "hooks.slack.test" },
  ]);
  expect(JSON.stringify(channels)).not.toContain("services/T1");
  await expect(
    runtime.releases.social.startConnect(member, "linkedin"),
  ).rejects.toMatchObject({
    code: "permission_denied",
  });
  await expect(
    runtime.releases.social.startConnect(owner, "linkedin"),
  ).rejects.toMatchObject({
    code: "social_app_required",
  });
});

it("connects LinkedIn with OAuth and lists the member and administered pages", async () => {
  await runtime.releases.social.setApp(owner, "linkedin", {
    clientId: "linkedin-client",
    clientSecret: "secret",
    organizationPages: true,
  });
  const authorize = new URL(
    await runtime.releases.social.startConnect(owner, "linkedin"),
  );
  expect(authorize.origin + authorize.pathname).toBe(
    "https://www.linkedin.com/oauth/v2/authorization",
  );
  expect(authorize.searchParams.get("redirect_uri")).toBe(
    "https://cloud.example.test/api/v1/social/linkedin/callback",
  );
  expect(authorize.searchParams.get("scope")).toBe(
    "openid profile w_member_social w_organization_social r_organization_admin",
  );
  await expect(
    runtime.releases.social.completeConnect(
      owner,
      "linkedin",
      "code",
      "forged",
    ),
  ).rejects.toMatchObject({ code: "social_state" });
  const { id } = await runtime.releases.social.completeConnect(
    owner,
    "linkedin",
    "code",
    authorize.searchParams.get("state")!,
  );
  await expect(
    runtime.releases.social.completeConnect(
      owner,
      "linkedin",
      "code",
      authorize.searchParams.get("state")!,
    ),
  ).rejects.toMatchObject({ code: "social_state" });
  expect(await runtime.releases.social.accounts(member)).toMatchObject([
    {
      id,
      network: "linkedin",
      name: "Ada Owner",
      externalId: "abc123",
      connectedBy: "owner",
    },
  ]);
  expect(await runtime.releases.social.targets(owner, id)).toEqual([
    { urn: "urn:li:person:abc123", name: "Ada Owner", kind: "person" },
    {
      urn: "urn:li:organization:42",
      name: "machdoch GmbH",
      kind: "organization",
    },
  ]);
  const exchange = calls.find((call) => call.url.endsWith("/accessToken"))!;
  expect(new URLSearchParams(exchange.body).get("client_secret")).toBe(
    "secret",
  );
});

it("collects shipped work and publishes approved posts to LinkedIn, every subreddit and Slack", async () => {
  const productId = await createProduct();
  const linkedIn = await connect("linkedin");
  const reddit = await connect("reddit");
  for (const input of [
    channel({
      kind: "linkedin",
      name: "Company page",
      accountId: linkedIn.id,
      authorUrn: "urn:li:organization:42",
      authorName: "machdoch GmbH",
    }),
    channel({
      kind: "reddit",
      name: "Reddit",
      accountId: reddit.id,
      subreddits: [
        { name: "r/programming", postType: "link", flairId: "f1" },
        { name: "selfhosted", postType: "text" },
      ],
    }),
    channel({
      kind: "webhook",
      name: "Slack",
      url: "https://hooks.slack.test/services/T1",
      format: "slack",
    }),
  ])
    await runtime.releases.products.createChannel(
      owner,
      randomUUID(),
      productId,
      input,
    );
  await completeIssue("Automations for everything");
  await runtime.planning.createIssue(
    owner,
    randomUUID(),
    issueInputSchema.parse({ teamId, title: "Still open" }),
  );
  const { id: releaseId } = await runtime.releases.releases.create(
    member,
    randomUUID(),
    {
      productId,
      version: "42.1",
      name: "Automations",
      since: null,
      targetDate: null,
    },
  );
  await expect(
    runtime.releases.releases.create(member, randomUUID(), {
      productId,
      version: "42.1",
      name: "",
      since: null,
      targetDate: null,
    }),
  ).rejects.toMatchObject({ code: "release_version" });
  const release = await runtime.releases.releases.get(member, releaseId);
  expect(release.items.map((item) => item.title)).toEqual([
    "Automations for everything",
  ]);
  expect(release.posts.map((post) => post.channelName)).toEqual([
    "Company page",
    "Reddit",
    "Slack",
  ]);
  expect(release.status).toBe("draft");
  const visual = await runtime.releases.studio.createVisual(member, releaseId, {
    template: "announcement",
    format: "landscape",
    eyebrow: "",
    headline: "Automations for everything",
    subline: "",
    items: [],
    mediaId: null,
    theme: "brand",
  });
  expect(visual).toMatchObject({
    kind: "image",
    width: 1200,
    height: 627,
    role: "visual",
    source: "template",
  });
  for (const post of release.posts)
    await runtime.releases.releases.updatePost(member, randomUUID(), post.id, {
      revision: post.revision,
      title:
        post.channelKind === "reddit"
          ? "machdoch 42.1 adds workflow automations"
          : "",
      body: "Automations are here (finally). #machdoch",
      mediaIds: post.channelKind === "linkedin" ? [visual.id] : [],
      link: "https://machdoch.app/releases/42-1",
    });
  const draft = (await runtime.releases.releases.get(member, releaseId))
    .posts[0]!;
  await expect(
    runtime.releases.releases.changePost(member, randomUUID(), draft.id, {
      action: "publish",
      revision: draft.revision,
    }),
  ).rejects.toMatchObject({ code: "publish_denied" });
  await expect(
    runtime.releases.releases.changePost(owner, randomUUID(), draft.id, {
      action: "publish",
      revision: draft.revision,
    }),
  ).rejects.toMatchObject({ code: "approval_required" });

  const published = await publishAll(releaseId);
  const [linkedInPost, redditPost, slackPost] = published.posts;
  expect(linkedInPost).toMatchObject({
    state: "published",
    deliveries: [
      {
        target: "linkedin",
        state: "published",
        url: "https://www.linkedin.com/feed/update/urn:li:share:7/",
      },
    ],
  });
  const created = JSON.parse(
    calls.find((call) => call.url === "https://api.linkedin.com/rest/posts")!
      .body,
  );
  expect(created).toMatchObject({
    author: "urn:li:organization:42",
    commentary:
      "Automations are here \\(finally\\). {hashtag|\\#|machdoch}\n\nhttps://machdoch.app/releases/42-1",
    content: { media: { id: "urn:li:image:C1" } },
    lifecycleState: "PUBLISHED",
  });
  expect(
    calls
      .find((call) => call.url.endsWith("/rest/posts"))!
      .headers.get("LinkedIn-Version"),
  ).toBe("202610");
  expect(redditPost!.state).toBe("failed");
  expect(redditPost!.deliveries).toMatchObject([
    { target: "r/programming", state: "published" },
    {
      target: "r/selfhosted",
      state: "failed",
      error: "You are doing that too much.",
    },
  ]);
  const programming = new URLSearchParams(
    calls.find((call) => call.url.endsWith("/api/submit"))!.body,
  );
  expect(Object.fromEntries(programming)).toMatchObject({
    sr: "programming",
    kind: "link",
    title: "machdoch 42.1 adds workflow automations",
    url: "https://machdoch.app/releases/42-1",
    flair_id: "f1",
  });
  expect(slackPost!.state).toBe("published");
  expect(
    JSON.parse(
      calls.find((call) => call.url.startsWith("https://hooks.slack.test"))!
        .body,
    ).text,
  ).toContain("*machdoch 42.1: Automations*");
  expect(published.status).toBe("attention");

  await runtime.releases.releases.changePost(
    owner,
    randomUUID(),
    redditPost!.id,
    {
      action: "retry",
      revision: redditPost!.revision,
    },
  );
  await runtime.releases.dispatcher.tick();
  const retried = await runtime.releases.releases.get(owner, releaseId);
  expect(retried.status).toBe("published");
  expect(
    calls
      .filter((call) => call.url.endsWith("/api/submit"))
      .map((call) => new URLSearchParams(call.body).get("sr")),
  ).toEqual(["programming", "selfhosted", "selfhosted"]);
  await expect(
    runtime.releases.releases.updatePost(
      owner,
      randomUUID(),
      retried.posts[0]!.id,
      {
        revision: retried.posts[0]!.revision,
        title: "",
        body: "edit",
        mediaIds: [],
        link: null,
      },
    ),
  ).rejects.toMatchObject({ code: "post_published" });
});

it("lets members publish when the product allows it and hides invisible work", async () => {
  const productId = await createProduct({ membersCanPublish: true });
  await runtime.releases.products.createChannel(
    owner,
    randomUUID(),
    productId,
    channel({
      kind: "webhook",
      url: "https://hooks.slack.test/services/T1",
      format: "json",
      requiresApproval: false,
    }),
  );
  await database.engine.query(
    "UPDATE cloud_teams SET visibility='private' WHERE id=$1",
    [teamId],
  );
  await completeIssue("Private work");
  const { id } = await runtime.releases.releases.create(owner, randomUUID(), {
    productId,
    version: "1.0",
    name: "",
    since: null,
    targetDate: null,
  });
  expect((await runtime.releases.releases.get(owner, id)).items).toHaveLength(
    1,
  );
  const release = await runtime.releases.releases.get(member, id);
  expect(release.items).toEqual([]);
  expect(release.canPublish).toBe(true);
  const post = await runtime.releases.releases.updatePost(
    member,
    randomUUID(),
    release.posts[0]!.id,
    {
      revision: release.posts[0]!.revision,
      title: "",
      body: "Hello",
      mediaIds: [],
      link: null,
    },
  );
  await runtime.releases.releases.changePost(member, randomUUID(), post.id, {
    action: "publish",
    revision: post.revision,
  });
  await runtime.releases.dispatcher.tick();
  expect(
    (await runtime.releases.releases.get(member, id)).posts[0]!.state,
  ).toBe("published");
  await expect(
    runtime.releases.releases.create(viewer, randomUUID(), {
      productId,
      version: "2",
      name: "",
      since: null,
      targetDate: null,
    }),
  ).rejects.toMatchObject({
    code: "permission_denied",
  });
});

it("accepts uploads, capture links and range reads through the API", async () => {
  const productId = await createProduct();
  const { id: releaseId } = await runtime.releases.releases.create(
    owner,
    randomUUID(),
    { productId, version: "2.0", name: "", since: null, targetDate: null },
  );
  const brief = await runtime.releases.studio.startCapture(owner, releaseId, {
    shots: ["The automations gallery", "A run history"],
  });
  expect(brief.prompt).toContain("1. The automations gallery");
  expect(brief.prompt).toContain(brief.uploadUrl);
  const video = Buffer.alloc(300_000, 7);
  const upload = await handleCloudApi(
    new Request(`${brief.uploadUrl}?name=demo.mp4&caption=Gallery%20tour`, {
      method: "POST",
      headers: { "Content-Type": "video/mp4" },
      body: video,
    }),
    "203.0.113.1",
    runtime,
  );
  expect(upload.status).toBe(201);
  const media = await runtime.releases.media.list(owner, {
    productId,
    releaseId,
  });
  expect(media).toMatchObject([
    {
      kind: "video",
      role: "recording",
      source: "capture",
      caption: "Gallery tour",
      byteLength: 300_000,
    },
  ]);
  const range = await runtime.releases.media.read(
    owner,
    media[0]!.id,
    "bytes=262140-262150",
  );
  expect([range.start, range.end, range.total]).toEqual([
    262_140, 262_150, 300_000,
  ]);
  expect(Buffer.from(await new Response(range.body).arrayBuffer())).toEqual(
    video.subarray(262_140, 262_151),
  );
  const release = await runtime.releases.releases.get(owner, releaseId);
  expect(release.jobs[0]).toMatchObject({
    kind: "capture",
    state: "succeeded",
    detail: "1 file received",
  });
  const rejected = await handleCloudApi(
    new Request(`${brief.uploadUrl}?name=x.gif`, {
      method: "POST",
      headers: { "Content-Type": "image/gif" },
      body: "GIF89a",
    }),
    "203.0.113.1",
    runtime,
  );
  expect(rejected.status).toBe(415);
  await database.engine.query(
    "UPDATE cloud_release_capture_tokens SET expires_at=clock_timestamp()-interval '1 second'",
  );
  const expired = await handleCloudApi(
    new Request(`${brief.uploadUrl}?name=late.png`, {
      method: "POST",
      headers: { "Content-Type": "image/png" },
      body: "x",
    }),
    "203.0.113.1",
    runtime,
  );
  expect(expired.status).toBe(404);
});

it("lets Agent write the notes, native posts and branded visuals", async () => {
  const productId = await createProduct({
    voice: "Confident, concrete, no hype.",
  });
  await runtime.releases.products.createChannel(
    owner,
    randomUUID(),
    productId,
    channel({
      kind: "webhook",
      name: "Discord",
      url: "https://hooks.slack.test/services/T1",
      format: "discord",
    }),
  );
  await completeIssue("Release studio");
  const { id: releaseId } = await runtime.releases.releases.create(
    owner,
    randomUUID(),
    { productId, version: "43.0", name: "", since: null, targetDate: null },
  );
  const providerId = (
    await runtime.aiProviders.create(owner, randomUUID(), {
      name: "Provider",
      provider: "openai",
      region: null,
      models: ["fixture-model"],
      apiKey: "private-fixture-key",
      maxOutputTokens: 256,
      dailyTokenBudget: 500_000,
      maxConcurrentRequests: 4,
    })
  ).id;
  start
    .mockResolvedValueOnce({
      text: "",
      toolCalls: [
        {
          id: "notes",
          name: "propose_release_notes",
          arguments: {
            release: releaseId,
            summary: "Launch content writes itself.",
            notes: "## Release studio\n- Agent drafts every post",
            highlights: [
              { title: "Release studio", body: "From shipped work to posts." },
            ],
          },
        },
        {
          id: "post",
          name: "propose_release_post",
          arguments: {
            release: "machdoch 43.0",
            channel: "Discord",
            body: "Release studio is live.",
          },
        },
        {
          id: "visual",
          name: "propose_release_visual",
          arguments: {
            release: releaseId,
            template: "highlights",
            format: "square",
            headline: "What's new",
            items: ["Release studio"],
            attachTo: ["Discord"],
          },
        },
      ],
      usage: { totalTokens: 10 },
    })
    .mockResolvedValueOnce({
      text: "Drafted everything.",
      toolCalls: [],
      usage: { totalTokens: 4 },
    });
  const job = await runtime.releases.studio.startWrite(
    member,
    randomUUID(),
    releaseId,
    {
      providerId,
      model: "fixture-model",
      scope: "all",
      channelIds: [],
      instructions: "",
    },
  );
  const call = (
    await database.engine.query<{
      id: string;
      system_prompt: string;
      user_prompt: string;
    }>("SELECT id,system_prompt,user_prompt FROM cloud_inference_calls")
  ).rows[0]!;
  expect(call.user_prompt).toContain(
    "Voice and style rules:\\nConfident, concrete, no hype.",
  );
  expect(call.user_prompt).toContain("PLAT-1: Release studio");
  await runtime.inference.worker.runOne(owner.organizationId, call.id);
  await runtime.releases.dispatcher.tick();
  const release = await runtime.releases.releases.get(member, releaseId);
  expect(release.jobs.find((entry) => entry.id === job.id)).toMatchObject({
    state: "succeeded",
    detail: "Wrote notes, 1 post and 1 visual",
  });
  expect(release).toMatchObject({
    summary: "Launch content writes itself.",
    highlights: [{ title: "Release studio" }],
  });
  expect(release.posts[0]).toMatchObject({
    state: "draft",
    body: "Release studio is live.",
    mediaIds: [expect.any(String)],
  });
  const media = await runtime.releases.media.list(member, {
    productId,
    releaseId,
  });
  expect(media).toMatchObject([
    {
      role: "visual",
      width: 1080,
      height: 1080,
      id: release.posts[0]!.mediaIds[0],
    },
  ]);
  expect(await runtime.chat.store.list(member)).toEqual([]);
});

it("launches every ready post at once and records posts made by hand", async () => {
  const productId = await createProduct();
  for (const [name, requiresApproval] of [
    ["Slack", false],
    ["Review", true],
    ["Empty", false],
  ] as const)
    await runtime.releases.products.createChannel(
      owner,
      randomUUID(),
      productId,
      channel({
        kind: "webhook",
        name,
        url: "https://hooks.slack.test/services/T1",
        format: "slack",
        requiresApproval,
      }),
    );
  const { id } = await runtime.releases.releases.create(owner, randomUUID(), {
    productId,
    version: "2.0",
    name: "",
    since: null,
    targetDate: null,
  });
  const created = await runtime.releases.releases.get(owner, id);
  const postOf = (name: string) =>
    created.posts.find((post) => post.channelName === name)!;
  for (const name of ["Slack", "Review"])
    await runtime.releases.releases.updatePost(
      owner,
      randomUUID(),
      postOf(name).id,
      {
        revision: postOf(name).revision,
        title: "",
        body: `${name} post`,
        mediaIds: [],
        link: null,
      },
    );
  await expect(
    runtime.releases.releases.launch(member, randomUUID(), id, {
      action: "publish",
    }),
  ).rejects.toMatchObject({ code: "publish_denied" });
  const at = new Date(Date.now() + 3_600_000).toISOString();
  const key = randomUUID();
  const scheduled = await runtime.releases.releases.launch(owner, key, id, {
    action: "schedule",
    at,
  });
  expect(scheduled).toEqual({
    launched: 1,
    skipped: [
      { channelName: "Review", reason: expect.any(String) },
      { channelName: "Empty", reason: expect.any(String) },
    ],
  });
  expect(
    await runtime.releases.releases.launch(owner, key, id, {
      action: "schedule",
      at,
    }),
  ).toMatchObject({ launched: 0 });
  let release = await runtime.releases.releases.get(owner, id);
  expect(
    release.posts.find((post) => post.channelName === "Slack"),
  ).toMatchObject({ state: "scheduled", scheduledAt: at });

  const review = release.posts.find((post) => post.channelName === "Review")!;
  await expect(
    runtime.releases.releases.changePost(member, randomUUID(), review.id, {
      action: "manual",
      revision: review.revision,
      url: "https://www.linkedin.com/feed/update/1",
    }),
  ).rejects.toMatchObject({ code: "publish_denied" });
  const posted = await runtime.releases.releases.changePost(
    owner,
    randomUUID(),
    review.id,
    {
      action: "manual",
      revision: review.revision,
      url: "https://www.linkedin.com/feed/update/1",
    },
  );
  expect(posted).toMatchObject({
    state: "published",
    deliveries: [
      {
        target: "manual",
        state: "published",
        url: "https://www.linkedin.com/feed/update/1",
      },
    ],
  });
  await expect(
    runtime.releases.releases.changePost(owner, randomUUID(), review.id, {
      action: "manual",
      revision: posted.revision,
      url: "https://www.linkedin.com/feed/update/2",
    }),
  ).rejects.toBeInstanceOf(Error);

  const published = await runtime.releases.releases.launch(
    owner,
    randomUUID(),
    id,
    { action: "publish" },
  );
  expect(published).toEqual({
    launched: 0,
    skipped: [{ channelName: "Empty", reason: expect.any(String) }],
  });
  release = await runtime.releases.releases.get(owner, id);
  expect(release.posts.map((post) => post.state).sort()).toEqual([
    "draft",
    "published",
    "scheduled",
  ]);
  expect(calls).toEqual([]);
});

it("rewrites only the chosen channel's post", async () => {
  const productId = await createProduct();
  const channelIds: string[] = [];
  for (const name of ["Slack", "Discord"])
    channelIds.push(
      (
        await runtime.releases.products.createChannel(
          owner,
          randomUUID(),
          productId,
          channel({
            kind: "webhook",
            name,
            url: "https://hooks.slack.test/services/T1",
            format: "slack",
          }),
        )
      ).id,
    );
  const { id: releaseId } = await runtime.releases.releases.create(
    owner,
    randomUUID(),
    { productId, version: "3.0", name: "", since: null, targetDate: null },
  );
  const providerId = (
    await runtime.aiProviders.create(owner, randomUUID(), {
      name: "Provider",
      provider: "openai",
      region: null,
      models: ["fixture-model"],
      apiKey: "private-fixture-key",
      maxOutputTokens: 256,
      dailyTokenBudget: 500_000,
      maxConcurrentRequests: 4,
    })
  ).id;
  const write = (ids: string[]) =>
    runtime.releases.studio.startWrite(member, randomUUID(), releaseId, {
      providerId,
      model: "fixture-model",
      scope: "posts",
      channelIds: ids,
      instructions: "",
    });
  await expect(write([randomUUID()])).rejects.toMatchObject({
    code: "channel_unavailable",
  });
  await write([channelIds[1]!]);
  const { user_prompt: prompt } = (
    await database.engine.query<{ user_prompt: string }>(
      "SELECT user_prompt FROM cloud_inference_calls",
    )
  ).rows[0]!;
  expect(prompt).toContain("Discord");
  expect(prompt).not.toContain("Slack");
});

it("renders videos in the background and stores them as release media", async () => {
  const productId = await createProduct();
  const { id: releaseId } = await runtime.releases.releases.create(
    owner,
    randomUUID(),
    { productId, version: "44", name: "", since: null, targetDate: null },
  );
  const screenshot = await runtime.releases.studio.createVisual(
    owner,
    releaseId,
    {
      template: "announcement",
      format: "wide",
      eyebrow: "",
      headline: "Frame",
      subline: "",
      items: [],
      mediaId: null,
      theme: "dark",
    },
  );
  compose.mockResolvedValue({
    bytes: Buffer.from("mp4-bytes"),
    durationMs: 9_000,
  });
  const input = {
    name: "Launch film",
    format: "wide" as const,
    clips: [{ mediaId: screenshot.id, seconds: 4, caption: "Plan it" }],
    intro: { enabled: true, headline: "machdoch 44", subline: "", seconds: 2 },
    outro: {
      enabled: true,
      headline: "Try it",
      subline: "machdoch.app",
      seconds: 3,
    },
  };
  await runtime.releases.studio.queueVideo(
    owner,
    randomUUID(),
    releaseId,
    input,
  );
  await runtime.releases.dispatcher.tick();
  expect(compose).toHaveBeenCalledTimes(1);
  expect(compose.mock.calls[0]![2].get(screenshot.id)).toMatchObject({
    kind: "image",
    mime: "image/png",
  });
  const media = await runtime.releases.media.list(owner, {
    productId,
    releaseId,
  });
  expect(media[0]).toMatchObject({
    kind: "video",
    role: "video",
    source: "composition",
    durationMs: 9_000,
    recipe: input,
  });
  expect(
    (await runtime.releases.releases.get(owner, releaseId)).jobs[0],
  ).toMatchObject({
    kind: "video",
    state: "succeeded",
    detail: "Rendered Launch film · 9 s",
  });
});
