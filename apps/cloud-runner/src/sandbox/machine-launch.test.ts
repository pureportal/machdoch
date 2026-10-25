import assert from "node:assert/strict";
import { test } from "node:test";
import { machineLaunch } from "../../../../packages/cloud-client/src/worker/sandbox/machine-launch.ts";
import { sandboxConfigurationSchema } from "../../../../packages/cloud-client/src/worker/sandbox/configuration.ts";

const artifact = { path: process.execPath, sha256: "a".repeat(64) };
const artifacts = {
  supervisor: artifact,
  qemu: artifact,
  kernel: artifact,
  initramfs: artifact,
  image: artifact,
};
await test("KVM launch has no accelerator fallback, network or writable source disk", () => {
  const configuration = sandboxConfigurationSchema.parse({
    backend: "kvm",
    cgroupRoot: "/sys/fs/cgroup/worker",
    ...artifacts,
  });
  const launch = machineLaunch(configuration, "/private/environment");
  const option = (key: string) =>
    launch.process.args[launch.process.args.indexOf(key) + 1];
  assert.equal(option("-accel"), "kvm");
  assert.equal(option("-nic"), "none");
  assert.equal(option("-monitor"), "none");
  assert.equal(
    option("-sandbox"),
    "on,obsolete=deny,elevateprivileges=deny,spawn=deny,resourcecontrol=deny",
  );
  assert.equal(
    option("-chardev"),
    "socket,id=agent,path=agent.sock,server=on,wait=off",
  );
  const disks = launch.process.args.flatMap((value, index, args) =>
    value === "-blockdev" ? [JSON.parse(args[index + 1]!)] : [],
  );
  assert.ok(disks.every((disk) => disk["read-only"] === true));
  assert.deepEqual(Object.keys(launch.process.environment), ["PATH"]);
});
await test("configuration requires explicit KVM delegation and rejects mixed backends", () => {
  assert.equal(
    sandboxConfigurationSchema.safeParse({ backend: "kvm", ...artifacts })
      .success,
    false,
  );
  assert.equal(
    sandboxConfigurationSchema.safeParse({
      backend: "whpx",
      cgroupRoot: "/sys/fs/cgroup/worker",
      ...artifacts,
    }).success,
    false,
  );
  assert.throws(
    () =>
      machineLaunch(
        { backend: "kvm", cgroupRoot: "/sys/fs/cgroup/worker", ...artifacts },
        "",
      ),
    /private VM socket/,
  );
});

await test("WHPX uses a private local socket without a named pipe or network listener", () => {
  const launch = machineLaunch(
    { backend: "whpx", ...artifacts },
    "C:\\private\\environment",
  );
  const option = (key: string) =>
    launch.process.args[launch.process.args.indexOf(key) + 1];
  assert.equal(
    option("-chardev"),
    "socket,id=agent,path=agent.sock,server=on,wait=off",
  );
  assert.equal(launch.process.directory, "C:\\private\\environment");
  assert.equal(option("-nic"), "none");
  assert.equal(option("-monitor"), "none");
  assert.ok(!launch.process.args.some((value) => value.includes("pipe,id=")));
});
