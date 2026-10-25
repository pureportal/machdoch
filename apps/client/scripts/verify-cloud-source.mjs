import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  unlink,
  readdir,
  open,
  access,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { NativeSupervisor } from "@machdoch/cloud-client/supervisor";
import {
  exportClientSourcePack,
  sourcePackRuntimeSchema,
} from "../src/core/cloud/source-pack.ts";

assert.ok(
  process.env.MACHDOCH_CLOUD_SOURCE_RUNTIME,
  "Select the verified source export runtime.",
);
const runtime = sourcePackRuntimeSchema.parse(
  JSON.parse(await readFile(process.env.MACHDOCH_CLOUD_SOURCE_RUNTIME, "utf8")),
);
const parent = resolve("../../.tmp/cloud-source-verification");
await mkdir(parent, { recursive: true });
const directory = await mkdtemp(join(parent, "case-"));
const checks = [];
function git(path, args, input) {
  const child = spawnSync(
    runtime.git.path,
    [
      "--no-optional-locks",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.autocrlf=false",
      "-C",
      path,
      ...args,
    ],
    {
      windowsHide: true,
      input,
      maxBuffer: 1024 * 1024,
      env: {
        SystemRoot: process.env.SystemRoot,
        GIT_CONFIG_GLOBAL: "NUL",
        GIT_CONFIG_SYSTEM: "NUL",
        GIT_TERMINAL_PROMPT: "0",
      },
    },
  );
  assert.equal(child.status, 0, child.stderr?.toString());
  return child.stdout.toString();
}
const commit = (path) => {
  git(path, ["add", "-A"]);
  git(path, [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "-qm",
    "Fixture",
  ]);
  return git(path, ["rev-parse", "HEAD"]).trim();
};
async function fixture(name) {
  const root = join(directory, name);
  const source = join(root, "source 工作"),
    storage = join(root, "exports");
  await mkdir(source, { recursive: true });
  await mkdir(storage);
  git(source, ["init", "-q", "--template="]);
  return {
    root,
    source,
    storage,
    identity: { repositoryRoot: source, gitDirectory: join(source, ".git") },
  };
}
async function receipt(storage) {
  const folders = await readdir(storage);
  assert.equal(folders.length, 1);
  const value = JSON.parse(
    await readFile(join(storage, folders[0], "stopped.json"), "utf8"),
  );
  assert.equal(value.processTreeStopped, true);
  return value;
}

await test("exports the pinned tree with no history, private files, source writes or local Git commands", async () => {
  const current = await fixture("pinned");
  await writeFile(
    join(current.source, "old-secret.txt"),
    "old private history",
  );
  commit(current.source);
  await unlink(join(current.source, "old-secret.txt"));
  await writeFile(join(current.source, "README"), "pinned source\n");
  await writeFile(
    join(current.source, "keep.txt"),
    "must survive export-ignore\n",
  );
  await writeFile(
    join(current.source, ".gitattributes"),
    "keep.txt export-ignore filter=hostprobe\n",
  );
  const base = commit(current.source);
  await writeFile(join(current.source, "README"), "staged change\n");
  git(current.source, ["add", "README"]);
  await writeFile(join(current.source, "README"), "dirty change\n");
  await writeFile(
    join(current.source, "untracked-private.txt"),
    "private untracked data",
  );
  const configPath = join(current.source, ".git", "config");
  const config =
    (await readFile(configPath, "utf8")) +
    '\n[core]\n\tfsmonitor = cmd.exe /d /c echo unsafe > invoked.txt\n[filter "hostprobe"]\n\tclean = cmd.exe /d /c echo unsafe > invoked.txt\n\tsmudge = cmd.exe /d /c echo unsafe > invoked.txt\n[uploadpack]\n\tpackObjectsHook = cmd.exe /d /c echo unsafe > invoked.txt\n';
  await writeFile(configPath, config);
  const index = await readFile(join(current.source, ".git", "index"));
  const refs = git(current.source, ["show-ref"]);
  const pack = await exportClientSourcePack(
    current.identity,
    base,
    current.storage,
    runtime,
    new AbortController().signal,
  );
  assert.equal(
    pack.sha256,
    createHash("sha256").update(pack.bytes).digest("hex"),
  );
  const destination = join(current.root, "restored");
  await mkdir(destination);
  git(destination, ["init", "-q", "--template="]);
  await writeFile(join(destination, ".git", "shallow"), base + "\n");
  git(
    destination,
    ["index-pack", "--strict", "--stdin", "--max-input-size=67108864"],
    pack.bytes,
  );
  git(destination, ["update-ref", "refs/heads/base", base]);
  git(destination, ["checkout", "-q", "--detach", base]);
  git(destination, ["fsck", "--strict", "--no-dangling", base]);
  assert.equal(
    await readFile(join(destination, "README"), "utf8"),
    "pinned source\n",
  );
  assert.equal(
    await readFile(join(destination, "keep.txt"), "utf8"),
    "must survive export-ignore\n",
  );
  const objects = git(destination, [
    "cat-file",
    "--batch-all-objects",
    "--batch-check=%(objecttype) %(objectname)",
  ]);
  assert.equal(
    objects.split("\n").filter((line) => line.startsWith("commit ")).length,
    1,
  );
  assert.deepEqual((await readdir(destination)).sort(), [
    ".git",
    ".gitattributes",
    "README",
    "keep.txt",
  ]);
  assert.equal(
    await readFile(join(current.source, "README"), "utf8"),
    "dirty change\n",
  );
  assert.equal(
    await readFile(join(current.source, "untracked-private.txt"), "utf8"),
    "private untracked data",
  );
  assert.deepEqual(
    await readFile(join(current.source, ".git", "index")),
    index,
  );
  assert.equal(await readFile(configPath, "utf8"), config);
  assert.equal(git(current.source, ["show-ref"]), refs);
  await assert.rejects(access(join(current.source, "invoked.txt")), {
    code: "ENOENT",
  });
  assert.equal((await receipt(current.storage)).reason, "completed");
  checks.push(
    "Pinned tree only; private history and files omitted; source, index, configuration and refs unchanged",
  );
});

await test("rejects missing objects and modified runtime assets without returning a pack", async () => {
  const current = await fixture("missing");
  await assert.rejects(
    exportClientSourcePack(
      current.identity,
      "f".repeat(40),
      current.storage,
      runtime,
      new AbortController().signal,
    ),
    /could not be exported/,
  );
  assert.notEqual((await receipt(current.storage)).exitCode, 0);
  const broken = join(current.root, "changed.cjs");
  await writeFile(broken, "changed");
  const before = await readdir(current.storage);
  await assert.rejects(
    exportClientSourcePack(
      current.identity,
      "a".repeat(40),
      current.storage,
      { ...runtime, host: { ...runtime.host, path: broken } },
      new AbortController().signal,
    ),
    /runtime asset changed/,
  );
  assert.deepEqual(await readdir(current.storage), before);
  checks.push(
    "Missing objects stop safely; changed runtime is rejected before launch",
  );
});

await test("cancellation after native launch stops the exporter before returning source", async (context) => {
  const current = await fixture("cancel");
  await writeFile(join(current.source, "README"), "source");
  const base = commit(current.source);
  const controller = new AbortController();
  const start = NativeSupervisor.prototype.start;
  context.mock.method(
    NativeSupervisor.prototype,
    "start",
    async function (...args) {
      const pid = await start.apply(this, args);
      controller.abort(new Error("Canceled source export"));
      return pid;
    },
  );
  await assert.rejects(
    exportClientSourcePack(
      current.identity,
      base,
      current.storage,
      runtime,
      controller.signal,
    ),
    /Canceled source export/,
  );
  assert.notEqual((await receipt(current.storage)).reason, "completed");
  checks.push("Cancellation after launch has native process-tree stop proof");
});

await test("bounds oversized source output and confirms termination", async () => {
  const current = await fixture("limit");
  const large = await open(join(current.source, "large.bin"), "wx");
  try {
    for (let index = 0; index < 65; index++)
      await large.write(randomBytes(1024 * 1024));
  } finally {
    await large.close();
  }
  const base = commit(current.source);
  await assert.rejects(
    exportClientSourcePack(
      current.identity,
      base,
      current.storage,
      runtime,
      new AbortController().signal,
    ),
    /64 MiB transfer limit/,
  );
  await receipt(current.storage);
  checks.push("Output exceeding 64 MiB is refused and the exporter stops");
});

assert.equal(checks.length, 4);
await writeFile(
  join(directory, "results.json"),
  JSON.stringify({ checks }, null, 2),
);
process.stdout.write(`Source export evidence: ${directory}\n`);
