import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";

const baseUrl = process.env.MACHDOCH_CLIENT_UI_URL ?? "http://127.0.0.1:4173";
const output = path.resolve("apps/client/.cache/responsive-review");
const reportName = process.env.MACHDOCH_CLIENT_REPORT ?? "report.json";
const sizes = process.env.MACHDOCH_CLIENT_VIEWPORTS
  ? JSON.parse(process.env.MACHDOCH_CLIENT_VIEWPORTS)
  : [
      [320, 568],
      [390, 844],
      [844, 390],
      [768, 1024],
      [1024, 768],
      [1440, 900],
    ];
const report = [];
const failures = [];
const errors = [];
const blocked = [];
await mkdir(output, { recursive: true });
const response = await fetch(baseUrl);
assert.equal(response.status, 200, "The existing client must be running");
const browser = await chromium.launch({
  channel: process.env.MACHDOCH_BROWSER_CHANNEL ?? "chrome",
  headless: true,
});

async function capture(page, label) {
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  const metrics = await page.evaluate(() => {
    const bounds = (element) => {
      const { x, y, width, height } = element.getBoundingClientRect();
      return { x, y, width, height };
    };
    const visible = (element) =>
      element.checkVisibility() && element.getBoundingClientRect().width > 0;
    return {
      hasVisibleContent:
        document.body.innerText.trim().length > 0 ||
        [
          ...document.querySelectorAll("button,input,textarea,img,canvas,svg"),
        ].some(visible),
      viewport: { width: innerWidth, height: innerHeight },
      documentWidth: document.documentElement.scrollWidth,
      documentHeight: document.documentElement.scrollHeight,
      conversationHeight:
        document
          .querySelector(".app-conversation-feed")
          ?.closest('[data-slot="scroll-area-viewport"]')
          ?.getBoundingClientRect().height ?? null,
      dialogs: [...document.querySelectorAll('[role="dialog"],dialog[open]')]
        .filter(visible)
        .map(bounds),
      overflow: [
        ...document.querySelectorAll("div,section,aside,header,nav,form"),
      ]
        .filter((element) => {
          const style = getComputedStyle(element);
          return (
            visible(element) &&
            element.clientWidth > 1 &&
            element.scrollWidth > element.clientWidth + 2 &&
            ["hidden", "clip", "visible"].includes(style.overflowX) &&
            style.whiteSpace !== "nowrap" &&
            !element.closest(
              '.react-flow,.xterm,.cm-editor,pre,[aria-hidden="true"]',
            ) &&
            !element.matches('[data-command-focus="terminal"]')
          );
        })
        .map((element) => ({
          className: element.className,
          width: element.clientWidth,
          scrollWidth: element.scrollWidth,
          text: element.textContent.slice(0, 90),
        })),
      regions: [
        ...document.querySelectorAll(
          '[data-slot="scroll-area-viewport"],.app-session-footer,[role="tabpanel"],.react-flow',
        ),
      ]
        .filter(visible)
        .map((element) => ({
          label:
            element.getAttribute("aria-label") ??
            element.className.slice(0, 60),
          ...bounds(element),
        })),
    };
  });
  const filename = `${page.viewportSize().width}-${page.viewportSize().height}-${label}`;
  const nativeBlocker = blocked.findLast(
    (entry) =>
      entry.url === page.url() &&
      entry.width === metrics.viewport.width &&
      entry.height === metrics.viewport.height,
  );
  report.push({
    label,
    status: metrics.hasVisibleContent
      ? "captured"
      : nativeBlocker
        ? "blocked"
        : "empty",
    ...metrics,
  });
  if (!metrics.hasVisibleContent && !nativeBlocker)
    failures.push(`${filename}: surface did not render`);
  if (metrics.documentWidth > metrics.viewport.width + 1)
    failures.push(`${filename}: document overflow`);
  if (
    ["chat-content", "chat-draft", "chat-compact"].includes(label) &&
    metrics.conversationHeight !== null &&
    metrics.conversationHeight < 80
  ) {
    failures.push(
      `${filename}: conversation collapsed to ${metrics.conversationHeight}px`,
    );
  }
  for (const rect of metrics.dialogs) {
    if (
      rect.x < -1 ||
      rect.y < -1 ||
      rect.x + rect.width > metrics.viewport.width + 1 ||
      rect.y + rect.height > metrics.viewport.height + 1
    ) {
      failures.push(
        `${filename}: dialog outside viewport: ${JSON.stringify(rect)}`,
      );
    }
  }
  await page.screenshot({ path: path.join(output, `${filename}.png`) });
  console.log(`${filename}: ${metrics.overflow.length} overflow candidates`);
}

async function navigate(page, name) {
  if (
    await page
      .getByRole("button", { name: "Open navigation", exact: true })
      .isVisible()
  ) {
    await page
      .getByRole("button", { name: "Open navigation", exact: true })
      .click();
    await page.getByRole("menuitem", { name, exact: true }).click();
  } else {
    await page
      .locator(".app-shell-rail")
      .getByRole("button", { name: new RegExp(`^${name}(,|$)`) })
      .click();
  }
  await page
    .getByText("Loading...", { exact: true })
    .waitFor({ state: "hidden" });
}

async function dismiss(page) {
  await page.keyboard.press("Escape");
}

async function inspectButton(page, name, label) {
  await page.getByRole("button", { name, exact: true }).click();
  await capture(page, label);
  if (
    label.startsWith("media-") &&
    (await page
      .locator('.app-flow-panel button[aria-label^="Close"]')
      .first()
      .isVisible())
  ) {
    await page
      .locator('.app-flow-panel button[aria-label^="Close"]')
      .first()
      .click();
  } else await dismiss(page);
}

async function fixtureSurfaces(page) {
  const fixtureUrl = `${baseUrl}/responsive-fixtures`;
  const fixturePath = `/@fs/${path.resolve("apps/client/src/tauri/ui/__test__/responsive-surfaces.tsx").replaceAll("\\", "/")}`;
  const stylePath = `/@fs/${path.resolve("apps/client/src/tauri/ui/styles.css").replaceAll("\\", "/")}`;
  await page.route("**/@tauri-apps_api_window.js*", (route) => {
    const implementationUrl = new URL(route.request().url());
    if (implementationUrl.searchParams.has("responsive-window-implementation"))
      return route.continue();
    implementationUrl.searchParams.set("responsive-window-implementation", "1");
    return route.fulfill({
      contentType: "text/javascript",
      body: `export * from ${JSON.stringify(implementationUrl.href)}; export const getCurrentWindow = () => ({ onDragDropEvent: async () => () => {} });`,
    });
  });
  await page.route(fixtureUrl, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html class="dark" data-theme="dark" data-density="comfortable"><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="${stylePath}"></head><body><div id="root"></div><script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => (type) => type; window.__vite_plugin_react_preamble_installed__ = true; const fixture = await import('${fixturePath}'); window.mountResponsiveSurface = fixture.mountResponsiveSurface;</script></body></html>`,
    }),
  );
  await page.goto(fixtureUrl);
  await page.waitForFunction(
    () => typeof window.mountResponsiveSurface === "function",
  );
  for (const name of [
    "input",
    "input-options",
    "interview",
    "ralph-interview",
    "onboarding",
    "image",
    "image-error",
    "file",
    "file-error",
    "voice-recording",
    "voice-transcribing",
    "voice-error",
    "media-import",
    "media-categories",
    "image-mask",
    "workspace-run",
    "task-timeout",
    "ralph-expanded-editor",
    "ralph-overview",
    "ralph",
  ]) {
    await page.evaluate((name) => window.mountResponsiveSurface(name), name);
    if (name === "workspace-run") {
      await page.getByRole("button", { name: /^Run workspace/ }).click();
      await page.getByRole("dialog").waitFor();
    }
    if (name === "task-timeout") {
      await page.getByRole("button", { name: "Adjust chat timeout" }).click();
      await page.getByLabel("Inactivity (minutes)").fill("0");
    }
    await capture(page, `fixture-${name}`);
    if (name === "ralph-expanded-editor") {
      const visibleEditor = await page
        .getByRole("textbox", { name: "Expanded prompt" })
        .evaluate((element) => {
          const field = element.getBoundingClientRect();
          const parent = element.parentElement.getBoundingClientRect();
          return field.bottom <= parent.bottom && field.height > 40;
        });
      assert.ok(visibleEditor, "Expanded editor must fit its scroll region");
    }
  }
  await page
    .getByRole("button", { name: "Create blank Ralph flow from canvas" })
    .click();
  await capture(page, "ralph-block-settings");
  await page.getByRole("button", { name: "Hide block settings" }).click();
  await capture(page, "ralph-design");
  for (const mode of ["Generate", "Run", "Review", "Design"]) {
    await page
      .getByRole("navigation", { name: "Ralph editor mode" })
      .getByRole("button", { name: mode, exact: true })
      .click();
    await capture(page, `ralph-mode-${mode.toLowerCase()}`);
  }
  const hideInspector = page.getByRole("button", {
    name: "Hide block settings",
  });
  if (await hideInspector.isVisible()) await hideInspector.click();
  await inspectButton(page, "Ralph keyboard shortcuts", "ralph-shortcuts");
  const openFlows = page.getByRole("button", { name: "Open Ralph flows" });
  if (await openFlows.isVisible()) await openFlows.click();
  await capture(page, "ralph-library");
  await inspectButton(page, "Open starter Ralph flows", "ralph-starters");
  await page.getByRole("button", { name: "Collapse Ralph flows" }).click();
  await page.getByRole("button", { name: "Add Prompt block" }).click();
  await capture(page, "ralph-prompt-settings");
  for (const block of [
    "Validate",
    "Decision",
    "Pack",
    "Ask User",
    "Interview",
    "Utility",
    "Note",
    "Group",
    "End",
  ]) {
    await page.getByRole("button", { name: "Hide block settings" }).click();
    await page
      .getByRole("button", { name: `Add ${block} block`, exact: true })
      .click();
    await capture(
      page,
      `ralph-settings-${block.toLowerCase().replaceAll(" ", "-")}`,
    );
  }
  await page.getByRole("button", { name: "Hide block settings" }).click();
  await inspectButton(page, "Add integration block", "ralph-integrations");
}

async function seedConversation(page) {
  await page.waitForFunction(() =>
    localStorage.getItem("machdoch.desktop.shell-state-snapshot"),
  );
  const seedUrl = `${baseUrl}/responsive-seed`;
  await page.route(seedUrl, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><html><body></body></html>",
    }),
  );
  await page.goto(seedUrl);
  await page.unroute(seedUrl);
  await page.evaluate(() => {
    const key = "machdoch.desktop.shell-state-snapshot";
    const snapshot = JSON.parse(localStorage.getItem(key));
    const session = snapshot.state.sessions[0];
    session.manualTitle =
      "Review a very long workspace title and responsive conversation content";
    session.messages = [
      {
        id: "responsive-user",
        taskId: "responsive-task",
        role: "user",
        createdAt: Date.now() - 3000,
        content:
          "Inspect this long path: C:/Development/" +
          "LongWorkspaceDirectory".repeat(9),
      },
      {
        id: "responsive-agent",
        taskId: "responsive-task",
        role: "agent",
        outcome: { status: "succeeded" },
        createdAt: Date.now() - 2000,
        content: [
          "The workspace is ready for review.",
          "https://example.com/" + "long-resource-name".repeat(14),
          "```typescript\nconst path = '" +
            "long-directory/".repeat(25) +
            "';\n```",
          "| File | Result | Details |\n| --- | --- | --- |\n| `" +
            "long-file-name".repeat(12) +
            "` | Passed | Layout inspected |",
          ...Array.from(
            { length: 12 },
            (_, index) =>
              `Paragraph ${index + 1}: Scroll through the conversation and keep the composer visible.`,
          ),
        ].join("\n\n"),
      },
    ];
    snapshot.revision += 1;
    localStorage.setItem(key, JSON.stringify(snapshot));
    localStorage.setItem(
      "machdoch.desktop.shell-state-revision",
      String(snapshot.revision),
    );
  });
  await page.goto(baseUrl);
  await page.getByRole("textbox", { name: "Task composer" }).waitFor();
  await page
    .getByText("The workspace is ready for review.", { exact: true })
    .waitFor({ state: "attached" });
}

async function chat(page) {
  await navigate(page, "Chat");
  await page
    .getByText("The workspace is ready for review.", { exact: true })
    .scrollIntoViewIfNeeded();
  await capture(page, "chat-content");
  await page
    .locator(".app-conversation-feed pre")
    .first()
    .scrollIntoViewIfNeeded();
  await capture(page, "chat-code");
  await page
    .locator(".app-conversation-feed table")
    .first()
    .scrollIntoViewIfNeeded();
  await capture(page, "chat-table");
  const composer = page.getByRole("textbox", { name: "Task composer" });
  await composer.fill(
    "A draft message that should remain usable on a narrow display.",
  );
  await capture(page, "chat-draft");
  await composer.fill("");
  await page.getByRole("button", { name: "Edit", exact: true }).first().click();
  await capture(page, "chat-edit");
  await page.getByRole("button", { name: "Cancel edit", exact: true }).click();
  for (const [name, label] of [
    [/^Session model:/, "chat-model"],
    [/^Reasoning mode:/, "chat-reasoning"],
    [/^Execution mode:/, "chat-mode"],
    [/^Prompt enhancement:/, "chat-enhancement"],
    ["Context packs", "chat-context-packs"],
    ["Add context", "chat-attachments"],
  ])
    await inspectButton(page, name, label);
  await page
    .getByRole("button", { name: "Context packs", exact: true })
    .click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await capture(page, "chat-context-pack-editor");
  await page
    .getByRole("button", { name: "Save pack", exact: true })
    .scrollIntoViewIfNeeded();
  await capture(page, "chat-context-pack-overrides");
  await dismiss(page);
  await page
    .getByRole("button", { name: "Manage session memory", exact: true })
    .click();
  await capture(page, "chat-memory");
  await page
    .getByRole("button", { name: "Close session memory", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Rename session", exact: true })
    .click();
  await capture(page, "chat-rename");
  await dismiss(page);
  const mobile = await page
    .getByRole("button", { name: "Open sessions", exact: true })
    .isVisible();
  if (mobile)
    await page
      .getByRole("button", { name: "Open sessions", exact: true })
      .click();
  await capture(page, "sessions");
  for (const [name, label] of [
    [/^Session scope:/, "sessions-scope"],
    [/^Session status:/, "sessions-status"],
    [/^Session actions for/, "sessions-actions"],
  ]) {
    await inspectButton(page, name, label);
  }
  const search = page.getByRole("searchbox", { name: "Search sessions" });
  await search.fill("No matching session");
  await capture(page, "sessions-empty-search");
  await search.fill("");
  if (mobile)
    await page.getByRole("button", { name: "Close sessions" }).click();
  await page
    .getByRole("button", { name: "Delete session", exact: true })
    .click();
  await capture(page, "chat-empty-after-delete");
  await seedConversation(page);
}

async function settings(page) {
  await navigate(page, "Settings");
  await page.getByRole("button", { name: "Close settings" }).waitFor();
  const mobileSections = page.getByLabel("Settings section", { exact: true });
  const names = [
    "Providers",
    "Agent limits",
    "Global memory",
    "Web search",
    "Voice",
    "MCP servers",
    "Appearance",
    "Desktop & chats",
    "Run timeouts",
    "Settings transfer",
  ];
  for (const name of names) {
    if (await mobileSections.isVisible())
      await mobileSections.selectOption({ label: name });
    else
      await page
        .getByRole("navigation", { name: "Settings sections" })
        .getByRole("button", { name, exact: true })
        .click();
    await capture(page, `settings-${name.toLowerCase().replace(/\W+/g, "-")}`);
    if (name === "MCP servers") {
      await inspectButton(page, "Add custom", "settings-mcp-custom");
      await inspectButton(page, "Add preset", "settings-mcp-presets");
    }
  }
  await page.getByRole("searchbox", { name: "Find settings" }).fill("voice");
  await capture(page, "settings-search");
  await page.getByRole("button", { name: "Close settings" }).click();
}

async function workspaces(page) {
  await navigate(page, "Workspace Management");
  await page.getByRole("tab", { name: "Output", exact: true }).waitFor();
  for (const name of [
    "Output",
    "Files",
    "Configuration",
    "Git",
    "Memory",
    "Settings",
  ]) {
    await page.getByRole("tab", { name, exact: true }).click();
    await capture(page, `workspace-${name.toLowerCase()}`);
    if (name === "Files") {
      await page
        .getByRole("treeitem", { name: "README.md", exact: true })
        .click();
      await capture(page, "workspace-file-preview");
      await inspectButton(page, "New terminal", "workspace-terminal-menu");
    }
    if (name === "Git") {
      for (const tab of ["Branches", "Remotes", "Pull requests", "Status"]) {
        await page.getByRole("tab", { name: tab, exact: true }).click();
        await capture(
          page,
          `workspace-git-${tab.toLowerCase().replaceAll(" ", "-")}`,
        );
      }
    }
    if (name === "Settings") {
      await inspectButton(page, "Add custom", "workspace-mcp-custom");
      await inspectButton(page, "Add preset", "workspace-mcp-presets");
    }
  }
}

async function media(page) {
  await navigate(page, "Media Studio");
  await page
    .getByRole("navigation", { name: "Media Studio", exact: true })
    .waitFor();
  await page.getByRole("button", { name: "Basic", exact: true }).click();
  for (const name of ["Image", "Video", "SVG"]) {
    await page.getByRole("button", { name, exact: true }).click();
    await capture(page, `media-basic-${name.toLowerCase()}`);
  }
  await page.getByRole("button", { name: "Image", exact: true }).click();
  await page.getByRole("combobox").click();
  await capture(page, "media-model-picker");
  await dismiss(page);
  await page.getByRole("button", { name: /More options/ }).click();
  await capture(page, "media-basic-options");
  await page.getByRole("button", { name: "Advanced", exact: true }).click();
  await capture(page, "media-flow");
  for (const [name, label] of [
    ["Browse built-in flow templates", "media-templates"],
    [/^Manage variables and presets/, "media-variables"],
    ["Add node", "media-add-node"],
    [/^Manage canvas organization/, "media-canvas-organization"],
    [/^Manage node selection/, "media-selection"],
  ])
    await inspectButton(page, name, label);
  for (
    let index = 0;
    index < (await page.locator(".react-flow__node").count());
    index += 1
  ) {
    await page.locator(".react-flow__node").nth(index).click();
    await capture(page, `media-node-${index + 1}`);
    await page
      .getByRole("button", { name: "Close node inspector", exact: true })
      .click();
  }
  await inspectButton(page, /^Review \d+ issue/, "media-diagnostics");
  await inspectButton(page, /^Runtime plan/, "media-runtime-plan");
  await page.getByRole("button", { name: "Assets", exact: true }).click();
  await capture(page, "media-assets");
  await page
    .getByRole("button", { name: "View GPT Image 2", exact: true })
    .click();
  await capture(page, "media-asset-details");
  await page
    .getByRole("button", { name: "Close asset details", exact: true })
    .click();
  await page
    .getByRole("combobox", { name: "Choose categories", exact: true })
    .click();
  await capture(page, "media-category-picker");
  await page
    .getByRole("button", { name: "Manage categories", exact: true })
    .click();
  await capture(page, "media-category-manager");
  await page
    .getByRole("button", { name: "Close categories", exact: true })
    .click();
  for (const type of [
    "Models",
    "LoRAs",
    "Embeddings",
    "Images",
    "Videos",
    "SVGs",
  ]) {
    await page.getByRole("button", { name: type, exact: true }).click();
    await capture(page, `media-assets-${type.toLowerCase()}`);
  }
  await page.getByRole("button", { name: "Activity", exact: true }).click();
  await capture(page, "media-activity");
}

async function otherSurfaces(page) {
  await navigate(page, "Instructions");
  await page
    .getByRole("button", { name: "New file", exact: true })
    .first()
    .waitFor();
  await capture(page, "instructions");
  await page
    .getByRole("button", { name: "New file", exact: true })
    .first()
    .click();
  await capture(page, "instruction-editor");
  await navigate(page, "Ralph");
  await page
    .getByRole("button", { name: "Choose workspace", exact: true })
    .waitFor();
  await capture(page, "ralph-overview-unavailable");
  await navigate(page, "Smart Scheduler");
  await page.getByRole("dialog").waitFor();
  await capture(page, "scheduler-jobs");
  for (const name of [
    "interval",
    "delay",
    "event",
    "cron",
    "RALPH Flow",
    "Prompt",
  ]) {
    await page.getByRole("button", { name, exact: true }).click();
    await capture(
      page,
      `scheduler-form-${name.toLowerCase().replaceAll(" ", "-")}`,
    );
  }
  await page.getByLabel("Trigger Kind").selectOption("webhook");
  await capture(page, "scheduler-webhook-trigger");
  await page.getByLabel("Trigger Kind").selectOption("poll");
  await capture(page, "scheduler-poll-trigger");
  await page.getByRole("button", { name: "Runs", exact: true }).click();
  await capture(page, "scheduler-runs");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await navigate(page, "Fleet Manager");
  await page.getByRole("dialog").waitFor();
  await capture(page, "fleet-connection");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.keyboard.press("Control+k");
  await page.getByRole("dialog").waitFor();
  await capture(page, "command-palette");
  await dismiss(page);
}

async function mediaDetails(page) {
  await navigate(page, "Media Studio");
  await page.getByRole("button", { name: "Advanced", exact: true }).click();
  await inspectButton(page, "Import", "media-import-review");
  await page
    .getByRole("combobox", { name: "Open workflow", exact: true })
    .click();
  await capture(page, "media-saved-workflows");
  await dismiss(page);
  await page.getByRole("button", { name: "Add node", exact: true }).click();
  await page.getByRole("option", { name: "Image asset", exact: true }).click();
  await capture(page, "media-image-node");
  await page
    .getByRole("button", { name: "Choose Source asset", exact: true })
    .click();
  await page.getByRole("dialog").waitFor();
  await capture(page, "media-image-asset-picker");
  await dismiss(page);
  await page
    .getByRole("button", { name: "Close node inspector", exact: true })
    .click();
}

async function auxiliarySurfaces(page) {
  for (const name of [
    "assistant-bubble",
    "assistant-popup",
    "quick-voice",
    "tray-menu",
  ]) {
    await page.goto(`${baseUrl}/?window=${name}`);
    await page.waitForLoadState("networkidle");
    await capture(page, `window-${name}`);
  }
}

async function compactSurfaces(page) {
  await navigate(page, "Settings");
  await page.getByRole("button", { name: "Close settings" }).waitFor();
  const sections = page.getByLabel("Settings section", { exact: true });
  if (await sections.isVisible())
    await sections.selectOption({ label: "Appearance" });
  else
    await page
      .getByRole("navigation", { name: "Settings sections" })
      .getByRole("button", { name: "Appearance", exact: true })
      .click();
  await page.getByRole("button", { name: "Compact", exact: true }).click();
  await capture(page, "settings-compact");
  await page.getByRole("button", { name: "Close settings" }).click();
  await navigate(page, "Chat");
  await capture(page, "chat-compact");
  const sessions = page.getByRole("button", {
    name: "Open sessions",
    exact: true,
  });
  if (await sessions.isVisible()) {
    await sessions.click();
    await capture(page, "sessions-compact");
    await page.getByRole("button", { name: "Close sessions" }).click();
  }
}

try {
  for (const [width, height] of sizes) {
    const context = await browser.newContext({
      viewport: { width, height },
      hasTouch: width < 1024,
      isMobile: width < 768,
      reducedMotion: "reduce",
    });
    await context.addInitScript(() => {
      localStorage.setItem(
        "machdoch.desktop.onboarding-state",
        JSON.stringify({ skippedAt: Date.now() }),
      );
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.on("pageerror", (error) => {
      const entry = {
        width,
        height,
        url: page.url(),
        error: error.message,
        stack: error.stack,
      };
      if (
        error.message.includes("metadata") &&
        error.stack?.includes("getCurrentWindow")
      )
        blocked.push(entry);
      else errors.push(entry);
    });
    await page.goto(baseUrl);
    await page.getByRole("textbox", { name: "Task composer" }).waitFor();
    await seedConversation(page);
    for (const [label, run] of [
      ["chat", chat],
      ["settings", settings],
      ["workspaces", workspaces],
      ["media", media],
      ["media-details", mediaDetails],
      ["other", otherSurfaces],
      ["compact", compactSurfaces],
      ["auxiliary", auxiliarySurfaces],
      ["fixtures", fixtureSurfaces],
    ]) {
      if (
        process.env.MACHDOCH_CLIENT_SURFACES &&
        !process.env.MACHDOCH_CLIENT_SURFACES.split(",").includes(label)
      )
        continue;
      try {
        await run(page);
      } catch (error) {
        failures.push(`${width}-${height}-${label}: ${error.message}`);
        await page.screenshot({
          path: path.join(output, `${width}-${height}-${label}-failure.png`),
        });
        console.error(failures.at(-1));
        await page.goto(baseUrl);
        await page
          .getByRole("button", {
            name: width < 768 ? "Open navigation" : /^Chat(,|$)/,
          })
          .waitFor();
      }
    }
    await context.close();
  }
} finally {
  await writeFile(
    path.join(output, reportName),
    JSON.stringify({ baseUrl, report, failures, errors, blocked }, null, 2),
  );
  await browser.close();
}
console.log(
  JSON.stringify(
    { checkpoints: report.length, failures, errors, blocked },
    null,
    2,
  ),
);
if (failures.length || errors.length) process.exitCode = 1;
