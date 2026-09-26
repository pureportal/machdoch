import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { chromium } from "playwright-core";

const candidates = [
  process.env.CHROME_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
].filter(Boolean);
let executablePath;
for (const candidate of candidates) {
  try { await access(candidate); executablePath = candidate; break; } catch {}
}
if (!executablePath) throw new Error("Chrome or Edge was not found.");

const browser = await chromium.launch({ executablePath, headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
  await page.goto(process.env.MACHDOCH_CLIENT_UI_URL ?? "http://127.0.0.1:4173");
  const skip = page.getByRole("button", { name: "Skip first-startup setup" });
  if (await skip.count()) await skip.click();
  await page.getByRole("dialog").waitFor({ timeout: 5000 }).catch(() => undefined);
  const setup = page.getByRole("button", { name: "Skip setup", exact: true });
  if (await setup.count()) await setup.click();
  const mediaButton = page.locator('.app-shell-rail button[aria-label^="Media Studio"]');
  if (!await mediaButton.count()) throw new Error(`Media Studio is unavailable: ${(await page.locator("body").innerText()).slice(0, 1_000)}; errors: ${errors.join(" | ")}`);
  await mediaButton.click();
  await page.locator('.m-media-navigation button[aria-label="Basic"]').click();
  await page.getByRole("button", { name: "Create pose map" }).click();
  const canvas = page.getByRole("img", { name: "Pose canvas" });
  await canvas.waitFor();
  if (await page.getByRole("button", { name: "Combine" }).count()) throw new Error("Combine is still visible.");
  if (await page.getByRole("button", { name: /^Use pose \d|^Add pose \d/ }).count()) throw new Error("Duplicate asset actions are still visible.");

  const standingPreview = page.getByRole("button", { name: "Add Standing" }).locator("svg");
  const walkingPreview = page.getByRole("button", { name: "Add Walking" }).locator("svg");
  const standingWristSpan = Number(await standingPreview.locator("circle").nth(7).getAttribute("cx"))
    - Number(await standingPreview.locator("circle").nth(4).getAttribute("cx"));
  const walkingWristY = Number(await walkingPreview.locator("circle").nth(4).getAttribute("cy"));
  const walkingShoulderY = Number(await walkingPreview.locator("circle").nth(2).getAttribute("cy"));
  if (standingWristSpan > 150 || walkingWristY <= walkingShoulderY) throw new Error("Preset arm geometry regressed.");

  await page.getByRole("button", { name: "Add Standing", exact: true }).click();
  const first = canvas.locator('g[role="button"]').first();
  const torso = first.locator("line").first();
  await torso.scrollIntoViewIfNeeded();
  const before = Number(await torso.getAttribute("x1"));
  const box = await torso.boundingBox();
  if (!box) throw new Error("Pose is not visible.");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  const after = Number(await torso.getAttribute("x1"));
  if (!(after > before + 50)) throw new Error(`Pose did not move: ${before} -> ${after}`);
  await torso.dblclick();
  await page.getByRole("button", { name: "Done" }).waitFor();
  const joint = first.locator("circle").nth(4);
  const jointBefore = Number(await joint.getAttribute("cx"));
  const jointBox = await joint.boundingBox();
  if (!jointBox) throw new Error("Joint is not visible.");
  await page.mouse.move(jointBox.x + jointBox.width / 2, jointBox.y + jointBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(jointBox.x + jointBox.width / 2 + 35, jointBox.y + jointBox.height / 2, { steps: 6 });
  await page.mouse.up();
  const jointAfter = Number(await joint.getAttribute("cx"));
  if (!(jointAfter > jointBefore)) throw new Error("Joint did not move.");
  if (await page.getByRole("button", { name: "Done" }).count() !== 1) throw new Error("Joint drag deselected the figure.");
  await page.getByRole("button", { name: "Done" }).click();
  await page.getByRole("slider", { name: "Map Strength" }).fill("1.25");
  await page.getByRole("slider", { name: "Map Start" }).fill("0.2");
  await page.getByRole("slider", { name: "Map End" }).fill("0.8");
  if (await page.getByRole("slider", { name: "Map Strength" }).inputValue() !== "1.25") throw new Error("Pose strength did not update.");
  const firstBeforeAdd = Number(await torso.getAttribute("x1"));
  await page.getByRole("button", { name: "Add Sitting" }).click();
  if (await canvas.locator('g[role="button"]').count() !== 2) throw new Error("Second pose was not added.");
  const firstBeforeSecondMove = Number(await torso.getAttribute("x1"));
  if (firstBeforeSecondMove !== firstBeforeAdd) throw new Error("Adding a pose moved the first figure.");
  const secondLeg = canvas.locator('g[role="button"]').nth(1).locator("line").nth(9);
  await secondLeg.scrollIntoViewIfNeeded();
  const secondBefore = Number(await secondLeg.getAttribute("x1"));
  const secondBox = await secondLeg.boundingBox();
  if (!secondBox) throw new Error("Second pose is not visible.");
  await page.mouse.move(secondBox.x + secondBox.width / 2, secondBox.y + secondBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(secondBox.x + secondBox.width / 2 - 40, secondBox.y + secondBox.height / 2, { steps: 6 });
  await page.mouse.up();
  const secondAfter = Number(await secondLeg.getAttribute("x1"));
  const firstAfterSecondMove = Number(await torso.getAttribute("x1"));
  if (!(secondAfter < secondBefore - 20) || firstAfterSecondMove !== firstBeforeSecondMove) {
    const hit = await page.evaluate(({ x, y }) => {
      const target = document.elementFromPoint(x, y);
      return { tag: target?.tagName, pose: target?.closest('g[role="button"]')?.getAttribute("aria-label") };
    }, { x: secondBox.x + secondBox.width / 2, y: secondBox.y + secondBox.height / 2 });
    throw new Error(`Figures did not move independently: second ${secondBefore} -> ${secondAfter}, first ${after} -> ${firstAfterSecondMove}, hit ${JSON.stringify(hit)}.`);
  }
  await page.getByRole("button", { name: "Duplicate Standing" }).click();
  await page.getByRole("button", { name: "Edit Standing copy" }).click();
  await page.getByRole("button", { name: "Edit Standing", exact: true }).click();
  if (await page.getByRole("textbox", { name: "Pose name" }).inputValue() !== "Standing copy 2") throw new Error("Editing a default pose must create a new copy.");
  await page.getByRole("button", { name: "Cancel" }).click();

  const output = path.resolve("apps/client/.cache/openpose-review/pose-workspace.png");
  await mkdir(path.dirname(output), { recursive: true });
  await page.screenshot({ path: output, fullPage: true });
  await page.setViewportSize({ width: 430, height: 740 });
  await canvas.scrollIntoViewIfNeeded();
  const mobileCanvas = await canvas.boundingBox();
  const mobileLibrary = await page.locator('section[aria-label="Pose library"]').boundingBox();
  const mobileFigures = await page.getByRole("heading", { name: "Figures" }).boundingBox();
  if (!mobileCanvas || mobileCanvas.width > 430) throw new Error("Pose canvas overflows the mobile viewport.");
  if (!mobileLibrary || !mobileFigures || mobileLibrary.y + mobileLibrary.height > mobileCanvas.y || mobileCanvas.y + mobileCanvas.height > mobileFigures.y) throw new Error("Pose dialog sections overlap on mobile.");
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.reload();
  await page.locator('.app-shell-rail button[aria-label^="Media Studio"]').click();
  await page.locator('.m-media-navigation button[aria-label="Basic"]').click();
  await page.getByRole("button", { name: "Create pose map" }).click();
  await page.getByRole("button", { name: "Edit Standing copy" }).waitFor();
  await page.getByRole("button", { name: "Add Standing", exact: true }).click();
  await page.getByRole("button", { name: "Open in Pose chat" }).click();
  await page.getByRole("img", { name: "Editable pose scene" }).waitFor();
  if (await page.getByRole("textbox", { name: "Task composer" }).inputValue() !== "Refine this pose scene") throw new Error("Generate did not open a pose refinement chat.");
  if (await page.locator('section[aria-label="Pose scene"] g[role="button"]').count() !== 1) throw new Error("The starting scene is missing from Chat.");
  const chatScreenshot = path.resolve("apps/client/.cache/openpose-review/pose-chat.png");
  await page.screenshot({ path: chatScreenshot, fullPage: true });
  await page.locator('.app-shell-rail button[aria-label^="Media Studio"]').click();
  await page.locator('.m-media-navigation button[aria-label="Basic"]').click();
  await page.getByRole("button", { name: "Create pose map" }).click();
  await page.getByRole("button", { name: "Open in Pose chat" }).click();
  await page.getByRole("textbox", { name: "Task composer" }).waitFor();
  if (await page.getByRole("textbox", { name: "Task composer" }).inputValue() !== "Create a pose scene") throw new Error("Generate with an empty canvas did not open a new pose chat.");
  if (await page.locator('section[aria-label="Pose scene"] g[role="button"]').count()) throw new Error("The empty pose chat has an unexpected scene.");
  if (errors.length) throw new Error(errors.join("\n"));
  process.stdout.write(JSON.stringify({ moved: [before, after], secondMoved: [secondBefore, secondAfter], joint: [jointBefore, jointAfter], mobileCanvasWidth: mobileCanvas.width, screenshot: output, chatScreenshot }) + "\n");
} finally {
  await browser.close();
}
