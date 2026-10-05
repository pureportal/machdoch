import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FleetRalphEditor } from "./cli-fleet-ralph-editor.js";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));

let workspace: string;
let editor: FleetRalphEditor;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "machdoch-fleet-editor-"));
  editor = new FleetRalphEditor(async () => workspace);
  mocks.spawn.mockReset();
});

afterEach(async () => {
  await editor.shutdown();
  await rm(workspace, { recursive: true, force: true });
});

function respond(value: unknown, splitBytes = false): void {
  mocks.spawn.mockImplementationOnce(() => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    setTimeout(() => {
      const output = Buffer.from(JSON.stringify(value));
      if (splitBytes)
        for (const byte of output) child.stdout.write(Buffer.from([byte]));
      else child.stdout.write(output);
      child.stdout.end();
      child.stderr.end();
      child.emit("close", 0);
    }, 0);
    return child;
  });
}

async function readOperation(id: string): Promise<unknown> {
  let content = "";
  try {
    await vi.waitFor(async () => {
      const response = await editor.request({ kind: "read", id, offset: 0 });
      expect(response.state).toBe("complete");
    });
    for (;;) {
      const response = await editor.request({
        kind: "read",
        id,
        offset: content.length,
      });
      if (response.state !== "complete")
        throw new Error("Expected completed RALPH response.");
      content += response.chunk;
      if (content.length === response.total)
        return JSON.parse(Buffer.from(content, "base64").toString("utf8"));
    }
  } finally {
    await editor.request({ kind: "release", id });
  }
}

async function execute(taskId: string): Promise<unknown> {
  const id = randomUUID();
  expect(
    (
      await editor.request({
        kind: "invoke",
        id,
        command: "run_ralph_command",
        args: {
          request: { workspaceRoot: workspace, arguments: ["list"], taskId },
        },
      })
    ).state,
  ).toBe("pending");
  return readOperation(id);
}

it("preserves Unicode when CLI output splits every UTF-8 byte", async () => {
  const value = { name: "Grüße 世界 🧪", flows: [] };
  respond(value, true);
  expect(await execute("unicode-task")).toEqual(value);
});

it("bounds recent task results by bytes as well as task count", async () => {
  const size = 34 * 1024 * 1024;
  for (const taskId of ["first-task", "second-task"]) {
    respond({ payload: "x".repeat(size) });
    const result = (await execute(taskId)) as { payload: string };
    expect(result.payload.length).toBe(size);
  }
  const id = randomUUID();
  await editor.request({
    kind: "invoke",
    id,
    command: "get_recent_desktop_task_results",
    args: { taskIds: ["first-task", "second-task"] },
  });
  const results = (await readOperation(id)) as Array<{ id: string }>;
  expect(results.map((result) => result.id)).toEqual(["second-task"]);
});
