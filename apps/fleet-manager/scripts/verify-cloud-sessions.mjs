import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  cloudApi,
  cloudBrowserFixture,
  assertEventually,
} from "./cloud-browser-fixture.mjs";

let dropRevocation = false;
const fixture = await cloudBrowserFixture({
  dropResponse: ({ path, status }) =>
    dropRevocation &&
    path === "/api/v1/account/sessions/revoke" &&
    status === 200,
});
const page = await fixture.ownerContext.newPage();
const checks = [];
const contexts = [];
function passed(name) {
  checks.push(name);
  console.log(`PASS ${name}`);
}
async function signIn(context, email = "owner@example.test") {
  const tab = await context.newPage();
  await tab.goto(`${fixture.origin}/cloud/login`);
  await tab.getByLabel("Email", { exact: true }).fill(email);
  await tab.getByLabel("Password", { exact: true }).fill(fixture.password);
  await tab.getByRole("button", { name: "Sign in", exact: true }).click();
  await tab.waitForURL("**/cloud/issues");
  return tab;
}
async function another(agent) {
  const context = await fixture.createContext({ userAgent: agent });
  contexts.push(context);
  await signIn(context);
  return context;
}
const rows = () => page.locator("[data-session-id]");
async function waitRows(number) {
  await assertEventually(async () => (await rows().count()) === number);
}
try {
  await page.goto(`${fixture.origin}/cloud/login`);
  await page.getByLabel("Email", { exact: true }).fill("owner@example.test");
  await page.getByLabel("Password", { exact: true }).fill(fixture.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL("**/cloud/issues");
  const firefox = await another(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:145.0) Gecko/20100101 Firefox/145.0",
  );
  const safari = await another(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15",
  );
  await page.goto(`${fixture.origin}/cloud/account`);
  await waitRows(3);
  await page.getByText("Firefox · Windows", { exact: true }).waitFor();
  await page.getByText("Safari · macOS", { exact: true }).waitFor();
  assert.equal(
    await page.getByText("This session", { exact: true }).count(),
    1,
  );
  const workspace = await cloudApi(fixture, fixture.ownerContext, "workspace");
  const account = {
    organizationId: workspace.organization.id,
    userId: workspace.actor.id,
  };
  const list = await cloudApi(
    fixture,
    fixture.ownerContext,
    `account/sessions?${new URLSearchParams(account)}`,
  );
  assert.equal(list.length, 3);
  assert.equal(list[0].current, true);
  assert.equal(
    Object.keys(list[0]).some((key) => /hash|token|csrf/i.test(key)),
    false,
  );
  assert.ok(
    list.every(
      (session) => session.browser && session.platform && session.address,
    ),
  );
  passed(
    "Lists recognizable browser sessions with current-session status and bounded sign-in metadata without exposing credential hashes",
  );

  await page
    .getByRole("button", { name: "Sign out Firefox · Windows", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  assert.equal(
    await page
      .getByRole("button", { name: "Sign out Firefox · Windows", exact: true })
      .evaluate((element) => element === document.activeElement),
    true,
  );
  await page
    .getByRole("button", { name: "Sign out Firefox · Windows", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Sign out", exact: true })
    .click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await waitRows(2);
  assert.equal(
    (await firefox.request.get(`${fixture.origin}/api/v1/workspace`)).status(),
    401,
  );
  await assertEventually(async () =>
    page
      .getByRole("button", { name: "Refresh sessions", exact: true })
      .evaluate((element) => element === document.activeElement),
  );
  assert.equal(
    (await safari.request.get(`${fixture.origin}/api/v1/workspace`)).status(),
    200,
  );
  passed(
    "Revokes a selected browser immediately, preserves other sessions and restores keyboard focus when its row disappears",
  );

  dropRevocation = true;
  await page
    .getByRole("button", { name: "Sign out other sessions", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Sign out", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("alert")
    .filter({ hasText: "did not confirm" })
    .waitFor();
  assert.equal(
    (await safari.request.get(`${fixture.origin}/api/v1/workspace`)).status(),
    401,
  );
  dropRevocation = false;
  const newer = await another(
    "Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 Chrome/155.0.0.0 Mobile Safari/537.36",
  );
  await fixture.restart();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Sign out", exact: true })
    .click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await waitRows(2);
  assert.equal(
    (await newer.request.get(`${fixture.origin}/api/v1/workspace`)).status(),
    200,
  );
  assert.equal(
    (
      await fixture.database.query(
        "SELECT count(*)::int AS count FROM cloud_outbox WHERE kind='sessions.revoked' AND payload->>'scope'='other_sessions'",
      )
    ).rows[0].count,
    1,
  );
  passed(
    "Recovers a lost revocation response after restart without revoking a session created after the original command",
  );

  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("heading", { name: "Organization sessions", exact: true })
    .scrollIntoViewIfNeeded();
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await page.screenshot({
    path: join(fixture.directory, "sessions-mobile.png"),
    animations: "disabled",
  });
  passed("Keeps account session controls within the mobile viewport");

  const otherId = randomUUID();
  await fixture.database.query(
    "INSERT INTO cloud_users(id,email,name,password_hash) SELECT $1,'other@example.test','Other member',password_hash FROM cloud_users WHERE email='owner@example.test'",
    [otherId],
  );
  await fixture.database.query(
    "INSERT INTO cloud_memberships(organization_id,user_id,role) VALUES($1,$2,'member')",
    [account.organizationId, otherId],
  );
  const otherContext = await fixture.createContext();
  contexts.push(otherContext);
  await signIn(otherContext, "other@example.test");
  await cloudApi(fixture, fixture.ownerContext, "auth/login", "POST", {
    email: "other@example.test",
    password: fixture.password,
  });
  await page
    .getByRole("button", { name: "Sign out other sessions", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Sign out", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("alert")
    .filter({ hasText: "account or organization changed" })
    .waitFor();
  assert.equal(
    (
      await otherContext.request.get(`${fixture.origin}/api/v1/workspace`)
    ).status(),
    200,
  );
  assert.equal(
    (await newer.request.get(`${fixture.origin}/api/v1/workspace`)).status(),
    200,
  );
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await page.reload();
  await waitRows(2);
  passed(
    "Rejects a stale account tab after the browser switches users, preserving both users' other sessions",
  );

  await page
    .getByRole("button", { name: "Sign out this session", exact: true })
    .click();
  dropRevocation = true;
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Sign out", exact: true })
    .click();
  await assertEventually(
    async () =>
      new URL(page.url()).pathname === "/cloud/login" ||
      (await page
        .getByRole("dialog")
        .getByRole("alert")
        .filter({ hasText: "did not confirm" })
        .isVisible()),
  );
  dropRevocation = false;
  if (new URL(page.url()).pathname !== "/cloud/login")
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Sign out", exact: true })
      .click();
  await page.waitForURL("**/cloud/login");
  assert.equal(
    (await fixture.ownerContext.cookies()).some(
      (cookie) => cookie.name === "__Host-machdoch_cloud_session",
    ),
    false,
  );
  assert.equal(
    (
      await fixture.ownerContext.request.get(
        `${fixture.origin}/api/v1/workspace`,
      )
    ).status(),
    401,
  );
  assert.equal(
    (
      await otherContext.request.get(`${fixture.origin}/api/v1/workspace`)
    ).status(),
    200,
  );
  passed(
    "Recovers a lost current-session revocation response, clears its cookies and preserves the other browser",
  );
  const otherCookies = await otherContext.cookies();
  const otherCsrf = otherCookies.find(
    (cookie) => cookie.name === "__Host-machdoch_cloud_csrf",
  ).value;
  const raceStarted = Date.now();
  const [selfRevocation] = await Promise.all([
    otherContext.request.post(
      `${fixture.origin}/api/v1/account/sessions/revoke`,
      {
        headers: {
          Origin: fixture.origin,
          "x-machdoch-cloud-csrf": otherCsrf,
          "Idempotency-Key": randomUUID(),
        },
        data: {
          scope: "other_sessions",
          account: { organizationId: account.organizationId, userId: otherId },
        },
      },
    ),
    cloudApi(fixture, newer, `members/${otherId}`, "PATCH", {
      role: "member",
      active: false,
      revision: 1,
    }),
  ]);
  assert.ok(
    [200, 401, 403].includes(selfRevocation.status()),
    `Unexpected revocation result: ${selfRevocation.status()} ${fixture.logs()}`,
  );
  assert.ok(Date.now() - raceStarted < 5000);
  assert.equal(
    (
      await fixture.database.query(
        "SELECT count(*)::int AS count FROM cloud_sessions WHERE user_id=$1",
        [otherId],
      )
    ).rows[0].count,
    0,
  );
  await cloudApi(fixture, newer, `members/${otherId}`, "PATCH", {
    role: "member",
    active: true,
    revision: 2,
  });
  assert.equal(
    (
      await otherContext.request.get(`${fixture.origin}/api/v1/workspace`)
    ).status(),
    401,
  );
  passed(
    "Concurrent self-revocation and administrator suspension finish without a lock timeout, and restoration does not revive old browser access",
  );
  assert.deepEqual(fixture.pageErrors, []);
  await writeFile(
    join(fixture.directory, "session-results.json"),
    JSON.stringify({ checks, pageErrors: fixture.pageErrors }, null, 2),
  );
  console.log(`Evidence: ${fixture.directory}`);
} catch (error) {
  dropRevocation = false;
  await page.screenshot({
    path: join(fixture.directory, "sessions-failure.png"),
    animations: "disabled",
  });
  await writeFile(
    join(fixture.directory, "sessions-failure.json"),
    JSON.stringify(
      {
        checks,
        error: error.stack,
        logs: fixture.logs(),
        pageErrors: fixture.pageErrors,
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  await fixture.close();
}
