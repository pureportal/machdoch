import assert from "node:assert/strict";
import { capture, contained } from "./browser.mjs";

export async function reviewDashboardRecovery(page, size) {
  let accountMode = "loading";
  let releaseAccount;
  const waitingAccount = new Promise((resolve) => {
    releaseAccount = resolve;
  });
  let sessions = [
    {
      sessionId: "review_current",
      clientLabel: "Review browser",
      createdAt: 1,
      lastSeenAt: 1,
      idleExpiresAt: 9999999999,
      absoluteExpiresAt: 9999999999,
      current: true,
    },
    {
      sessionId: "review_other",
      clientLabel: "Review tablet",
      createdAt: 1,
      lastSeenAt: 1,
      idleExpiresAt: 9999999999,
      absoluteExpiresAt: 9999999999,
      current: false,
    },
  ];
  let revokeFailed = true;
  await page.route("**/api/auth/account", async (route) => {
    assert.equal(route.request().method(), "GET");
    if (accountMode === "loading") await waitingAccount;
    await route.fulfill({
      status: accountMode === "loaded" ? 200 : 503,
      json:
        accountMode === "loaded"
          ? {
              account: { username: "review-owner", createdAt: 1, updatedAt: 1 },
            }
          : { error: "Account could not be loaded. Try again." },
    });
  });
  await page.route("**/api/auth/sessions**", async (route) => {
    if (route.request().method() === "DELETE") {
      assert(
        route.request().url().endsWith("/review_other"),
        "Only the fixture session may be revoked",
      );
      if (!revokeFailed)
        sessions = sessions.filter(
          (session) => session.sessionId !== "review_other",
        );
      await route.fulfill({
        status: revokeFailed ? 503 : 200,
        json: revokeFailed
          ? { error: "Session could not be revoked. Try again." }
          : { ok: true },
      });
    } else await route.fulfill({ json: { sessions } });
  });
  await page.goto("/users");
  await page.getByText("Loading account…", { exact: true }).waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Update owner", exact: true })
      .count(),
    0,
  );
  accountMode = "failed";
  releaseAccount();
  await page
    .getByRole("alert")
    .filter({ hasText: "Account could not be loaded" })
    .waitFor();
  await capture(page, `${size}-account-load-error`);
  accountMode = "loaded";
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await page.getByLabel("Username", { exact: true }).waitFor();
  assert.equal(
    await page.getByLabel("Username", { exact: true }).inputValue(),
    "review-owner",
  );
  await page
    .getByText("Review tablet", { exact: true })
    .locator("../../..")
    .getByRole("button", { name: "Revoke browser session", exact: true })
    .click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Revoke session", exact: true })
    .click();
  await page.getByRole("alertdialog").getByRole("alert").waitFor();
  await contained(page, '[role="alertdialog"]');
  revokeFailed = false;
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Revoke session", exact: true })
    .click();
  await page
    .getByText("Review tablet", { exact: true })
    .waitFor({ state: "detached" });

  let keysFailed = true;
  let grants = [];
  await page.route("**/api/enrollment-keys**", async (route) => {
    const method = route.request().method();
    if (method === "POST") {
      const now = Math.floor(Date.now() / 1000);
      grants = [
        { grantId: "review_fixture_key", createdAt: now, expiresAt: now + 300 },
      ];
      await route.fulfill({
        json: {
          ...grants[0],
          enrollmentKey: "fixture-key-not-valid",
          managerUrl: page.url().split("/enrollment")[0],
          managerId: "review_fixture",
        },
      });
    } else if (method === "DELETE") {
      assert(route.request().url().endsWith("/review_fixture_key"));
      grants = [];
      await route.fulfill({ json: { ok: true } });
    } else
      await route.fulfill({
        status: keysFailed ? 503 : 200,
        json: keysFailed
          ? { error: "Keys could not be loaded. Try again." }
          : { grants },
      });
  });
  await page.goto("/enrollment");
  await page
    .getByRole("alert")
    .filter({ hasText: "Keys could not be loaded" })
    .waitFor();
  assert.equal(
    await page.getByText("No unused keys.", { exact: true }).count(),
    0,
  );
  await capture(page, `${size}-enrollment-load-error`);
  keysFailed = false;
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await page.getByText("No unused keys.", { exact: true }).waitFor();
  assert.equal(
    await page
      .getByRole("alert")
      .filter({ hasText: "Keys could not be loaded" })
      .count(),
    0,
  );
  await page
    .getByRole("button", { name: "Create enrollment key", exact: true })
    .click();
  await page.getByLabel("Enrollment key", { exact: true }).waitFor();
  await page.evaluate(() =>
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          throw new DOMException("Clipboard denied", "NotAllowedError");
        },
      },
    }),
  );
  await page
    .getByRole("button", { name: "Copy enrollment key", exact: true })
    .click();
  await page
    .getByRole("alert")
    .filter({ hasText: "could not be copied" })
    .waitFor();
  await page.evaluate(() =>
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async () => {} },
    }),
  );
  await page
    .getByRole("button", { name: "Copy enrollment key", exact: true })
    .click();
  await page
    .getByRole("alert")
    .filter({ hasText: "could not be copied" })
    .waitFor({ state: "detached" });
  await page.getByRole("button", { name: "Revoke", exact: true }).click();
  await page
    .getByLabel("Enrollment key", { exact: true })
    .waitFor({ state: "detached" });
  return `${size}: account loading/retry, browser-session revoke retry, enrollment error recovery and clipboard denial/retry (fixtures)`;
}
