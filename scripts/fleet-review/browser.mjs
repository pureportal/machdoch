import assert from "node:assert/strict";

export const output =
  process.env.MACHDOCH_FLEET_REVIEW_OUTPUT ?? ".machdoch/e2e/fleet-review";

export async function capture(page, name) {
  const metrics = await page.evaluate(() => ({
    viewport: innerWidth,
    width: document.documentElement.scrollWidth,
  }));
  assert(
    metrics.width <= metrics.viewport + 1,
    `${name}: page overflows horizontally`,
  );
  await page.screenshot({
    path: `${output}/${name}.png`,
    fullPage: false,
    caret: "initial",
  });
}

export async function contained(page, selector) {
  const locator =
    typeof selector === "string" ? page.locator(selector) : selector;
  const box = await locator.boundingBox();
  const viewport = page.viewportSize();
  assert(
    box &&
      box.x >= -1 &&
      box.y >= -1 &&
      box.x + box.width <= viewport.width + 1 &&
      box.y + box.height <= viewport.height + 1,
    `${selector} is clipped: ${JSON.stringify(box)}`,
  );
}

export async function trapped(page) {
  for (let index = 0; index < 12; index++) {
    await page.keyboard.press(index < 6 ? "Tab" : "Shift+Tab");
    assert(
      await page
        .getByRole("dialog")
        .evaluate((dialog) => dialog.contains(document.activeElement)),
      "Focus escaped the dialog",
    );
  }
  await contained(page, page.getByRole("dialog"));
}

export async function command(fixture, kind, page) {
  await page.waitForFunction(
    () => !document.querySelector('[aria-label="Updating"]'),
  );
  assert(
    fixture.commands.some((item) => item.kind === kind),
    `Missing ${kind} command`,
  );
}

export async function activate(page, locator) {
  await locator.scrollIntoViewIfNeeded();
  if (await page.evaluate(() => matchMedia("(pointer: coarse)").matches))
    await locator.tap();
  else await locator.click();
}
