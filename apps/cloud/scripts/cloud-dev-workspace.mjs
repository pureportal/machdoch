import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { chromium } from "playwright-core";
import { assertEventually } from "./cloud-browser-fixture.mjs";
import {
  seedCloudCollaboration,
  seedCloudDesign,
} from "./cloud-design-fixture.mjs";
import { startGitFixture } from "./cloud-git-fixture.mjs";
import { completeSecondFactor } from "./cloud-two-factor-fixture.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const databaseUrl = process.env.MACHDOCH_CLOUD_DATABASE_URL;
assert.ok(databaseUrl, "Set MACHDOCH_CLOUD_DATABASE_URL to an empty database.");
const port = Number(process.env.PORT ?? 4310);
const origin = `http://localhost:${port}`;
const output = resolve(root, "../../.tmp/cloud-dev-workspace");

const git = await startGitFixture();
const server = spawn(
  process.execPath,
  ["--import", "@oxc-node/core/register", "src/server.ts", "dev"],
  {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      MACHDOCH_CLOUD_LISTEN_ADDRESS: "127.0.0.1",
    },
    stdio: "inherit",
    windowsHide: true,
  },
);
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ??
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true,
});
const database = new pg.Pool({ connectionString: databaseUrl, max: 3 });
const stop = async () => {
  server.kill();
  await browser.close();
  await git.close();
  await database.end();
};
process.once("SIGINT", () => void stop().then(() => process.exit(0)));
const ownerContext = await browser.newContext();
const fixture = { origin, database, ownerContext };
await assertEventually(
  async () => (await ownerContext.request.get(`${origin}/healthz`)).ok(),
  () => "The Cloud server did not start.",
  240_000,
);
const password = randomBytes(18).toString("base64url");
const setup = await ownerContext.request.post(`${origin}/api/v1/auth/setup`, {
  headers: { Origin: origin },
  data: {
    organization: "Northstar Studio",
    name: "Alex Morgan",
    email: "owner@example.test",
    password,
  },
});
assert.equal(setup.status(), 201, await setup.text());
await completeSecondFactor(fixture, ownerContext);
const seeded = await seedCloudDesign(fixture);
await seedCloudCollaboration(fixture, seeded, { gitApiUrl: git.apiUrl });
await mkdir(output, { recursive: true });
await writeFile(
  join(output, "session.json"),
  JSON.stringify(
    {
      origin,
      email: "owner@example.test",
      password,
      cookies: await ownerContext.cookies(),
    },
    null,
    2,
  ),
);
process.stdout.write(`Cloud workspace ready at ${origin}\n`);
