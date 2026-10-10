import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyKeyboardViewport } from "./mobile-viewport-verification.mjs";

export async function selectProductView(page, label) {
  await page.bringToFront();
  await page
    .locator(".m-application-navigation")
    .waitFor({ state: "attached" });
  const trigger = page.getByRole("button", {
    name: "Open navigation",
    exact: true,
  });
  if (await trigger.isVisible()) {
    await trigger.click();
    await page.getByRole("menuitem", { name: label, exact: true }).click();
  } else {
    await page.getByRole("button", { name: label, exact: true }).click();
  }
}

export const palette = (page) =>
  page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    const sample = document.createElement("span");
    sample.hidden = true;
    document.body.append(sample);
    try {
      return Object.fromEntries(
        [
          "--app-bg",
          "--app-surface",
          "--app-text",
          "--app-border",
          "--app-sky-500",
        ].map((name) => {
          if (!style.getPropertyValue(name).trim())
            throw new Error(`Missing theme color: ${name}`);
          sample.style.color = `var(${name})`;
          return [name, getComputedStyle(sample).color];
        }),
      );
    } finally {
      sample.remove();
    }
  });

export async function verifyClientUi(context, expectedPalette, fixtureRoot) {
  const buildPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../client/dist/ui-preview",
  );
  await readFile(join(buildPath, "index.html"));
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(
        new URL(request.url, "http://127.0.0.1").pathname,
      );
      const file = resolve(
        buildPath,
        pathname === "/" ? "index.html" : pathname.slice(1),
      );
      if (!file.startsWith(`${buildPath}${sep}`)) {
        response.writeHead(403).end();
        return;
      }
      const content = await readFile(file);
      const types = {
        ".html": "text/html",
        ".js": "text/javascript",
        ".css": "text/css",
        ".png": "image/png",
        ".svg": "image/svg+xml",
      };
      response.writeHead(200, {
        "Content-Type": types[extname(file)] ?? "application/octet-stream",
      });
      response.end(content);
    } catch (error) {
      response.writeHead(error.code === "ENOENT" ? 404 : 500).end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const client = await context.newPage();
  try {
    await client.bringToFront();
    await client.setViewportSize({ width: 1280, height: 900 });
    await client.goto(`http://127.0.0.1:${server.address().port}`);
    await client.locator(".m-application-shell.app-shell").waitFor();
    await client
      .getByRole("button", { name: "Skip first-startup setup", exact: true })
      .click();
    await client
      .getByRole("dialog", { name: "Prepare Machdoch", exact: true })
      .waitFor({ state: "hidden" });
    assert.deepEqual(
      await palette(client),
      expectedPalette,
      "Client and Fleet palettes differ.",
    );
    assert.ok(await client.locator(".m-application-navigation").isVisible());
    await client.screenshot({
      path: join(fixtureRoot, "shared-client-desktop.png"),
      fullPage: true,
    });
    await client.setViewportSize({ width: 390, height: 844 });
    await selectProductView(client, "Chat");
    const composer = client.getByRole("textbox", {
      name: "Task composer",
      exact: true,
    });
    await composer.waitFor();
    await composer.fill("Review the phone layout\nand keep the message draft.");
    const options = client.getByRole("button", {
      name: "Composer options",
      exact: true,
    });
    await options.waitFor({ state: "visible" });
    await options.click();
    assert.equal(await options.getAttribute("aria-expanded"), "true");
    await options.click();
    await client
      .getByRole("button", { name: "Session actions", exact: true })
      .click();
    await client
      .getByRole("textbox", { name: "Session tags", exact: true })
      .waitFor();
    await client.keyboard.press("Escape");
    await client
      .getByRole("button", { name: "Open sessions", exact: true })
      .click();
    await client.getByRole("dialog").waitFor();
    await client
      .getByRole("dialog")
      .getByRole("button", { name: "Close sessions", exact: true })
      .click();
    await client.screenshot({
      path: join(fixtureRoot, "shared-client-chat-mobile.png"),
    });
    const keyboardViewport = await verifyKeyboardViewport(
      client,
      fixtureRoot,
      "machdoch-chat",
    );
    await client.setViewportSize({ width: 920, height: 414 });
    await options.waitFor({ state: "visible" });
    const send = await client
      .getByRole("button", { name: "Send message", exact: true })
      .boundingBox();
    assert.ok(send && send.y >= 0 && send.y + send.height <= 414);
    assert.ok(
      await client.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    await client.screenshot({
      path: join(fixtureRoot, "shared-client-chat-landscape.png"),
    });
    await client.setViewportSize({ width: 390, height: 844 });
    await client
      .getByRole("button", { name: "Open navigation", exact: true })
      .click();
    await client
      .getByRole("menuitem", { name: "Media Studio", exact: true })
      .click();
    await client.locator(".m-media-studio-layout").waitFor();
    assert.ok(
      await client.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    await client.screenshot({
      path: join(fixtureRoot, "shared-client-mobile.png"),
      fullPage: true,
    });
    return keyboardViewport;
  } finally {
    await client.close();
    server.closeAllConnections();
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

async function assertViewport(page) {
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    "Product overflows the viewport.",
  );
  const shell = await page.locator(".m-application-shell").boundingBox();
  const content = await page.locator(".m-product-layout").boundingBox();
  assert.ok(
    shell && content && content.height > 200 && content.width > 200,
    "Product content has no usable space.",
  );
}

export async function verifyProductUi({
  page,
  small,
  api,
  origin,
  fixtureRoot,
  device,
}) {
  const instanceId = device.connection.instanceId;
  const path = `/instances/${instanceId}`;
  await page.bringToFront();
  const appearancePage = await page.goto(`${origin}/users`);
  await writeFile(
    join(fixtureRoot, "appearance-server.html"),
    await appearancePage.text(),
  );
  await page
    .getByRole("heading", { name: "Appearance", exact: true })
    .waitFor();
  await page.getByRole("button", { name: "Dark", exact: true }).click();
  await page.getByRole("button", { name: "Sky", exact: true }).click();
  const dashboardPalette = await palette(page);
  assert.ok(await page.locator(".m-application-navigation").isVisible());
  await page.screenshot({
    path: join(fixtureRoot, "shared-dashboard-desktop.png"),
    fullPage: true,
  });
  await verifyClientUi(page.context(), dashboardPalette, fixtureRoot);
  await page.bringToFront();
  await page.goto(`${origin}${path}`);
  await page.getByRole("button", { name: "Chat", exact: true }).waitFor();
  assert.deepEqual(
    await palette(page),
    dashboardPalette,
    "Fleet and device colors differ.",
  );
  await selectProductView(page, "Chat");
  await page
    .getByRole("textbox", { name: "Task composer", exact: true })
    .waitFor();
  await assertViewport(page);
  const draft = "Fleet draft retained across views";
  await page
    .getByRole("textbox", { name: "Task composer", exact: true })
    .fill(draft);
  await selectProductView(page, "Media Studio");
  const media = page.frameLocator('iframe[title="Media Studio"]');
  await media.locator(".m-media-studio-layout").waitFor();
  const mediaFrame = await (
    await page.locator('iframe[title="Media Studio"]').elementHandle()
  ).contentFrame();
  assert.ok(mediaFrame);
  assert.deepEqual(
    await palette(mediaFrame),
    dashboardPalette,
    "Media Studio colors differ.",
  );
  await selectProductView(page, "Chat");
  assert.equal(
    await page
      .getByRole("textbox", { name: "Task composer", exact: true })
      .inputValue(),
    draft,
  );
  await page.screenshot({
    path: join(fixtureRoot, "shared-chat-desktop.png"),
    fullPage: true,
  });
  await small.bringToFront();
  await small.goto(`${origin}/users`);
  await small
    .getByRole("button", { name: "Open navigation", exact: true })
    .click();
  await small.getByRole("menuitem", { name: "Overview", exact: true }).click();
  await small.waitForURL(`${origin}/instances`);
  assert.ok(
    await small.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await small.screenshot({
    path: join(fixtureRoot, "shared-dashboard-mobile.png"),
    fullPage: true,
  });
  await small.goto(`${origin}${path}`);
  await small
    .getByRole("button", { name: "Open navigation", exact: true })
    .waitFor();
  await selectProductView(small, "Chat");
  await small
    .getByRole("textbox", { name: "Task composer", exact: true })
    .waitFor();
  await assertViewport(small);
  await small.getByRole("button", { name: "Sessions", exact: true }).click();
  const sessions = small.getByRole("dialog", { name: "Sessions", exact: true });
  await sessions.waitFor();
  await sessions.getByRole("button", { name: "New", exact: true }).click();
  await sessions.waitFor({ state: "hidden" });
  await small.screenshot({
    path: join(fixtureRoot, "shared-chat-mobile.png"),
    fullPage: true,
  });
  const product = await api(`/instances/${instanceId}/product/snapshot`);
  assert.ok(
    product.shell.sessions.length >= 2,
    "New remote session did not reach the host.",
  );
  await page.bringToFront();
  await page.goto(`${origin}/users`);
  await page.getByRole("button", { name: "Light", exact: true }).click();
  await page.getByRole("button", { name: "Violet", exact: true }).click();
  const lightPalette = await palette(page);
  assert.notDeepEqual(lightPalette, dashboardPalette);
  await page.goto(`${origin}${path}`);
  await page.getByRole("button", { name: "Chat", exact: true }).waitFor();
  assert.deepEqual(
    await palette(page),
    lightPalette,
    "Appearance did not survive navigation.",
  );
  await selectProductView(page, "Chat");
  await page.screenshot({
    path: join(fixtureRoot, "shared-chat-light.png"),
    fullPage: true,
  });
  await page.goto(`${origin}/users`);
  await page.getByRole("button", { name: "Dark", exact: true }).click();
  await page.getByRole("button", { name: "Sky", exact: true }).click();
  return "Shared client/dashboard/device navigation, desktop/mobile Chat, live session creation, view-switch draft retention, Media palette, and persistent light/dark accents passed in the production browser UI.";
}
