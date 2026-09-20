import { capture } from "./browser.mjs";

export async function reviewMediaStates(page, size) {
  await page
    .getByRole("button", { name: "Media Studio", exact: true })
    .filter({ visible: true })
    .click();
  await page.locator('iframe[title="Media Studio"]').waitFor();
  await capture(page, `${size}-media-studio`);
  await page
    .getByRole("button", { name: "Chat", exact: true })
    .filter({ visible: true })
    .click();
  return `${size}: embedded shared Media Studio; generation and library interactions covered by verify:fleet-media`;
}
