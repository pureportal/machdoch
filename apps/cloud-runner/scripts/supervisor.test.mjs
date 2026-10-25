import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { readFile, writeFile, rmdir, access } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createInterface } from "node:readline";

const program =
  process.env.MACHDOCH_CLOUD_SUPERVISOR ??
  fileURLToPath(
    new URL(
      `../native/target/release/machdoch-cloud-supervisor${process.platform === "win32" ? ".exe" : ""}`,
      import.meta.url,
    ),
  );
const hold = "setInterval(()=>{},1000)";
const cgroupRoot = process.env.MACHDOCH_TEST_CGROUP_ROOT;
if (process.platform === "linux")
  assert.ok(cgroupRoot, "Select an empty delegated test cgroup root");
function supervisor({ guardMs = 6000, eventTimeoutMs = 5000 } = {}) {
  const root = fileURLToPath(
    new URL("../../../.tmp/cloud-native-receipts/", import.meta.url),
  );
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, "case-"));
  const receiptPath = join(directory, "stopped.json");
  const environmentId = randomUUID();
  const child = spawn(program, [], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const guard = setTimeout(() => child.kill(), guardMs);
  const history = [];
  const waiters = new Set();
  const malformed = [];
  let errors = "";
  child.stderr.on("data", (chunk) => {
    errors += chunk.toString();
  });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      malformed.push(line);
      return;
    }
    history.push(event);
    for (const waiter of waiters)
      if (waiter.predicate(event)) {
        clearTimeout(waiter.timer);
        waiters.delete(waiter);
        waiter.resolve(event);
      }
  });
  const exit = once(child, "exit");
  function wait(predicate) {
    const found = history.find(predicate);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        timer: setTimeout(() => {
          waiters.delete(waiter);
          reject(new Error(`Supervisor event timed out: ${errors}`));
        }, eventTimeoutMs),
      };
      waiters.add(waiter);
    });
  }
  function send(value) {
    child.stdin.write(JSON.stringify(value) + "\n");
  }
  async function start(
    code,
    {
      allowance = 5000,
      memory = 512 * 1024 * 1024,
      duration = 10000,
      program: childProgram = process.execPath,
      args = ["-e", code],
    } = {},
  ) {
    send({
      kind: "prepare",
      receipt_path: receiptPath,
      environment_id: environmentId,
      cgroup_root: cgroupRoot,
    });
    await wait((event) => event.kind === "prepared");
    send({ kind: "anchor", id: "initial" });
    await wait((event) => event.kind === "anchored");
    send({
      kind: "start",
      anchor_id: "initial",
      allowance_ms: allowance,
      max_duration_ms: duration,
      memory_limit_bytes: memory,
      program: childProgram,
      args,
      directory: process.cwd(),
      environment: { SystemRoot: process.env.SystemRoot },
    });
    return (await wait((event) => event.kind === "started")).pid;
  }
  async function close() {
    clearTimeout(guard);
    lines.removeAllListeners("line");
    lines.close();
    child.stdout.resume();
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exit;
    for (const waiter of waiters) clearTimeout(waiter.timer);
    if (cgroupRoot) {
      const group = join(cgroupRoot, environmentId);
      try {
        await access(group);
      } catch (error) {
        if (error.code === "ENOENT") return;
        throw error;
      }
      await writeFile(join(group, "cgroup.kill"), "1");
      const deadline = Date.now() + 3000;
      while (
        !(await readFile(join(group, "cgroup.events"), "utf8")).includes(
          "populated 0",
        )
      ) {
        assert.ok(Date.now() < deadline, "Test cgroup did not stop");
        await new Promise((done) => setTimeout(done, 10));
      }
      await rmdir(group);
    }
  }
  return {
    child,
    history,
    malformed,
    send,
    wait,
    start,
    close,
    exit,
    receiptPath,
    environmentId,
  };
}

test("writes a durable stop receipt when the parent control channel closes", async () => {
  const fixture = supervisor();
  try {
    const pid = await fixture.start(hold);
    fixture.child.stdin.end();
    await fixture.exit;
    await gone(pid);
    const receipt = JSON.parse(await readFile(fixture.receiptPath, "utf8"));
    assert.equal(receipt.environmentId, fixture.environmentId);
    assert.equal(receipt.childPid, pid);
    assert.equal(receipt.processTreeStopped, true);
    assert.equal(receipt.reason, "parent_closed");
  } finally {
    await fixture.close();
  }
});

test("delivers bounded stdin frames and EOF without mixing output with control events", async () => {
  const fixture = supervisor();
  try {
    await fixture.start("let data='';process.stdin.on('data',b=>data+=b);process.stdin.on('end',()=>process.stdout.write(data))");
    const payload = Buffer.from('quoted "text"\n' + "a".repeat(60000));
    fixture.send({ kind: "input", id: "frame", data: payload.toString("base64") });
    await fixture.wait((event) => event.kind === "input_written" && event.id === "frame");
    fixture.send({ kind: "input", id: "eof", data: null });
    await fixture.wait((event) => event.kind === "input_written" && event.id === "eof");
    const [exitCode] = await fixture.exit;
    assert.equal(exitCode, 0);
    const output = Buffer.concat(fixture.history.filter((event) => event.kind === "stdout").map((event) => Buffer.from(event.data, "base64")));
    assert.deepEqual(output, payload);
    assert.equal(JSON.parse(await readFile(fixture.receiptPath, "utf8")).reason, "completed");
  } finally {
    await fixture.close();
  }
});

test("a blocked stdin writer cannot delay lease expiry", async () => {
  const fixture = supervisor();
  try {
    const pid = await fixture.start(hold, { allowance: 1500 });
    let blocked = false;
    for (let frame = 0; frame < 256; frame++) {
      const id = `frame-${frame}`;
      fixture.send({ kind: "input", id, data: Buffer.alloc(65536).toString("base64") });
      const written = await Promise.race([
        fixture.wait((event) => event.kind === "input_written" && event.id === id).then(() => true),
        fixture.exit.then(() => false),
      ]);
      if (!written) { blocked = true; break; }
    }
    const [exitCode] = await fixture.exit;
    assert.equal(exitCode, 0);
    await gone(pid);
    const receipt = JSON.parse(await readFile(fixture.receiptPath, "utf8"));
    assert.equal(receipt.reason, "lease_expired");
    assert.equal(receipt.processTreeStopped, true);
    assert.ok(blocked, "The child input did not reach backpressure");
  } finally {
    await fixture.close();
  }
});

test("oversized input stops the owned process with a confirmed receipt", async () => {
  const fixture = supervisor();
  try {
    const pid = await fixture.start(hold);
    fixture.send({ kind: "input", id: "oversized", data: Buffer.alloc(65537).toString("base64") });
    const [exitCode] = await fixture.exit;
    assert.equal(exitCode, 1);
    await gone(pid);
    assert.equal(JSON.parse(await readFile(fixture.receiptPath, "utf8")).processTreeStopped, true);
  } finally {
    await fixture.close();
  }
});

test("records confirmed cleanup after a malformed control message", async () => {
  const fixture = supervisor();
  try {
    const pid = await fixture.start(hold);
    fixture.send({ kind: "invalid" });
    const [exitCode] = await fixture.exit;
    assert.equal(exitCode, 1);
    await gone(pid);
    const receipt = JSON.parse(await readFile(fixture.receiptPath, "utf8"));
    assert.equal(receipt.childPid, pid);
    assert.equal(receipt.processTreeStopped, true);
    assert.equal(receipt.reason, "control_error");
  } finally {
    await fixture.close();
  }
});

test("a forcibly crashed supervisor cannot fabricate a stop receipt", async () => {
  const fixture = supervisor();
  try {
    const pid = await fixture.start(hold);
    fixture.child.kill();
    await fixture.exit;
    await gone(pid);
    await assert.rejects(readFile(fixture.receiptPath, "utf8"), {
      code: "ENOENT",
    });
  } finally {
    await fixture.close();
  }
});
async function gone(pid) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      if (
        process.platform === "linux" &&
        /\) Z /.test(await readFile(`/proc/${pid}/stat`, "utf8"))
      )
        return;
    } catch (error) {
      if (error.code === "ESRCH" || error.code === "ENOENT") return;
      throw error;
    }
    await new Promise((done) => setTimeout(done, 10));
  }
  assert.fail(`Owned child ${pid} survived supervisor termination`);
}

test("captures exact UTF-8 output and the natural exit status", async () => {
  const fixture = supervisor();
  try {
    await fixture.start("process.stdout.write('Grüße 🐱');process.exitCode=7");
    const stopped = await fixture.wait((event) => event.kind === "stopped");
    assert.equal(stopped.reason, "completed");
    assert.equal(stopped.exitCode, 7);
    const output = Buffer.concat(
      fixture.history
        .filter((event) => event.kind === "stdout")
        .map((event) => Buffer.from(event.data, "base64")),
    ).toString();
    assert.equal(output, "Grüße 🐱");
    assert.equal((await fixture.exit)[0], 0);
    assert.deepEqual(fixture.malformed, []);
  } finally {
    await fixture.close();
  }
});

test("lease expiry stops an unresponsive child", async () => {
  const fixture = supervisor();
  try {
    const pid = await fixture.start(hold, { allowance: 500 });
    const stopped = await fixture.wait((event) => event.kind === "stopped");
    assert.equal(stopped.reason, "lease_expired");
    await gone(pid);
  } finally {
    await fixture.close();
  }
});

test("closing the parent channel terminates the owned process", async () => {
  const fixture = supervisor();
  try {
    const pid = await fixture.start(hold);
    fixture.child.stdin.end();
    assert.equal(
      (await fixture.wait((event) => event.kind === "stopped")).reason,
      "parent_closed",
    );
    await gone(pid);
  } finally {
    await fixture.close();
  }
});

test(
  "a supervisor crash kills its child and grandchild through the Windows job",
  { skip: process.platform !== "win32" },
  async () => {
    const fixture = supervisor();
    try {
      const pid = await fixture.start(
        `const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(hold)}],{stdio:'ignore'});process.stdout.write(JSON.stringify({descendant:c.pid})+'\\n');${hold}`,
      );
      const event = await fixture.wait((event) => event.kind === "stdout");
      const descendant = JSON.parse(
        Buffer.from(event.data, "base64").toString(),
      ).descendant;
      fixture.child.kill();
      await fixture.exit;
      await Promise.all([gone(pid), gone(descendant)]);
    } finally {
      await fixture.close();
    }
  },
);

test(
  "Linux applies cgroup limits and privilege restrictions before the program executes",
  { skip: process.platform !== "linux" },
  async () => {
    const fixture = supervisor();
    try {
      await fixture.start(
        `const f=require('node:fs'),p=require('node:path');const line=f.readFileSync('/proc/self/cgroup','utf8').trim();const root=p.join('/sys/fs/cgroup',line.split(':')[2]);process.stdout.write(JSON.stringify({line,limits:Object.fromEntries(['memory.max','memory.swap.max','memory.oom.group','pids.max','cpu.max'].map(n=>[n,f.readFileSync(p.join(root,n),'utf8').trim()])),status:f.readFileSync('/proc/self/status','utf8')}))`,
      );
      await fixture.exit;
      const output = JSON.parse(
        Buffer.concat(
          fixture.history
            .filter((e) => e.kind === "stdout")
            .map((e) => Buffer.from(e.data, "base64")),
        ).toString(),
      );
      assert.ok(output.line.endsWith(fixture.environmentId));
      assert.deepEqual(output.limits, {
        "memory.max": String(512 * 1024 * 1024),
        "memory.swap.max": "0",
        "memory.oom.group": "1",
        "pids.max": "128",
        "cpu.max": "200000 100000",
      });
      assert.match(output.status, /NoNewPrivs:\s+1/);
      await assert.rejects(access(join(cgroupRoot, fixture.environmentId)), {
        code: "ENOENT",
      });
    } finally {
      await fixture.close();
    }
  },
);

test(
  "Linux cgroup shutdown kills descendants that create another session",
  { skip: process.platform !== "linux" },
  async () => {
    const fixture = supervisor();
    try {
      await fixture.start(
        `const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(hold)}],{stdio:'ignore',detached:true});process.stdout.write(JSON.stringify({descendant:c.pid}));c.unref()`,
      );
      await fixture.exit;
      const output = JSON.parse(
        Buffer.concat(
          fixture.history
            .filter((e) => e.kind === "stdout")
            .map((e) => Buffer.from(e.data, "base64")),
        ).toString(),
      );
      await gone(output.descendant);
      assert.equal(
        JSON.parse(await readFile(fixture.receiptPath, "utf8"))
          .processTreeStopped,
        true,
      );
      await assert.rejects(access(join(cgroupRoot, fixture.environmentId)), {
        code: "ENOENT",
      });
    } finally {
      await fixture.close();
    }
  },
);

test(
  "Linux rejects a regular directory as a delegated cgroup before accepting an environment",
  { skip: process.platform !== "linux" },
  async () => {
    const fixture = supervisor();
    try {
      fixture.send({
        kind: "prepare",
        receipt_path: fixture.receiptPath,
        environment_id: fixture.environmentId,
        cgroup_root: process.cwd(),
      });
      assert.match(
        (await fixture.wait((e) => e.kind === "error")).message,
        /not a cgroup v2 filesystem/,
      );
      assert.equal((await fixture.exit)[0], 1);
      await assert.rejects(readFile(fixture.receiptPath), { code: "ENOENT" });
    } finally {
      await fixture.close();
    }
  },
);

test("a stale renewal terminates the process instead of extending authority", async () => {
  const fixture = supervisor();
  try {
    const pid = await fixture.start(hold);
    fixture.send({ kind: "anchor", id: "current" });
    await fixture.wait(
      (event) => event.kind === "anchored" && event.id === "current",
    );
    fixture.send({ kind: "renew", anchor_id: "older", allowance_ms: 5000 });
    assert.match(
      (await fixture.wait((event) => event.kind === "error")).message,
      /anchor/,
    );
    assert.equal((await fixture.exit)[0], 1);
    await gone(pid);
  } finally {
    await fixture.close();
  }
});

test("renewal cannot extend the absolute runtime ceiling", async () => {
  const fixture = supervisor();
  try {
    const pid = await fixture.start(hold, { duration: 500 });
    fixture.send({ kind: "anchor", id: "renew" });
    await fixture.wait(
      (event) => event.kind === "anchored" && event.id === "renew",
    );
    fixture.send({ kind: "renew", anchor_id: "renew", allowance_ms: 5000 });
    await fixture.wait((event) => event.kind === "renewed");
    assert.equal(
      (await fixture.wait((event) => event.kind === "stopped")).reason,
      "lease_expired",
    );
    await gone(pid);
  } finally {
    await fixture.close();
  }
});

test("output backpressure cannot keep a flooding child alive", async () => {
  const fixture = supervisor();
  try {
    const pid = await fixture.start(
      "const b=Buffer.alloc(65536);function write(){while(process.stdout.write(b)){}process.stdout.once('drain',write)}write();setInterval(()=>{},1000)",
      { allowance: 2000 },
    );
    fixture.child.stdout.pause();

    const [code] = await fixture.exit;
    assert.equal(code, 1);
    await gone(pid);
  } finally {
    await fixture.close();
  }
});

test(
  "KVM boots a networkless guest as a non-root process inside its bounded cgroup",
  { skip: !process.env.MACHDOCH_TEST_NESTED_KERNEL },
  async () => {
    const fixture = supervisor({ guardMs: 30000, eventTimeoutMs: 25000 });
    try {
      assert.notEqual(process.getuid(), 0);
      await fixture.start("", {
        program: "/usr/bin/qemu-system-x86_64",
        args: [
          "-accel",
          "kvm",
          "-machine",
          "q35,dump-guest-core=off",
          "-m",
          "256",
          "-smp",
          "1",
          "-nodefaults",
          "-no-user-config",
          "-display",
          "none",
          "-serial",
          "stdio",
          "-monitor",
          "none",
          "-nic",
          "none",
          "-no-reboot",
          "-kernel",
          process.env.MACHDOCH_TEST_NESTED_KERNEL,
          "-initrd",
          process.env.MACHDOCH_TEST_NESTED_INITRAMFS,
          "-append",
          "console=ttyS0 rdinit=/nested-enter panic=-1 loglevel=3",
          "-sandbox",
          "on,obsolete=deny,elevateprivileges=deny,spawn=deny,resourcecontrol=deny",
        ],
        allowance: 20000,
        duration: 20000,
        memory: 768 * 1024 * 1024,
      });
      await fixture.exit;
      const output = Buffer.concat(
        fixture.history
          .filter((e) => e.kind === "stdout" || e.kind === "stderr")
          .map((e) => Buffer.from(e.data, "base64")),
      ).toString();
      assert.ok(output.includes("MACHDOCH_NESTED_GUEST_READY"), output);
      const receipt = JSON.parse(await readFile(fixture.receiptPath, "utf8"));
      assert.equal(receipt.processTreeStopped, true);
      assert.equal(receipt.reason, "completed");
      assert.equal(receipt.exitCode, 0);
      process.stdout.write("MACHDOCH_KVM_BOOT_VERIFIED\n");
    } finally {
      await fixture.close();
    }
  },
);

test("the job memory limit prevents a child from allocating beyond its budget", async () => {
  const fixture = supervisor();
  try {
    await fixture.start(
      "const b=Buffer.alloc(512*1024*1024,1);process.stdout.write('UNBOUNDED');setInterval(()=>{},1000)",
      { memory: 128 * 1024 * 1024 },
    );
    const stopped = await fixture.wait((event) => event.kind === "stopped");
    assert.equal(stopped.reason, "completed");
    assert.notEqual(stopped.exitCode, 0);
    assert.equal(
      fixture.history.some(
        (event) =>
          event.kind === "stdout" &&
          Buffer.from(event.data, "base64").includes("UNBOUNDED"),
      ),
      false,
    );
  } finally {
    await fixture.close();
  }
});
