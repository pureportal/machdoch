import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  assertEventually,
  cloudApi,
  cloudBrowserFixture,
} from "./cloud-browser-fixture.mjs";
import { seedCloudDesign } from "./cloud-design-fixture.mjs";

const providers = {
  openai: { key: "OPENAI_API_KEY", model: "gpt-5.4-mini" },
  anthropic: { key: "ANTHROPIC_API_KEY", model: "claude-haiku-4-5" },
  google: { key: "GOOGLE_API_KEY", model: "gemini-3-flash" },
};
const providerKind = process.env.MACHDOCH_VERIFY_PROVIDER ?? "openai";
const selected = providers[providerKind];
assert.ok(selected, "Select openai, anthropic or google.");
const apiKey = process.env[selected.key];
assert.ok(apiKey, `Configure ${selected.key} for live Ask verification.`);
const model = process.env.MACHDOCH_VERIFY_MODEL ?? selected.model;
const fixture = await cloudBrowserFixture();
const page = await fixture.ownerContext.newPage();
page.setDefaultTimeout(30000);
const api = (path, method, body) =>
  cloudApi(fixture, fixture.ownerContext, path, method, body);
const checks = [];
function passed(name) {
  checks.push(name);
  process.stdout.write(`PASS ${name}\n`);
}
async function ask(question) {
  await page.getByLabel("AI provider", { exact: true }).selectOption({
    label: "Ask verification",
  });
  await page.getByLabel("Model", { exact: true }).selectOption(model);
  await page.getByLabel("Message", { exact: true }).fill(question);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.waitForURL(/\/cloud\/chat\/[a-f0-9-]+$/);
  const chatId = new URL(page.url()).pathname.split("/").at(-1);
  await assertEventually(
    async () =>
      ["complete", "failed"].includes(
        (await api(`chats/${chatId}`)).turns.at(-1).state,
      ),
    () => "The Ask response did not finish.",
    120000,
  );
  const turn = (await api(`chats/${chatId}`)).turns.at(-1);
  assert.equal(turn.state, "complete", turn.errorCode ?? "");
  await page.locator(".cloud-chat-answer .app-markdown").last().waitFor();
  return { chatId, turn };
}
try {
  await api("auth/login", "POST", {
    email: "owner@example.test",
    password: fixture.password,
  });
  const { issues } = await seedCloudDesign(fixture);
  const blocked = issues[8];
  const focus = issues[0];
  await api("ai-providers", "POST", {
    name: "Ask verification",
    provider: providerKind,
    region: null,
    models: [model],
    apiKey,
    maxOutputTokens: 4096,
    dailyTokenBudget: 200000,
    maxConcurrentRequests: 2,
  });
  await page.goto(`${fixture.origin}/cloud/chat`);
  await page.getByRole("heading", { name: "Ask", exact: true }).waitFor();
  const workspaceAnswer = await ask(
    "Which issues are blocked right now? Link each one.",
  );
  assert.match(workspaceAnswer.turn.answer, new RegExp(blocked.identifier));
  const link = page.locator(
    `.cloud-chat-answer a[href="/cloud/issues/${blocked.id}"]`,
  );
  await link.first().waitFor();
  await page.screenshot({
    path: join(fixture.directory, "ask-workspace.png"),
    fullPage: true,
  });
  await link.first().click();
  await page.waitForURL(`**/cloud/issues/${blocked.id}`);
  passed(
    `Ask answers a workspace question from permitted planning data and links ${blocked.identifier}`,
  );
  await page.goto(`${fixture.origin}/cloud/issues/${focus.id}`);
  await page
    .locator("main")
    .getByRole("link", { name: "Ask", exact: true })
    .click();
  await page.waitForURL(`**/cloud/chat?issue=${focus.id}`);
  await page
    .getByRole("link", { name: new RegExp(focus.identifier) })
    .first()
    .waitFor();
  const issueAnswer = await ask(
    "What are the acceptance criteria of this issue? Quote them.",
  );
  assert.match(issueAnswer.turn.answer, /reconnects successfully/i);
  assert.equal(
    (await api(`chats/${issueAnswer.chatId}`)).chat.issueId,
    focus.id,
  );
  await page.screenshot({
    path: join(fixture.directory, "ask-issue.png"),
    fullPage: true,
  });
  passed(
    `Ask from ${focus.identifier} keeps the issue in focus and answers from its acceptance criteria`,
  );
  assert.deepEqual(fixture.pageErrors, []);
  await writeFile(
    join(fixture.directory, "ask-results.json"),
    JSON.stringify(
      {
        checks,
        model,
        workspaceAnswer: workspaceAnswer.turn.answer,
        issueAnswer: issueAnswer.turn.answer,
      },
      null,
      2,
    ),
  );
  process.stdout.write(`Ask evidence: ${fixture.directory}\n`);
} catch (error) {
  await page
    .screenshot({
      path: join(fixture.directory, "ask-failure.png"),
      fullPage: true,
    })
    .catch(() => {});
  process.stderr.write(
    `${error instanceof Error ? error.stack : error}\n${fixture.logs()}\n`,
  );
  process.exitCode = 1;
} finally {
  await fixture.close();
}
