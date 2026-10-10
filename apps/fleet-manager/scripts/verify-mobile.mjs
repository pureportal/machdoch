import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startMobileFixture } from "./mobile-browser-fixture.mjs";
import {
  openAttachments,
  verifyMobileAttachmentBrowsing,
  verifyMobileFleetForms,
  verifyMobileMediaPicker,
} from "./mobile-workflow-verification.mjs";
import {
  insideVisibleViewport,
  restoreVisibleViewport,
  setVisibleViewport,
  verifyKeyboardViewport,
} from "./mobile-viewport-verification.mjs";
import {
  selectProductView,
  verifyClientUi,
  palette,
} from "./verify-product-ui.mjs";

const images = process.argv.slice(2);
assert.ok(images.length > 0, "Pass the image file paths to verify uploads.");

async function viewportFits(page) {
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    "Horizontal page overflow",
  );
}

async function insideViewport(page, locator) {
  const box = await locator.boundingBox();
  const viewport = page.viewportSize();
  assert.ok(
    box &&
      box.x >= 0 &&
      box.y >= 0 &&
      box.x + box.width <= viewport.width + 1 &&
      box.y + box.height <= viewport.height + 1,
    `Control outside viewport: ${await locator.getAttribute("aria-label")}`,
  );
}

let fixture;
try {
  fixture = await startMobileFixture();
  const { context, origin, instanceId, fixtureRoot } = fixture;
  const artifactRoot = join(fixtureRoot, "screenshots");
  await mkdir(artifactRoot, { recursive: true });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const measurements = [];
  for (const [width, height] of [
    [320, 740],
    [390, 844],
    [920, 414],
    [390, 420],
  ]) {
    process.stdout.write(`Checking ${width}x${height}\n`);
    await page.setViewportSize({ width, height });
    await page.goto(`${origin}/instances`);
    await page
      .getByRole("heading", { name: "Devices", exact: false })
      .waitFor();
    await viewportFits(page);
    await page
      .getByRole("button", { name: "Details for Legion Go S", exact: true })
      .click();
    const details = page.getByRole("dialog");
    await details.waitFor();
    await insideViewport(page, details);
    await details
      .getByRole("button", { name: "Close", exact: true })
      .first()
      .click();
    await page.screenshot({
      path: join(artifactRoot, `fleet-${width}x${height}.png`),
    });
    await page.goto(`${origin}/instances/${instanceId}`);
    await selectProductView(page, "Chat");
    const input = page.getByRole("textbox", {
      name: "Task composer",
      exact: true,
    });
    await input.waitFor();
    await input.fill(
      "Review the mobile layout\nand keep all controls reachable.",
    );
    await viewportFits(page);
    await insideViewport(page, input);
    await insideViewport(
      page,
      page.getByRole("button", { name: "Send message", exact: true }),
    );
    const options = page.getByRole("button", {
      name: "Composer options",
      exact: true,
    });
    await options.waitFor({ state: "visible" });
    const modelBox = await page
      .locator(".m-composer-surface-model")
      .boundingBox();
    const optionsBox = await options.boundingBox();
    assert.ok(
      Math.abs(modelBox.y - optionsBox.y) < 5,
      "Model and options occupy separate rows",
    );
    const surface = await page.locator(".m-composer-surface").boundingBox();
    const conversation = await page
      .locator(".m-product-conversation")
      .boundingBox();
    assert.ok(
      conversation.height > 60,
      "Composer consumes the conversation space",
    );
    measurements.push({
      width,
      height,
      composerHeight: surface.height,
      conversationHeight: conversation.height,
    });
    await options.click();
    assert.equal(await options.getAttribute("aria-expanded"), "true");
    await insideViewport(page, page.locator(".m-composer-surface-controls"));
    await options.click();
    await page.locator(".m-composer-surface-model button").click();
    const modelPicker = page.getByRole("dialog", {
      name: "Session model",
      exact: true,
    });
    await modelPicker.waitFor();
    await insideViewport(page, modelPicker);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Sessions", exact: true }).click();
    await page.getByRole("dialog", { name: "Sessions", exact: true }).waitFor();
    await page
      .getByRole("button", { name: "Close sessions", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Device actions", exact: true })
      .click();
    await page
      .getByRole("menuitem", { name: "Refresh", exact: true })
      .waitFor();
    await page.keyboard.press("Escape");
    await page.screenshot({
      path: join(artifactRoot, `chat-${width}x${height}.png`),
    });
  }
  process.stdout.write("Checking visible viewport with the keyboard open\n");
  const keyboardViewport = await verifyKeyboardViewport(
    page,
    artifactRoot,
    "fleet-chat",
  );
  await page
    .getByRole("textbox", { name: "Task composer", exact: true })
    .fill("Review the mobile layout");
  await setVisibleViewport(page, 420, 40);
  await openAttachments(page, "Images");
  await insideVisibleViewport(page, page.getByRole("dialog"));
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await restoreVisibleViewport(page);
  process.stdout.write("Checking attachment browsing by touch\n");
  const attachmentBrowsing = await verifyMobileAttachmentBrowsing(
    page,
    fixture,
    artifactRoot,
  );
  process.stdout.write("Checking phone uploads\n");
  await page.setViewportSize({ width: 390, height: 844 });
  await openAttachments(page, "Images");
  await page
    .getByRole("button", { name: "Browse device", exact: true })
    .click();
  await page.getByRole("button", { name: "photos/", exact: true }).waitFor();
  assert.equal(fixture.browsed.at(-1), ".");
  await page.getByRole("button", { name: "photos/", exact: true }).click();
  await page.getByRole("button", { name: "Up", exact: true }).click();
  await page.getByRole("button", { name: "photos/", exact: true }).waitFor();
  assert.equal(fixture.browsed.at(-1), ".");
  await insideViewport(page, page.getByRole("dialog"));
  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Upload files", exact: true }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles(images);
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  assert.equal(fixture.uploaded.length, images.length);
  for (let index = 0; index < images.length; index++) {
    assert.deepEqual(
      fixture.uploaded[index].bytes,
      await readFile(images[index]),
      "Uploaded screenshot bytes changed",
    );
  }
  assert.equal(fixture.transfers.size, 0);
  process.stdout.write("Checking an interrupted multi-chunk phone upload\n");
  const largeFile = {
    name: "Urlaub – März 📷.bin",
    mimeType: "application/octet-stream",
    buffer: randomBytes(393_216 * 3 + 17),
  };
  await openAttachments(page, "Files");
  fixture.failWriteAfter(393_216);
  await page.getByLabel("Upload attachments").setInputFiles(largeFile);
  await page
    .getByRole("alert")
    .filter({ hasText: "File upload was interrupted. Select the file again." })
    .waitFor();
  assert.equal(fixture.transfers.size, 0);
  fixture.failWriteAfter(null);
  await page.getByLabel("Upload attachments").setInputFiles(largeFile);
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  assert.equal(fixture.uploaded.at(-1).name, largeFile.name);
  assert.deepEqual(fixture.uploaded.at(-1).bytes, largeFile.buffer);
  assert.equal(fixture.transfers.size, 0);
  assert.deepEqual(
    fixture.transferWrites
      .filter(({ name }) => name === largeFile.name)
      .map(({ offset }) => offset),
    [0, 0, 393_216, 786_432, 1_179_648],
  );
  await page.screenshot({
    path: join(artifactRoot, "uploaded-phone-images.png"),
  });
  await openAttachments(page, "Files");
  fixture.failImport(true);
  await page.getByLabel("Upload attachments").setInputFiles({
    name: "phone-report.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Phone attachment"),
  });
  await page
    .getByRole("alert")
    .filter({ hasText: "Could not save the file. Try again." })
    .waitFor();
  assert.equal(fixture.transfers.size, 0);
  fixture.failImport(false);
  await page.getByLabel("Upload attachments").setInputFiles({
    name: "phone-report.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Phone attachment"),
  });
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  assert.equal(fixture.uploaded.at(-1).bytes.toString(), "Phone attachment");
  assert.equal(fixture.transfers.size, 0);
  process.stdout.write("Checking Media Studio phone picker\n");
  const mediaPicker = await verifyMobileMediaPicker(
    page,
    fixture,
    images[0],
    artifactRoot,
  );
  process.stdout.write("Checking fleet phone forms\n");
  const fleetForms = await verifyMobileFleetForms(page, fixture, artifactRoot);
  for (const [width, height] of [
    [320, 740],
    [920, 414],
  ]) {
    await page.setViewportSize({ width, height });
    for (const route of [
      "workspaces",
      "enrollment",
      "settings",
      "users",
      "copilot",
      "privacy",
    ]) {
      await page.goto(`${origin}/${route}`);
      await page.locator(".fleet-dashboard").waitFor();
      await viewportFits(page);
      await page.screenshot({
        path: join(artifactRoot, `${route}-${width}x${height}.png`),
      });
    }
  }
  const clientKeyboardViewport = await verifyClientUi(
    context,
    await palette(page),
    fixtureRoot,
  );
  const desktop = await fixture.browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 900 },
  });
  await desktop.addCookies(await context.cookies());
  const wide = await desktop.newPage();
  await wide.goto(`${origin}/instances/${instanceId}`);
  await selectProductView(wide, "Chat");
  await wide
    .getByRole("textbox", { name: "Task composer", exact: true })
    .waitFor();
  await viewportFits(wide);
  assert.ok(await wide.locator(".m-product-sidebar").isVisible());
  assert.ok(
    !(await wide
      .getByRole("button", { name: "Composer options", exact: true })
      .isVisible()),
  );
  await wide.screenshot({ path: join(artifactRoot, "chat-desktop.png") });
  assert.deepEqual(errors, []);
  await writeFile(
    join(fixtureRoot, "results.json"),
    JSON.stringify(
      {
        measurements,
        attachmentBrowsing,
        mediaPicker,
        fleetForms,
        keyboardViewports: {
          fleet: keyboardViewport,
          machdoch: clientKeyboardViewport,
          simulation:
            "VisualViewport height and offset overrides; native keyboard not exercised.",
        },
        uploaded: fixture.uploaded.map(({ name, bytes }) => ({
          name,
          size: bytes.length,
        })),
        browsed: fixture.browsed,
        transferWrites: fixture.transferWrites,
        errors,
        limitation:
          "Production manager and browser with a simulated native device; no physical phone or live desktop attachment storage.",
      },
      null,
      2,
    ),
  );
  process.stdout.write(
    `Mobile Playwright checks passed. Evidence: ${fixtureRoot}\n`,
  );
} catch (error) {
  if (fixture) {
    await writeFile(join(fixture.fixtureRoot, "failure.txt"), error.stack);
    for (const page of fixture.context.pages()) {
      await page
        .screenshot({
          path: join(
            fixture.fixtureRoot,
            `failure-${fixture.context.pages().indexOf(page)}.png`,
          ),
        })
        .catch(() => {});
    }
  }
  throw error;
} finally {
  await fixture?.close();
}
