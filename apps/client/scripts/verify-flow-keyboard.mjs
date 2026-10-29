import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

const output = path.resolve("apps/client/dist/flow-designer-results");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--allow-file-access-from-files"],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.setDefaultTimeout(10_000);
const errors = [];
const checks = [];
page.on("pageerror", (error) => errors.push(error.message));
const node = (id) => page.locator(`.react-flow__node[data-id="${id}"]`);
const nodeCount = async (expected) =>
  page.waitForFunction(
    (expected) =>
      document.querySelectorAll(".react-flow__node").length === expected,
    expected,
  );
const waitForPosition = async (id, position) =>
  page.waitForFunction(
    ({ id, position }) =>
      document.querySelector(`.react-flow__node[data-id="${id}"]`).style
        .transform === position,
    { id, position },
  );
const focusCanvas = async () =>
  page.locator(".react-flow__pane").click({ position: { x: 25, y: 25 } });
try {
  await page.goto(
    pathToFileURL(
      path.resolve("apps/client/dist/flow-designers-verification/index.html"),
    ).href,
  );
  for (const designer of ["RALPH", "Media Studio"]) {
    await page
      .getByRole("navigation", { name: "Designers" })
      .getByRole("button", { name: designer, exact: true })
      .click();
    if (designer === "RALPH") {
      await page
        .getByRole("button", { name: "Create blank Ralph flow from canvas" })
        .click();
      await page.getByRole("button", { name: "Add Prompt block" }).click();
    } else {
      await page.getByRole("button", { name: "Add node", exact: true }).click();
      await page.getByPlaceholder("Search nodes", { exact: true }).fill("Seed");
      await page.getByRole("option", { name: "Seed", exact: true }).click();
    }
    const initialCount = designer === "RALPH" ? 3 : 4;
    await nodeCount(initialCount);
    const selectedCard =
      designer === "RALPH"
        ? node("prompt-1")
        : page.locator(".react-flow__node").filter({ hasText: /^sourceSeed/ });
    const id = await selectedCard.getAttribute("data-id");
    const card = node(id);
    const nameField = page.getByLabel(
      designer === "RALPH" ? "Block title" : "Node name",
      { exact: true },
    );
    const originalName = await nameField.inputValue();
    await nameField.fill("Keyboard edit");
    await nameField.press("Tab");
    await card.getByText("Keyboard edit", { exact: true }).waitFor();
    await page
      .getByRole("button", {
        name:
          designer === "RALPH" ? "Hide block settings" : "Close node inspector",
      })
      .click();
    await page.getByRole("button", { name: "Fit View", exact: true }).click();
    const header = card.getByText("Keyboard edit", { exact: true });
    await header.hover();
    const before = await card.evaluate((element) => element.style.transform);
    const box = await header.boundingBox();
    await page.mouse.move(box.x + 15, box.y + 5);
    await page.mouse.down();
    await page.mouse.move(box.x + 70, box.y + 65, { steps: 10 });
    await page.mouse.up();
    await page.waitForFunction(
      ({ id, before }) =>
        document.querySelector(`.react-flow__node[data-id="${id}"]`).style
          .transform !== before,
      { id, before },
    );
    const moved = await card.evaluate((element) => element.style.transform);
    await focusCanvas();
    await page.keyboard.press("Control+z");
    await waitForPosition(id, before);
    await card.getByText("Keyboard edit", { exact: true }).waitFor();
    await page.keyboard.press("Control+z");
    await card
      .locator("div.truncate.text-sm")
      .filter({ hasText: originalName })
      .waitFor();
    await page.keyboard.press("Control+Shift+z");
    await card.getByText("Keyboard edit", { exact: true }).waitFor();
    await page.keyboard.press("Control+y");
    await waitForPosition(id, moved);
    checks.push(
      `${designer}: keyboard undo/redo preserves edit order across names and positions`,
    );
    await card.click({ position: { x: 40, y: 25 } });
    await nameField.focus();
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Backspace");
    assert.equal(await page.locator(".react-flow__node").count(), initialCount);
    await nameField.fill("Keyboard edit");
    await nameField.press("Tab");
    checks.push(`${designer}: text editing does not delete canvas nodes`);
    await card.focus();
    await page.keyboard.press("Delete");
    await nodeCount(initialCount - 1);
    await focusCanvas();
    await page.keyboard.press("Control+z");
    await nodeCount(initialCount);
    await waitForPosition(id, moved);
    checks.push(`${designer}: delete and undo restore node and position`);
  }
  assert.deepEqual(errors, []);
  await writeFile(
    path.join(output, "keyboard-results.json"),
    JSON.stringify({ checks, errors }, null, 2),
  );
  console.log(JSON.stringify({ checks, errors }, null, 2));
} catch (error) {
  await page.screenshot({ path: path.join(output, "keyboard-failure.png") });
  console.error(JSON.stringify({ checks, errors }, null, 2));
  throw error;
} finally {
  await browser.close();
}
