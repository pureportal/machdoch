import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { palette, selectProductView } from "./verify-product-ui.mjs";

async function eventually(check, message) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(message);
}

async function openInstructions(page, path) {
  await page.bringToFront();
  await page.goto(path);
  await selectProductView(page, "Instructions");
  const controls = page.frameLocator('iframe[title="Instructions"]');
  await controls
    .getByRole("heading", { name: "Instructions", exact: true })
    .waitFor();
  const frame = await (
    await page.locator('iframe[title="Instructions"]').elementHandle()
  ).contentFrame();
  assert.ok(frame);
  return { controls, frame };
}

async function saved(controls) {
  await eventually(
    () =>
      controls
        .getByRole("button", {
          name: "Duplicate instruction file",
          exact: true,
        })
        .isEnabled(),
    "Instruction changes did not finish saving.",
  );
}

export async function verifyInstructions({
  page,
  small,
  api,
  origin,
  fixtureRoot,
  device,
}) {
  const path = `${origin}/instances/${device.connection.instanceId}`;
  const libraryPath = join(device.userRoot, "instruction-library.json");
  const library = async () => JSON.parse(await readFile(libraryPath, "utf8"));
  const name = "Remote instruction review";
  const body = "# Review\n\nKeep the 🌿 context and check the tests.\n";
  const { controls, frame } = await openInstructions(page, path);
  const editorWidth = await frame.evaluate(() => innerWidth);
  const shellWidth = await page
    .locator(".m-product-layout")
    .evaluate((element) => element.getBoundingClientRect().width);
  assert.ok(
    editorWidth >= shellWidth - 4,
    "Instructions do not fill the desktop workspace.",
  );
  assert.deepEqual(
    await palette(frame),
    await palette(page),
    "Instructions colors differ from the remote shell.",
  );
  await controls
    .getByRole("button", { name: "New file", exact: true })
    .first()
    .click();
  await controls.getByLabel("Name", { exact: true }).fill(name);
  await controls.getByLabel("Instruction Markdown", { exact: true }).fill(body);
  await controls
    .getByRole("textbox", { name: "Add tag", exact: true })
    .fill("web, ui");
  await controls
    .getByRole("textbox", { name: "Add tag", exact: true })
    .press("Enter");
  await controls.getByRole("checkbox", { name: "Global", exact: true }).check();
  await selectProductView(page, "Chat");
  await selectProductView(page, "Instructions");
  assert.equal(
    await controls.getByLabel("Name", { exact: true }).inputValue(),
    name,
  );
  assert.equal(
    await controls
      .getByLabel("Instruction Markdown", { exact: true })
      .inputValue(),
    body,
  );
  const instancePath = `/instances/${device.connection.instanceId}/product`;
  const beforeSwitch = await api(`${instancePath}/snapshot`);
  const activeSession = beforeSwitch.shell.sessions.find(
    (session) => session.id === beforeSwitch.shell.activeSessionId,
  );
  assert.ok(activeSession?.workspace);
  await api(`${instancePath}/commands`, "POST", {
    kind: "create-project",
    commandId: randomUUID(),
    name: "instruction-context",
    initializeGit: false,
  });
  let project;
  await eventually(async () => {
    project = (await api(`${instancePath}/snapshot`)).shell.projectLibrary.projects.find(
      (entry) => entry.name === "instruction-context" && entry.status === "ready",
    );
    return Boolean(project);
  }, "Instruction test workspace did not become ready.");
  const requestedRoots = new Set();
  const recordWorkspace = (request) => {
    if (request.frame() !== frame || !request.url().endsWith("/instructions")) return;
    const requestBody = request.postDataJSON();
    if (requestBody?.kind === "invoke") requestedRoots.add(requestBody.args.request.workspaceRoot);
  };
  page.on("request", recordWorkspace);
  try {
    await api(`${instancePath}/commands`, "POST", {
      kind: "set-session-workspace",
      commandId: randomUUID(),
      sessionId: activeSession.id,
      workspace: project.workspace,
    });
    await eventually(
      () => requestedRoots.has(project.workspace),
      "Instructions did not follow the active workspace.",
    );
    assert.equal(await controls.getByLabel("Name", { exact: true }).inputValue(), name);
    assert.equal(await controls.getByLabel("Instruction Markdown", { exact: true }).inputValue(), body);
  } finally {
    await api(`${instancePath}/commands`, "POST", {
      kind: "set-session-workspace",
      commandId: randomUUID(),
      sessionId: activeSession.id,
      workspace: activeSession.workspace,
    });
    await eventually(
      () => requestedRoots.has(activeSession.workspace),
      "Instructions did not return to the original workspace.",
    );
    page.off("request", recordWorkspace);
    await api(`${instancePath}/commands`, "POST", {
      kind: "forget-project",
      commandId: randomUUID(),
      projectId: project.id,
    });
  }
  assert.equal(await controls.getByLabel("Name", { exact: true }).inputValue(), name);
  assert.equal(await controls.getByLabel("Instruction Markdown", { exact: true }).inputValue(), body);
  await controls.getByRole("button", { name: "Save", exact: true }).click();
  await saved(controls);
  const created = (await library()).profiles.find(
    (profile) => profile.name === name,
  );
  assert.ok(created);
  assert.equal(created.body, body);
  assert.equal(created.global, true);
  assert.deepEqual(created.tags, ["web", "ui"]);
  await controls.getByRole("tab", { name: /^preview$/i }).click();
  await controls
    .getByRole("heading", { name: "Review", exact: true })
    .waitFor();
  await controls.getByRole("tab", { name: /^edit$/i }).click();

  const mobile = await openInstructions(small, path);
  await mobile.controls
    .locator("aside")
    .getByRole("button")
    .filter({ hasText: name })
    .click();
  assert.ok(
    await mobile.frame.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    "Instructions overflow the mobile viewport.",
  );
  await page.bringToFront();
  const desktopDraft = "Keep my unsaved desktop draft 🌿.";
  await controls
    .getByLabel("Instruction Markdown", { exact: true })
    .fill(desktopDraft);
  await small.bringToFront();
  const mobileBody = "# Reviewed on mobile\n\nCheck the updated tests.\n";
  await mobile.controls
    .getByLabel("Instruction Markdown", { exact: true })
    .fill(mobileBody);
  await mobile.controls
    .getByRole("button", { name: "Save", exact: true })
    .click();
  await saved(mobile.controls);
  assert.equal(
    (await library()).profiles.find((profile) => profile.id === created.id)
      .body,
    mobileBody,
  );
  await page.bringToFront();
  await controls.getByRole("button", { name: "Save", exact: true }).click();
  await controls
    .getByRole("alert")
    .filter({ hasText: /revision|changed/i })
    .waitFor();
  assert.equal(
    await controls
      .getByLabel("Instruction Markdown", { exact: true })
      .inputValue(),
    desktopDraft,
  );
  assert.equal(
    (await library()).profiles.find((profile) => profile.id === created.id)
      .body,
    mobileBody,
  );
  page.once("dialog", (dialog) => dialog.dismiss());
  await controls
    .getByRole("button", { name: "Refresh instructions", exact: true })
    .click();
  assert.equal(
    await controls
      .getByLabel("Instruction Markdown", { exact: true })
      .inputValue(),
    desktopDraft,
  );
  page.once("dialog", (dialog) => dialog.accept());
  await controls
    .getByRole("button", { name: "Refresh instructions", exact: true })
    .click();
  await frame.waitForFunction(
    (expected) =>
      document.querySelector('textarea[aria-label="Instruction Markdown"]')
        ?.value === expected,
    mobileBody,
  );
  await saved(controls);
  await controls
    .getByRole("checkbox", { name: "Global", exact: true })
    .uncheck();
  const tagMatch = controls
    .getByRole("heading", { name: "Workspace tag match", exact: true })
    .locator("..");
  await tagMatch
    .getByRole("checkbox", { name: "Enabled", exact: true })
    .check();
  await controls
    .getByLabel("Matching workspace tag", { exact: true })
    .fill("web");
  await controls.getByRole("button", { name: "Save", exact: true }).click();
  await saved(controls);
  assert.deepEqual(
    (await library()).profiles.find((profile) => profile.id === created.id)
      .match,
    { op: "and", rules: [{ op: "tag", tag: "web" }] },
  );
  await controls.getByLabel("Name", { exact: true }).focus();
  await page.keyboard.press("Control+k");
  await controls
    .getByRole("dialog")
    .getByText("Refresh instructions", { exact: true })
    .waitFor();
  await page.keyboard.press("Escape");
  await page.screenshot({
    path: join(fixtureRoot, "shared-instructions-desktop.png"),
    fullPage: true,
  });
  await small.bringToFront();
  await mobile.controls
    .getByRole("button", { name: "Refresh instructions", exact: true })
    .click();
  await mobile.controls
    .getByLabel("Matching workspace tag", { exact: true })
    .waitFor();
  await small.screenshot({
    path: join(fixtureRoot, "shared-instructions-mobile.png"),
    fullPage: true,
  });
  await page.bringToFront();
  const previousIds = new Set(
    (await library()).profiles.map((profile) => profile.id),
  );
  await controls
    .getByRole("button", { name: "Duplicate instruction file", exact: true })
    .click();
  await eventually(
    async () =>
      (await library()).profiles.some(
        (profile) => !previousIds.has(profile.id),
      ),
    "Instruction duplication did not persist.",
  );
  const duplicate = (await library()).profiles.find(
    (profile) => !previousIds.has(profile.id),
  );
  await frame.waitForFunction(
    (expected) =>
      Array.from(document.querySelectorAll("input")).some(
        (input) => input.value === expected,
      ),
    duplicate.name,
  );
  await saved(controls);
  assert.equal(duplicate.global, false);
  assert.equal(duplicate.match, undefined);
  page.once("dialog", (dialog) => dialog.accept());
  await controls
    .getByRole("button", { name: "Delete instruction file", exact: true })
    .click();
  await eventually(
    async () =>
      !(await library()).profiles.some(
        (profile) => profile.id === duplicate.id,
      ),
    "Instruction deletion did not persist.",
  );

  await writeFile(libraryPath, "corrupt instruction library bytes");
  await controls
    .getByRole("button", { name: "Refresh instructions", exact: true })
    .click();
  await controls
    .getByRole("button", { name: "Restore", exact: true })
    .waitFor();
  await controls.getByRole("button", { name: "Restore", exact: true }).click();
  await controls
    .getByRole("button", { name: "Restore", exact: true })
    .waitFor({ state: "hidden" });
  assert.ok(Array.isArray((await library()).profiles));
  await writeFile(libraryPath, "new corrupt instruction library bytes");
  await controls
    .getByRole("button", { name: "Refresh instructions", exact: true })
    .click();
  await controls.getByRole("button", { name: "Reset", exact: true }).waitFor();
  page.once("dialog", (dialog) => dialog.accept());
  await controls.getByRole("button", { name: "Reset", exact: true }).click();
  await controls
    .getByRole("button", { name: "Reset", exact: true })
    .waitFor({ state: "hidden" });
  assert.deepEqual((await library()).profiles, []);
  await selectProductView(page, "Chat");
  return "The shared Instructions editor created, edited, tagged, previewed, duplicated and deleted real host files; followed workspace changes while retaining drafts across workspace/view navigation; rejected a stale edit from another viewer; restored and reset corrupt libraries; exposed its command palette; and matched the client palette without mobile overflow.";
}
