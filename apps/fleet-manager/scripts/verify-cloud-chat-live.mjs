import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  assertEventually,
  cloudApi,
  cloudBrowserFixture,
} from "./cloud-browser-fixture.mjs";

const providerKind = process.env.MACHDOCH_VERIFY_PROVIDER;
assert.ok(
  providerKind === "openai" || providerKind === "google",
  "Select openai or google with MACHDOCH_VERIFY_PROVIDER.",
);
const apiKey =
  process.env[providerKind === "openai" ? "OPENAI_API_KEY" : "GOOGLE_API_KEY"];
assert.ok(
  apiKey,
  "Configure the selected provider's API key for live verification.",
);
assert.ok(
  process.env.MACHDOCH_VERIFY_MODEL,
  "Select an available model with MACHDOCH_VERIFY_MODEL.",
);
const fixture = await cloudBrowserFixture();
const page = await fixture.ownerContext.newPage();
const api = (path, method, body) =>
  cloudApi(fixture, fixture.ownerContext, path, method, body);
try {
  await api("auth/login", "POST", {
    email: "owner@example.test",
    password: fixture.password,
  });
  const provider = await api("ai-providers", "POST", {
    name: "Live verification",
    provider: providerKind,
    region: null,
    models: [process.env.MACHDOCH_VERIFY_MODEL],
    apiKey,
    maxOutputTokens: 64,
    dailyTokenBudget: 2000,
    maxConcurrentRequests: 1,
  });
  await page.goto(`${fixture.origin}/cloud/chat`);
  await page
    .getByLabel("Message", { exact: true })
    .fill("Reply with exactly this token: CLOUD_CHAT_OK");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.waitForURL(/\/cloud\/chat\/[a-f0-9-]+$/);
  const chatId = new URL(page.url()).pathname.split("/").at(-1);
  await page
    .locator(".cloud-chat-answer")
    .filter({ hasText: "CLOUD_CHAT_OK" })
    .waitFor();
  await assertEventually(
    async () => (await api(`chats/${chatId}`)).turns[0].state === "complete",
  );
  await page.getByRole("button", { name: "Send", exact: true }).waitFor();
  await page
    .getByLabel("Message", { exact: true })
    .fill(
      "Repeat the exact token from your previous answer, and nothing else.",
    );
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await assertEventually(async () => {
    const detail = await api(`chats/${chatId}`);
    return (
      detail.turns.length === 2 &&
      detail.turns.every((turn) => turn.state === "complete")
    );
  });
  const detail = await api(`chats/${chatId}`);
  assert.ok(
    detail.turns.every((turn) => turn.answer.includes("CLOUD_CHAT_OK")),
  );
  const budget = await api(`inference-budgets/${provider.id}`);
  assert.ok(budget.usedTokens > 0 && budget.usedTokens <= 2000);
  assert.equal(budget.reservedTokens, 0);
  const calls = await fixture.database.query(
    "SELECT state,actual_tokens,max_output_tokens FROM cloud_inference_calls ORDER BY created_at",
  );
  assert.equal(calls.rows.length, 2);
  assert.ok(
    calls.rows.every(
      (call) =>
        call.state === "complete" &&
        call.actual_tokens > 0 &&
        call.max_output_tokens === 64,
    ),
  );
  assert.deepEqual(fixture.pageErrors, []);
  await page.screenshot({
    path: join(fixture.directory, "chat-live.png"),
    fullPage: true,
  });
  await writeFile(
    join(fixture.directory, "results.json"),
    JSON.stringify(
      {
        provider: providerKind,
        model: process.env.MACHDOCH_VERIFY_MODEL,
        calls: calls.rows,
        usedTokens: budget.usedTokens,
        checks: [
          "Live provider response through the cloud UI",
          "Conversation context retained in follow-up",
          "Verified usage replaces reservations",
          "Output bounded to 64 tokens per request",
        ],
        pageErrors: fixture.pageErrors,
      },
      null,
      2,
    ),
  );
  process.stdout.write(
    `PASS Live cloud chat and context with ${process.env.MACHDOCH_VERIFY_MODEL}; ${budget.usedTokens} provider-reported tokens across two requests.\nEvidence: ${fixture.directory}\n`,
  );
} catch (error) {
  await page
    .screenshot({
      path: join(fixture.directory, "failure.png"),
      fullPage: true,
    })
    .catch(() => {});
  const states = await fixture.database
    .query("SELECT state,error_code FROM cloud_chat_turns")
    .catch(() => ({ rows: [] }));
  process.stderr.write(
    `Turn states: ${JSON.stringify(states.rows)}\n${fixture.logs()}\nEvidence: ${fixture.directory}\n`,
  );
  throw error;
} finally {
  await fixture.close();
}
