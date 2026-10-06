import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { palette, selectProductView } from "./verify-product-ui.mjs";

export async function verifyScheduler({
  page,
  small,
  origin,
  fixtureRoot,
  device,
}) {
  const path = `${origin}/instances/${device.connection.instanceId}`;
  await page.bringToFront();
  await page.goto(path);
  await selectProductView(page, "Smart Scheduler");
  const scheduler = page.frameLocator('iframe[title="Smart Scheduler"]');
  await scheduler
    .getByRole("heading", { name: "Smart Scheduler", exact: true })
    .waitFor();
  const iframe = await page
    .locator('iframe[title="Smart Scheduler"]')
    .elementHandle();
  const frame = await iframe.contentFrame();
  assert.ok(frame);
  assert.deepEqual(
    await palette(frame),
    await palette(page),
    "Scheduler colors differ from the remote shell.",
  );
  await scheduler
    .getByLabel("Name", { exact: true })
    .fill("Remote verification job");
  await scheduler
    .getByLabel("Prompt", { exact: true })
    .fill("Review the workspace");
  await scheduler
    .getByRole("button", { name: "interval", exact: true })
    .click();
  await scheduler.getByLabel("Interval ms", { exact: true }).fill("3600000");
  await selectProductView(page, "Chat");
  await selectProductView(page, "Smart Scheduler");
  assert.equal(
    await scheduler.getByLabel("Name", { exact: true }).inputValue(),
    "Remote verification job",
  );
  await scheduler.getByRole("button", { name: "Create", exact: true }).click();
  await scheduler
    .getByText("Created Remote verification job.", { exact: true })
    .waitFor();
  const statePath = join(device.workspace, ".machdoch", "scheduler.json");
  const readJob = async () =>
    JSON.parse(await readFile(statePath, "utf8")).jobs.find(
      (job) => job.name === "Remote verification job",
    );
  assert.equal((await readJob()).status, "active");
  const row = scheduler
    .locator("article")
    .filter({ hasText: "Remote verification job" });
  await row
    .getByRole("button", { name: "Pause scheduled job", exact: true })
    .click();
  await row
    .getByRole("button", { name: "Resume scheduled job", exact: true })
    .waitFor();
  assert.equal((await readJob()).status, "paused");
  await row
    .getByRole("button", { name: "Resume scheduled job", exact: true })
    .click();
  await row
    .getByRole("button", { name: "Pause scheduled job", exact: true })
    .waitFor();
  await scheduler.getByLabel("Name", { exact: true }).focus();
  await page.keyboard.press("Control+k");
  await scheduler.getByRole("dialog").waitFor();
  await scheduler.getByText("Refresh scheduler", { exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await page.screenshot({
    path: join(fixtureRoot, "shared-scheduler-desktop.png"),
    fullPage: true,
  });
  await small.bringToFront();
  await small.goto(path);
  await selectProductView(small, "Smart Scheduler");
  const mobile = small.frameLocator('iframe[title="Smart Scheduler"]');
  const mobileRow = mobile
    .locator("article")
    .filter({ hasText: "Remote verification job" });
  await mobileRow.waitFor();
  const mobileFrame = await (
    await small.locator('iframe[title="Smart Scheduler"]').elementHandle()
  ).contentFrame();
  assert.ok(
    await mobileFrame.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    "Scheduler overflows the mobile viewport.",
  );
  await mobile.getByLabel("Name", { exact: true }).fill("Mobile draft");
  await mobile.getByRole("button", { name: "RALPH Flow", exact: true }).click();
  assert.equal(
    await mobile
      .getByRole("button", { name: "Create", exact: true })
      .isDisabled(),
    true,
  );
  await small.screenshot({
    path: join(fixtureRoot, "shared-scheduler-mobile.png"),
    fullPage: true,
  });
  await mobileRow
    .getByRole("button", { name: "Delete scheduled job", exact: true })
    .click();
  await mobile
    .getByRole("dialog", {
      name: "Delete Remote verification job?",
      exact: true,
    })
    .waitFor();
  await mobile.getByRole("button", { name: "Cancel", exact: true }).click();
  await mobileRow
    .getByRole("button", { name: "Delete scheduled job", exact: true })
    .click();
  await mobile.getByRole("button", { name: "Delete job", exact: true }).click();
  await mobile
    .getByText("Deleted Remote verification job.", { exact: true })
    .waitFor();
  assert.equal((await readJob()).status, "deleted");
  return "The built shared Scheduler created a job through the authenticated TLS relay, retained its draft across views, paused/resumed it, opened its command palette, rendered on mobile, gated RALPH creation, and confirmed deletion.";
}
