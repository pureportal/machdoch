import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright-core";
import { createTestCloudDatabase } from "../src/server/cloud/test-database.ts";
import { FleetDatabase } from "../src/server/database.ts";
import { initializeInstallation } from "../src/server/cloud/installation-storage.ts";
import { cloudCredentialsCipher } from "../src/server/cloud/credential-storage.ts";
import {
  createCloudRuntime,
  getCloudRuntime,
  initializeCloudRuntime,
} from "../src/server/cloud/runtime.ts";
import { pushCandidate } from "../src/server/cloud/execution/candidate-push.ts";
import { completeSecondFactor } from "./cloud-two-factor-fixture.mjs";
import { cloudApi } from "./cloud-browser-fixture.mjs";
import { startLocalGitHub } from "./local-github.ts";

const { values } = parseArgs({
  options: {
    model: { type: "string", default: "sonnet" },
    "claude-config": { type: "string", default: join(homedir(), ".claude") },
    port: { type: "string", default: "4329" },
  },
});
const model = values.model!;
const port = Number(values.port);
const origin = `http://localhost:${port}`;
const workspaceRoot = resolve(import.meta.dirname, "../../..");
const output = join(workspaceRoot, ".tmp/cloud-journey-verification");
const landing = "machdoch/landing";
const recurrence = "machdoch/recurrence";
const docsUrl = "https://github.com/pureportal/machdoch#readme";

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
const hub = await startLocalGitHub({
  directory: join(output, "github"),
  tokens: {
    ghp_machdoch_local_organization_token: "machdoch-bot",
    ghp_machdoch_local_contributor_token: "alex-morgan",
  },
  repositories: [
    { fullName: landing, source: workspaceRoot, sourcePath: "apps/landing" },
    {
      fullName: recurrence,
      source: workspaceRoot,
      sourcePath: "packages/recurrence",
    },
  ],
});
const database = await createTestCloudDatabase();
await new FleetDatabase(database).initialize();
const installation = await initializeInstallation(database);
await initializeCloudRuntime(async () =>
  createCloudRuntime(database, origin, {
    credentialsCipher: cloudCredentialsCipher(installation.credentials_key),
    repositoryFetch: (input, init) => fetch(hub.rewrite(String(input)), init),
    candidatePush: (input) =>
      pushCandidate({
        ...input,
        remote: hub.barePath(
          new URL(input.remote).pathname.replace(/^\/|\.git$/gu, ""),
        ),
        allowFileRemote: true,
      }),
  }),
);
process.argv = [process.argv[0]!, "src/server.ts", "dev"];
Object.assign(process.env, {
  PORT: String(port),
  MACHDOCH_CLOUD_LISTEN_ADDRESS: "127.0.0.1",
});
await import("../src/server.ts");

const browser = await chromium.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true,
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
});
const fixture = {
  origin,
  ownerContext: context,
  database: {
    query: (text: string, parameters?: unknown[]) =>
      database.engine.query(text, parameters),
  },
};
const pending = new Map<number, { path: string; since: number }>();
let requestSequence = 0;
let currentStep = "setup";
async function api(path: string, method = "GET", data?: unknown) {
  const id = ++requestSequence;
  pending.set(id, { path: `${method} ${path}`, since: Date.now() });
  try {
    return await cloudApi(fixture, context, path, method, data);
  } finally {
    pending.delete(id);
  }
}
const watchdog = setInterval(() => {
  const slow = [...pending.values()]
    .filter((entry) => Date.now() - entry.since > 20_000)
    .map(
      (entry) =>
        `${entry.path} (${Math.round((Date.now() - entry.since) / 1000)}s)`,
    );
  log(
    `… ${currentStep}${slow.length ? `; waiting on ${slow.join(", ")}` : ""}`,
  );
}, 60_000);
watchdog.unref();
function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} did not answer`)), 15_000),
    ),
  ]);
}
const page = await context.newPage();
page.setDefaultTimeout(60_000);
page.setDefaultNavigationTimeout(300_000);
const pageErrors: string[] = [];
page.on("pageerror", (error) => pageErrors.push(error.message));
const passed: string[] = [];
const cliHomes = new Set<string>();
const runnerIds = new Set<string>();

function log(message: string) {
  process.stdout.write(
    `[${new Date().toISOString().slice(11, 19)}] ${message}\n`,
  );
}

async function step(name: string, body: () => Promise<void>) {
  currentStep = name;
  log(`▶ ${name}`);
  await body();
  passed.push(name);
  await page.screenshot({
    path: join(
      output,
      `${String(passed.length).padStart(2, "0")}-${name.replace(/[^a-z0-9]+/giu, "-").toLowerCase()}.png`,
    ),
    fullPage: true,
  });
  log(`✓ ${name}`);
}

class FatalCheck extends Error {}

async function eventually<T>(
  label: string,
  check: () => Promise<T | null | undefined | false>,
  timeout: number,
  options: { sync?: boolean } = {},
): Promise<T> {
  const deadline = Date.now() + timeout;
  let lastSync = 0;
  let cause: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      if (error instanceof FatalCheck) throw error;
      cause = error;
    }
    if (options.sync && Date.now() - lastSync > 15_000) {
      lastSync = Date.now();
      await api("git/github/sync", "POST", {}).catch(() => undefined);
    }
    await new Promise((done) => setTimeout(done, 2_000));
  }
  throw new Error(`Timed out: ${label}`, { cause });
}

function automationTracer(prefix: string) {
  const seen = new Set<string>();
  return async () => {
    const queries = [
      "SELECT COALESCE(event->'git'->>'kind',event->>'kind') AS pending FROM cloud_automation_events ORDER BY sequence",
      "SELECT a.name,r.state,r.error FROM cloud_automation_runs r JOIN cloud_automations a ON a.organization_id=r.organization_id AND a.id=r.automation_id ORDER BY r.created_at",
      "SELECT id,state,stop_message,left(summary,400) AS summary FROM cloud_runs ORDER BY created_at",
      "SELECT run_id,purpose,state,error_code FROM cloud_inference_calls WHERE error_code IS NOT NULL ORDER BY created_at",
    ];
    for (const query of queries)
      for (const row of (await database.engine.query(query)).rows) {
        const line = JSON.stringify(row);
        if (seen.has(line)) continue;
        seen.add(line);
        log(`  ${prefix}: ${line.slice(0, 600)}`);
      }
  };
}

let lastProgress = "";
async function chat(message: string) {
  const composer = page.getByLabel("Message", { exact: true });
  await composer.fill(message);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.waitForURL(/\/cloud\/chat\/[a-f0-9-]+$/u);
  const chatId = new URL(page.url()).pathname.split("/").at(-1)!;
  return eventually(
    `the agent answers “${message.slice(0, 40)}”`,
    async () => {
      const detail = await api(`chats/${chatId}`);
      const turn = detail.turns.at(-1);
      const progress = `${turn.state} · ${turn.steps.map((entry: { label: string }) => entry.label).join(" → ")}`;
      if (progress !== lastProgress)
        log(`  agent: ${(lastProgress = progress)}`);
      if (turn.state === "failed") throw new Error(JSON.stringify(turn));
      return turn.state === "complete" ? turn : null;
    },
    600_000,
  );
}

async function decide(kind: string, verb: string) {
  const chatId = new URL(page.url()).pathname.split("/").at(-1)!;
  const turn = (await api(`chats/${chatId}`)).turns.at(-1);
  const action = turn.actions.find(
    (entry: { kind: string }) => entry.kind === kind,
  );
  assert.ok(
    action,
    `The agent proposed ${kind}: ${JSON.stringify(turn.actions.map((entry: { kind: string }) => entry.kind))} ${turn.answer}`,
  );
  const card = page
    .locator(".cloud-agent-action")
    .filter({
      has: page.getByRole("heading", { name: action.title, exact: true }),
    })
    .last();
  await card.getByRole("button", { name: verb, exact: true }).click();
  const applied = await eventually(
    `the ${kind} proposal is applied`,
    async () => {
      const current = (await api(`chats/${chatId}`)).turns
        .at(-1)
        .actions.find((entry: { id: string }) => entry.id === action.id);
      if (current.state === "failed") throw new Error(current.error);
      return current.state === "applied" ? current : null;
    },
    120_000,
  );
  return applied.result as { id: string; label: string };
}

async function chooseTemplate(name: string) {
  await page.goto(`${origin}/cloud/automations`);
  const newAutomation = page.getByRole("button", { name: "New automation" });
  if (await newAutomation.isVisible().catch(() => false))
    await newAutomation.click();
  await page
    .getByRole("button", { name: new RegExp(`^${name}`, "u") })
    .first()
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Create automation" }).click();
  await dialog.waitFor({ state: "hidden" });
  await page
    .getByRole("list", { name: "Automations" })
    .getByText(name)
    .first()
    .waitFor();
}

async function setUpRepository(
  fullName: string,
  checks: { name: string; command: string }[],
) {
  await page.goto(`${origin}/cloud/execution`);
  await page.getByRole("button", { name: "Set up a project" }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog
    .locator(".cloud-select", { has: page.locator("#profile-repository") })
    .locator(".cloud-select-trigger")
    .click();
  await page
    .locator(".cloud-select-menu")
    .getByRole("option", { name: fullName })
    .click();
  await dialog.getByText("More options").click();
  await dialog
    .locator(".cloud-select", { has: page.locator("#profile-tokens") })
    .locator(".cloud-select-trigger")
    .click();
  await page
    .locator(".cloud-select-menu")
    .getByRole("option", { name: "3,000,000 tokens" })
    .click();
  for (const [index, check] of checks.entries()) {
    await dialog.getByRole("button", { name: "Add check" }).click();
    await dialog.getByLabel(`Check name ${index + 1}`).fill(check.name);
    await dialog.getByLabel(`Check command ${index + 1}`).fill(check.command);
  }
  await dialog.getByRole("button", { name: "Set up", exact: true }).click();
  await page.getByRole("heading", { name: fullName }).waitFor();
}

async function pullRequest(fullName: string, number: number) {
  return hub.pulls(fullName).find((entry) => entry.number === number);
}

try {
  await eventually(
    "the Cloud server starts",
    async () => (await context.request.get(`${origin}/healthz`)).ok(),
    300_000,
  );
  const setup = await context.request.post(`${origin}/api/v1/auth/setup`, {
    headers: { Origin: origin },
    data: {
      organization: "Machdoch",
      name: "Andreas Ehrhardt",
      email: "owner@example.test",
      password: randomUUID(),
    },
  });
  assert.equal(setup.status(), 201, await setup.text());
  await completeSecondFactor(fixture, context);
  const workspace = await api("workspace");
  const organizationId = workspace.organization.id as string;
  const team = await api("teams", "POST", {
    name: "Engineering",
    key: "ENG",
    visibility: "organization",
    estimateScale: [1, 2, 3, 5].map((points) => ({
      label: String(points),
      points,
    })),
  });
  const project = await api("projects", "POST", {
    teamId: team.id,
    name: "Machdoch website",
    description:
      "The public landing page and the recurrence library it documents.",
    status: "active",
  });
  const provider = await api("ai-providers", "POST", {
    name: "Claude Code",
    provider: "claude-code-cli",
    region: null,
    models: [model],
    apiKey: "",
    maxOutputTokens: 8192,
    dailyTokenBudget: 4_000_000,
    maxConcurrentRequests: 2,
  });
  const home = join(
    homedir(),
    ".machdoch-cloud",
    "cli",
    organizationId,
    provider.id,
  );
  cliHomes.add(join(homedir(), ".machdoch-cloud", "cli", organizationId));
  await mkdir(home, { recursive: true, mode: 0o700 });
  await copyFile(
    join(values["claude-config"]!, ".credentials.json"),
    join(home, ".credentials.json"),
  );
  assert.equal(
    (await api(`ai-providers/${provider.id}/login`)).state,
    "signed-in",
  );

  await step("Connect the local GitHub", async () => {
    await page.goto(`${origin}/cloud/settings?tab=git`);
    await page.getByRole("button", { name: "Connect GitHub" }).click();
    const dialog = page.getByRole("dialog");
    await dialog
      .getByLabel("Access token")
      .fill("ghp_machdoch_local_organization_token");
    await dialog.getByText("Self-hosted GitHub").click();
    await dialog.getByLabel("API address").fill(hub.apiUrl);
    await dialog.getByRole("button", { name: "Save connection" }).click();
    await dialog.waitFor({ state: "hidden" });
    for (const fullName of [landing, recurrence]) {
      await page.getByRole("button", { name: "Add repository" }).click();
      const picker = page.getByRole("dialog");
      await picker.getByLabel("Repository").selectOption(fullName);
      await picker.getByRole("button", { name: "Add repository" }).click();
      await picker.waitFor({ state: "hidden" });
      await page.getByText(fullName).first().waitFor();
    }
  });

  await step("Set up two repositories for one project", async () => {
    await setUpRepository(landing, [
      { name: "Docs link", command: `grep -q "${docsUrl}" index.html` },
    ]);
    await setUpRepository(recurrence, []);
    const profiles = (await api(`execution-profiles?projectId=${project.id}`))
      .profiles;
    assert.equal(profiles.length, 2);
  });
  const profiles = (await api(`execution-profiles?projectId=${project.id}`))
    .profiles as { id: string; repository: string }[];
  const landingProfile = profiles.find((profile) =>
    profile.repository.endsWith(landing),
  )!;

  await step("Run AI tasks on this server", async () => {
    await page.goto(`${origin}/cloud/execution`);
    await page
      .locator(".cloud-setup-card", {
        has: page.getByRole("heading", { name: landing }),
      })
      .getByRole("button", { name: "Runners" })
      .click();
    await page.getByText("This server · Running").waitFor({ timeout: 120_000 });
    for (const worker of (
      await api(`execution-workers?profileId=${landingProfile.id}`)
    ).workers)
      runnerIds.add(worker.id);
  });

  await step("Connect pull request review automations", async () => {
    await chooseTemplate("Review new pull requests");
    await chooseTemplate("Address requested changes with an AI task");
  });

  await page.goto(`${origin}/cloud/chat`);
  let issue: {
    id: string;
    identifier: string;
    revision: number;
    title: string;
    description: string;
    acceptanceCriteria: string;
  };
  await step("Ask the agent to create a ticket", async () => {
    await chat(
      `Create an ENG issue in the "Machdoch website" project: the landing page (repository ${landing}, file index.html) needs a "Documentation" link to ${docsUrl} in both the primary navigation and the footer navigation. Keep the existing links.`,
    );
    const created = await decide("create_issue", "Create issue");
    issue = await api(`issues/${created.id}`);
    assert.match(issue.title, /documentation/iu);
  });

  await step("Ask the agent to change the ticket", async () => {
    await chat(
      `Change ${issue.identifier}: the link text should be "Docs" instead of "Documentation", and add acceptance criteria that the change is verified with a Playwright browser test that opens the page (serve it with python3 -m http.server) and checks both navigation areas show the Docs link.`,
    );
    await decide("update_issue", "Apply changes");
    const updated = await api(`issues/${issue.id}`);
    assert.ok(updated.revision > issue.revision);
    assert.match(
      `${updated.description}\n${updated.acceptanceCriteria}`,
      /playwright/iu,
    );
    issue = updated;
  });

  let runId = "";
  await step("Ask the agent to create a pull request", async () => {
    const turn = await chat(`Create a pull request for ${issue.identifier}.`);
    if (turn.question) {
      await page
        .locator(".cloud-agent-question button", { hasText: landing })
        .first()
        .click();
      await eventually(
        "the agent proposes the task",
        async () => {
          const chatId = new URL(page.url()).pathname.split("/").at(-1)!;
          const turns = (await api(`chats/${chatId}`)).turns;
          return (
            turns.at(-1).id !== turn.id && turns.at(-1).state === "complete"
          );
        },
        600_000,
      );
    }
    runId = (await decide("issue_task", "Start task")).id;
  });

  await step(
    "The sandbox implements the ticket and opens a pull request",
    async () => {
      const seenTimeline = new Set<string>();
      const inferenceStates = new Map<string, string>();
      await page.goto(`${origin}/cloud/tasks/${runId}`);
      const run = await eventually(
        "the task finishes",
        async () => {
          const current = await api(`runs/${runId}`);
          for (const entry of current.timeline as {
            id: string;
            kind: string;
            status: string;
            title: string;
            detail: string;
          }[]) {
            const seen = `${entry.id}:${entry.status}`;
            if (seenTimeline.has(seen)) continue;
            seenTimeline.add(seen);
            log(
              `  task: ${entry.kind}/${entry.status} ${entry.title}${entry.detail ? ` — ${entry.detail.replace(/\s+/g, " ").slice(0, 160)}` : ""}`,
            );
          }
          const inferences = (
            await database.engine.query(
              `SELECT id, state, error_code, actual_tokens FROM cloud_inference_calls WHERE run_id = $1 ORDER BY created_at`,
              [runId],
            )
          ).rows as {
            id: string;
            state: string;
            error_code: string | null;
            actual_tokens: number | null;
          }[];
          for (const [index, inference] of inferences.entries()) {
            const state = `${inference.state}${inference.error_code ? ` (${inference.error_code})` : ""}`;
            if (inferenceStates.get(inference.id) === state) continue;
            inferenceStates.set(inference.id, state);
            log(
              `  inference ${index + 1}: ${state}${inference.actual_tokens ? ` ${inference.actual_tokens} tokens` : ""}`,
            );
          }
          if (["failed", "canceled", "timed_out"].includes(current.state))
            throw new FatalCheck(
              `Task ${current.state}: ${current.summary ?? current.stopMessage ?? ""}`,
            );
          return current.state === "succeeded" ? current : null;
        },
        45 * 60_000,
      );
      log(`Task succeeded with ${run.usage.requests} model requests`);
      await eventually(
        "the pull request opens",
        async () => pullRequest(landing, 1),
        180_000,
        { sync: true },
      );
      await page.reload();
    },
  );

  await step("Machdoch reviews the pull request automatically", async () => {
    const trace = automationTracer("review");
    await eventually(
      "the AI review is approved",
      async () => {
        await trace();
        const pull = await pullRequest(landing, 1);
        const latest = pull?.reviews.at(-1);
        return latest?.state === "APPROVED" && latest.commitId === pull!.headSha
          ? latest
          : null;
      },
      20 * 60_000,
      { sync: true },
    );
    const pull = (await pullRequest(landing, 1))!;
    log(
      `Reviews on #1: ${pull.reviews.map((review) => review.state).join(", ")}`,
    );
    await page.goto(`${hub.origin}/${landing}/pull/1`);
  });

  await step(
    "The reviewer requests changes on a broken pull request",
    async () => {
      await hub.commit(recurrence, "alex/hour-24", "Allow 24 as an hour", {
        "src/cron.ts": (text) =>
          text.replace(
            "hour: field(parts[1]!, 0, 23)",
            "hour: field(parts[1]!, 0, 24)",
          ),
      });
      const created = await fetch(`${hub.apiUrl}/repos/${recurrence}/pulls`, {
        method: "POST",
        headers: {
          Authorization: "Bearer ghp_machdoch_local_contributor_token",
        },
        body: JSON.stringify({
          title: "Accept hour 24 in cron expressions",
          body: "Lets schedules use 24 for midnight.",
          head: "alex/hour-24",
          base: "main",
        }),
      });
      assert.equal(created.status, 201);
      const trace = automationTracer("contributor");
      await eventually(
        "the AI requests changes",
        async () => {
          await trace();
          return (await pullRequest(recurrence, 1))?.reviews.find(
            (review) => review.state === "CHANGES_REQUESTED",
          );
        },
        30 * 60_000,
        { sync: true },
      );
      await page.goto(`${hub.origin}/${recurrence}/pull/1`);
    },
  );

  await step("Connect merge automations", async () => {
    await chooseTemplate("Merge approved pull requests");
    await chooseTemplate("Resolve merge conflicts with an AI task");
  });

  await step("Merge after resolving a conflict", async () => {
    await hub.commit(landing, "main", "Tag navigation links for analytics", {
      "index.html": (text) =>
        text.replace(
          /(<nav class="(?:primary|footer)-navigation"[\s\S]*?<\/nav>)/gu,
          (block) =>
            block.replace(/<a href=/gu, '<a data-analytics="navigation" href='),
        ),
    });
    const trace = automationTracer("merge");
    await eventually(
      "the pull request is merged",
      async () => {
        await trace();
        return (await pullRequest(landing, 1))?.state === "merged";
      },
      60 * 60_000,
      { sync: true },
    );
    const merged = await hub.readFile(landing, "main", "index.html");
    assert.ok(merged.includes(docsUrl), "The Docs link is on main");
    assert.ok(
      merged.includes('data-analytics="navigation"'),
      "The base change is kept",
    );
    assert.ok(
      !/^(<<<<<<<|>>>>>>>)/mu.test(merged),
      "No conflict markers remain",
    );
    await eventually(
      "the issue is done",
      async () => (await api(`issues/${issue.id}`)).state === "complete",
      120_000,
      { sync: true },
    );
  });

  await step("The ticket shows what happened", async () => {
    await eventually(
      "the reviewed criteria are ticked",
      async () => {
        const criteria = (await api(`issues/${issue.id}`)).acceptanceCriteria;
        return (
          criteria.includes("[x]") &&
          !/^\s*(?:[-*+]|\d+[.)])\s+\[ \]/mu.test(criteria)
        );
      },
      5 * 60_000,
    );
    await page.goto(`${origin}/cloud/issues/${issue.id}`);
    await page
      .getByText(/Merged/u)
      .first()
      .waitFor();
    const expand = page.getByRole("button", { name: /^Show \d+ events$/u });
    if (await expand.count()) await expand.click();
    await page
      .locator(".cloud-activity-change", { hasText: "changed status to Done" })
      .getByText(`${landing}#1`)
      .waitFor();
    assert.equal(
      await page
        .locator(".cloud-issue-criteria input[type=checkbox]:not(:checked)")
        .count(),
      0,
    );
  });

  assert.deepEqual(pageErrors, []);
  await writeFile(
    join(output, "results.json"),
    JSON.stringify(
      {
        model,
        passed,
        pulls: {
          landing: hub.pulls(landing),
          recurrence: hub.pulls(recurrence),
        },
      },
      null,
      2,
    ),
  );
  log(`PASS ${passed.length} steps. Evidence: ${output}`);
} catch (error) {
  console.error(error);
  await page
    .screenshot({ path: join(output, "failure.png"), fullPage: true })
    .catch(() => undefined);
  const rows = (text: string) =>
    bounded(database.engine.query(text), "The database")
      .then((result) => result.rows)
      .catch((reason: Error) => [{ unavailable: reason.message }]);
  await writeFile(
    join(output, "failure.json"),
    JSON.stringify(
      {
        passed,
        pageErrors,
        runs: await rows(
          "SELECT id,state,stop_reason,stop_message,left(summary,2000) AS summary,manifest->'subject' AS subject FROM cloud_runs ORDER BY created_at",
        ),
        inferences: await rows(
          "SELECT run_id,state,error_code,model,reserved_tokens,actual_tokens,max_output_tokens,length(user_prompt) AS prompt_bytes,created_at,left(response->>'text',400) AS text,left((response->'toolCalls')::text,800) AS tool_calls FROM cloud_inference_calls WHERE run_id IS NOT NULL ORDER BY created_at DESC LIMIT 8",
        ),
        chats: await rows(
          "SELECT state,error_code,answer FROM cloud_chat_turns ORDER BY created_at",
        ),
        automations: await rows(
          "SELECT a.name,r.state,r.steps,r.error FROM cloud_automation_runs r JOIN cloud_automations a ON a.organization_id=r.organization_id AND a.id=r.automation_id ORDER BY r.created_at",
        ),
        deliveries: await rows(
          "SELECT state,reason,branch,pull_request_number FROM cloud_run_deliveries",
        ),
        pulls: {
          landing: hub.pulls(landing),
          recurrence: hub.pulls(recurrence),
        },
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
} finally {
  await bounded(browser.close(), "Closing the browser").catch(() => undefined);
  await bounded(
    getCloudRuntime().then((runtime) =>
      runtime.execution.hostedRunners.close(),
    ),
    "Stopping hosted runners",
  ).catch((error: Error) => log(error.message));
  for (const directory of cliHomes)
    await rm(directory, { recursive: true, force: true });
  for (const id of runnerIds)
    await rm(join(homedir(), ".machdoch-cloud", "runners", id), {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 3_000,
    }).catch((error: unknown) => log(`Runner state kept: ${String(error)}`));
  await hub.close();
  process.exit(process.exitCode ?? 0);
}
