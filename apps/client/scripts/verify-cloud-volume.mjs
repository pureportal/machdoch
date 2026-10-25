import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdir,
  lstat,
  mkdtemp,
  readFile,
  stat,
  statfs,
  rmdir,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { NativeSupervisor } from "@machdoch/cloud-client/supervisor";
import { operateWindowsVolume } from "../src/core/cloud/windows-volume.ts";

const processSandbox = process.argv.includes("--sandbox");
assert.deepEqual(process.argv.slice(2), processSandbox ? ["--sandbox"] : []);

assert.ok(process.env.MACHDOCH_CLOUD_STORAGE, "Set MACHDOCH_CLOUD_STORAGE.");
assert.ok(
  process.env.MACHDOCH_CLOUD_SUPERVISOR,
  "Set MACHDOCH_CLOUD_SUPERVISOR.",
);
const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(project, "../..");
const storage = join(root, ".tmp/cloud-volume-verification");
await mkdir(storage, { recursive: true });
const directory = await mkdtemp(join(storage, "case-工作-"));
async function asset(path) {
  return {
    path,
    sha256: createHash("sha256")
      .update(await readFile(path))
      .digest("hex"),
  };
}
const tools = {
  helper: await asset(resolve(process.env.MACHDOCH_CLOUD_STORAGE)),
  controller: await asset(join(project, "src/cloud-agent/windows-volume.ps1")),
};
const volume = {
  directory: join(directory, "volume"),
  id: randomUUID(),
  attemptId: randomUUID(),
  bytes: 256 * 1024 * 1024,
};
await mkdir(volume.directory);
await writeFile(
  join(directory, "intent.json"),
  JSON.stringify({ tools, volume }, null, 2),
);
const operate = (action) => operateWindowsVolume(tools, volume, action);
const execute = promisify(execFile);
const mountPath = join(volume.directory, "mount");
async function nativeMountVolume() {
  const record = JSON.parse(
    await readFile(join(volume.directory, "volume.json"), "utf8"),
  );
  const input = {
    action: "inspect",
    image: join(volume.directory, "sandbox.vhdx"),
    id: volume.id,
    bytes: volume.bytes,
    volumeId: record.volumeId,
  };
  const result = await new Promise((resolveResult, reject) => {
    const child = execFile(
      tools.helper.path,
      [],
      { windowsHide: true, timeout: 15000, maxBuffer: 65536, encoding: "utf8" },
      (error, stdout) => {
        if (error) reject(error);
        else resolveResult(stdout);
      },
    );
    child.stdin.on("error", reject);
    child.stdin.end(JSON.stringify(input));
  });
  const parsed = JSON.parse(result);
  assert.equal(parsed.ok, true);
  return parsed.volume.mountVolumeId;
}
const checks = [];
function passed(name) {
  checks.push(name);
  console.log(`PASS ${name}`);
}
async function until(operation, description) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await operation()) return;
    await delay(25);
  }
  throw new Error(description);
}
let supervisor;
try {
  const created = await operate("create");
  assert.equal(created.attached, true);
  assert.equal(created.phase, "ready");
  assert.ok(created.physicalBytes >= volume.bytes);
  await assert.rejects(operate("create"), /not empty/);
  await assert.rejects(
    operateWindowsVolume(tools, { ...volume, id: randomUUID() }, "detach"),
    /another task/,
  );
  assert.equal((await operate("inspect")).attached, true);
  passed(
    "Fixed owned volume created; duplicate creation and wrong ownership rejected",
  );
  assert.equal((await operate("detach")).attached, false);
  assert.equal(await nativeMountVolume(), null);
  assert.equal((await operate("attach")).attached, true);
  passed(
    "Ready volume detaches and remounts with its filesystem identity intact",
  );
  const recordPath = join(volume.directory, "volume.json");
  const originalRecord = await readFile(recordPath, "utf8");
  try {
    const changed = JSON.parse(originalRecord);
    changed.volumeId = `\\\\?\\Volume{${randomUUID()}}\\`;
    await writeFile(recordPath, JSON.stringify(changed));
    await assert.rejects(operate("detach"), /another volume/);
    assert.equal(await nativeMountVolume(), created.volumeId);
  } finally {
    await writeFile(recordPath, originalRecord);
  }
  assert.equal((await operate("inspect")).attached, true);
  passed(
    "A mismatched filesystem identity cannot remove a mount point or detach the image",
  );
  const unexpectedDetach = join(directory, "unexpected-detach.ps1");
  await writeFile(
    unexpectedDetach,
    `$ErrorActionPreference='Stop'
$image=[IO.Path]::GetFullPath($args[0])
$record=[IO.File]::ReadAllText($args[1])|ConvertFrom-Json
if($record.id -ne $args[2] -or $record.phase -ne 'ready'){throw 'Unexpected volume identity or phase'}
$owned=Get-DiskImage -ImagePath $image
$disk=$owned|Get-Disk
if($owned.ImagePath -ne $image -or $disk.IsSystem -or $disk.IsBoot -or $disk.BusType -ne 'File Backed Virtual' -or $disk.Size -ne $record.bytes){throw 'Unexpected disk'}
Dismount-DiskImage -InputObject $owned|Out-Null
`,
  );
  const detachExternally = () =>
    execute(
      join(
        process.env.SystemRoot,
        "System32/WindowsPowerShell/v1.0/powershell.exe",
      ),
      [
        "-NoProfile",
        "-NonInteractive",
        "-File",
        unexpectedDetach,
        join(volume.directory, "sandbox.vhdx"),
        recordPath,
        volume.id,
      ],
      { windowsHide: true, timeout: 30000 },
    );
  await writeFile(
    join(mountPath, "checkout", "recovery.txt"),
    "Recovered before execution",
  );
  await detachExternally();
  assert.equal((await operate("inspect")).attached, false);
  assert.equal(await nativeMountVolume(), created.volumeId);
  assert.equal((await operate("attach")).attached, true);
  assert.equal(
    await readFile(join(mountPath, "checkout", "recovery.txt"), "utf8"),
    "Recovered before execution",
  );
  await detachExternally();
  assert.equal((await operate("detach")).attached, false);
  assert.equal(await nativeMountVolume(), null);
  passed(
    "Unexpected detachment preserves edits; owned stale mounts recover or detach without relying on cached access paths",
  );
  const foreign = join(directory, "foreign");
  await mkdir(foreign);
  await writeFile(join(foreign, "keep.txt"), "Do not change");
  await rmdir(mountPath);
  await symlink(foreign, mountPath, "junction");
  try {
    await assert.rejects(operate("attach"), /mount point|mount path/);
    await assert.rejects(operate("detach"), /mount point|mount path/);
    assert.equal((await lstat(mountPath)).isSymbolicLink(), true);
    assert.equal(
      await readFile(join(foreign, "keep.txt"), "utf8"),
      "Do not change",
    );
  } finally {
    assert.equal((await lstat(mountPath)).isSymbolicLink(), true);
    await unlink(mountPath);
    await mkdir(mountPath);
    await operate("detach");
  }
  assert.equal((await operate("attach")).attached, true);
  passed(
    "Foreign directory redirection is rejected and its files remain unchanged",
  );
  const lockScript = join(directory, "hold-lock.ps1");
  await writeFile(
    lockScript,
    "$ErrorActionPreference='Stop'\n$file=[IO.File]::Open($args[0],[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)\ntry{[Console]::WriteLine('locked');[Console]::In.ReadLine()|Out-Null}finally{$file.Dispose()}\n",
  );
  const lockOwner = spawn(
    join(
      process.env.SystemRoot,
      "System32/WindowsPowerShell/v1.0/powershell.exe",
    ),
    [
      "-NoProfile",
      "-NonInteractive",
      "-File",
      lockScript,
      join(volume.directory, "operation.lock"),
    ],
    { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
  );
  try {
    const [ready] = await once(lockOwner.stdout, "data");
    assert.match(ready.toString(), /locked/);
    await assert.rejects(operate("inspect"), /another process/);
  } finally {
    const closed = once(lockOwner, "close");
    lockOwner.kill("SIGKILL");
    await closed;
  }
  assert.equal((await operate("inspect")).attached, true);
  passed(
    "Kernel-owned operation lock rejects contention and releases after owner crash",
  );
  const mount = join(volume.directory, "mount");
  const checkout = join(mount, "checkout"),
    state = join(mount, "state");
  const image = join(volume.directory, "sandbox.vhdx");
  const imageBytes = (await stat(image)).size;
  const filesystem = await statfs(checkout);
  const capacity = filesystem.blocks * filesystem.bsize;
  assert.ok(capacity > 0 && capacity <= volume.bytes);
  const entrypoint = join(directory, "fill.cjs");
  await writeFile(
    entrypoint,
    `
const fs=require('node:fs'),path=require('node:path');
const quota=${volume.bytes},image=${JSON.stringify(image)};
function denied(fn){try{fn();return 'allowed'}catch(e){return e.code}}
fs.writeFileSync('preserved.txt','preserved task edits');
const result=${processSandbox ? `{imageRead:denied(()=>fs.readFileSync(image)),imageWrite:denied(()=>fs.openSync(image,'r+')),ownerWrite:denied(()=>fs.openSync('../owner.json','r+')),receiptWrite:denied(()=>fs.writeFileSync(${JSON.stringify(join(volume.directory, "stopped.json"))},'forged')),rawDisk:denied(()=>fs.openSync('\\\\\\\\.\\\\PhysicalDrive0','r')),rawOwnVolume:denied(()=>fs.openSync(${JSON.stringify(created.volumeId.slice(0, -1))},'r+'))}` : "{}"};
const allocation=fs.openSync('allocation.bin','wx');
try{result.truncate=denied(()=>fs.ftruncateSync(allocation,quota*4))}finally{fs.closeSync(allocation);fs.unlinkSync('allocation.bin')}
const file=fs.openSync('fill.bin','wx'),block=Buffer.alloc(1024*1024,42);let bytes=0;
try{while(bytes<quota*2)bytes+=fs.writeSync(file,block)}catch(e){result.failure=e.code}finally{fs.closeSync(file)}
result.bytes=bytes;result.stateWrite=denied(()=>fs.writeFileSync(path.join(process.env.HOME,'large.bin'),Buffer.alloc(1024*1024,42)));
console.log(JSON.stringify({kind:'quota_result',...result}));setInterval(()=>{},1000);
`,
  );
  let stdout = "",
    stderr = "";
  supervisor = new NativeSupervisor(
    process.env.MACHDOCH_CLOUD_SUPERVISOR,
    (kind, bytes) => {
      if (kind === "stdout") stdout += bytes;
      else stderr = (stderr + bytes).slice(-8192);
    },
  );
  const receiptPath = join(volume.directory, "stopped.json");
  await supervisor.prepareReceipt(receiptPath, volume.id);
  assert.equal((await operate("begin")).phase, "active");
  await assert.rejects(operate("begin"), /not available/);
  await assert.rejects(operate("detach"), /stopped\.json/);
  await assert.rejects(operate("attach"), /stopped\.json/);
  await writeFile(
    receiptPath,
    JSON.stringify({
      version: 1,
      environmentId: randomUUID(),
      processTreeStopped: true,
      supervisorPid: 1,
      reason: "completed",
    }),
    { flag: "wx" },
  );
  await assert.rejects(operate("detach"), /matching native stop receipt/);
  await unlink(receiptPath);
  assert.equal((await operate("inspect")).attached, true);
  passed(
    "Execution is single use; active volume cannot detach or remount without native stop proof",
  );
  const ownerState = join(directory, "owner");
  await mkdir(ownerState);
  await supervisor.start({
    anchorId: await supervisor.anchor(),
    allowanceMs: 15000,
    maxDurationMs: 20000,
    memoryLimitBytes: 512 * 1024 * 1024,
    program: process.execPath,
    args: [
      processSandbox
        ? join(project, "dist/machdoch-cloud-sandbox.cjs")
        : entrypoint,
    ],
    directory: processSandbox ? project : checkout,
    environment: {
      SystemRoot: process.env.SystemRoot,
      PATH: dirname(process.execPath),
      LOCALAPPDATA: ownerState,
      TEMP: ownerState,
      HOME: state,
    },
  });
  if (processSandbox)
    await supervisor.writeInput(
      Buffer.from(
        JSON.stringify({
          access: "workspace",
          executable: process.execPath,
          arguments: [entrypoint],
          checkoutDirectory: checkout,
          stateDirectory: state,
          readonlyPaths: [entrypoint],
          durationMs: 20000,
        }) + "\n",
      ),
    );
  await until(() => {
    if (supervisor.signal.aborted)
      throw new Error(stderr || "Quota worker stopped before its check");
    return stdout.split("\n").some((line) => line.includes('"quota_result"'));
  }, `Quota result did not arrive: ${stderr}`);
  const result = stdout
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse)
    .find((value) => value.kind === "quota_result");
  assert.equal(result.failure, "ENOSPC");
  assert.equal(result.truncate, "ENOSPC");
  assert.equal(result.stateWrite, "ENOSPC");
  assert.ok(result.bytes > 0 && result.bytes <= volume.bytes);
  if (processSandbox)
    for (const key of [
      "imageRead",
      "imageWrite",
      "ownerWrite",
      "receiptWrite",
      "rawDisk",
      "rawOwnVolume",
    ])
      assert.ok(
        ["EACCES", "EPERM"].includes(result[key]),
        `${key}: ${result[key]}`,
      );
  assert.equal((await stat(image)).size, imageBytes);
  passed(
    "Volume capacity bounds checkout/state writes and oversized file allocation without growing the backing file",
  );
  if (processSandbox)
    passed(
      "Sandbox cannot access the backing image, raw disks or lifecycle records",
    );
  await supervisor.renew(await supervisor.anchor(), 1000);
  let receipt;
  await until(async () => {
    try {
      receipt = JSON.parse(await readFile(receiptPath, "utf8"));
      return true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return false;
    }
  }, "The full volume prevented its native stop receipt");
  assert.equal(receipt.environmentId, volume.id);
  assert.equal(receipt.reason, "lease_expired");
  assert.equal(receipt.processTreeStopped, true);
  await supervisor.close();
  supervisor = undefined;
  passed(
    "Lease watchdog stops a disk-full worker and durably records termination outside its allowance",
  );
  assert.equal((await operate("detach")).attached, false);
  assert.equal((await operate("attach")).phase, "stopped");
  assert.equal(
    await readFile(join(checkout, "preserved.txt"), "utf8"),
    "preserved task edits",
  );
  await assert.rejects(operate("begin"), /not available/);
  passed(
    "Stopped volume remounts for recovery with edits preserved and cannot start another execution",
  );
  await writeFile(
    join(directory, "results.json"),
    JSON.stringify(
      {
        checks,
        result,
        capacity,
        imageBytes,
        volume,
        tools,
        node: process.version,
        processSandbox,
      },
      null,
      2,
    ),
  );
  console.log(`Volume evidence: ${directory}`);
} catch (error) {
  await writeFile(
    join(directory, "failure.json"),
    JSON.stringify(
      { checks, error: error.message, processSandbox, volume, tools },
      null,
      2,
    ),
  );
  console.error(`Volume verification failed: ${directory}`);
  throw error;
} finally {
  if (supervisor) await supervisor.close();
  const record = await readFile(
    join(volume.directory, "volume.json"),
    "utf8",
  ).then(JSON.parse, (error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (
    record &&
    (await stat(join(volume.directory, "sandbox.vhdx")).catch(() => null))
  )
    assert.equal((await operate("detach")).attached, false);
}
