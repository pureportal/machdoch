import { chromium } from "playwright-core";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const outputRoot = process.argv[2];
if (!outputRoot) throw new Error("Pass a verification output directory.");
await mkdir(outputRoot, { recursive: true });
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1080 } });
let imageId;
let imageUuid;
const imageDownloads = [];
page.on("response", (response) => {
  if (
    imageUuid &&
    response.url().startsWith("https://image.civitai.com/") &&
    response.url().includes(imageUuid) &&
    response.status() === 200
  ) {
    const filename = join(outputRoot, `reference-${imageId}.jpeg`);
    imageDownloads.push(
      response.body().then((body) => writeFile(filename, body)),
    );
  }
});
let records = [];
try {
  records = JSON.parse(
    await readFile(join(outputRoot, "civitai-references.json"), "utf8"),
  );
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
try {
  for (const id of [
    144655944, 144697438, 144594528, 145095967, 144599398, 145177887,
  ]) {
    const existing = records.find((record) => record.id === id);
    if (
      existing?.links &&
      (await access(join(outputRoot, `reference-${id}.jpeg`)).then(
        () => true,
        () => false,
      ))
    )
      continue;
    imageId = id;
    imageUuid = existing?.records[0]?.url;
    const url = `https://civitai.red/images/${id}`;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page
      .getByText("Generation data", { exact: true })
      .or(page.getByText("This content requires an account", { exact: true }))
      .waitFor({ timeout: 30000 });
    const more = page.getByText("Show more", { exact: true });
    for (let count = 0; count < (await more.count());)
      await more.first().click();
    const record = await page.evaluate(
      ({ id, url }) => {
        const data = document.querySelector("#__NEXT_DATA__");
        const state = data ? JSON.parse(data.textContent) : null;
        const matching = [];
        const visit = (value) => {
          if (!value || typeof value !== "object") return;
          if (value.id === id && (value.meta || value.url))
            matching.push(value);
          for (const child of Object.values(value)) visit(child);
        };
        visit(state);
        return {
          id,
          url,
          title: document.title,
          text: document.body.innerText,
          records: matching,
          links: [...document.links]
            .map((link) => ({ href: link.href, text: link.textContent.trim() }))
            .filter((link) => link.href.includes("/models/")),
          images: [...document.images].map((img) => ({
            src: img.currentSrc,
            alt: img.alt,
            width: img.naturalWidth,
            height: img.naturalHeight,
          })),
        };
      },
      { id, url },
    );
    records = [...records.filter((record) => record.id !== id), record];
    await writeFile(
      join(outputRoot, "civitai-references.json"),
      JSON.stringify(records, null, 2),
    );
    await page.screenshot({
      path: join(outputRoot, `reference-${id}.png`),
      fullPage: true,
    });
    if (
      imageUuid &&
      record.images.some((image) => image.src.includes(imageUuid))
    ) {
      await page
        .locator(`img[src*="${imageUuid}"]`)
        .first()
        .screenshot({ path: join(outputRoot, `reference-${id}-image.png`) });
    }
    console.log(
      JSON.stringify({
        id,
        records: record.records.length,
        images: record.images.length,
        generationData: record.text.slice(
          record.text.indexOf("Generation data"),
          record.text.indexOf("Discussion"),
        ),
      }),
    );
  }
} finally {
  await Promise.all(imageDownloads);
  await browser.close();
}
