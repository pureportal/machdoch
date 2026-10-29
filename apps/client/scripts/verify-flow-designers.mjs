import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

const output = path.resolve(
  process.argv[2] ?? "apps/client/dist/flow-designer-results",
);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--allow-file-access-from-files"],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.setDefaultTimeout(10_000);
const errors = [];
const checks = [];
page.on("pageerror", (error) => errors.push(error.message));
const node = (id) => page.locator(`.react-flow__node[data-id="${id}"]`);
const handle = (id, port, type) =>
  node(id).locator(
    `.react-flow__handle.${type}${port ? `[data-handleid="${port}"]` : ""}`,
  );
const count = async (selector, expected) =>
  page.waitForFunction(
    ({ selector, expected }) =>
      document.querySelectorAll(selector).length === expected,
    { selector, expected },
  );
const waitForFramedNodes = async () => {
  return page.waitForFunction(() => {
    const canvas = document
      .querySelector(".react-flow")
      .getBoundingClientRect();
    return [...document.querySelectorAll(".react-flow__node")].every((node) => {
      const box = node.getBoundingClientRect();
      return (
        box.width > 0 &&
        box.left >= canvas.left &&
        box.right <= canvas.right &&
        box.top >= canvas.top &&
        box.bottom <= canvas.bottom
      );
    });
  });
};
const fit = async () => {
  await page.getByRole("button", { name: "Fit View", exact: true }).click();
  await waitForFramedNodes();
  await page.locator(".react-flow__viewport").evaluate(
    (element) =>
      new Promise((resolve) => {
        let previous = "";
        let stableFrames = 0;
        const measure = () => {
          const transform = element.getAttribute("style");
          stableFrames = transform === previous ? stableFrames + 1 : 0;
          previous = transform;
          if (stableFrames >= 3) resolve();
          else requestAnimationFrame(measure);
        };
        requestAnimationFrame(measure);
      }),
  );
};
const checkPorts = async (designer) => {
  const rows = await page.locator(".flow-port-row").evaluateAll((elements) =>
    elements.map((element) => {
      const handles = element.querySelectorAll(".react-flow__handle");
      const dot = handles[0].getBoundingClientRect();
      const label = element.querySelector("span").getBoundingClientRect();
      return {
        count: handles.length,
        label: element.textContent.trim(),
        aligned:
          Math.abs(dot.y + dot.height / 2 - label.y - label.height / 2) < 1,
        beside: dot.right <= label.left || dot.left >= label.right,
      };
    }),
  );
  assert.ok(rows.length > 0);
  assert.ok(
    rows.every((row) => row.count === 1 && row.aligned && row.beside),
    JSON.stringify(rows),
  );
  assert.equal(
    await page.locator(".flow-node-ports .react-flow__handle").count(),
    await page.locator(".react-flow__handle").count(),
  );
  checks.push(`${designer}: one aligned, labeled handle per port`);
};
const connect = async (source, target) => {
  await source.dragTo(target);
};
const dragNode = async (id) => {
  await fit();
  const before = await node(id).evaluate((element) => element.style.transform);
  const box = await node(id).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + 25);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 40, box.y + 65, { steps: 8 });
  await page.mouse.up();
  await page.waitForFunction(
    ({ id, before }) =>
      document.querySelector(`.react-flow__node[data-id="${id}"]`).style
        .transform !== before,
    { id, before },
  );
  return {
    before,
    after: await node(id).evaluate((element) => element.style.transform),
  };
};
const checkZoom = async (designer) => {
  const viewport = page.locator(".react-flow__viewport");
  const before = await viewport.getAttribute("style");
  await page.getByRole("button", { name: "Zoom In", exact: true }).click();
  await page.waitForFunction(
    (before) =>
      document.querySelector(".react-flow__viewport").getAttribute("style") !==
      before,
    before,
  );
  await fit();
  checks.push(`${designer}: zoom and fit`);
};
const checkSelectionAndPan = async (designer, first, second) => {
  await fit();
  await node(first).click({ position: { x: 35, y: 25 } });
  await fit();
  await node(second).click({
    position: { x: 35, y: 25 },
    modifiers: ["Control"],
  });
  await page.waitForFunction(
    () => document.querySelectorAll(".react-flow__node.selected").length >= 2,
  );
  const canvas = await page.locator(".react-flow").boundingBox();
  const previous = await page
    .locator(".react-flow__viewport")
    .getAttribute("style");
  await page.mouse.move(canvas.x + 30, canvas.y + 30);
  await page.mouse.down({ button: "middle" });
  await page.mouse.move(canvas.x + 90, canvas.y + 70, { steps: 8 });
  await page.mouse.up({ button: "middle" });
  await page.waitForFunction(
    (previous) =>
      document.querySelector(".react-flow__viewport").getAttribute("style") !==
      previous,
    previous,
  );
  await fit();
  checks.push(designer + ": Control multi-selection and middle-button panning");
};
try {
  await page.goto(
    pathToFileURL(
      path.resolve("apps/client/dist/flow-designers-verification/index.html"),
    ).href,
  );
  await page
    .getByRole("button", { name: "Create blank Ralph flow from canvas" })
    .click();
  await count(".react-flow__node", 2);
  await waitForFramedNodes();
  checks.push("RALPH: opening the flow fits all nodes automatically");
  await page.getByRole("button", { name: "Add Validate block" }).click();
  await count(".react-flow__node", 3);
  await page.getByRole("button", { name: "Undo flow edit" }).click();
  await count(".react-flow__node", 2);
  await page.getByRole("button", { name: "Redo flow edit" }).click();
  await count(".react-flow__node", 3);
  checks.push("RALPH: add node, undo, redo");
  await page.getByRole("button", { name: "Hide block settings" }).click();
  await fit();
  await checkPorts("RALPH");
  await checkSelectionAndPan("RALPH", "start", "validator-1");
  await connect(
    handle("validator-1", "DONE", "source"),
    handle("end", null, "target"),
  );
  await count(".react-flow__edge", 2);
  checks.push("RALPH: connect labeled branch");
  await dragNode("validator-1");
  await page.getByRole("button", { name: "Clean Ralph layout" }).click();
  await fit();
  await checkZoom("RALPH");
  await node("validator-1").click({ position: { x: 65, y: 25 } });
  await page.getByLabel("Block title", { exact: true }).fill("Review result");
  await page.getByLabel("Block title", { exact: true }).press("Tab");
  await node("validator-1")
    .getByText("Review result", { exact: true })
    .waitFor();
  await page.getByRole("button", { name: "Hide block settings" }).click();
  await fit();
  checks.push("RALPH: drag, auto-layout, edit title");
  const ralphStyle = await node("validator-1")
    .locator(".flow-port-row")
    .first()
    .evaluate((element) => ({
      fontSize: getComputedStyle(element).fontSize,
      minHeight: getComputedStyle(element).minHeight,
    }));
  await page.screenshot({ path: path.join(output, "ralph-desktop.png") });
  await page
    .getByRole("navigation", { name: "Designers" })
    .getByRole("button", { name: "Media Studio" })
    .click();
  await count(".react-flow__node", 3);
  await waitForFramedNodes();
  checks.push("Media Studio: opening the flow fits all nodes automatically");
  await fit();
  await checkPorts("Media Studio");
  await checkSelectionAndPan("Media Studio", "prompt", "generate");
  await page.getByRole("button", { name: "Close node inspector" }).click();
  await fit();
  const mediaStyle = await node("generate")
    .locator(".flow-port-row")
    .first()
    .evaluate((element) => ({
      fontSize: getComputedStyle(element).fontSize,
      minHeight: getComputedStyle(element).minHeight,
    }));
  assert.deepEqual(mediaStyle, ralphStyle);
  checks.push("Both designers: identical port typography and spacing");
  await page.getByRole("button", { name: "Add node", exact: true }).click();
  await page.getByPlaceholder("Search nodes", { exact: true }).fill("Seed");
  await page.getByRole("option", { name: "Seed", exact: true }).click();
  await count(".react-flow__node", 4);
  const seedId = await page
    .locator(".react-flow__node")
    .filter({ hasText: /^sourceSeed/ })
    .getAttribute("data-id");
  await page.getByRole("button", { name: "Close node inspector" }).click();
  await page.getByRole("button", { name: "Undo flow edit" }).click();
  await count(".react-flow__node", 3);
  await page.getByRole("button", { name: "Redo flow edit" }).click();
  await count(".react-flow__node", 4);
  await fit();
  checks.push("Media Studio: search, add node, undo, redo");
  await connect(
    handle(seedId, "seed", "source"),
    handle("generate", "seed", "target"),
  );
  await count(".react-flow__edge", 3);
  const connectedEdges = await page
    .locator(".react-flow__edge")
    .evaluateAll((edges) => edges.map((edge) => edge.getAttribute("data-id")));
  await connect(
    handle(seedId, "seed", "source"),
    handle("generate", "prompt", "target"),
  );
  assert.deepEqual(
    await page
      .locator(".react-flow__edge")
      .evaluateAll((edges) =>
        edges.map((edge) => edge.getAttribute("data-id")),
      ),
    connectedEdges,
  );
  checks.push(
    "Media Studio: connect typed ports and reject incompatible connection",
  );
  const seedPosition = await dragNode(seedId);
  await page.getByRole("button", { name: "Undo flow edit" }).click();
  await page.waitForFunction(
    ({ id, position }) =>
      document.querySelector(`.react-flow__node[data-id="${id}"]`).style
        .transform === position,
    { id: seedId, position: seedPosition.before },
  );
  await page.getByRole("button", { name: "Redo flow edit" }).click();
  await page.waitForFunction(
    ({ id, position }) =>
      document.querySelector(`.react-flow__node[data-id="${id}"]`).style
        .transform === position,
    { id: seedId, position: seedPosition.after },
  );
  await page.getByRole("button", { name: "Auto-layout flow" }).click();
  await fit();
  await checkZoom("Media Studio");
  await node("generate").click({ position: { x: 65, y: 25 } });
  await page.getByLabel("Node name", { exact: true }).fill("Create artwork");
  await page.getByLabel("Node name", { exact: true }).press("Tab");
  await node("generate").getByText("Create artwork", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Close node inspector" }).click();
  await fit();
  await checkPorts("Media Studio after editing");
  checks.push("Media Studio: drag, layout history, auto-layout, edit title");
  await page.screenshot({ path: path.join(output, "media-desktop.png") });
  await node("prompt").click({ position: { x: 35, y: 25 } });
  await fit();
  await node("generate").click({
    position: { x: 35, y: 25 },
    modifiers: ["Control"],
  });
  await page
    .getByRole("button", { name: "Group 2 selected nodes", exact: true })
    .click();
  await page.getByRole("button", { name: "Close canvas organization" }).click();
  await fit();
  await page.waitForFunction(() => {
    const group = document
      .querySelector(".react-flow__node-mediaGroup")
      .getBoundingClientRect();
    return ["prompt", "generate"].every((id) => {
      const member = document
        .querySelector('.react-flow__node[data-id="' + id + '"]')
        .getBoundingClientRect();
      return (
        member.left > group.left &&
        member.right < group.right &&
        member.top > group.top &&
        member.bottom < group.bottom
      );
    });
  });
  checks.push("Media Studio: group bounds enclose full card and all ports");
  await page.screenshot({ path: path.join(output, "media-group.png") });
  await page.getByRole("button", { name: "Add node", exact: true }).click();
  await page.getByPlaceholder("Search nodes", { exact: true }).fill("Edit image");
  await page.getByRole("option", { name: "Edit image", exact: true }).click();
  await count(".react-flow__node", 6);
  const editCard = page.locator(".react-flow__node").filter({ hasText: /^taskEdit image/ });
  const maskRow = editCard.locator(".flow-port-row").filter({ hasText: /^Mask/ });
  assert.equal(await maskRow.count(), 1);
  assert.equal(await maskRow.locator(".react-flow__handle").count(), 1);
  await page.getByRole("button", { name: "Close node inspector" }).click();
  await fit();
  await checkPorts("Media Studio masked-image task");
  await editCard.screenshot({ path: path.join(output, "media-masked-image.png") });
  await page.getByRole("button", { name: "Undo flow edit" }).click();
  await count(".react-flow__node", 5);
  await page.setViewportSize({ width: 900, height: 700 });
  await fit();
  await checkPorts("Media Studio compact");
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await page.screenshot({ path: path.join(output, "media-compact.png") });
  await page
    .getByRole("navigation", { name: "Designers" })
    .getByRole("button", { name: "RALPH", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Create blank Ralph flow from canvas" })
    .click();
  const hideInspector = page.getByRole("button", {
    name: "Hide block settings",
  });
  if (await hideInspector.isVisible()) await hideInspector.click();
  await fit();
  await checkPorts("RALPH compact");
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await page.screenshot({ path: path.join(output, "ralph-compact.png") });
  assert.deepEqual(errors, []);
  await writeFile(
    path.join(output, "results.json"),
    JSON.stringify({ checks, errors }, null, 2),
  );
  console.log(JSON.stringify({ checks, errors }, null, 2));
} catch (error) {
  await page.screenshot({ path: path.join(output, "failure.png") });
  console.error(JSON.stringify({ checks, errors }, null, 2));
  throw error;
} finally {
  await browser.close();
}
