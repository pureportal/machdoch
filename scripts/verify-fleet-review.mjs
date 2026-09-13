import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright-core";
import { loadConfig } from "../apps/fleet-manager/src/server/config.ts";
import { output, capture } from "./fleet-review/browser.mjs";
import { reviewDashboard } from "./fleet-review/dashboard.mjs";
import { reviewDashboardRecovery } from "./fleet-review/dashboard-recovery.mjs";
import {
  reviewActivity,
  reviewSessionActions,
} from "./fleet-review/activity.mjs";
import { reviewServiceCommands } from "./fleet-review/service-commands.mjs";
import { reviewServiceEditing } from "./fleet-review/service-editing.mjs";
import { reviewServicePreviews } from "./fleet-review/service-previews.mjs";
import { reviewMediaStates } from "./fleet-review/media-states.mjs";
import { reviewProduct } from "./fleet-review/product.mjs";
import { reviewChatWorkflows } from "./fleet-review/chat-workflows.mjs";
import { buildSettingsHarness } from "./fleet-review/settings-browser.mjs";
import { reviewSettings } from "./fleet-review/settings.mjs";
import {
  reviewFeatureStates,
  reviewProjects,
  reviewServices,
} from "./fleet-review/states.mjs";

const config = loadConfig(
  "apps/fleet-manager/fleet-manager.json",
  "development",
);
const baseURL = process.env.MACHDOCH_FLEET_UI_URL ?? config.externalBaseUrl;
const username =
  process.env.MACHDOCH_FLEET_UI_USERNAME ??
  process.env.FLEET_MANAGER_SEED_USERNAME;
const password =
  process.env.MACHDOCH_FLEET_UI_PASSWORD ??
  process.env.FLEET_MANAGER_SEED_PASSWORD;
assert(username && password, "Fleet review credentials are required.");
await mkdir(output, { recursive: true });
await writeFile(
  `${output}/verification.json`,
  JSON.stringify(
    {
      passed: false,
      startedAt: new Date().toISOString(),
      phase: "Starting review",
    },
    null,
    2,
  ),
);
const mountSettings = await buildSettingsHarness();
const launchOptions = {
  headless: true,
  ...(process.env.CHROME_PATH
    ? { executablePath: process.env.CHROME_PATH }
    : { channel: process.platform === "win32" ? "msedge" : "chrome" }),
};
const browser = await chromium.launch(launchOptions);
const results = [];
const errors = [];
const control = await browser.newContext({ baseURL });
const login = await control.newPage();
login.setDefaultTimeout(15_000);
let grantId;
let passed = false;
let failure;
let live;

try {
  assert.equal((await control.request.get("/healthz")).status(), 200);
  await login.goto("/login");
  await login
    .getByLabel("Username", { exact: true })
    .fill("invalid-fleet-review-user");
  await login
    .getByLabel("Password", { exact: true })
    .fill("invalid-fleet-review-password");
  await login.getByRole("button", { name: "Sign in", exact: true }).click();
  await login
    .getByRole("alert")
    .filter({ hasText: "Username or password is incorrect." })
    .waitFor();
  await login.getByLabel("Username", { exact: true }).fill(username);
  await login.getByLabel("Password", { exact: true }).fill(password);
  await login.getByRole("button", { name: "Sign in", exact: true }).click();
  await login.waitForURL("**/instances");
  const inventory = await login.evaluate(async () =>
    (await fetch("/api/instances")).json(),
  );
  const instance = inventory.instances.find(
    (item) => item.status !== "revoked",
  );
  assert(
    instance,
    "An enrolled instance is required for the server-rendered product route.",
  );
  const hostSnapshot = await login.evaluate(async (id) => {
    const response = await fetch(
      `/api/instances/${encodeURIComponent(id)}/product/snapshot`,
    );
    return { status: response.status };
  }, instance.instanceId);
  let offlineConsoleVerified = false;
  if (instance.status === "offline" && hostSnapshot.status === 503) {
    await login.goto(`/instances/${encodeURIComponent(instance.instanceId)}`);
    const retry = login.getByRole("button", { name: "Retry", exact: true });
    await retry.waitFor();
    const retryResponse = login.waitForResponse((response) =>
      response.url().endsWith("/product/snapshot"),
    );
    await retry.click();
    assert.equal((await retryResponse).status(), 503);
    await capture(login, "live-disconnected");
    offlineConsoleVerified = true;
  }
  const settingsResponse = await login.goto("/settings");
  live = {
    checkedAt: new Date().toISOString(),
    instanceStatus: instance.status,
    snapshotStatus: hostSnapshot.status,
    offlineConsoleVerified,
    settingsEnabled: config.settingsManager.enabled,
    settingsPageStatus: settingsResponse.status(),
  };
  assert.equal(live.settingsPageStatus, live.settingsEnabled ? 200 : 404);
  results.push(
    `Live availability: host ${live.instanceStatus} (snapshot ${live.snapshotStatus}); Settings Manager ${live.settingsEnabled ? "enabled" : "disabled"} (page ${live.settingsPageStatus})`,
  );
  await login.goto("/enrollment");
  const createdResponse = login.waitForResponse(
    (response) =>
      response.url().endsWith("/api/enrollment-keys") &&
      response.request().method() === "POST",
  );
  await login
    .getByRole("button", { name: "Create enrollment key", exact: true })
    .click();
  const grant = await (await createdResponse).json();
  assert(grant.grantId, "Enrollment key creation failed");
  grantId = grant.grantId;
  await login.getByLabel("Enrollment key", { exact: true }).waitFor();
  await login
    .getByText(grantId, { exact: true })
    .locator("..")
    .locator("..")
    .getByRole("button", { name: "Revoke", exact: true })
    .click();
  await login
    .getByText(grantId, { exact: true })
    .waitFor({ state: "detached" });
  grantId = undefined;
  results.push(
    "Live app: health, rejected/accepted login, enrollment key creation and revocation",
  );
  const storageState = await control.storageState();
  for (const viewport of [
    { name: "desktop", width: 1440, height: 960 },
    { name: "tablet", width: 768, height: 1024 },
    { name: "mobile", width: 390, height: 844 },
    { name: "narrow", width: 320, height: 640 },
  ]) {
    const context = await browser.newContext({
      baseURL,
      viewport,
      hasTouch: viewport.width <= 900,
      isMobile: viewport.width <= 900,
      storageState,
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (
        message.type() === "error" &&
        !message.text().startsWith("Failed to load resource:")
      )
        errors.push(message.text());
    });
    try {
      results.push(
        await reviewDashboard(page, viewport.name, [
          instance,
          {
            ...instance,
            instanceId: "instance_review_revoked",
            displayName: "Revoked review instance",
            status: "revoked",
          },
        ]),
      );
      results.push(await reviewDashboardRecovery(page, viewport.name));
      const fixture = await reviewProduct(
        page,
        viewport.name,
        instance.instanceId,
      );
      assert.equal(
        await page
          .getByRole("link", {
            name: "Settings",
            exact: true,
            includeHidden: true,
          })
          .count(),
        live.settingsEnabled ? 1 : 0,
      );
      results.push(
        `${viewport.name}: chat drafts, send recovery, sessions, task cancellation, model IME, disconnection, activity tabs, scheduler actions, RALPH validation/run, modal focus, media preview`,
      );
      results.push(await reviewSessionActions(page, viewport.name, fixture));
      results.push(await reviewActivity(page, viewport.name, fixture));
      results.push(await reviewMediaStates(page, viewport.name, fixture));
      results.push(await reviewFeatureStates(page, viewport.name, fixture));
      results.push(await reviewProjects(page, viewport.name, fixture));
      results.push(
        await reviewServices(page, viewport.name, instance.instanceId, fixture),
      );
      results.push(
        await reviewServiceCommands(
          page,
          viewport.name,
          instance.instanceId,
          fixture,
        ),
      );
      results.push(
        await reviewServiceEditing(
          page,
          viewport.name,
          instance.instanceId,
          fixture,
        ),
      );
      results.push(
        await reviewServicePreviews(
          page,
          viewport.name,
          instance.instanceId,
          fixture,
        ),
      );
      results.push(
        await reviewChatWorkflows(page, viewport.name, instance.instanceId),
      );
      results.push(await reviewSettings(page, viewport.name, mountSettings));
      console.log(`Completed ${viewport.name} review`);
    } catch (error) {
      await capture(page, `${viewport.name}-failure`);
      throw error;
    } finally {
      await context.close();
    }
  }
  assert.deepEqual(errors, [], "Unexpected browser errors");
  await login.goto("/instances");
  await login
    .getByRole("button", { name: "Sign out", exact: true })
    .filter({ visible: true })
    .click();
  await login.waitForURL("**/login");
  results.push("Live app: sign out");
  passed = true;
} catch (reason) {
  failure = reason;
} finally {
  try {
    if (grantId)
      await login.evaluate(async (id) => {
        const token = document.cookie
          .split(";")
          .map((part) => part.trim())
          .find((part) => part.startsWith("__Host-machdoch_fleet_csrf="))
          ?.split("=")
          .slice(1)
          .join("=");
        const response = await fetch(
          `/api/enrollment-keys/${encodeURIComponent(id)}`,
          { method: "DELETE", headers: { "X-Machdoch-Fleet-CSRF": token } },
        );
        if (!response.ok)
          throw new Error("Review enrollment key cleanup failed.");
      }, grantId);
    if (login.url().startsWith(baseURL)) {
      await login.evaluate(async () => {
        const token = document.cookie
          .split(";")
          .map((part) => part.trim())
          .find((part) => part.startsWith("__Host-machdoch_fleet_csrf="))
          ?.split("=")
          .slice(1)
          .join("=");
        if (!token) return;
        const response = await fetch("/api/auth/logout", {
          method: "POST",
          headers: { "X-Machdoch-Fleet-CSRF": token },
        });
        if (!response.ok && response.status !== 401)
          throw new Error("Review session cleanup failed.");
      });
    }
  } catch (reason) {
    errors.push(`Cleanup failed: ${reason.message}`);
    failure ??= reason;
  }
  await browser.close();
  await writeFile(
    `${output}/verification.json`,
    JSON.stringify(
      {
        passed: passed && !failure,
        live,
        results,
        errors,
        failure: failure?.message,
      },
      null,
      2,
    ),
  );
  console.log(results.join("\n"));
}

if (failure) throw failure;
