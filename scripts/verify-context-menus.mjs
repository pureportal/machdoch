import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

const requireClient = createRequire(
  new URL("../apps/client/package.json", import.meta.url),
);
const { build } = await import(
  pathToFileURL(requireClient.resolve("vite")).href
);
const { default: tailwind } = await import(
  pathToFileURL(requireClient.resolve("@tailwindcss/vite")).href
);
const result = await build({
  configFile: false,
  root: resolve("apps/client"),
  logLevel: "error",
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [tailwind()],
  build: {
    write: false,
    lib: {
      entry: resolve(
        "apps/client/src/tauri/ui/__test__/context-menu-surfaces.tsx",
      ),
      formats: ["iife"],
      name: "ContextMenuReview",
    },
  },
});
const chunks = result.flatMap((bundle) => bundle.output);
const script = chunks.find((item) => item.type === "chunk").code;
const css = chunks
  .filter((item) => item.fileName.endsWith(".css"))
  .map((item) => item.source)
  .join("\n");
const output = resolve("apps/client/.cache/context-menu-review");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  channel: process.env.CHROME_CHANNEL ?? "chrome",
  headless: true,
});
const errors = [];
try {
  const page = await browser.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("http://127.0.0.1/context-menu-review", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Menu review</title></head><body><div id="root"></div></body></html>',
    }),
  );
  await page.goto("http://127.0.0.1/context-menu-review");
  await page.addStyleTag({ content: css });
  await page.evaluate(() => {
    window.copiedValues = [];
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: async (value) => window.copiedValues.push(value) },
    });
  });
  await page.addScriptTag({ content: script });

  const assertOpaque = async (locator) => {
    const alpha = await locator.evaluate((element) => {
      const context = document.createElement("canvas").getContext("2d");
      context.fillStyle = getComputedStyle(element).backgroundColor;
      context.fillRect(0, 0, 1, 1);
      return context.getImageData(0, 0, 1, 1).data[3];
    });
    assert.equal(alpha, 255, "Menu background must be opaque");
  };

  for (const theme of ["light", "dark"]) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    await page.getByTestId("path").click({ button: "right" });
    const copyMenu = page.getByRole("menu", { name: "Copy actions" });
    await assertOpaque(copyMenu);
    assert.equal(
      await page
        .getByTestId("path")
        .evaluate((element) => getComputedStyle(element).userSelect),
      "text",
    );
    await page.screenshot({ path: resolve(output, `${theme}-copy.png`) });
    await page.getByRole("menuitem", { name: "Copy full path" }).click();
    await copyMenu.waitFor({ state: "hidden" });
    assert.equal(
      await page.evaluate(() => window.copiedValues.at(-1)),
      "C:\\workspace\\src\\index.ts",
    );
    await page.getByRole("button", { name: "Actions", exact: true }).click();
    await assertOpaque(page.locator('[data-slot="dropdown-menu-content"]'));
    await page.getByRole("menuitem", { name: "More", exact: true }).hover();
    await page.getByRole("menuitem", { name: "Submenu action" }).waitFor();
    await assertOpaque(page.locator('[data-slot="dropdown-menu-sub-content"]'));
    await page.screenshot({ path: resolve(output, `${theme}-dropdown.png`) });
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await assertOpaque(
      page.getByRole("menu", { name: "Flow actions", exact: true }),
    );
    await page.getByRole("menuitem", { name: "Add block" }).hover();
    await page.getByRole("menuitem", { name: "Prompt", exact: true }).waitFor();
    await assertOpaque(
      page.getByRole("menuitem", { name: "Prompt", exact: true }).locator(".."),
    );
  }

  await page.getByTestId("output").evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element.querySelector("code"));
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await page.getByTestId("output").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Copy selection" }).click();
  assert.equal(
    await page.evaluate(() => window.copiedValues.at(-1)),
    "First line\nSecond line",
  );

  await page.getByTestId("path").focus();
  await page.keyboard.press("Shift+F10");
  await page.getByRole("menuitem", { name: "Copy full path" }).waitFor();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Escape");
  assert.equal(
    await page
      .getByTestId("path")
      .evaluate((element) => element === document.activeElement),
    true,
  );
  await page.getByTestId("path").click({ button: "right" });
  await page.getByRole("button", { name: "Outside", exact: true }).click();
  assert.equal(
    await page
      .getByRole("button", { name: "Outside", exact: true })
      .evaluate((element) => element === document.activeElement),
    true,
  );

  await page.getByRole("button", { name: "Details", exact: true }).click();
  await page
    .getByText("Connection failed", { exact: true })
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "Copy diagnostic" }).click();
  assert.equal(
    await page.evaluate(() => window.copiedValues.at(-1)),
    "Connection failed",
  );
  assert.equal(await page.getByRole("dialog").isVisible(), true);
  await page.keyboard.press("Escape");

  await page.setViewportSize({ width: 320, height: 480 });
  await page.getByTestId("path").evaluate((element) => {
    element.style.position = "fixed";
    element.style.right = "0";
    element.style.bottom = "0";
  });
  await page
    .getByTestId("path")
    .click({ button: "right", position: { x: 180, y: 10 } });
  const bounds = await page
    .getByRole("menu", { name: "Copy actions" })
    .boundingBox();
  assert.ok(
    bounds.x >= 0 &&
      bounds.y >= 0 &&
      bounds.x + bounds.width <= 320 &&
      bounds.y + bounds.height <= 480,
    "Context menu must fit the viewport",
  );
  await page.screenshot({ path: resolve(output, "narrow-copy.png") });
  assert.deepEqual(errors, []);
  console.log(
    "Context menus passed: themes, opacity, copying, selection, keyboard, focus, dialogs, and viewport edges.",
  );
} finally {
  await browser.close();
}
