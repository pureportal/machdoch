import assert from "node:assert/strict";
import { fleetRunsFixture } from "../fixtures/fleet-review.mjs";
import { capture } from "./browser.mjs";

export async function reviewServicePreviews(page, size, instanceId, fixture) {
  const data = fleetRunsFixture(fixture.snapshot.shell.workspaces[0].root);
  data.previewsEnabled = true;
  data.snapshot.statuses[0].state = "running";
  data.snapshot.statuses[0].pid = 12345;
  let statusFailed = false;
  let launchMode = "failed";
  let closeFailed = true;
  const requests = [];
  await page.route("**/runs?*", (route) => {
    assert.equal(route.request().method(), "GET");
    return route.fulfill({
      status: statusFailed ? 503 : 200,
      json: statusFailed
        ? { error: "Preview status unavailable. Try again." }
        : data,
    });
  });
  await page.context().route("**/review-preview-launch", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Preview fixture</title><p>Preview fixture</p>",
    }),
  );
  await page.route("**/api/instances/*/previews**", async (route) => {
    const request = route.request();
    requests.push({ method: request.method(), body: request.postDataJSON() });
    if (request.method() === "DELETE") {
      assert(
        new URL(request.url()).searchParams.get("id") === "review-preview",
      );
      if (!closeFailed) data.previews = [];
      await route.fulfill({
        status: closeFailed ? 503 : 200,
        json: closeFailed
          ? { error: "Preview could not be closed. Try again." }
          : { ok: true },
      });
      return;
    }
    assert.equal(request.method(), "POST");
    assert.equal(request.postDataJSON().target.configurationId, "frontend");
    if (launchMode === "failed") {
      await route.fulfill({
        status: 503,
        json: { error: "Preview could not be opened. Try again." },
      });
      return;
    }
    if (launchMode === "invalid") {
      await route.fulfill({
        json: { url: "https://invalid-preview.example/" },
      });
      return;
    }
    statusFailed = true;
    data.previews = [
      {
        id: "review-preview",
        origin: "https://preview.example",
        configurationId: "frontend",
        port: 4173,
        expiresAt: Date.now() + 3600_000,
        connections: 0,
      },
    ];
    await route.fulfill({ json: { url: "/review-preview-launch" } });
  });
  await page.goto(`/instances/${instanceId}/runs`);
  const preview = page.getByRole("button", {
    name: "Preview :4173",
    exact: true,
  });
  await preview.waitFor();
  await page.evaluate(() => {
    window.reviewOriginalOpen = window.open;
    window.open = () => null;
  });
  await preview.click();
  await page.getByRole("alert").filter({ hasText: "Allow pop-ups" }).waitFor();
  assert.equal(requests.length, 0);
  await page.evaluate(() => {
    window.open = window.reviewOriginalOpen;
    delete window.reviewOriginalOpen;
  });
  for (const mode of ["failed", "invalid"]) {
    launchMode = mode;
    const popupPromise = page.waitForEvent("popup");
    await preview.click();
    const popup = await popupPromise;
    const closed = popup.isClosed()
      ? Promise.resolve()
      : popup.waitForEvent("close");
    await page
      .getByRole("alert")
      .filter({
        hasText:
          mode === "failed"
            ? "Preview could not be opened"
            : "Invalid preview launch URL",
      })
      .waitFor();
    await closed;
  }
  launchMode = "success";
  const popupPromise = page.waitForEvent("popup");
  await preview.click();
  const popup = await popupPromise;
  try {
    await popup.waitForURL("**/review-preview-launch");
    assert.equal(await popup.evaluate(() => window.opener), null);
    await page
      .getByRole("alert")
      .filter({ hasText: "Preview status unavailable" })
      .waitFor();
    assert.equal(
      popup.isClosed(),
      false,
      "Accepted previews must survive a failed status refresh",
    );
    assert(await preview.isDisabled());
    await capture(page, `${size}-preview-refresh-error`);
    statusFailed = false;
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await page
      .getByRole("region", { name: "Private previews", exact: true })
      .waitFor();
    await page
      .getByRole("button", { name: "Close preview", exact: true })
      .click();
    await page
      .getByRole("alert")
      .filter({ hasText: "Preview could not be closed" })
      .waitFor();
    closeFailed = false;
    await page
      .getByRole("button", { name: "Close preview", exact: true })
      .click();
    await page
      .getByRole("region", { name: "Private previews", exact: true })
      .waitFor({ state: "detached" });
    assert.equal(
      requests.filter((request) => request.method === "POST").length,
      3,
    );
    assert.equal(
      requests.filter((request) => request.method === "DELETE").length,
      2,
    );
    await capture(page, `${size}-preview-closed`);
  } finally {
    await popup.close();
  }
  return `${size}: preview popup denial, launch failure, invalid launch URL, successful launch with failed refresh, close failure/retry (fixtures; no host preview opened)`;
}
