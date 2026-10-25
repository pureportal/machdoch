import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: { "kvm-boot": { type: "boolean", default: false } },
});

for (const name of [
  "MACHDOCH_SANDBOX_CONFIG",
  "MACHDOCH_LINUX_BASE_INITRAMFS",
  "MACHDOCH_LINUX_ROOTFS",
  "MACHDOCH_LINUX_MODULES",
])
  assert.ok(process.env[name], `Configure ${name}`);
assert.equal(
  process.platform,
  "win32",
  "This verification boots a Linux host through WHPX",
);
const workspace = fileURLToPath(new URL("../../../", import.meta.url));
const manifest = JSON.parse(
  await readFile(process.env.MACHDOCH_SANDBOX_CONFIG, "utf8"),
);
const directory = join(
  workspace,
  ".tmp/cloud-linux-verification",
  randomUUID(),
);
await mkdir(directory, { recursive: true });
let inode = 0;
function entry(name, data, mode) {
  const body = Buffer.from(data),
    path = Buffer.from(name + "\0");
  const header = Buffer.from(
    "070701" +
      [++inode, mode, 0, 0, 1, 0, body.length, 0, 0, 0, 0, path.length, 0]
        .map((value) => value.toString(16).padStart(8, "0"))
        .join(""),
  );
  return Buffer.concat([
    header,
    path,
    Buffer.alloc((4 - ((header.length + path.length) % 4)) % 4),
    body,
    Buffer.alloc((4 - (body.length % 4)) % 4),
  ]);
}
const records = [];
if (values["kvm-boot"]) records.push(entry("probe-kvm", "", 0o100644));
records.push(
  entry(
    "cloud-modloop",
    await readFile(process.env.MACHDOCH_LINUX_MODULES),
    0o100644,
  ),
);
const nestedInitramfs = Buffer.concat([
  await readFile(process.env.MACHDOCH_LINUX_BASE_INITRAMFS),
  gzipSync(
    Buffer.concat([
      entry(
        "nested-enter",
        await readFile(new URL("nested-guest.sh", import.meta.url)),
        0o100755,
      ),
      entry("TRAILER!!!", "", 0),
    ]),
  ),
]);
records.push(
  entry("nested-kernel", await readFile(manifest.kernel.path), 0o100644),
  entry("nested-initramfs", nestedInitramfs, 0o100644),
);
const directories = new Set();
async function include(relative) {
  const parts = ("verify/" + relative).split("/");
  for (let count = 1; count < parts.length; count++) {
    const name = parts.slice(0, count).join("/");
    if (!directories.has(name)) {
      directories.add(name);
      records.push(entry(name, "", 0o40755));
    }
  }
  records.push(
    entry(
      "verify/" + relative,
      await readFile(join(workspace, relative)),
      0o100644,
    ),
  );
}
for (const root of [
  "apps/cloud-runner/native",
  "packages/process-supervisor",
]) {
  for (const file of [
    "Cargo.toml",
    ...(root.endsWith("native") ? ["Cargo.lock"] : []),
  ])
    await include(root + "/" + file);
  for (const file of await readdir(join(workspace, root, "src")))
    if (file.endsWith(".rs")) await include(root + "/src/" + file);
}
await include("apps/cloud-runner/scripts/supervisor.test.mjs");
records.push(
  entry(
    "cloud-linux-verify",
    await readFile(new URL("linux-supervisor-verify.sh", import.meta.url)),
    0o100755,
  ),
  entry("TRAILER!!!", "", 0),
);
const initramfs = join(directory, "initramfs");
await writeFile(
  initramfs,
  Buffer.concat([
    await readFile(process.env.MACHDOCH_LINUX_BASE_INITRAMFS),
    gzipSync(await readFile(process.env.MACHDOCH_LINUX_ROOTFS)),
    gzipSync(Buffer.concat(records)),
  ]),
  { flag: "wx" },
);
const helper = spawn(manifest.supervisor.path, [], {
  windowsHide: true,
  detached: true,
  stdio: ["pipe", "pipe", "pipe"],
  env: { SystemRoot: process.env.SystemRoot },
});
const completion = once(helper, "exit");
const send = (value) => helper.stdin.write(JSON.stringify(value) + "\n");
let output = "",
  heartbeat,
  lastProgress = 0;
const decoder = new StringDecoder("utf8");
helper.stderr.on("data", (bytes) => {
  output += bytes.toString();
});
createInterface({ input: helper.stdout }).on("line", (line) => {
  const event = JSON.parse(line);
  if (event.kind === "prepared") send({ kind: "anchor", id: "initial" });
  if (event.kind === "anchored") {
    if (event.id === "initial")
      send({
        kind: "start",
        anchor_id: event.id,
        allowance_ms: 60000,
        max_duration_ms: 900000,
        memory_limit_bytes: 4 * 1024 * 1024 * 1024,
        program: manifest.qemu.path,
        directory,
        environment: {
          SystemRoot: process.env.SystemRoot,
          PATH: dirname(manifest.qemu.path),
        },
        args: [
          "-accel",
          "whpx",
          "-machine",
          "q35",
          "-m",
          "2048",
          "-smp",
          "2",
          "-nodefaults",
          "-no-user-config",
          "-display",
          "none",
          "-serial",
          "stdio",
          "-monitor",
          "none",
          "-netdev",
          "user,id=build",
          "-device",
          "virtio-net-pci,netdev=build,disable-legacy=on",
          "-kernel",
          manifest.kernel.path,
          "-initrd",
          initramfs,
          "-append",
          "console=ttyS0 rdinit=/cloud-linux-verify panic=-1 loglevel=3",
          "-no-reboot",
        ],
      });
    else send({ kind: "renew", anchor_id: event.id, allowance_ms: 60000 });
  }
  if (event.kind === "started")
    heartbeat = setInterval(
      () => send({ kind: "anchor", id: randomUUID() }),
      15000,
    );
  if (event.kind === "stdout" || event.kind === "stderr") {
    output += decoder.write(Buffer.from(event.data, "base64"));
    if (Date.now() - lastProgress > 10000) {
      process.stdout.write(output.slice(-600));
      lastProgress = Date.now();
    }
  }
  if (event.kind === "error") output += JSON.stringify(event) + "\n";
  if (output.length > 8 * 1024 * 1024) helper.kill();
});
const guard = setTimeout(() => helper.kill(), 915000);
try {
  send({
    kind: "prepare",
    receipt_path: join(directory, "host.stopped.json"),
    environment_id: randomUUID(),
  });
  const [code] = await completion;
  output += decoder.end();
  await writeFile(join(directory, "verification.log"), output);
  const sha256 = output.match(
    /MACHDOCH_LINUX_SUPERVISOR_SHA256:([a-f0-9]{64})/,
  )?.[1];
  await writeFile(
    join(directory, "results.json"),
    JSON.stringify(
      {
        status:
          code === 0 && output.includes("MACHDOCH_LINUX_COMPLETE")
            ? "passed"
            : "failed",
        supervision: output.includes("MACHDOCH_SUPERVISION_VERIFIED")
          ? "passed"
          : "failed",
        supervisorSha256: sha256 ?? null,
        nestedKvmDevice: output.includes("MACHDOCH_NESTED_KVM_PRESENT")
          ? true
          : output.includes("MACHDOCH_NESTED_KVM_ABSENT")
            ? false
            : null,
        kvmGuestBoot: values["kvm-boot"]
          ? output.includes("MACHDOCH_KVM_BOOT_VERIFIED")
            ? "passed"
            : "failed"
          : "not-run",
        log: join(directory, "verification.log"),
      },
      null,
      2,
    ),
  );
  process.stdout.write(`Linux verification evidence: ${directory}\n`);
  assert.equal(code, 0, output.slice(-5000));
  assert.ok(output.includes("MACHDOCH_LINUX_COMPLETE"), output.slice(-5000));
  assert.ok(sha256, "The Linux build did not report its binary digest");
  assert.ok(output.includes("MACHDOCH_SUPERVISION_VERIFIED"));
  if (values["kvm-boot"])
    assert.ok(output.includes("MACHDOCH_KVM_BOOT_VERIFIED"));
} finally {
  clearInterval(heartbeat);
  clearTimeout(guard);
  if (helper.exitCode === null && helper.signalCode === null) helper.kill();
  await completion;
}
