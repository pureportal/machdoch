import { selectProductView } from "./verify-product-ui.mjs";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function eventually(check, message) {
  const deadline = Date.now() + 60_000;
  let cause;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch (error) {
      cause = error;
    }
    await delay(250);
  }
  throw new Error(message, { cause });
}

function fingerprint(flow) {
  const canonicalize = (value) =>
    Array.isArray(value)
      ? value.map(canonicalize)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .filter(([, entry]) => entry !== undefined)
              .sort(([left], [right]) => left.localeCompare(right))
              .map(([key, entry]) => [key, canonicalize(entry)]),
          )
        : value;
  const semantic = Object.fromEntries(
    [
      "schemaVersion",
      "id",
      "alias",
      "name",
      "description",
      "guidance",
      "settings",
      "variables",
      "blocks",
      "edges",
      "annotationLinks",
    ].map((key) => [key, flow[key]]),
  );
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(semantic)))
    .digest("hex");
}

export async function verifyRalphEditor({
  page,
  small,
  api,
  origin,
  fixtureRoot,
  device,
}) {
  await page.bringToFront();
  const browserErrors = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  const instanceId = device.connection.instanceId;
  const endpoint = `/instances/${instanceId}/product/ralph`;
  const exchange = (request) => api(endpoint, "POST", request);
  const readOperation = async (id) => {
    let encoded = "";
    const deadline = Date.now() + 60_000;
    try {
      while (Date.now() < deadline) {
        const response = await exchange({
          kind: "read",
          id,
          offset: encoded.length,
        });
        if (response.state === "failed")
          throw new Error(JSON.stringify(response.error));
        if (response.state === "pending") {
          await delay(250);
          continue;
        }
        assert.equal(response.state, "complete");
        assert.equal(response.offset, encoded.length);
        encoded += response.chunk;
        if (encoded.length === response.total)
          return JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
      }
      throw new Error("RALPH operation timed out.");
    } finally {
      await exchange({ kind: "release", id });
    }
  };
  const invoke = async (command, args = {}) => {
    const id = randomUUID();
    const started = await exchange({ kind: "invoke", id, command, args });
    assert.equal(started.state, "pending", JSON.stringify(started));
    return readOperation(id);
  };
  const run = (arguments_, taskId) =>
    invoke("run_ralph_command", {
      request: {
        workspaceRoot: device.workspace,
        arguments: arguments_,
        ...(taskId ? { taskId } : {}),
      },
    });
  const flow = {
    schemaVersion: 1,
    id: "fleet-remote-edit",
    name: "Fleet remote edit",
    description: "Remote payload – Grüße 世界 🧪 ".repeat(4000),
    blocks: [
      { id: "start", type: "START", title: "Start", position: { x: 0, y: 0 } },
      {
        id: "write",
        type: "UTILITY",
        title: "Write result",
        position: { x: 300, y: 0 },
        utility: {
          type: "WRITE_FILE",
          path: "fleet-ralph-result.txt",
          content: "Remote RALPH execution verified.\n",
        },
      },
      {
        id: "end",
        type: "END",
        title: "Finish",
        status: "success",
        position: { x: 600, y: 0 },
      },
    ],
    edges: [
      { id: "start-write", from: "start", fromOutput: "SUCCESS", to: "write" },
      { id: "write-end", from: "write", fromOutput: "SUCCESS", to: "end" },
    ],
  };
  const saved = await run([
    "save",
    flow.id,
    "--scope",
    "workspace",
    "--flow-json",
    JSON.stringify(flow),
  ]);
  assert.equal(saved.validation.valid, true, JSON.stringify(saved.validation));
  assert.equal(saved.flow.description, flow.description);
  const initialFingerprint = fingerprint(saved.flow);
  process.stdout.write("Large RALPH payload saved on the remote device.\n");
  const inputFlow = {
    ...flow,
    id: "fleet-remote-input",
    name: "Fleet remote input",
    description: "",
    blocks: [
      flow.blocks[0],
      {
        id: "ask",
        type: "ASK_USER",
        title: "Details",
        mode: "alwaysAsk",
        fields: [
          {
            id: "details",
            label: "Details",
            type: "text",
            required: true,
            variableName: "details",
          },
        ],
      },
      {
        ...flow.blocks[1],
        utility: {
          type: "WRITE_FILE",
          path: "fleet-ralph-input.txt",
          content: "{{details}}",
        },
      },
      flow.blocks[2],
    ],
    edges: [
      { id: "start-ask", from: "start", fromOutput: "SUCCESS", to: "ask" },
      { id: "ask-write", from: "ask", fromOutput: "SUCCESS", to: "write" },
      flow.edges[1],
    ],
  };
  const inputSaved = await run([
    "save",
    inputFlow.id,
    "--scope",
    "workspace",
    "--flow-json",
    JSON.stringify(inputFlow),
  ]);
  assert.equal(
    inputSaved.validation.valid,
    true,
    JSON.stringify(inputSaved.validation),
  );
  const waiting = await run([
    "run",
    inputFlow.id,
    "--scope",
    "workspace",
    "--mode",
    "machdoch",
  ]);
  assert.equal(waiting.run.status, "waiting-for-input");
  const resumed = await run([
    "resume",
    waiting.run.runId,
    "--scope",
    "workspace",
    "--input-json",
    JSON.stringify({ details: "Remote input resumed" }),
  ]);
  assert.equal(resumed.run.status, "completed");
  assert.equal(
    await readFile(join(device.workspace, "fleet-ralph-input.txt"), "utf8"),
    "Remote input resumed",
  );
  const delayFlow = {
    ...flow,
    id: "fleet-remote-cancel",
    name: "Fleet remote cancel",
    description: "",
    blocks: [
      flow.blocks[0],
      {
        ...flow.blocks[1],
        utility: { type: "WAIT", mode: "delay", delaySeconds: 120 },
      },
      flow.blocks[2],
    ],
  };
  await run([
    "save",
    delayFlow.id,
    "--scope",
    "workspace",
    "--flow-json",
    JSON.stringify(delayFlow),
  ]);
  const operationId = randomUUID();
  const taskId = `ralph-fleet-cancel-${Date.now()}`;
  const invocation = {
    kind: "invoke",
    id: operationId,
    command: "run_ralph_command",
    args: {
      request: {
        workspaceRoot: device.workspace,
        arguments: [
          "run",
          delayFlow.id,
          "--scope",
          "workspace",
          "--mode",
          "machdoch",
        ],
        taskId,
      },
    },
  };
  assert.equal((await exchange(invocation)).state, "pending");
  await eventually(
    async () =>
      (await invoke("get_active_desktop_tasks")).some(
        (task) => task.id === taskId,
      ),
    "Remote RALPH task did not register.",
  );
  assert.equal((await exchange(invocation)).state, "pending");
  await eventually(async () => {
    const progress = await exchange({ kind: "events", after: 0 });
    return (
      progress.state === "events" &&
      progress.events.some(
        (event) =>
          event.name === "desktop-task-progress" &&
          event.payload.taskId === taskId,
      )
    );
  }, "Remote RALPH progress did not reach the controller.");
  const activeSnapshot = await api(`/instances/${instanceId}/product/snapshot`);
  assert.ok(
    activeSnapshot.sessions.some(
      (task) => task.taskId === taskId && task.cancellable,
    ),
  );
  const fleet = await api("/fleet/status");
  assert.ok(
    fleet.devices
      .find((entry) => entry.instanceId === instanceId)
      .tasks.some((task) => task.taskId === taskId),
  );
  await api(`/instances/${instanceId}/product/commands`, "POST", {
    kind: "cancel",
    commandId: randomUUID(),
    taskId,
  });
  const cancelled = await readOperation(operationId);
  assert.notEqual(cancelled.run.status, "completed");
  await eventually(
    async () =>
      !(await invoke("get_active_desktop_tasks")).some(
        (task) => task.id === taskId,
      ),
    "Cancelled RALPH task remained active.",
  );
  const retainedTask = await invoke("get_recent_desktop_task_results", {
    taskIds: [taskId],
  });
  assert.equal(retainedTask.length, 1);
  process.stdout.write(
    "Remote input/resume, global task visibility, replay and cancellation passed.\n",
  );
  const snapshot = await api(`/instances/${instanceId}/product/snapshot`);
  assert.equal(snapshot.shell.ralph.editorAvailable, true);
  assert.ok(snapshot.shell.ralph.flows.some((entry) => entry.id === flow.id));
  await page.goto(`${origin}/instances/${instanceId}`, {
    waitUntil: "domcontentloaded",
  });
  try {
    await selectProductView(page, "RALPH");
  } catch (cause) {
    process.stderr.write(
      `RALPH browser errors: ${JSON.stringify(browserErrors)}\n`,
    );
    await page
      .screenshot({
        path: join(fixtureRoot, "ralph-navigation-failed.png"),
        fullPage: true,
        timeout: 5_000,
      })
      .catch((error) => process.stderr.write(`${error.message}\n`));
    throw new Error(
      `RALPH navigation did not open. ${JSON.stringify(browserErrors)}`,
      { cause },
    );
  }
  const editor = page.frameLocator('iframe[title="RALPH"]');
  try {
    await editor
      .getByRole("button", { name: /Open Fleet remote edit in/ })
      .click();
  } catch (cause) {
    const state = await editor.locator("body").innerText();
    await page.screenshot({
      path: join(fixtureRoot, "ralph-overview-failed.png"),
      fullPage: true,
    });
    throw new Error(
      `RALPH overview did not open. ${JSON.stringify(browserErrors)} ${state.slice(0, 4000)}`,
      { cause },
    );
  }
  process.stdout.write("Shared RALPH overview opened the remote flow.\n");
  try {
    await editor.locator(".react-flow__node").first().waitFor();
  } catch (cause) {
    process.stderr.write(
      `RALPH browser errors: ${JSON.stringify(browserErrors)}\n`,
    );
    await page
      .screenshot({
        path: join(fixtureRoot, "ralph-open-failed.png"),
        fullPage: true,
        timeout: 5_000,
      })
      .catch((error) => process.stderr.write(`${error.message}\n`));
    throw new Error(
      `RALPH canvas did not open. ${JSON.stringify(browserErrors)}`,
      { cause },
    );
  }
  await editor
    .getByRole("button", { name: "Show flow settings", exact: true })
    .click();
  await editor
    .getByRole("textbox", { name: "Flow name", exact: true })
    .fill("Fleet desktop edit");
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await eventually(
    async () =>
      (await run(["show", flow.id, "--scope", "workspace"])).flow.name ===
      "Fleet desktop edit",
    "Desktop editor did not persist its change on the device.",
  );
  await page.screenshot({
    path: join(fixtureRoot, "ralph-desktop.png"),
    fullPage: true,
  });
  await editor
    .getByRole("button", { name: /^Fleet desktop edit\b/ })
    .click({ button: "right" });
  await editor.getByRole("menu").waitFor();
  assert.equal(
    await editor.getByText("Open in Explorer", { exact: true }).count(),
    0,
  );
  await editor.locator("body").press("Escape");
  const stale = await run([
    "save",
    flow.id,
    "--scope",
    "workspace",
    "--flow-json",
    JSON.stringify(flow),
    "--expected-fingerprint",
    initialFingerprint,
  ]).catch((error) => error);
  assert.ok(
    stale instanceof Error,
    "A stale remote editor overwrote the saved flow.",
  );
  assert.match(stale.message, /conflict|fingerprint/i);
  assert.equal(
    (await run(["show", flow.id, "--scope", "workspace"])).flow.name,
    "Fleet desktop edit",
  );
  await small.goto(`${origin}/instances/${instanceId}`, {
    waitUntil: "domcontentloaded",
  });
  await selectProductView(small, "RALPH");
  const mobile = small.frameLocator('iframe[title="RALPH"]');
  await mobile
    .getByRole("button", { name: /Open Fleet desktop edit in/ })
    .click();
  await mobile
    .getByRole("button", { name: "Show flow settings", exact: true })
    .click();
  await mobile
    .getByRole("textbox", { name: "Flow name", exact: true })
    .fill("Fleet mobile edit");
  await small.screenshot({
    path: join(fixtureRoot, "ralph-mobile-edit.png"),
    fullPage: true,
  });
  await mobile
    .getByRole("button", { name: "Hide block settings", exact: true })
    .click();
  await selectProductView(small, "Chat");
  await delay(6_000);
  await selectProductView(small, "RALPH");
  await mobile
    .getByRole("button", { name: "Show block settings", exact: true })
    .click();
  assert.equal(
    await mobile
      .getByRole("textbox", { name: "Flow name", exact: true })
      .inputValue(),
    "Fleet mobile edit",
  );
  await mobile
    .getByRole("button", { name: "Hide block settings", exact: true })
    .click();
  await mobile.getByRole("button", { name: "Save", exact: true }).click();
  await eventually(
    async () =>
      (await run(["show", flow.id, "--scope", "workspace"])).flow.name ===
      "Fleet mobile edit",
    "Mobile editor did not persist its change on the device.",
  );
  assert.ok(
    await small.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  );
  assert.ok(
    await mobile
      .locator("body")
      .evaluate(
        (element) =>
          element.ownerDocument.documentElement.scrollWidth <=
          element.ownerDocument.defaultView.innerWidth,
      ),
  );
  await small.screenshot({
    path: join(fixtureRoot, "ralph-mobile.png"),
    fullPage: true,
  });
  await mobile
    .getByRole("button", { name: "Run Ralph flow", exact: true })
    .click();
  await eventually(
    async () =>
      (await readFile(
        join(device.workspace, "fleet-ralph-result.txt"),
        "utf8",
      )) === "Remote RALPH execution verified.\n",
    "Running the saved flow from the mobile editor did not write the remote result.",
  );
  let completed;
  await eventually(async () => {
    completed = (
      await run(["runs", flow.id, "--scope", "workspace"])
    ).runs.find((entry) => entry.status === "completed");
    return Boolean(completed);
  }, "Remote run did not finish successfully.");
  const detail = await run([
    "run-detail",
    completed.id,
    "--scope",
    "workspace",
  ]);
  assert.equal(detail.effectiveStatus, "completed");
  assert.equal(detail.record.flowName, "Fleet mobile edit");
  assert.ok(
    detail.record.blockResults.some((result) => result.blockId === "write"),
  );
  const revisions = await run(["revisions", flow.id, "--scope", "workspace"]);
  assert.ok(revisions.revisions.length >= 2);
  const recent = await invoke("get_active_desktop_tasks");
  assert.ok(
    !recent.some((task) => task.arguments.includes(flow.id)),
    "Completed run remains active.",
  );
  await assert.rejects(
    () =>
      invoke("run_ralph_command", {
        request: {
          workspaceRoot: join(fixtureRoot, "unlisted"),
          arguments: ["list"],
        },
      }),
    /workspace|project/i,
  );
  return "The shared desktop RALPH canvas edited and saved on desktop and at 390px, retained an unsaved edit across view navigation and device refresh, rejected a stale save, and executed a utility flow on a real remote CLI. Both the page and the iframe fit the mobile viewport. Result files, revisions, persisted runs and task retirement were checked independently. Remote input/resume, progress delivery, global task visibility, invocation replay and cancellation passed. A multilingual payload larger than Windows command-line limits was saved intact; unlisted workspaces were rejected.";
}
