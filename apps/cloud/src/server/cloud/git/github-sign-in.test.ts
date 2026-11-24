import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import type { CloudActor } from "../../../lib/cloud-contract";
import { SettingsCipher } from "../../settings-crypto";
import { createCloudRuntime, type CloudRuntime } from "../runtime";
import { createTestCloudDatabase } from "../test-database";
import { CloudGitHubSignIn } from "./github-sign-in";

const token = `gho_${"a".repeat(36)}`;
let database: Awaited<ReturnType<typeof createTestCloudDatabase>>;
let runtime: CloudRuntime;
let owner: CloudActor;
let directory: string;
let authorizations: string[];

beforeAll(async () => {
  database = await createTestCloudDatabase();
  directory = await mkdtemp(join(tmpdir(), "machdoch-gh-"));
  await writeFile(
    join(directory, "gh.mjs"),
    `import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const store = join(process.env.GH_CONFIG_DIR, "token");
appendFileSync(${JSON.stringify(join(directory, "calls"))}, JSON.stringify(args) + "\\n");
if (args[1] === "login") {
  process.stderr.write("! One-time code (AB12-CD34) copied to clipboard\\nOpen this URL to continue in your web browser: https://github.com/login/device\\n");
  setTimeout(() => writeFileSync(store, ${JSON.stringify(token)}), 300);
} else process.stdout.write(readFileSync(store, "utf8") + "\\n");
`,
  );
}, 30_000);
afterAll(async () => {
  await database?.close();
  await rm(directory, { recursive: true, force: true });
});
beforeEach(async () => {
  authorizations = [];
  runtime = createCloudRuntime(database, "https://cloud.example.test", {
    credentialsCipher: new SettingsCipher(randomBytes(32)),
    gitFetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      authorizations.push(
        new Headers(init?.headers).get("authorization") ?? "",
      );
      return Response.json({ login: "octocat" });
    }) as typeof fetch,
  });
  await database.engine.exec(
    "TRUNCATE cloud_organizations,cloud_users CASCADE",
  );
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
});

async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Timed out");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

it("connects GitHub with a device code instead of a pasted token", async () => {
  const signIn = new CloudGitHubSignIn(
    database,
    runtime.git.connections,
    runtime.git.accounts,
    { file: process.execPath, prefixArgs: [join(directory, "gh.mjs")] },
  );
  expect(await signIn.start(owner, "connection")).toMatchObject({
    state: "waiting",
    url: "https://github.com/login/device",
    code: "AB12-CD34",
  });
  await until(
    async () => (await signIn.get(owner, "connection")).state !== "waiting",
  );
  expect(await signIn.get(owner, "connection")).toMatchObject({
    state: "signed-in",
    account: "octocat",
  });
  const [connection] = (await runtime.git.connections.get(owner)).connections;
  expect(connection).toMatchObject({
    account: "octocat",
    apiUrl: "https://api.github.com",
    automate: true,
  });
  expect(authorizations).toContain(`Bearer ${token}`);
  const [login] = (await readFile(join(directory, "calls"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[]);
  expect(login).toEqual(
    expect.arrayContaining(["--web", "--scopes", "admin:repo_hook,workflow"]),
  );
  await Promise.all([signIn.close(), signIn.close()]);
});

it("cancels sign-in before storing a GitHub connection", async () => {
  const signIn = new CloudGitHubSignIn(
    database,
    runtime.git.connections,
    runtime.git.accounts,
    { file: process.execPath, prefixArgs: [join(directory, "gh.mjs")] },
  );
  expect(await signIn.start(owner, "connection")).toMatchObject({
    state: "waiting",
  });
  expect(await signIn.cancel(owner, "connection")).toMatchObject({
    state: "signed-out",
  });
  expect((await runtime.git.connections.get(owner)).connections).toEqual([]);
  await signIn.close();
});
