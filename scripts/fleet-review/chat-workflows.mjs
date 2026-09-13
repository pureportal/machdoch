import assert from "node:assert/strict";
import { fleetReviewFixture } from "../fixtures/fleet-review.mjs";
import { capture, contained } from "./browser.mjs";

export async function reviewChatWorkflows(page, size, instanceId) {
  const fixture = fleetReviewFixture();
  const shell = fixture.snapshot.shell;
  shell.composer.reasoningOptions = [
    "default",
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "ultra",
    "aeon",
  ];
  await fixture.install(page);
  await page.goto(`/instances/${instanceId}`, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  const composer = page.getByRole("textbox", { name: "Task composer" });
  const send = page.getByRole("button", { name: "Send message", exact: true });
  await composer.waitFor();

  for (const recover of [true, false]) {
    await composer.fill("Original message awaiting submission");
    fixture.delay = 800;
    fixture.failNext = "submit-message";
    await send.click();
    await composer.fill("Next message written while waiting");
    await page.getByText("Message not sent", { exact: true }).waitFor();
    fixture.delay = 0;
    assert.equal(
      await composer.inputValue(),
      "Next message written while waiting",
    );
    assert(await send.isDisabled());
    await page
      .getByRole("button", { name: "Media Studio", exact: true })
      .filter({ visible: true })
      .click();
    await page
      .getByRole("button", { name: "Chat", exact: true })
      .filter({ visible: true })
      .click();
    await page.getByText("Message not sent", { exact: true }).click();
    await page
      .getByText("Original message awaiting submission", { exact: true })
      .waitFor();
    await contained(page, ".m-product-composer");
    await capture(page, `${size}-unsent-message`);
    const recovery = page.getByRole("button", {
      name: recover ? "Add to draft" : "Discard",
      exact: true,
    });
    if (page.viewportSize().width <= 900) await recovery.tap();
    else await recovery.click();
    await composer.and(page.locator(":focus")).waitFor();
    assert.equal(
      await composer.inputValue(),
      recover
        ? "Original message awaiting submission\n\nNext message written while waiting"
        : "Next message written while waiting",
    );
    await page
      .getByText("Message not sent", { exact: true })
      .waitFor({ state: "detached" });
  }
  if (page.viewportSize().width <= 900) {
    const sent = fixture.commands.filter(
      (item) => item.kind === "submit-message",
    ).length;
    const beforeEnter = await composer.inputValue();
    assert(await page.evaluate(() => matchMedia("(pointer: coarse)").matches));
    await composer.evaluate((element) => {
      element.focus();
      element.setSelectionRange(element.value.length, element.value.length);
    });
    await composer.press("Enter");
    assert.equal(await composer.inputValue(), `${beforeEnter}\n`);
    assert.equal(
      fixture.commands.filter((item) => item.kind === "submit-message").length,
      sent,
    );
    await page
      .getByRole("button", { name: "Composer options", exact: true })
      .tap();
    const model = page.locator(".m-composer-model-trigger");
    await contained(page, model);
    const modelBounds = await model.boundingBox();
    assert(
      modelBounds.width >= 44 && modelBounds.height >= 44,
      "Expanded options must keep the model picker usable by touch",
    );
  }

  const reasoning = page.getByRole("button", { name: /^Reasoning mode:/ });
  await reasoning.focus();
  await page.keyboard.press("ArrowDown");
  const menu = page.getByRole("menu", { name: "Reasoning mode", exact: true });
  await menu.waitFor();
  await contained(page, menu);
  await page.keyboard.press("End");
  await menu
    .getByRole("menuitemradio", { name: "Choose Aeon", exact: true })
    .and(page.locator(":focus"))
    .waitFor();
  await contained(
    page,
    menu.getByRole("menuitemradio", { name: "Choose Aeon", exact: true }),
  );
  await capture(page, `${size}-reasoning-menu`);
  await page.keyboard.press("Home");
  await menu
    .getByRole("menuitemradio", {
      name: "Choose Workspace default",
      exact: true,
    })
    .and(page.locator(":focus"))
    .waitFor();
  await page.keyboard.press("ArrowDown");
  await menu
    .getByRole("menuitemradio", {
      name: "Choose Provider default",
      exact: true,
    })
    .and(page.locator(":focus"))
    .waitFor();
  await page.keyboard.press("Enter");
  await page
    .getByRole("button", {
      name: "Reasoning mode: Provider default",
      exact: true,
    })
    .waitFor();
  assert(
    fixture.commands.some(
      (item) =>
        item.kind === "set-session-reasoning" && item.reasoning === "default",
    ),
  );
  await reasoning.click();
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "detached" });
  await reasoning.and(page.locator(":focus")).waitFor();

  const workspace = page.getByRole("button", { name: /^Workspace:/ });
  if (page.viewportSize().width <= 900) await workspace.tap();
  else await workspace.click();
  const clearWorkspace = page.getByRole("menuitemradio", {
    name: "No workspace",
    exact: true,
  });
  if (page.viewportSize().width <= 900) await clearWorkspace.tap();
  else await clearWorkspace.click();
  await page
    .getByRole("button", { name: "Workspace: No workspace", exact: true })
    .waitFor();
  await workspace.click();
  await page
    .getByRole("menuitemradio")
    .filter({ hasText: shell.workspaces[0].label })
    .click();
  await page
    .getByRole("menu", { name: "Workspace", exact: true })
    .waitFor({ state: "detached" });
  await page.getByLabel("Updating").waitFor({ state: "detached" });
  await page
    .getByRole("button", { name: "Context packs", exact: true })
    .click();
  await contained(
    page,
    page.getByRole("menu", { name: "Context packs", exact: true }),
  );
  fixture.offline = true;
  await page.getByText("Disconnected", { exact: true }).waitFor();
  await page.getByRole("menu").waitFor({ state: "detached" });
  assert(await reasoning.isDisabled());
  assert(await workspace.isDisabled());
  assert(
    await page
      .getByRole("button", { name: "Context packs", exact: true })
      .isDisabled(),
  );
  if (page.viewportSize().width <= 900) {
    fixture.offline = false;
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await page.getByText("Connected", { exact: true }).waitFor();
    await page
      .getByRole("button", { name: "Composer options", exact: true })
      .click();
    fixture.offline = true;
    await page.getByText("Disconnected", { exact: true }).waitFor();
  }

  const message = page
    .locator(".m-product-message")
    .filter({ hasText: "shared Markdown" });
  await message.scrollIntoViewIfNeeded();
  await page.evaluate(() =>
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error("Denied");
        },
      },
    }),
  );
  await message
    .getByRole("button", { name: "Copy message", exact: true })
    .click();
  await message.getByRole("alert").waitFor();
  await page.evaluate(() =>
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text) => {
          window.reviewCopiedMessage = text;
        },
      },
    }),
  );
  await message
    .getByRole("button", { name: "Copy message", exact: true })
    .click();
  await message
    .getByRole("button", { name: "Copied message", exact: true })
    .waitFor();
  assert.equal(
    await page.evaluate(() => window.reviewCopiedMessage),
    shell.visibleMessages.find((item) =>
      item.content.includes("shared Markdown"),
    ).content,
  );
  assert.equal(await message.getByRole("alert").count(), 0);
  await capture(page, `${size}-copy-message`);
  fixture.offline = false;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.getByText("Connected", { exact: true }).waitFor();

  const second = shell.sessions[1];
  second.runningTaskId = "linked_review_task";
  fixture.snapshot.sessions = [
    {
      taskId: second.runningTaskId,
      task: "Task in another chat",
      mode: "machdoch",
      state: "running",
      message: "Working",
      cancellable: true,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      progressCount: 0,
      logs: [],
      timeline: [],
    },
  ];
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page
    .locator(".m-product-topbar, .m-product-rail")
    .getByRole("button", { name: "Activity", exact: true })
    .filter({ visible: true })
    .click();
  fixture.failNext = "activate-session";
  await page.getByRole("button", { name: "Open chat", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("alert")
    .filter({ hasText: "Chat could not be opened" })
    .waitFor();
  await page.getByLabel("Updating").waitFor({ state: "detached" });
  await page.getByRole("button", { name: "Open chat", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Activity", exact: true })
    .waitFor({ state: "detached" });
  await page
    .getByRole("heading", { name: second.title, exact: true })
    .waitFor();
  assert.equal(await composer.inputValue(), "");
  await page
    .getByRole("button", { name: "Media Studio", exact: true })
    .filter({ visible: true })
    .click();
  await page
    .locator(".m-product-topbar, .m-product-rail")
    .getByRole("button", { name: "Activity", exact: true })
    .filter({ visible: true })
    .click();
  await page.getByRole("tab", { name: "Workspaces", exact: true }).click();
  fixture.failNext = "create-session";
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "New chat", exact: true })
    .first()
    .click();
  await page
    .getByRole("dialog")
    .getByRole("alert")
    .filter({ hasText: "Chat could not be opened" })
    .waitFor();
  await page.getByLabel("Updating").waitFor({ state: "detached" });
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "New chat", exact: true })
    .first()
    .click();
  await page
    .getByRole("dialog", { name: "Activity", exact: true })
    .waitFor({ state: "detached" });
  await page.getByRole("heading", { name: "New task", exact: true }).waitFor();
  await contained(page, ".m-product-composer");
  await capture(page, `${size}-activity-new-chat`);
  return `${size}: unsent-message recovery/discard, touch Enter, keyboard menus and provider-default reasoning, workspace selection, disconnected menus, offline message copy denial/retry, running-task navigation and workspace chat creation/retry (fixtures)`;
}
