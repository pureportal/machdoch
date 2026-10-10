import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { selectProductView } from "./verify-product-ui.mjs";
import {
  insideVisibleViewport,
  restoreVisibleViewport,
  setVisibleViewport,
} from "./mobile-viewport-verification.mjs";

export async function openAttachments(page, kind) {
  await page.getByRole("button", { name: "Add context", exact: true }).click();
  await page.getByRole("menuitem", { name: kind, exact: true }).click();
  await page
    .getByRole("dialog", { name: `Attach ${kind.toLowerCase()}`, exact: true })
    .waitFor();
}

export async function verifyMobileAttachmentBrowsing(
  page,
  fixture,
  artifactRoot,
) {
  await page.setViewportSize({ width: 320, height: 740 });
  await openAttachments(page, "Images");
  await page
    .getByRole("button", { name: "Browse device", exact: true })
    .click();
  await page.getByRole("button", { name: "photos/", exact: true }).click();
  const name =
    "Urlaub – März 📷 24 – Sonnenuntergang am Meer mit der Familie.png";
  const checkbox = page.getByRole("checkbox", {
    name: `Select ${name}`,
    exact: true,
  });
  const row = page.locator(".m-attachment-file").filter({ has: checkbox });
  await row.scrollIntoViewIfNeeded();
  const box = await row.boundingBox();
  assert.ok(box && box.height >= 44);
  await row.tap({ position: { x: box.width - 10, y: box.height / 2 } });
  assert.equal(await checkbox.isChecked(), true);
  const dialog = page.getByRole("dialog", {
    name: "Attach images",
    exact: true,
  });
  assert.ok(
    await dialog.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  );
  await page.screenshot({
    path: join(artifactRoot, "fleet-attachment-browser-phone.png"),
  });
  await dialog.getByRole("button", { name: "Attach", exact: true }).tap();
  await dialog.waitFor({ state: "hidden" });
  assert.ok(
    fixture.attachedPaths.includes("/projects/example/photos/holiday-24.png"),
  );
  await openAttachments(page, "Folders");
  const folder = page.getByRole("checkbox", {
    name: "Select photos",
    exact: true,
  });
  const folderTarget = page
    .locator(".m-attachment-directory-select")
    .filter({ has: folder });
  const targetBox = await folderTarget.boundingBox();
  assert.ok(targetBox && targetBox.width >= 44 && targetBox.height >= 44);
  await folderTarget.tap({
    position: { x: targetBox.width - 4, y: targetBox.height / 2 },
  });
  assert.equal(await folder.isChecked(), true);
  await page.getByRole("button", { name: "Attach", exact: true }).tap();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  assert.ok(fixture.attachedPaths.includes("/projects/example/photos"));
  return { fileTarget: box, folderTarget: targetBox, lastFileAttached: true };
}

export async function verifyMobileMediaPicker(
  page,
  fixture,
  image,
  artifactRoot,
) {
  await page.setViewportSize({ width: 390, height: 844 });
  await selectProductView(page, "Media Studio");
  const media = page.frameLocator('iframe[title="Media Studio"]');
  await media.getByRole("button", { name: "Assets", exact: true }).click();
  await media.getByRole("button", { name: "Import", exact: true }).click();
  let chooserPromise = page.waitForEvent("filechooser");
  await media
    .getByRole("button", { name: "Drop or select a file", exact: true })
    .click();
  const cancelled = await chooserPromise;
  assert.equal(
    await cancelled.element().evaluate((input) => input.isConnected),
    true,
  );
  await cancelled
    .element()
    .evaluate((input) => input.dispatchEvent(new Event("cancel")));
  assert.equal(await media.locator('input[type="file"]').count(), 0);
  assert.equal(fixture.transfers.size, 0);
  chooserPromise = page.waitForEvent("filechooser");
  await media
    .getByRole("button", { name: "Drop or select a file", exact: true })
    .click();
  const chooser = await chooserPromise;
  assert.equal(
    await chooser.element().evaluate((input) => input.isConnected),
    true,
  );
  await chooser.setFiles(image);
  await media
    .getByRole("button", { name: basename(image), exact: true })
    .waitFor();
  const importButton = media.getByRole("button", {
    name: "Import asset",
    exact: true,
  });
  await importButton.waitFor();
  await page.screenshot({
    path: join(artifactRoot, "fleet-media-phone-picker.png"),
  });
  await importButton.click();
  await media.locator("#media-import-title").waitFor({ state: "detached" });
  assert.equal(await media.locator('input[type="file"]').count(), 0);
  assert.equal(fixture.mediaImports.length, 1);
  assert.deepEqual(fixture.mediaImports[0].bytes, await readFile(image));
  assert.equal(fixture.transfers.size, 0);
  await page.screenshot({
    path: join(artifactRoot, "fleet-media-phone-import.png"),
  });
  return {
    pickerMounted: true,
    cancelledPickerRemoved: true,
    importedBytes: fixture.mediaImports[0].bytes.length,
    transfersReleased: true,
  };
}

export async function verifyMobileFleetForms(page, fixture, artifactRoot) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${fixture.origin}/settings`);
  await page.getByRole("button", { name: "New profile", exact: true }).click();
  const profile = page.getByRole("dialog", {
    name: "New profile",
    exact: true,
  });
  await profile.getByLabel("Name", { exact: true }).fill("Phone verification");
  await setVisibleViewport(page, 360, 40);
  await insideVisibleViewport(page, profile);
  await profile
    .getByRole("button", { name: "Create profile", exact: true })
    .click();
  await profile.waitFor({ state: "hidden" });
  await restoreVisibleViewport(page);
  await page
    .getByLabel("Profile section", { exact: true })
    .selectOption("instructions");
  await page
    .getByRole("button", { name: "Add instruction", exact: true })
    .click();
  const instruction = page.getByRole("dialog", {
    name: "New instruction",
    exact: true,
  });
  await instruction
    .getByLabel("Name", { exact: true })
    .fill("Phone instruction");
  await instruction
    .getByLabel("Content", { exact: true })
    .fill("Saved from a phone viewport.");
  await setVisibleViewport(page, 360, 40);
  await insideVisibleViewport(page, instruction);
  await instruction
    .getByRole("button", { name: "Save instruction", exact: true })
    .scrollIntoViewIfNeeded();
  await insideVisibleViewport(
    page,
    instruction.getByRole("button", { name: "Save instruction", exact: true }),
  );
  await page.screenshot({
    path: join(artifactRoot, "fleet-instruction-keyboard.png"),
  });
  await instruction
    .getByRole("button", { name: "Save instruction", exact: true })
    .click();
  await instruction.waitFor({ state: "hidden" });
  await restoreVisibleViewport(page);
  await page
    .getByRole("button", { name: "Edit Phone instruction", exact: true })
    .waitFor();
  await page.reload();
  await page
    .getByLabel("Profile section", { exact: true })
    .selectOption("instructions");
  await page
    .getByRole("button", { name: "Edit Phone instruction", exact: true })
    .click();
  assert.equal(
    await page.getByLabel("Content", { exact: true }).inputValue(),
    "Saved from a phone viewport.",
  );
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.goto(`${fixture.origin}/instances`);
  await page
    .getByRole("button", { name: "Enroll device", exact: true })
    .click();
  const enrollment = page.getByRole("dialog", {
    name: "Enroll device",
    exact: true,
  });
  await enrollment
    .getByRole("button", { name: "Create enrollment key", exact: true })
    .click();
  await enrollment.getByLabel("Enrollment key", { exact: true }).waitFor();
  await insideVisibleViewport(page, enrollment);
  await enrollment.getByRole("button", { name: "Done", exact: true }).click();
  return {
    profileSaved: true,
    instructionPersisted: true,
    enrollmentCreated: true,
  };
}
