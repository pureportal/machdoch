import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import type {
  CloudCliLogin,
  CloudCliProvider,
} from "@machdoch/fleet-protocol/cloud-providers";
import type { CloudActor, CloudRole } from "../../../lib/cloud-contract";
import { SettingsCipher } from "../../settings-crypto";
import { createCloudRuntime, type CloudRuntime } from "../runtime";
import { createTestCloudDatabase } from "../test-database";
import {
  CloudCliLogins,
  loginFailureMessage,
  parseLoginPrompt,
  parseLoginStatus,
} from "./cli-login";

const fixtures: Record<CloudCliProvider, string> = {
  "claude-code-cli": `import { existsSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    import { createInterface } from "node:readline";
    const args = process.argv.slice(2);
    const marker = join(process.env.CLAUDE_CONFIG_DIR, ".credentials.json");
    if (args[1] === "status") {
      const signedIn = existsSync(marker);
      console.log(JSON.stringify({ loggedIn: signedIn, email: signedIn ? "dev@example.test" : null }));
      process.exit(signedIn ? 0 : 1);
    }
    console.log("Opening browser to sign in…");
    console.log("If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&state=abc");
    process.stdout.write("Paste code here if prompted > ");
    createInterface({ input: process.stdin }).once("line", (code) => {
      if (code.trim() !== "good-code") {
        console.error("OAuth error: Invalid code");
        process.exit(1);
      }
      writeFileSync(marker, "{}");
      process.exit(0);
    });`,
  "codex-cli": `import { existsSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    const args = process.argv.slice(2);
    const auth = join(process.env.CODEX_HOME, "auth.json");
    if (!args.includes('cli_auth_credentials_store="file"')) process.exit(3);
    if (args[1] === "status") {
      console.error(existsSync(auth) ? "Logged in using ChatGPT" : "Not logged in");
      process.exit(existsSync(auth) ? 0 : 1);
    }
    console.log("1. Open this link in your browser and sign in to your account\\n   https://auth.openai.com/codex/device\\n\\n2. Enter this one-time code (expires in 15 minutes)\\n   CU4S-9YSKA");
    setTimeout(() => {
      writeFileSync(auth, "{}");
      process.exit(0);
    }, 300);`,
  "copilot-cli": `import { writeFileSync } from "node:fs";
    import { join } from "node:path";
    console.log("To authenticate, visit https://github.com/login/device and enter code 1EDB-F922");
    console.log("Waiting for authorization...");
    setTimeout(() => {
      writeFileSync(join(process.env.COPILOT_HOME, "config.json"), "// This file is managed automatically.\\n" + JSON.stringify({ lastLoggedInUser: { host: "https://github.com", login: "octocat" } }));
      process.exit(0);
    }, 300);`,
};

let database: Awaited<ReturnType<typeof createTestCloudDatabase>>;
let runtime: CloudRuntime;
let directory: string;
let logins: CloudCliLogins;
let owner: CloudActor;
let member: CloudActor;
const providers: Partial<Record<CloudCliProvider | "openai", string>> = {};

async function eventually(
  read: () => Promise<CloudCliLogin>,
  done: (login: CloudCliLogin) => boolean,
): Promise<CloudCliLogin> {
  const deadline = Date.now() + 10_000;
  let login = await read();
  while (!done(login) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    login = await read();
  }
  return login;
}

beforeAll(async () => {
  database = await createTestCloudDatabase();
  runtime = createCloudRuntime(database, "https://cloud.example.test", {
    credentialsCipher: new SettingsCipher(randomBytes(32)),
  });
  directory = await mkdtemp(join(tmpdir(), "cli-login-test-"));
  process.env.MACHDOCH_CLOUD_CLI_HOME = join(directory, "homes");
  for (const [provider, source] of Object.entries(fixtures))
    await writeFile(join(directory, `${provider}.mjs`), source);
}, 30_000);
afterAll(async () => {
  delete process.env.MACHDOCH_CLOUD_CLI_HOME;
  await database?.close();
  await rm(directory, { recursive: true, force: true, maxRetries: 3 });
});
beforeEach(async () => {
  await database.engine.exec(
    "TRUNCATE cloud_organizations,cloud_users CASCADE; TRUNCATE cloud_credential_key_checks",
  );
  const organizationId = randomUUID();
  await database.engine.query(
    "INSERT INTO cloud_organizations (id,name) VALUES ($1,'Organization')",
    [organizationId],
  );
  async function add(role: CloudRole) {
    const userId = randomUUID();
    await database.engine.query(
      "INSERT INTO cloud_users (id,email,name,password_hash) VALUES ($1,$2,$3,'test')",
      [userId, `${role}@example.test`, role],
    );
    await database.engine.query(
      "INSERT INTO cloud_memberships (organization_id,user_id,role) VALUES ($1,$2,$3)",
      [organizationId, userId, role],
    );
    return { organizationId, userId };
  }
  owner = await add("owner");
  member = await add("member");
  for (const provider of [
    "claude-code-cli",
    "codex-cli",
    "copilot-cli",
    "openai",
  ] as const)
    providers[provider] = (
      await runtime.aiProviders.create(owner, randomUUID(), {
        name: provider,
        provider,
        region: null,
        models: ["model-1"],
        maxOutputTokens: 4096,
        dailyTokenBudget: 200000,
        maxConcurrentRequests: 4,
        apiKey: provider === "openai" ? "sk-test" : "",
      })
    ).id;
  logins = new CloudCliLogins(runtime.aiProviders, (provider) => ({
    file: process.execPath,
    prefixArgs: [join(directory, `${provider}.mjs`)],
  }));
});
afterEach(() => logins.close());

describe("CLI sign-in", { timeout: 20_000 }, () => {
  it("relays a pasted Claude code and reports a failed attempt", async () => {
    const id = providers["claude-code-cli"]!;
    expect((await logins.get(owner, id)).state).toBe("signed-out");
    const started = await logins.start(owner, id);
    expect(started).toMatchObject({
      state: "waiting",
      url: "https://claude.com/cai/oauth/authorize?code=true&state=abc",
      code: null,
      acceptsCode: true,
    });
    expect(await logins.submitCode(owner, id, "wrong-code")).toMatchObject({
      state: "failed",
      message: "OAuth error: Invalid code",
    });
    await expect(
      logins.submitCode(owner, id, "good-code"),
    ).rejects.toMatchObject({ status: 409 });
    await logins.start(owner, id);
    expect(await logins.submitCode(owner, id, "good-code")).toMatchObject({
      state: "signed-in",
      account: "dev@example.test",
    });
    expect((await logins.get(owner, id)).state).toBe("signed-in");
  });

  it("shows device codes for Codex and Copilot and detects the finished sign-in", async () => {
    for (const [provider, expected] of [
      [
        "codex-cli",
        {
          url: "https://auth.openai.com/codex/device",
          code: "CU4S-9YSKA",
          account: "ChatGPT",
        },
      ],
      [
        "copilot-cli",
        {
          url: "https://github.com/login/device",
          code: "1EDB-F922",
          account: "octocat",
        },
      ],
    ] as const) {
      const id = providers[provider]!;
      expect(await logins.start(owner, id)).toMatchObject({
        state: "waiting",
        url: expected.url,
        code: expected.code,
        acceptsCode: false,
      });
      expect(
        await eventually(
          () => logins.get(owner, id),
          (login) => login.state !== "waiting",
        ),
      ).toMatchObject({ state: "signed-in", account: expected.account });
    }
  });

  it("is limited to administrators and CLI providers", async () => {
    await expect(
      logins.start(member, providers["claude-code-cli"]!),
    ).rejects.toMatchObject({ status: 403 });
    await expect(logins.get(owner, providers.openai!)).rejects.toMatchObject({
      status: 404,
    });
  });

  it("cancels a pending sign-in and reports a missing CLI", async () => {
    const id = providers["claude-code-cli"]!;
    await logins.start(owner, id);
    expect((await logins.cancel(owner, id)).state).toBe("signed-out");
    const missing = new CloudCliLogins(runtime.aiProviders, () => ({
      file: join(directory, "missing-cli"),
      prefixArgs: [],
    }));
    expect(await missing.start(owner, id)).toMatchObject({
      state: "failed",
      message: "The CLI is not installed on the cloud host.",
    });
  });
});

describe("CLI sign-in output", () => {
  it("reads the prompts printed by the real CLIs", () => {
    expect(
      parseLoginPrompt(
        "claude-code-cli",
        "Opening browser to sign in…\nIf the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&state=qjUB\nPaste code here if prompted > ",
      ),
    ).toEqual({
      url: "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&state=qjUB",
      code: null,
      acceptsCode: true,
    });
    expect(
      parseLoginPrompt(
        "codex-cli",
        "\u001b[1mWelcome to Codex\u001b[0m\n   https://auth.openai.com/codex/device\n\n2. Enter this one-time code (expires in 15 minutes)\n   \u001b[94mCU4S-9YSKA\u001b[0m\n",
      ),
    ).toEqual({
      url: "https://auth.openai.com/codex/device",
      code: "CU4S-9YSKA",
      acceptsCode: false,
    });
    expect(
      loginFailureMessage(
        "Waiting…\r\n\u001b[31mError: access denied\u001b[0m\n",
      ),
    ).toBe("Error: access denied");
  });

  it("reads the signed-in account from each status format", () => {
    expect(
      parseLoginStatus(
        "claude-code-cli",
        0,
        JSON.stringify({
          loggedIn: true,
          email: null,
          subscriptionType: "max",
        }),
      ),
    ).toEqual({ signedIn: true, account: "Claude max" });
    expect(
      parseLoginStatus("claude-code-cli", 1, '{"loggedIn":false}'),
    ).toEqual({ signedIn: false, account: null });
    expect(parseLoginStatus("codex-cli", 1, "Not logged in")).toEqual({
      signedIn: false,
      account: null,
    });
    expect(parseLoginStatus("copilot-cli", 0, "")).toEqual({
      signedIn: false,
      account: null,
    });
  });
});
