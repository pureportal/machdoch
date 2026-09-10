import { resolve } from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { build } from "vite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const close = '[aria-label="Close session memory"]';
const toggle = '[role="switch"]';
const firstForget = "tbody tr:first-child button";
const lastForget = "tbody tr:last-child button";
let browser: Browser;
let page: Page;
let script: string;
let styles: string;

beforeAll(async () => {
  const result = await build({
    configFile: false,
    logLevel: "error",
    define: { "process.env.NODE_ENV": JSON.stringify("development") },
    build: {
      write: false,
      minify: false,
      lib: {
        entry: resolve("src/memory-management.browser-fixture.tsx"),
        name: "MemoryDialogFixture",
        formats: ["iife"],
      },
    },
  });
  const outputs = (Array.isArray(result) ? result : [result]).flatMap(
    (output) => ("output" in output ? output.output : []),
  );
  script = outputs
    .filter((output) => output.type === "chunk")
    .map((output) => output.code)
    .join("\n");
  styles = outputs
    .flatMap((output) =>
      output.type === "asset" && output.fileName.endsWith(".css")
        ? [String(output.source)]
        : [],
    )
    .join("\n");
  expect(script.length).toBeGreaterThan(0);
  expect(styles.length).toBeGreaterThan(0);
  browser = await puppeteer.launch({
    executablePath:
      process.env.CHROME_PATH ??
      "C:/Program Files/Google/Chrome/Application/chrome.exe",
    headless: true,
    timeout: 60_000,
  });
  page = await browser.newPage();
}, 120_000);

beforeEach(async () => {
  await page.goto("about:blank");
  await page.setContent(
    '<div id="root"></div><button id="external">External</button>',
  );
  await page.addStyleTag({ content: styles });
  await page.addScriptTag({ content: script });
}, 60_000);

afterAll(async () => {
  await browser?.close();
}, 60_000);

async function openDialog() {
  await page.click("#opener");
  await page.waitForSelector('[role="dialog"], dialog');
  await expectFocus(close);
}

async function expectFocus(selector: string) {
  const focused = await page.evaluate(
    (value) => ({
      matches: document.activeElement === document.querySelector(value),
      element: document.activeElement?.outerHTML.slice(0, 300),
    }),
    selector,
  );
  expect(
    focused.matches,
    `Expected ${selector}, focused ${focused.element}`,
  ).toBe(true);
}

async function tab(reverse = false) {
  if (reverse) await page.keyboard.down("Shift");
  await page.keyboard.press("Tab");
  if (reverse) await page.keyboard.up("Shift");
}

async function expectClosed() {
  await page.waitForFunction(
    () => !document.querySelector('[role="dialog"], dialog'),
  );
  await expectFocus("#opener");
  await tab();
  await expectFocus("#background");
  await page.keyboard.press("Escape");
  expect(await page.evaluate(() => window.memoryDialogFixture.closeCount)).toBe(
    1,
  );
}

describe("session memory modal browser focus", { timeout: 30_000 }, () => {
  it("moves ordinary background focus when closed", async () => {
    await page.focus("#opener");
    await tab();
    await expectFocus("#background");
    await tab(true);
    await expectFocus("#opener");
  });

  it("initially focuses the close control", async () => {
    await openDialog();
  });

  it("wraps forward navigation from the last control to the first", async () => {
    await openDialog();
    for (const selector of [firstForget, lastForget, toggle, close]) {
      await tab();
      await expectFocus(selector);
    }
  });

  it("wraps reverse navigation from the first control to the last", async () => {
    await openDialog();
    for (const selector of [toggle, lastForget, firstForget, close]) {
      await tab(true);
      await expectFocus(selector);
    }
  });

  it("rejects background focus even outside the React root", async () => {
    await openDialog();
    for (const selector of ["#opener", "#background", "#external"]) {
      await page.focus(selector);
      await expectFocus(close);
    }
  });

  it("blocks background pointer activation", async () => {
    await openDialog();
    await page.click("#background");
    expect(
      await page.evaluate(() => window.memoryDialogFixture.backgroundCount),
    ).toBe(0);
  });

  it.each([false, true])(
    "contains navigation after the focused control is disabled (reverse=%s)",
    async (reverse) => {
      await openDialog();
      await page.focus(lastForget);
      await page.evaluate(() =>
        window.memoryDialogFixture.update({ disabled: true }),
      );
      await tab(reverse);
      await expectFocus(close);
      await tab(reverse);
      await expectFocus(close);
    },
  );

  it("keeps focus inside when every button is disabled", async () => {
    await openDialog();
    await page.evaluate(() => {
      document
        .querySelectorAll<HTMLButtonElement>(".m-memory-dialog button")
        .forEach((button) => {
          button.disabled = true;
        });
    });
    for (const reverse of [false, true]) {
      await tab(reverse);
      expect(
        await page.evaluate(() =>
          document
            .querySelector('[role="dialog"], dialog')
            ?.contains(document.activeElement),
        ),
      ).toBe(true);
    }
    await page.focus("#background");
    expect(await page.evaluate(() => document.activeElement?.id)).not.toBe(
      "background",
    );
  });

  it("closes on Escape and restores the opener and background navigation", async () => {
    await openDialog();
    await page.keyboard.press("Escape");
    await expectClosed();
  });

  it("closes on the close button and restores the opener", async () => {
    await openDialog();
    await page.click(close);
    await expectClosed();
  });

  it("preserves focused controls across callback replacement", async () => {
    await openDialog();
    await page.focus(firstForget);
    await page.evaluate(() => window.memoryDialogFixture.update({}));
    await expectFocus(firstForget);
  });

  it("contains focus and restores it on repeated opening", async () => {
    for (let index = 0; index < 3; index += 1) {
      await openDialog();
      await page.focus(lastForget);
      await tab();
      await expectFocus(toggle);
      await page.keyboard.press("Escape");
      await page.waitForFunction(
        () => !document.querySelector('[role="dialog"], dialog'),
      );
      await expectFocus("#opener");
    }
    expect(
      await page.evaluate(() => window.memoryDialogFixture.closeCount),
    ).toBe(3);
  });

  it("releases restrictions and handlers when the open dialog unmounts", async () => {
    await openDialog();
    await page.evaluate(() =>
      window.memoryDialogFixture.update({ mounted: false }),
    );
    await expectFocus("#opener");
    await tab();
    await expectFocus("#background");
    await page.keyboard.press("Escape");
    expect(
      await page.evaluate(() => window.memoryDialogFixture.closeCount),
    ).toBe(0);
  });

  it("releases background interaction when the entire React root unmounts", async () => {
    await openDialog();
    await page.evaluate(() => window.memoryDialogFixture.unmount());
    await page.focus("#external");
    await expectFocus("#external");
    await page.keyboard.press("Escape");
    expect(
      await page.evaluate(() => window.memoryDialogFixture.closeCount),
    ).toBe(0);
  });

  it("closes safely after the opener is removed", async () => {
    await openDialog();
    await page.evaluate(() =>
      window.memoryDialogFixture.update({ opener: false }),
    );
    await page.keyboard.press("Escape");
    await page.waitForFunction(
      () => !document.querySelector('[role="dialog"], dialog'),
    );
    await page.focus("#background");
    await expectFocus("#background");
  });
});
