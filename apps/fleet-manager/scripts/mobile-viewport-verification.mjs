import assert from "node:assert/strict";
import { join } from "node:path";

export async function setVisibleViewport(page, height, offsetTop = 0) {
  await page.evaluate(
    ({ height, offsetTop }) => {
      Object.defineProperties(window.visualViewport, {
        height: { configurable: true, value: height },
        offsetTop: { configurable: true, value: offsetTop },
      });
      window.visualViewport.dispatchEvent(new Event("resize"));
      window.visualViewport.dispatchEvent(new Event("scroll"));
    },
    { height, offsetTop },
  );
  await page.waitForFunction(
    ({ height }) =>
      Math.abs(
        document.querySelector(".m-application-shell").getBoundingClientRect()
          .height - height,
      ) < 1,
    { height },
  );
}

export async function insideVisibleViewport(page, locator) {
  const box = await locator.boundingBox();
  const viewport = await page.evaluate(() => ({
    width: innerWidth,
    height: visualViewport.height,
    offsetTop: visualViewport.offsetTop,
  }));
  assert.ok(
    box &&
      box.x >= 0 &&
      box.y >= viewport.offsetTop - 1 &&
      box.x + box.width <= viewport.width + 1 &&
      box.y + box.height <= viewport.offsetTop + viewport.height + 1,
    `Control outside visible viewport: ${(await locator.getAttribute("aria-label")) ?? (await locator.getAttribute("role"))} ${JSON.stringify({ box, viewport })}`,
  );
}

export async function restoreVisibleViewport(page) {
  await page.evaluate(() => {
    delete window.visualViewport.height;
    delete window.visualViewport.offsetTop;
    window.visualViewport.dispatchEvent(new Event("resize"));
    window.visualViewport.dispatchEvent(new Event("scroll"));
  });
  await page.waitForFunction(
    () =>
      Math.abs(
        document.querySelector(".m-application-shell").getBoundingClientRect()
          .height - visualViewport.height,
      ) < 1,
  );
}

export async function verifyKeyboardViewport(page, artifactRoot, prefix) {
  await page.setViewportSize({ width: 390, height: 844 });
  const input = page.getByRole("textbox", {
    name: "Task composer",
    exact: true,
  });
  const draft = Array.from(
    { length: 20 },
    (_, index) => `Line ${index + 1}`,
  ).join("\n");
  await input.fill(draft);
  await setVisibleViewport(page, 360, 40);
  assert.equal(await page.evaluate(() => innerHeight), 844);
  await page.screenshot({ path: join(artifactRoot, `${prefix}-keyboard.png`) });
  await insideVisibleViewport(page, input);
  await insideVisibleViewport(
    page,
    page.getByRole("button", { name: "Send message", exact: true }),
  );
  const measurement = {
    layout: page.viewportSize(),
    visible: await page.evaluate(() => ({
      height: visualViewport.height,
      offsetTop: visualViewport.offsetTop,
    })),
    input: await input.boundingBox(),
    send: await page
      .getByRole("button", { name: "Send message", exact: true })
      .boundingBox(),
  };
  await page.locator(".m-composer-surface-model button").click();
  const model = page.getByRole("dialog", {
    name: "Session model",
    exact: true,
  });
  await model.waitFor();
  await insideVisibleViewport(page, model);
  await page.keyboard.press("Escape");
  await restoreVisibleViewport(page);
  assert.equal(await input.inputValue(), draft);
  return measurement;
}
