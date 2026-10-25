import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { NativeSupervisor } from "@machdoch/cloud-client/supervisor";

await test("shutdown lets the native owner finish cleanup beyond an IPC acknowledgment deadline", async (context) => {
  let killed = 0;
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null as number | null,
    signalCode: null,
    kill: () => {
      killed++;
      return true;
    },
  });
  const spawn = context.mock.method(
    childProcess,
    "spawn",
    () => child as unknown as ReturnType<typeof childProcess.spawn>,
  );
  syncBuiltinESMExports();
  context.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const supervisor = new NativeSupervisor(process.execPath);
    let finished = false;
    const closing = supervisor.close().then(() => {
      finished = true;
    });
    assert.deepEqual(JSON.parse(child.stdin.read().toString()), {
      kind: "stop",
    });
    context.mock.timers.tick(10000);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(killed, 0);
    assert.equal(finished, false);
    child.exitCode = 0;
    child.emit("exit", 0, null);
    await Promise.resolve();
    assert.equal(finished, false);
    child.emit("close", 0, null);
    await closing;
    assert.equal(finished, true);
  } finally {
    spawn.mock.restore();
    syncBuiltinESMExports();
  }
});

await test("an uncertain command acknowledgment stops the process and rejects later commands", async (context) => {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null as number | null,
    signalCode: null,
    kill: () => true,
  });
  const spawn = context.mock.method(
    childProcess,
    "spawn",
    () => child as unknown as ReturnType<typeof childProcess.spawn>,
  );
  syncBuiltinESMExports();
  context.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const supervisor = new NativeSupervisor(process.execPath);
    const pending = supervisor.anchor();
    assert.equal(JSON.parse(child.stdin.read().toString()).kind, "anchor");
    const rejected = assert.rejects(pending, /did not acknowledge/);
    context.mock.timers.tick(5000);
    await rejected;
    assert.equal(supervisor.signal.aborted, true);
    assert.deepEqual(JSON.parse(child.stdin.read().toString()), {
      kind: "stop",
    });
    await assert.rejects(supervisor.anchor(), /did not acknowledge/);
    child.exitCode = 1;
    child.emit("exit", 1, null);
    child.emit("close", 1, null);
    await assert.rejects(supervisor.close(), /did not acknowledge/);
  } finally {
    spawn.mock.restore();
    syncBuiltinESMExports();
  }
});

await test("chunks concurrent input messages without interleaving and orders EOF last", async (context) => {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null as number | null,
    signalCode: null,
    kill: () => true,
  });
  const frames: (Buffer | null)[] = [];
  child.stdin.on("data", (bytes: Buffer) => {
    const command = JSON.parse(bytes.toString("utf8"));
    if (command.kind !== "input") return;
    frames.push(
      command.data === null ? null : Buffer.from(command.data, "base64"),
    );
    child.stdout.write(
      JSON.stringify({ kind: "input_written", id: command.id }) + "\n",
    );
  });
  const spawn = context.mock.method(
    childProcess,
    "spawn",
    () => child as unknown as ReturnType<typeof childProcess.spawn>,
  );
  syncBuiltinESMExports();
  try {
    const supervisor = new NativeSupervisor(process.execPath);
    const first = Buffer.from("元🙂".repeat(30000));
    const expected = Buffer.from(first);
    const firstWrite = supervisor.writeInput(first);
    first.fill(0);
    await Promise.all([
      firstWrite,
      supervisor.writeInput(Buffer.from("tail")),
      supervisor.writeInput(null),
    ]);
    assert.deepEqual(
      Buffer.concat(frames.filter((frame): frame is Buffer => frame !== null)),
      Buffer.concat([expected, Buffer.from("tail")]),
    );
    assert.equal(frames.at(-1), null);
    assert.ok(frames.every((frame) => frame === null || frame.length <= 65536));
    await assert.rejects(supervisor.writeInput(Buffer.from("late")), /closed/);
    child.exitCode = 0;
    child.emit("close", 0, null);
    await supervisor.close();
  } finally {
    spawn.mock.restore();
    syncBuiltinESMExports();
  }
});
