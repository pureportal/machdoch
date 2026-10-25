import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createPasswordInvitation,
  acceptPasswordInvitation,
  assertEventually,
  cloudApi,
  cloudBrowserFixture,
} from "./cloud-browser-fixture.mjs";

const fixture = await cloudBrowserFixture({
  serverEntry: "scripts/cloud-chat-fixture.ts",
});
const page = await fixture.ownerContext.newPage();
const api = (path, method, body) =>
  cloudApi(fixture, fixture.ownerContext, path, method, body);
const checks = [];
function passed(name) {
  checks.push(name);
  process.stdout.write(`PASS ${name}\n`);
}
const requestCount = async (prompt) =>
  (
    await fixture.database.query(
      "SELECT count(*)::integer AS count FROM verification_model_requests WHERE prompt=$1",
      [prompt],
    )
  ).rows[0].count;
const latest = (chatId) =>
  api(`chats/${chatId}`).then((detail) => detail.turns.at(-1));
async function send(prompt) {
  await page.getByLabel("Message", { exact: true }).fill(prompt);
  await page.getByRole("button", { name: "Send", exact: true }).click();
}
async function newChat(prompt) {
  await page.goto(`${fixture.origin}/cloud/chat`);
  await send(prompt);
  await page.waitForURL(/\/cloud\/chat\/[a-f0-9-]+$/);
  return new URL(page.url()).pathname.split("/").at(-1);
}
async function admission(context, providerId, prompt) {
  const csrf = (await context.cookies()).find(
    (cookie) => cookie.name === "__Host-machdoch_cloud_csrf",
  ).value;
  return context.request.post(`${fixture.origin}/api/v1/chats`, {
    headers: {
      Origin: fixture.origin,
      "x-machdoch-cloud-csrf": csrf,
      "Idempotency-Key": randomUUID(),
    },
    data: {
      chatId: null,
      revision: null,
      providerId,
      model: "fixture-model",
      prompt,
    },
  });
}

try {
  await api("auth/login", "POST", {
    email: "owner@example.test",
    password: fixture.password,
  });
  const configuration = {
    name: "Verification AI",
    provider: "openai",
    region: null,
    models: ["fixture-model"],
    apiKey: "fixture-provider-key",
    maxOutputTokens: 256,
    dailyTokenBudget: 200000,
    maxConcurrentRequests: 4,
  };
  const provider = await api("ai-providers", "POST", configuration);
  const chatId = await newChat("Explain cycle planning");
  await assertEventually(
    async () => (await latest(chatId)).state === "complete",
  );
  await page
    .getByText("Follow-up context: 1 messages.", { exact: true })
    .waitFor();
  assert.equal(
    await page.evaluate(() => window.modelScriptExecuted),
    undefined,
  );
  assert.equal(await page.locator(".cloud-chat-answer img").count(), 0);
  assert.equal(await requestCount("Explain cycle planning"), 1);
  const captured = (
    await fixture.database.query(
      "SELECT body FROM verification_model_requests WHERE prompt=$1",
      ["Explain cycle planning"],
    )
  ).rows[0].body;
  assert.deepEqual(captured.tools, []);
  assert.equal(captured.max_output_tokens, 256);
  assert.equal(captured.store, false);
  await send("How does carryover work?");
  await assertEventually(
    async () =>
      (await latest(chatId)).state === "complete" &&
      (await api(`chats/${chatId}`)).turns.length === 2,
  );
  await page
    .getByText("Follow-up context: 3 messages.", { exact: true })
    .waitFor();
  await page.screenshot({
    path: join(fixture.directory, "chat-desktop.png"),
    fullPage: true,
  });
  passed(
    "Cloud chat uses the shared SDK, preserves context and safely renders model output without tools",
  );

  await page.goto(`${fixture.origin}/cloud/chat`);
  let dropped = false;
  await page.route("**/api/v1/chats", async (route) => {
    if (route.request().method() === "POST" && !dropped) {
      dropped = true;
      await route.fetch();
      await route.abort("connectionclosed");
    } else await route.continue();
  });
  await send("Recover a lost acknowledgement");
  await page.getByRole("alert").filter({ hasText: /fetch/i }).waitFor();
  assert.equal(
    await page.getByLabel("Message", { exact: true }).inputValue(),
    "Recover a lost acknowledgement",
  );
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.waitForURL(/\/cloud\/chat\/[a-f0-9-]+$/);
  await page.unroute("**/api/v1/chats");
  const recoveredId = new URL(page.url()).pathname.split("/").at(-1);
  await assertEventually(
    async () => (await latest(recoveredId)).state === "complete",
  );
  assert.equal(await requestCount("Recover a lost acknowledgement"), 1);
  passed(
    "A lost admission response retains the draft and retry does not purchase a second model request",
  );

  const failedId = await newChat("Fail once then recover");
  await page
    .getByRole("button", { name: "Retry response", exact: true })
    .waitFor();
  assert.equal(await requestCount("Fail once then recover"), 1);
  const alternate = await api("ai-providers", "POST", {
    ...configuration,
    name: "Verification AI backup",
    models: ["fixture-alternate"],
  });
  await page.reload();
  await page
    .getByLabel("AI provider", { exact: true })
    .selectOption(alternate.id);
  await page
    .getByRole("button", { name: "Retry response", exact: true })
    .click();
  await assertEventually(
    async () => (await latest(failedId)).state === "complete",
  );
  assert.equal(await requestCount("Fail once then recover"), 2);
  assert.equal((await api(`chats/${failedId}`)).turns.length, 1);
  assert.equal((await latest(failedId)).model, "fixture-alternate");
  await page
    .getByText("Follow-up context: 1 messages.", { exact: true })
    .waitFor();
  assert.equal(await page.locator(".cloud-chat-user").count(), 1);
  passed(
    "Explicit retry uses the selected provider and keeps one visible message without an automatic fallback",
  );

  const canceledId = await newChat("Hold cancellable response");
  await page.getByText("Working on the answer.", { exact: true }).waitFor();
  await page
    .getByRole("button", { name: "Stop response", exact: true })
    .click();
  await page.getByText("Response stopped", { exact: true }).waitFor();
  await assertEventually(
    async () =>
      (
        await fixture.database.query(
          "SELECT state FROM verification_model_requests WHERE prompt=$1",
          ["Hold cancellable response"],
        )
      ).rows[0].state === "aborted",
  );
  assert.equal((await latest(canceledId)).state, "canceled");
  assert.equal(
    (await latest(canceledId)).answer.includes("Final response"),
    false,
  );
  passed("Cancellation stops streamed output and rejects a late answer");

  const crashedId = await newChat("Hold crash recovery");
  await page.getByText("Working on the answer.", { exact: true }).waitFor();
  const crashedTurn = await latest(crashedId);
  await fixture.restart(async () => {
    await fixture.database.query(
      "UPDATE cloud_inference_calls SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
      [crashedTurn.requestId],
    );
  });
  await page.reload();
  await page
    .getByText("The response was interrupted. Retry when you are ready.", {
      exact: true,
    })
    .waitFor();
  assert.equal(await requestCount("Hold crash recovery"), 1);
  await page
    .getByRole("button", { name: "Retry response", exact: true })
    .click();
  await assertEventually(
    async () => (await requestCount("Hold crash recovery")) === 2,
  );
  await assertEventually(
    async () =>
      (
        await fixture.database.query(
          "SELECT state FROM verification_model_requests WHERE prompt=$1 ORDER BY created_at DESC LIMIT 1",
          ["Hold crash recovery"],
        )
      ).rows[0]?.state === "held",
  );
  await fixture.database.query(
    "UPDATE verification_model_requests SET state='release' WHERE prompt=$1 AND state='held'",
    ["Hold crash recovery"],
  );
  await assertEventually(
    async () => (await latest(crashedId)).state === "complete",
  );
  assert.equal((await api(`chats/${crashedId}`)).turns.length, 1);
  passed(
    "A server crash preserves history and requires an explicit retry for an uncertain provider outcome",
  );

  const invitation = await createPasswordInvitation(
    fixture,
    fixture.ownerContext,
    {
      email: "member@example.test",
      role: "member",
    },
  );
  const member = await fixture.createContext();
  await acceptPasswordInvitation(fixture, member, invitation.url, {
    name: "Member",
    password: fixture.password,
  });
  assert.equal(
    (
      await member.request.get(`${fixture.origin}/api/v1/chats/${chatId}`)
    ).status(),
    404,
  );
  assert.deepEqual((await cloudApi(fixture, member, "chats")).chats, []);
  const memberPage = await member.newPage();
  await memberPage.goto(`${fixture.origin}/cloud/chat/${chatId}`);
  await memberPage.getByRole("heading", { name: "404", exact: true }).waitFor();
  passed("Conversation content and history remain private to their owner");

  const capacity = await api("ai-providers", "POST", {
    ...configuration,
    name: "Capacity",
    maxConcurrentRequests: 1,
  });
  const claims = await Promise.all([
    admission(fixture.ownerContext, capacity.id, "Hold capacity owner"),
    admission(member, capacity.id, "Hold capacity member"),
  ]);
  assert.deepEqual(
    claims.map((response) => response.status()).sort((a, b) => a - b),
    [202, 409],
  );
  assert.equal(
    (await claims.find((response) => response.status() === 409).json()).code,
    "provider_busy",
  );
  const winner = await claims
    .find((response) => response.status() === 202)
    .json();
  const winningContext =
    claims[0].status() === 202 ? fixture.ownerContext : member;
  await assertEventually(
    async () =>
      (
        await fixture.database.query(
          "SELECT request_started_at FROM cloud_inference_calls WHERE id=$1",
          [winner.requestId],
        )
      ).rows[0].request_started_at !== null,
  );
  await cloudApi(
    fixture,
    winningContext,
    `chat-turns/${winner.turnId}/cancel`,
    "POST",
    { requestId: winner.requestId },
  );
  passed("Concurrent users cannot exceed a provider's request-slot limit");

  const budget = await api("ai-providers", "POST", {
    ...configuration,
    name: "Budget",
    maxOutputTokens: 64,
    dailyTokenBudget: 2000,
  });
  const held = await admission(
    fixture.ownerContext,
    budget.id,
    "Hold budget response",
  );
  assert.equal(held.status(), 202);
  const rejected = await admission(member, budget.id, "Rejected over budget");
  assert.equal(rejected.status(), 409);
  assert.equal((await rejected.json()).code, "budget_exceeded");
  assert.equal(await requestCount("Rejected over budget"), 0);
  const budgetTurn = await held.json();
  await api(`chat-turns/${budgetTurn.turnId}/cancel`, "POST", {
    requestId: budgetTurn.requestId,
  });
  passed(
    "Daily budget reservation rejects excess requests before any provider call",
  );

  await page.goto(`${fixture.origin}/cloud/providers`);
  const card = page.locator(".cloud-card").filter({
    has: page.getByRole("heading", { name: "Verification AI", exact: true }),
  });
  await card.getByRole("button", { name: "Token usage", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByText("Day (UTC)", { exact: true })
    .waitFor();
  assert.ok((await api(`inference-budgets/${provider.id}`)).usedTokens > 0);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await page.goto(`${fixture.origin}/cloud/chat/${chatId}`);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.screenshot({
    path: join(fixture.directory, "chat-mobile.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Conversations", exact: true })
    .click();
  await page
    .getByRole("navigation", { name: "Conversations", exact: true })
    .waitFor();
  assert.deepEqual(fixture.pageErrors, []);
  passed("Provider usage and mobile conversation navigation are usable");
  await fixture.ownerContext.clearCookies();
  await page.getByRole("link", { name: "Sign in", exact: true }).waitFor();
  assert.equal(await page.locator(".cloud-chat-messages").count(), 0);
  assert.equal(
    await page
      .getByRole("navigation", { name: "Conversations", exact: true })
      .getByRole("link")
      .count(),
    0,
  );
  assert.equal(
    await page.getByRole("button", { name: "Send", exact: true }).isDisabled(),
    true,
  );
  passed(
    "Expired sessions clear private chat content and provide a sign-in action",
  );
  await writeFile(
    join(fixture.directory, "results.json"),
    JSON.stringify(
      {
        checks,
        pageErrors: fixture.pageErrors,
        scope:
          "Production UI, PostgreSQL and actual shared OpenAI SDK against a controlled streaming transport; no live vendor call.",
      },
      null,
      2,
    ),
  );
  process.stdout.write(`Evidence: ${fixture.directory}\n`);
} catch (error) {
  const calls = await fixture.database
    .query(
      "SELECT state,request_started_at IS NOT NULL AS dispatched,actual_tokens FROM cloud_inference_calls ORDER BY created_at",
    )
    .catch(() => ({ rows: [] }));
  const turns = await fixture.database
    .query("SELECT state,error_code FROM cloud_chat_turns ORDER BY created_at")
    .catch(() => ({ rows: [] }));
  process.stderr.write(
    `Call diagnostics: ${JSON.stringify(calls.rows)}\nTurn diagnostics: ${JSON.stringify(turns.rows)}\n`,
  );
  await page
    .screenshot({
      path: join(fixture.directory, "failure.png"),
      fullPage: true,
    })
    .catch(() => {});
  process.stderr.write(`${fixture.logs()}\nEvidence: ${fixture.directory}\n`);
  throw error;
} finally {
  await fixture.close();
}
