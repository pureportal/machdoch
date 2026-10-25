import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createPasswordInvitation,
  acceptPasswordInvitation,
  assertEventually,
  cloudApi,
  cloudBrowserFixture,
} from "./cloud-browser-fixture.mjs";

const fixture = await cloudBrowserFixture();
const owner = await fixture.ownerContext.newPage();
const memberContext = await fixture.createContext();
const member = await memberContext.newPage();
const api = (path, method, body) =>
  cloudApi(fixture, fixture.ownerContext, path, method, body);
const checks = [];
function passed(name) {
  checks.push(name);
  process.stdout.write(`PASS ${name}\n`);
}
try {
  await api("auth/login", "POST", {
    email: "owner@example.test",
    password: fixture.password,
  });
  const invitation = await createPasswordInvitation(
    fixture,
    fixture.ownerContext,
    {
      email: "member@example.test",
      role: "member",
    },
  );
  await acceptPasswordInvitation(fixture, memberContext, invitation.url, {
    name: "Member",
    password: fixture.password,
  });
  const team = await api("teams", "POST", {
    name: "Team",
    key: "TM",
    visibility: "organization",
    estimateScale: [
      { label: "Small", points: 3 },
      { label: "Large", points: 8 },
    ],
  });
  const issue = await api("issues", "POST", {
    teamId: team.id,
    title: "Discuss the change",
  });
  const url = `${fixture.origin}/cloud/issues/${issue.id}`;
  await Promise.all([owner.goto(url), member.goto(url)]);
  const text = '<img src="x" onerror="window.commentExecuted = true">';
  await member.getByLabel("Comment", { exact: true }).fill(text);
  await member
    .getByRole("button", { name: "Post comment", exact: true })
    .click();
  await member.getByText(text, { exact: true }).waitFor();
  await owner.getByText(text, { exact: true }).waitFor();
  assert.equal(await owner.evaluate(() => window.commentExecuted), undefined);
  const discussion = owner.getByRole("region", { name: "Comments" });
  assert.equal(await discussion.locator("img").count(), 0);
  assert.equal(
    await discussion
      .getByRole("button", { name: "Edit comment", exact: true })
      .count(),
    0,
  );
  passed("Comments synchronize between users and render untrusted text safely");

  await member
    .getByRole("button", { name: "Edit comment", exact: true })
    .click();
  await member
    .getByRole("dialog")
    .getByLabel("Comment", { exact: true })
    .fill("Edited by the author");
  await member
    .getByRole("dialog")
    .getByRole("button", { name: "Save comment", exact: true })
    .click();
  await member.getByRole("dialog").waitFor({ state: "hidden" });
  await owner.getByText("Edited by the author", { exact: true }).waitFor();
  const stale = await memberContext.newPage();
  await stale.goto(url);
  await stale
    .getByRole("button", { name: "Edit comment", exact: true })
    .click();
  await stale
    .getByRole("dialog")
    .getByLabel("Comment", { exact: true })
    .fill("Keep my unsaved edit");
  await member
    .getByRole("button", { name: "Edit comment", exact: true })
    .click();
  await member
    .getByRole("dialog")
    .getByLabel("Comment", { exact: true })
    .fill("Newer author edit");
  await member
    .getByRole("dialog")
    .getByRole("button", { name: "Save comment", exact: true })
    .click();
  await member.getByRole("dialog").waitFor({ state: "hidden" });
  await stale
    .getByRole("dialog")
    .getByRole("button", { name: "Save comment", exact: true })
    .click();
  await stale
    .getByRole("dialog")
    .getByRole("alert")
    .filter({ hasText: "This item changed" })
    .waitFor();
  assert.equal(
    await stale
      .getByRole("dialog")
      .getByLabel("Comment", { exact: true })
      .inputValue(),
    "Keep my unsaved edit",
  );
  await stale.close();
  passed("Author edits are versioned and stale editors retain their drafts");

  await owner.getByText("Newer author edit", { exact: true }).waitFor();
  await owner
    .getByRole("button", { name: "Delete comment", exact: true })
    .click();
  await owner
    .getByRole("dialog")
    .getByRole("button", { name: "Delete comment", exact: true })
    .click();
  await owner.getByRole("dialog").waitFor({ state: "hidden" });
  await member.getByText("Comment deleted", { exact: true }).waitFor();
  assert.equal((await api(`issues/${issue.id}/comments`)).comments[0].body, "");
  assert.equal((await api(`issues/${issue.id}`)).revision, 1);
  passed(
    "Administrator removal hides comment content and does not invalidate issue estimates",
  );

  const endpoint = `**/api/v1/issues/${issue.id}/comments`;
  let lostResponse = false;
  await member.route(endpoint, async (route) => {
    if (route.request().method() === "POST" && !lostResponse) {
      lostResponse = true;
      await route.fetch();
      await route.abort("connectionclosed");
    } else await route.continue();
  });
  await member
    .getByLabel("Comment", { exact: true })
    .fill("Accepted before disconnect");
  await member
    .getByRole("button", { name: "Post comment", exact: true })
    .click();
  await member.getByRole("alert").filter({ hasText: "fetch" }).waitFor();
  assert.equal(
    await member.getByLabel("Comment", { exact: true }).inputValue(),
    "Accepted before disconnect",
  );
  await member
    .getByRole("button", { name: "Post comment", exact: true })
    .click();
  await assertEventually(
    async () =>
      (await member.getByLabel("Comment", { exact: true }).inputValue()) === "",
  );
  await member.unroute(endpoint);
  assert.equal(
    (await api(`issues/${issue.id}/comments`)).comments.filter(
      (comment) => comment.body === "Accepted before disconnect",
    ).length,
    1,
  );
  passed(
    "A disconnected comment submission can be retried without duplication",
  );
  await member.setViewportSize({ width: 390, height: 844 });
  await member
    .getByRole("heading", { name: "Comments", exact: true })
    .scrollIntoViewIfNeeded();
  assert.ok(
    await member.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await member.screenshot({
    path: join(fixture.directory, "comments-mobile.png"),
  });
  assert.deepEqual(fixture.pageErrors, []);
  await writeFile(
    join(fixture.directory, "results.json"),
    JSON.stringify({ checks, pageErrors: fixture.pageErrors }, null, 2),
  );
  process.stdout.write(`Evidence: ${fixture.directory}\n`);
} catch (error) {
  await member
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
