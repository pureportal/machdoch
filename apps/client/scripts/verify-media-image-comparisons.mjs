import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

const root = path.resolve(process.argv[2]);
const manifest = JSON.parse(
  await readFile(path.join(root, "manifest.json"), "utf8"),
);
const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--allow-file-access-from-files"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
try {
  await page.goto(pathToFileURL(path.join(root, "index.html")).href);
  assert.equal(await page.locator("#reference option").count(), 6);
  let renders = 0;
  for (const reference of Object.keys(manifest.references)) {
    await page.locator("#reference").selectOption(reference);
    const generations = manifest.generations.filter(
      (entry) => entry.referenceId === reference,
    );
    assert.equal(
      await page.locator("#generation option").count(),
      generations.length,
    );
    for (let index = 0; index < generations.length; index++) {
      const generation = generations[index];
      await page.locator("#generation").selectOption(String(index));
      await page.waitForFunction(() =>
        [...document.images].every(
          (image) => image.complete && image.naturalWidth > 0,
        ),
      );
      assert.equal(
        await page.locator("#assessment").innerText(),
        generation.observations ?? "",
      );
      const sources = await page
        .locator("img")
        .evaluateAll((images) => images.map((image) => image.src));
      assert.ok(
        sources.every((source) =>
          source.startsWith(pathToFileURL(root + path.sep).href),
        ),
      );
      renders++;
    }
  }
  assert.equal(renders, manifest.generations.length);
  assert.deepEqual(errors, []);
  await page.screenshot({
    path: path.join(root, "comparison-current.png"),
    fullPage: true,
  });
  const result = {
    references: 6,
    renders,
    portableImages: true,
    observationsDisplayed: true,
    errors,
  };
  await writeFile(
    path.join(root, "playwright-results-current.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
}
