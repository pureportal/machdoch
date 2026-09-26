import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";

const url = process.env.MACHDOCH_CLIENT_UI_URL ?? "http://127.0.0.1:4173";
const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(url, { waitUntil: "load" });
  const skipSetup = page.getByRole("button", {
    name: "Skip setup",
    exact: true,
  });
  await skipSetup.waitFor({ state: "visible" });
  await skipSetup.click();
  await page
    .locator('[data-slot="dialog-overlay"]')
    .waitFor({ state: "hidden" });

  const textarea = page.getByRole("textbox", { name: "Task composer" });
  const send = page.getByRole("button", { name: "Send message" });
  const iterationButton = page.getByRole("button", {
    name: /^Iterations(?:: \d+)?$/,
  });
  const verifyLayout = async () => {
    const inputBounds = await textarea.boundingBox();
    const buttonBounds = await iterationButton.boundingBox();
    const sendBounds = await send.boundingBox();
    assert(inputBounds && buttonBounds && sendBounds);
    assert(buttonBounds.x >= inputBounds.x + inputBounds.width);
    assert(buttonBounds.x + buttonBounds.width <= sendBounds.x);
    await iterationButton.click();
    const iterations = page.getByRole("combobox", { name: "Iterations" });
    await iterations.waitFor({ state: "visible" });
    const pickerBounds = await iterations.boundingBox();
    assert(pickerBounds);
    assert(pickerBounds.x >= 0);
    assert(pickerBounds.x + pickerBounds.width <= page.viewportSize().width);
    return iterations;
  };

  assert.equal(
    await page.getByRole("combobox", { name: "Iterations" }).count(),
    0,
  );
  const compactIterations = await verifyLayout();
  await page.screenshot({
    path: path.join(os.tmpdir(), "machdoch-iterations-compact-picker.png"),
  });
  assert.equal(await compactIterations.inputValue(), "1");
  await compactIterations.selectOption("3");
  await page.getByRole("button", { name: "Iterations: 3" }).waitFor();
  await textarea.evaluate((element) => {
    element.style.height = "190px";
  });
  assert((await textarea.boundingBox()).height >= 180);
  const expandedIterations = await verifyLayout();
  await page.screenshot({
    path: path.join(os.tmpdir(), "machdoch-iterations-expanded-picker.png"),
  });
  assert.equal(await expandedIterations.inputValue(), "3");
  await expandedIterations.selectOption("4");
  await page.getByRole("button", { name: "Iterations: 4" }).waitFor();
  await page.getByRole("button", { name: "Iterations: 4" }).click();
  await page.getByRole("combobox", { name: "Iterations" }).selectOption("3");
  await textarea.evaluate((element) => {
    element.style.height = "";
  });
  await page
    .getByRole("textbox", { name: "Task composer" })
    .fill("Improve the UI of view XY");

  await page.evaluate(() => {
    window.__iterationQueueStates = [];
    const record = () => {
      const queue = document.querySelector('[aria-label="Queued messages"]');
      const state = queue
        ? {
            count: queue.querySelectorAll("li").length,
            text: queue.textContent ?? "",
          }
        : { count: 0, text: "" };
      const previous = window.__iterationQueueStates.at(-1);
      if (previous?.count !== state.count || previous?.text !== state.text) {
        window.__iterationQueueStates.push(state);
      }
    };
    new MutationObserver(record).observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });
    record();
  });

  await page.getByRole("button", { name: "Send message" }).click();
  const queue = page.getByRole("region", { name: "Queued messages" });
  if (await queue.isVisible()) {
    await page.screenshot({
      path: path.join(os.tmpdir(), "machdoch-iterations-queue.png"),
    });
  }

  await page.waitForFunction(
    () =>
      document.querySelectorAll('[data-message-role="user"]').length === 3 &&
      !document.querySelector('[aria-label="Queued messages"]') &&
      !document.querySelector(".app-composer-running-controls") &&
      document.querySelectorAll(
        '[data-message-role="agent"] .app-agent-message-bubble',
      ).length >= 3,
    null,
    { timeout: 20_000 },
  );

  const userRows = page.locator('[data-message-role="user"]');
  assert.equal(await userRows.count(), 3);
  for (let index = 1; index <= 3; index += 1) {
    assert.match(
      await userRows.nth(index - 1).innerText(),
      new RegExp(`Iteration ${index} of 3`),
    );
  }
  assert.match(await userRows.nth(0).innerText(), /Improve the UI of view XY/);
  assert.match(await userRows.nth(1).innerText(), /Continue/);
  assert.match(await userRows.nth(2).innerText(), /Continue/);
  await iterationButton.waitFor();
  await iterationButton.click();
  assert.equal(
    await page.getByRole("combobox", { name: "Iterations" }).inputValue(),
    "1",
  );
  await page.keyboard.press("Escape");

  const states = await page.evaluate(() => window.__iterationQueueStates);
  assert(states.some((state) => state.count === 3));
  assert(states.some((state) => state.text.includes("Iteration 2 of 3")));
  assert.equal(states.at(-1)?.count, 0);
  assert.deepEqual(pageErrors, []);

  await page.waitForFunction(
    () => {
      const raw = localStorage.getItem("machdoch.desktop.shell-state-snapshot");
      if (!raw) return false;
      const snapshot = JSON.parse(raw);
      const session = snapshot.state.sessions.find((entry) =>
        entry.messages.some((message) =>
          message.content.includes("Improve the UI of view XY"),
        ),
      );
      return (
        session?.messages.filter(
          (message) => message.source?.kind === "execution",
        ).length === 3
      );
    },
    null,
    { timeout: 20_000 },
  );

  await page.reload({ waitUntil: "load" });
  await page.getByText("Iteration 3 of 3").waitFor();
  assert.equal(await page.locator('[data-message-role="user"]').count(), 3);
  await page
    .locator(".app-composer-running-controls")
    .waitFor({ state: "hidden", timeout: 10_000 });

  await page.setViewportSize({ width: 390, height: 844 });
  await iterationButton.click();
  const narrowIterations = page.getByRole("combobox", {
    name: "Iterations",
  });
  await narrowIterations.selectOption("2");
  await page.getByRole("button", { name: "Iterations: 2" }).waitFor();
  await textarea.evaluate((element) => {
    element.style.height = "150px";
  });
  await iterationButton.click();
  assert.equal(await narrowIterations.inputValue(), "2");
  await narrowIterations.selectOption("1");
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
    true,
  );

  await page.screenshot({
    path: path.join(os.tmpdir(), "machdoch-iterations-complete.png"),
  });
  console.log(
    `Verified three queued iterations, execution order, and completion. Queue states: ${states.map((state) => state.count).join(" → ")}`,
  );
} finally {
  await browser.close();
}
