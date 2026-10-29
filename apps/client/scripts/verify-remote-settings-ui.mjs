import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import axe from "axe-core";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const ui = JSON.parse(
  await readFile(join(root, ".tmp/cloud-desktop-ui/current.json"), "utf8"),
);
const output = join(root, ".tmp/cloud-design/remote-settings");
await mkdir(output, { recursive: true });

const server = createServer(async (request, response) => {
  try {
    const path = resolve(
      ui.directory,
      "." + decodeURIComponent(new URL(request.url, "http://localhost").pathname),
    );
    const child = relative(ui.directory, path);
    if (child.startsWith("..") || isAbsolute(child)) {
      response.writeHead(403).end();
      return;
    }
    const bytes = await readFile(path);
    response.setHeader(
      "Content-Type",
      {
        ".html": "text/html",
        ".js": "text/javascript",
        ".css": "text/css",
        ".woff2": "font/woff2",
        ".svg": "image/svg+xml",
      }[extname(path)] ?? "application/octet-stream",
    );
    response.end(bytes);
  } catch {
    response.writeHead(404).end();
  }
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
const url = `http://127.0.0.1:${address.port}/cloud-workspace-fixture.html`;

const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ??
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true,
});
const checks = [];
const captures = [];
const accessibility = [];
const errors = [];
const calls = [];
const unexpected = [];
export const state = { handlers: new Map() };

export function passed(name) {
  checks.push(name);
  process.stdout.write(`PASS ${name}\n`);
}

export async function openPanel({ width = 1280, height = 900, theme = "dark" } = {}) {
  const context = await browser.newContext({
    viewport: { width, height },
    colorScheme: theme,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      !message.text().startsWith("Failed to load resource")
    )
      errors.push(message.text());
  });
  page.on("response", (response) => {
    if (response.status() >= 400 && !response.url().endsWith("/favicon.ico"))
      errors.push(`${response.status()} ${response.url()}`);
  });
  await page.exposeFunction("fixtureInvoke", async (command, args) => {
    calls.push({ command, args });
    if (command === "plugin:event|listen") return 1;
    if (command === "plugin:event|unlisten") return null;
    const handler = state.handlers.get(command);
    if (!handler) {
      unexpected.push(command);
      throw new Error(`Unexpected native command: ${command}`);
    }
    return handler(args ?? {});
  });
  await page.addInitScript((selectedTheme) => {
    window.isTauri = true;
    document.addEventListener("DOMContentLoaded", () => {
      document.documentElement.dataset.theme = selectedTheme;
    });
    let callback = 0;
    window.__TAURI_INTERNALS__ = {
      metadata: {
        currentWindow: { label: "main" },
        currentWebview: { label: "main" },
      },
      transformCallback: () => ++callback,
      unregisterCallback: () => {},
      invoke: (command, args) => window.fixtureInvoke(command, args ?? {}),
    };
  }, theme);
  await page.goto(url);
  return { context, page };
}

export async function capture(page, name) {
  await page.evaluate(() => document.fonts.ready);
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
    `${name}: horizontal overflow`,
  );
  await page.screenshot({ path: join(output, `${name}.png`), fullPage: true });
  await page.evaluate(axe.source);
  const violations = await page.evaluate(async () =>
    (
      await window.axe.run(document, {
        runOnly: ["color-contrast", "button-name", "label"],
      })
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
  process.stdout.write(`CAPTURE ${name}\n`);
}

try {
  const scenario = await import("./verify-remote-settings-ui.scenario.mjs");
  await scenario.run({ state, openPanel, capture, passed, calls });
  assert.deepEqual(unexpected, [], `Unexpected native commands: ${unexpected}`);
  assert.deepEqual(errors, [], errors.join("\n"));
  passed("no page errors or unexpected native calls");
} finally {
  await writeFile(
    join(output, "results.json"),
    JSON.stringify({ checks, captures, accessibility, errors, unexpected }, null, 2),
  );
  await browser.close();
  server.close();
}
if (accessibility.length) {
  process.stdout.write(`ACCESSIBILITY ${JSON.stringify(accessibility, null, 2)}\n`);
  process.exitCode = 1;
}
