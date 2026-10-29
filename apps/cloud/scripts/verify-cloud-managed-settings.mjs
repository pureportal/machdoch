import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import axe from "axe-core";
import {
  assertEventually as eventually,
  cloudBrowserFixture,
} from "./cloud-browser-fixture.mjs";
import { createSecret } from "../src/server/crypto.ts";
import {
  createFleetManagedSettingsEtag,
  fleetManagedSettingsDeliverySchema,
  gatewayProtocolVersion,
} from "@machdoch/fleet-protocol";

const directory = resolve("../../.tmp/cloud-design/managed-settings");
await mkdir(directory, { recursive: true });
const fixture = await cloudBrowserFixture();
const { ownerContext: context, origin } = fixture;
const page = await context.newPage();
page.setDefaultTimeout(15000);
const errors = [];
const captures = [];
const accessibility = [];
const checks = [];
page.on("pageerror", (error) =>
  errors.push({ url: page.url(), message: error.message }),
);
page.on("console", (message) => {
  if (message.type() === "error")
    errors.push({ url: page.url(), message: message.text() });
});

const csrf = async () =>
  (await context.cookies()).find(
    (cookie) => cookie.name === "__Host-machdoch_cloud_csrf",
  )?.value ?? "";
async function api(path, method = "GET", data) {
  const response = await context.request.fetch(`${origin}/api${path}`, {
    method,
    ...(method === "GET"
      ? {}
      : { headers: { Origin: origin, "X-Machdoch-Cloud-CSRF": await csrf() } }),
    ...(data === undefined ? {} : { data }),
  });
  assert.ok(
    response.ok(),
    `${method} ${path}: ${response.status()} ${await response.text()}`,
  );
  return response.status() === 204 ? null : response.json();
}

async function enroll(displayName) {
  const grant = await api("/enrollment-keys", "POST");
  const secret = createSecret("mch_instance");
  const response = await context.request.post(`${origin}/api/enroll`, {
    headers: { Authorization: `Bearer ${grant.enrollmentKey}` },
    data: {
      instanceSecret: secret,
      displayName,
      productVersion: "37.2.0",
      protocolVersion: gatewayProtocolVersion,
    },
  });
  assert.ok(response.ok(), await response.text());
  const { instanceId } = await response.json();
  const call = async (path, method = "GET", data, headers = {}) =>
    context.request.fetch(
      `${origin}/api/client/settings/${instanceId}${path}`,
      {
        method,
        headers: { Authorization: `Bearer ${secret}`, ...headers },
        ...(data === undefined ? {} : { data }),
      },
    );
  return { instanceId, displayName, call };
}

function passed(name) {
  checks.push(name);
  process.stdout.write(`PASS ${name}\n`);
}

async function capture(name) {
  await page.evaluate(() => document.fonts.ready);
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
    `${name}: horizontal overflow`,
  );
  await page.screenshot({ path: join(directory, `${name}.png`), fullPage: true });
  await page.evaluate(axe.source);
  const violations = await page.evaluate(async () =>
    (
      await window.axe.run(document, {
        runOnly: ["color-contrast", "button-name", "label", "aria-allowed-role"],
      })
    ).violations.map((item) => ({
      id: item.id,
      nodes: item.nodes.map((node) => ({
        target: node.target,
        summary: node.failureSummary,
      })),
    })),
  );
  if (violations.length) accessibility.push({ name, violations });
  captures.push(name);
  process.stdout.write(`CAPTURE ${name}\n`);
}

const uuid = (suffix) => `123e4567-e89b-42d3-a456-4266141740${suffix}`;
const emptyDefaults = {
  provider: null,
  model: null,
  mode: null,
  reasoning: null,
  webSearchProvider: null,
  theme: null,
  density: null,
  accent: null,
};
const github = {
  id: "github",
  title: "GitHub",
  enabled: true,
  transport: {
    type: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    env: { GITHUB_TOKEN: "{{secret:mcp_github_github_token}}" },
  },
};
const workstationSnapshot = {
  defaults: {
    ...emptyDefaults,
    provider: "openai",
    model: "gpt-5.6",
    mode: "machdoch",
    theme: "dark",
  },
  agentLimits: { infinite: null, executorTurns: 40, autopilotExecutorIterations: null },
  instructions: [
    {
      id: uuid("01"),
      name: "Code style",
      body: "Use tabs.\nPrefer small functions.\nWrite tests first.",
      enabled: true,
      global: true,
      tags: [],
    },
    {
      id: uuid("02"),
      name: "Security",
      body: "Never log secrets.",
      enabled: true,
      global: true,
      tags: [],
    },
  ],
  contextPacks: [],
  prompts: [
    {
      id: uuid("03"),
      relativePath: "review.prompt.md",
      content: "Review this change.",
    },
  ],
  mcpServers: [github],
};
const laptopSnapshot = {
  ...structuredClone(workstationSnapshot),
  defaults: { ...workstationSnapshot.defaults, theme: "light" },
  instructions: [
    {
      id: uuid("11"),
      name: "Code style",
      body: "Use spaces.\nPrefer small functions.\nWrite tests first.",
      enabled: true,
      global: true,
      tags: [],
    },
    {
      id: uuid("12"),
      name: "security",
      body: "Never log secrets.",
      enabled: true,
      global: true,
      tags: [],
    },
  ],
  prompts: [
    {
      id: uuid("13"),
      relativePath: "review.prompt.md",
      content: "Review this change.",
    },
  ],
};

try {
  const workstation = await enroll("Workstation");
  const laptop = await enroll("Laptop");

  for (const [device, snapshot] of [
    [workstation, workstationSnapshot],
    [laptop, laptopSnapshot],
  ]) {
    const status = await (await device.call("/snapshot")).json();
    assert.deepEqual(status, { requested: true, capturedAt: null });
    const upload = await device.call("/snapshot", "PUT", snapshot);
    assert.equal(upload.status(), 204, await upload.text());
    const after = await (await device.call("/snapshot")).json();
    assert.equal(after.requested, false);
    assert.equal(typeof after.capturedAt, "number");
  }
  passed("devices upload snapshots through the snapshot endpoint");

  // UI flows are appended below once the dashboard names are known.
  await import("./verify-cloud-managed-settings-ui.mjs").then((module) =>
    module.run({
      api,
      capture,
      checks,
      createFleetManagedSettingsEtag,
      eventually,
      fixture,
      fleetManagedSettingsDeliverySchema,
      laptop,
      page,
      passed,
      workstation,
    }),
  );

  assert.deepEqual(errors, [], JSON.stringify(errors, null, 2));
  passed("no page errors");
} finally {
  await writeFile(
    join(directory, "results.json"),
    JSON.stringify({ checks, captures, accessibility, errors }, null, 2),
  );
  await fixture.close();
}
if (accessibility.length) {
  process.stdout.write(
    `ACCESSIBILITY ${JSON.stringify(accessibility, null, 2)}\n`,
  );
  process.exitCode = 1;
}
