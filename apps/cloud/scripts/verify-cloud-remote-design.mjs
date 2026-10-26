import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import axe from "axe-core";
import { startMobileFixture } from "./mobile-browser-fixture.mjs";
import { selectProductView } from "./verify-product-ui.mjs";

const fixture = await startMobileFixture();
const directory = resolve("../../.tmp/cloud-design/remote");
await mkdir(directory, { recursive: true });
const page = await fixture.context.newPage();
page.setDefaultTimeout(15000);
const errors = [],
  captures = [],
  accessibility = [];
page.on("pageerror", (error) => errors.push({ url: page.url(), message: error.message, stack: error.stack }));
async function capture(name) {
  await page.evaluate(() => document.fonts.ready);
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
    `${name}: horizontal overflow`,
  );
  await page.screenshot({
    path: join(directory, `${name}.png`),
    fullPage: true,
  });
  await page.evaluate(axe.source);
  const violations = await page.evaluate(async () =>
    (
      await window.axe.run(document, { runOnly: ["color-contrast"] })
    ).violations.map((item) => ({
      id: item.id,
      nodes: item.nodes.map((node) => ({
        target: node.target,
        summary: node.failureSummary,
      })),
    })),
  );
  if (violations.length) accessibility.push({ name, violations });
  captures.push(name);
  process.stdout.write(`PASS ${name}\n`);
}
try {
  for (const theme of ["dark", "light"]) {
    await page.goto(`${fixture.origin}/cloud/account`);
    await page
      .getByRole("button", {
        name: theme === "dark" ? "Dark" : "Light",
        exact: true,
      })
      .click();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${fixture.origin}/instances`);
    await page
      .getByRole("button", { name: "Details for Legion Go S", exact: true })
      .waitFor();
    await capture(`clients-${theme}`);
    await page
      .getByRole("button", { name: "Details for Legion Go S", exact: true })
      .click();
    await capture(`client-details-${theme}`);
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    await page.goto(`${fixture.origin}/instances/${fixture.instanceId}`);
    await selectProductView(page, "Chat");
    await page
      .getByRole("textbox", { name: "Task composer", exact: true })
      .fill("Review the connected workspace.");
    await capture(`client-chat-${theme}`);
    for (const label of [
      "Projects",
      "RALPH",
      "Smart Scheduler",
      "Workspace Management",
      "Instructions",
    ]) {
      const button = page
        .locator(".m-application-navigation")
        .getByRole("button", { name: label, exact: true });
      if (await button.count()) {
        await button.click();
        await capture(`${label.toLowerCase().replaceAll(" ", "-")}-${theme}`);
      }
    }
    await page.goto(`${fixture.origin}/instances/${fixture.instanceId}/runs`);
    await page
      .getByRole("heading", { name: "Services & previews", exact: true })
      .waitFor();
    await page.locator("main").getByRole("alert").waitFor();
    await capture(`services-${theme}`);
    await page.goto(`${fixture.origin}/instances/${fixture.instanceId}/speech`);
    await page
      .getByRole("heading", { name: "Text to Speech", exact: true })
      .waitFor();
    await capture(`speech-${theme}`);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${fixture.origin}/instances/${fixture.instanceId}`);
  await selectProductView(page, "Chat");
  await page
    .getByRole("textbox", { name: "Task composer", exact: true })
    .fill("Keep the workspace draft.");
  await capture("client-chat-mobile");
  await page.goto(`${fixture.origin}/instances/${fixture.instanceId}/speech`);
  await page
    .getByRole("heading", { name: "Text to Speech", exact: true })
    .waitFor();
  await capture("speech-mobile");
  assert.deepEqual(errors, []);
  await writeFile(
    join(directory, "results.json"),
    JSON.stringify(
      {
        captures,
        accessibility,
        errors,
        limitations:
          "Synthetic connected client; service and speech APIs expose their unavailable states. No physical device, AI generation, or speech playback was exercised.",
      },
      null,
      2,
    ),
  );
  assert.deepEqual(
    accessibility,
    [],
    "Contrast findings; see remote/results.json",
  );
} catch (error) {
  await writeFile(
    join(directory, "failure.json"),
    JSON.stringify(
      { message: error.message, url: page.url(), errors, accessibility },
      null,
      2,
    ),
  );
  await page.screenshot({
    path: join(directory, "failure.png"),
    fullPage: true,
  });
  throw error;
} finally {
  await fixture.close();
}
