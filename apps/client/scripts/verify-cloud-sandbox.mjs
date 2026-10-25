import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { createServer, connect } from "node:net";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  spawnWindowsClientSandbox,
  windowsClientSandboxRequest,
} from "../src/core/cloud/windows-sandbox.ts";
import { NativeSupervisor } from "@machdoch/cloud-client/supervisor";
import { inspectSandboxJob } from "./cloud-sandbox-resource-probe.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const root = resolve(dirname(scriptPath), "../../..");
const fixtureToken = "controlled-worker-secret";
if (process.argv[2] === "owner") {
  const input = JSON.parse(await readFile(process.argv[3], "utf8"));
  const child = await spawnWindowsClientSandbox(input);
  if (process.argv[4] === "resources")
    process.stdout.write(
      JSON.stringify({ kind: "job_limits", ...inspectSandboxJob(child.id) }) +
        "\n",
    );
  child.standardOutput.pipe(process.stdout);
  child.standardError.pipe(process.stderr);
  process.stdin.pipe(child.standardInput);
  if (process.argv[4] === "stall")
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  try {
    await child.wait();
  } finally {
    child.dispose();
  }
} else {
  assert.ok(
    process.env.MACHDOCH_CLOUD_SUPERVISOR,
    "Set MACHDOCH_CLOUD_SUPERVISOR to the verified native helper.",
  );
  const storage = join(root, ".tmp/cloud-client-sandbox");
  await mkdir(storage, { recursive: true });
  const directory = await mkdtemp(join(storage, "case-"));
  const checks = [];
  const external = join(directory, "outside");
  await mkdir(external);
  const sentinel = join(external, "sentinel.txt");
  await writeFile(sentinel, "private sentinel");
  async function inputFor(name, source, durationMs = 20000) {
    const checkoutDirectory = join(directory, name);
    const stateDirectory = join(directory, `${name}-state`);
    const entrypoint = join(directory, `${name}.cjs`);
    await mkdir(checkoutDirectory);
    await mkdir(stateDirectory);
    await writeFile(entrypoint, source);
    return {
      access: "workspace",
      executable: process.execPath,
      arguments: [entrypoint],
      checkoutDirectory,
      stateDirectory,
      readonlyPaths: [entrypoint],
      durationMs,
    };
  }
  async function awaitCondition(operation, description) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (await operation()) return;
      await delay(25);
    }
    throw new Error(description);
  }
  function passed(name) {
    checks.push(name);
    process.stdout.write(`PASS ${name}\n`);
  }
  const server = createServer((socket) => socket.end());
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const port = server.address().port;
  const control = connect(port, "127.0.0.1");
  await once(control, "connect");
  control.resume();
  await once(control, "close");
  const ipv6Server = createServer((socket) => socket.end());
  await new Promise((done) => ipv6Server.listen(0, "::1", done));
  const ipv6Port = ipv6Server.address().port;
  const ipv6Control = connect(ipv6Port, "::1");
  await once(ipv6Control, "connect");
  ipv6Control.resume();
  await once(ipv6Control, "close");
  try {
    const input = await inputFor(
      "boundary",
      `
const fs=require('node:fs'),net=require('node:net'),cp=require('node:child_process');
const sentinel=${JSON.stringify(sentinel)},outside=${JSON.stringify(external)};
function attempt(fn){try{fn();return 'allowed'}catch(e){return e.code}}
async function network(host,port){return new Promise(resolve=>{const s=net.connect({host,port});const t=setTimeout(()=>{s.destroy();resolve('timeout')},2000);s.once('connect',()=>{clearTimeout(t);s.destroy();resolve('allowed')});s.once('error',e=>{clearTimeout(t);resolve(e.code)})})}
(async()=>{
 fs.writeFileSync('owned.txt','written');fs.writeFileSync(require('node:path').join(process.env.HOME,'state.txt'),'state');
 const result={ownRead:fs.readFileSync('owned.txt','utf8'),read:attempt(()=>fs.readFileSync(sentinel)),write:attempt(()=>fs.writeFileSync(sentinel,'changed')),listing:attempt(()=>fs.readdirSync(outside)),metadata:attempt(()=>fs.statSync(sentinel)),junctionRead:attempt(()=>fs.readFileSync('preexisting-junction/sentinel.txt')),hardlink:attempt(()=>{fs.linkSync(sentinel,'hardlink');fs.readFileSync('hardlink')}),newJunction:attempt(()=>{fs.symlinkSync(outside,'new-junction','junction');fs.readFileSync('new-junction/sentinel.txt')}),volumeAlias:attempt(()=>fs.readFileSync('\\\\\\\\?\\\\'+sentinel)),runtimeWrite:attempt(()=>fs.openSync(process.execPath,'r+')),scriptWrite:attempt(()=>fs.openSync(process.argv[1],'r+')),token:process.env.MACHDOCH_CLOUD_RUNNER_TOKEN??null,loopback:await network('127.0.0.1',${port}),loopbackV6:await network('::1',${ipv6Port}),arguments:process.argv.slice(2)};
 const child=cp.spawnSync(process.execPath,['-e',"try{require('node:fs').readFileSync("+JSON.stringify(sentinel)+");process.exit(17)}catch(e){console.log(e.code)}"],{encoding:'utf8',timeout:5000});result.childExit=child.status;result.childRead=child.stdout?.trim();
 let data='';for await(const chunk of process.stdin)data+=chunk;result.input=data;
 console.log(JSON.stringify(result));
})().catch(e=>{console.error(e);process.exitCode=1});`,
    );
    await symlink(
      external,
      join(input.checkoutDirectory, "preexisting-junction"),
      "junction",
    );
    const argumentSamples = [
      "",
      "two words",
      'a"b',
      "C:\\ends with slash\\",
      'slashes\\\\"quote',
      "$literal%value%",
    ];
    input.arguments.push(...argumentSamples);
    await assert.rejects(windowsClientSandboxRequest({ ...input, access: undefined }), /explicit sandbox access/);
    await assert.rejects(
      windowsClientSandboxRequest({
        ...input,
        stateDirectory: input.checkoutDirectory,
      }),
      /separate/,
    );
    await assert.rejects(
      windowsClientSandboxRequest({
        ...input,
        readonlyPaths: [input.checkoutDirectory],
      }),
      /outside writable/,
    );
    await assert.rejects(
      windowsClientSandboxRequest({ ...input, durationMs: 0 }),
      /duration/,
    );
    const previousToken = process.env.MACHDOCH_CLOUD_RUNNER_TOKEN;
    process.env.MACHDOCH_CLOUD_RUNNER_TOKEN = fixtureToken;
    let child;
    let stdout = "",
      stderr = "";
    try {
      child = await spawnWindowsClientSandbox(input);
      child.standardOutput.on("data", (data) => {
        stdout += data;
      });
      child.standardError.on("data", (data) => {
        stderr += data;
      });
      child.standardInput.end("broker request\n");
      const result = await child.wait();
      assert.equal(result.exitCode, 0, stderr);
      assert.deepEqual(child.warnings, []);
      const output = JSON.parse(stdout);
      assert.equal(output.ownRead, "written");
      assert.equal(output.input, "broker request\n");
      assert.deepEqual(output.arguments, argumentSamples);
      assert.equal(output.token, null);
      assert.equal(output.childExit, 0);
      for (const key of [
        "read",
        "write",
        "listing",
        "metadata",
        "junctionRead",
        "hardlink",
        "newJunction",
        "volumeAlias",
        "runtimeWrite",
        "scriptWrite",
        "childRead",
        "loopback",
        "loopbackV6",
      ])
        assert.ok(
          ["EPERM", "EACCES"].includes(output[key]),
          `${key}: ${output[key]}`,
        );
      assert.equal(await readFile(sentinel, "utf8"), "private sentinel");
      assert.equal(
        await readFile(join(input.stateDirectory, "state.txt"), "utf8"),
        "state",
      );
      passed(
        "Writable checkout/state, read-only runtime, precise arguments and broker pipes; secrets, filesystem escapes, descendants and host loopback denied",
      );
    } finally {
      child?.dispose();
      if (previousToken === undefined)
        delete process.env.MACHDOCH_CLOUD_RUNNER_TOKEN;
      else process.env.MACHDOCH_CLOUD_RUNNER_TOKEN = previousToken;
    }
    {
      const readonly = await inputFor(
        "readonly",
        `const fs=require('node:fs'),a=require('node:assert/strict');a.equal(fs.readFileSync('source.txt','utf8'),'source');for(const path of ['created.txt',process.env.MACHDOCH_USER_CONFIG_DIR+'/created.txt'])a.throws(()=>fs.writeFileSync(path,'denied'),e=>['EPERM','EACCES'].includes(e.code));a.throws(()=>fs.unlinkSync('source.txt'),e=>['EPERM','EACCES'].includes(e.code));console.log('Read-only source enforced');`,
      );
      readonly.access = "read-only";
      await writeFile(join(readonly.checkoutDirectory, "source.txt"), "source");
      const process = await spawnWindowsClientSandbox(readonly);
      let errors = "";
      process.standardOutput.resume();
      process.standardError.on("data", (bytes) => {
        errors = (errors + bytes).slice(-8192);
      });
      try {
        assert.equal((await process.wait()).exitCode, 0, errors);
        assert.equal(
          await readFile(
            join(readonly.checkoutDirectory, "source.txt"),
            "utf8",
          ),
          "source",
        );
        passed(
          "Read-only source mode denies creation, deletion and runtime-state writes",
        );
      } finally {
        process.dispose();
      }
    }
    for (const scenario of ["timeout", "kill", "exit", "owner-crash"]) {
      const input = await inputFor(
        scenario,
        `
const cp=require('node:child_process');
const child=cp.spawn(process.execPath,['-e',"const fs=require('node:fs');fs.writeFileSync('descendant.pid',String(process.pid));setInterval(()=>{},1000)"],{detached:true,stdio:'ignore'});child.unref();
${scenario === "exit" ? "setTimeout(()=>process.exit(0),1000)" : "setInterval(()=>{},1000)"};`,
        scenario === "timeout" ? 3000 : 20000,
      );
      let child, owner;
      let stderr = "";
      try {
        if (scenario === "owner-crash") {
          const requestPath = join(directory, "owner-request.json");
          await writeFile(requestPath, JSON.stringify(input));
          owner = spawn(
            process.execPath,
            [
              "--import",
              "@oxc-node/core/register",
              scriptPath,
              "owner",
              requestPath,
            ],
            {
              cwd: root,
              windowsHide: true,
              stdio: ["ignore", "ignore", "pipe"],
            },
          );
          owner.stderr.on("data", (data) => {
            stderr += data;
          });
        } else {
          child = await spawnWindowsClientSandbox(input);
          child.standardError.on("data", (data) => {
            stderr += data;
          });
          child.standardInput.end();
        }
        let descendantPid;
        await awaitCondition(async () => {
          try {
            descendantPid = Number(
              await readFile(
                join(input.checkoutDirectory, "descendant.pid"),
                "utf8",
              ),
            );
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
          }
          return !!descendantPid;
        }, `Descendant did not start: ${stderr}`);
        if (owner) {
          const exited = once(owner, "exit");
          owner.kill("SIGKILL");
          await exited;
        } else {
          if (scenario === "kill") child.kill();
          const result = await child.wait();
          assert.equal(result.timedOut, scenario === "timeout");
          child.dispose();
        }
        await awaitCondition(() => {
          try {
            process.kill(descendantPid, 0);
            return false;
          } catch (error) {
            if (error.code !== "ESRCH") throw error;
            return true;
          }
        }, `Detached descendant survived ${scenario}`);
        passed(`Detached descendants terminate after ${scenario}`);
      } finally {
        child?.dispose();
        if (owner && owner.exitCode === null && owner.signalCode === null)
          owner.kill("SIGKILL");
      }
    }
    const resourceInput = await inputFor(
      "resources",
      "setInterval(()=>{},1000)",
    );
    const resourceRequest = join(directory, "resource-request.json");
    await writeFile(resourceRequest, JSON.stringify(resourceInput));
    let resourceOutput = "",
      resourceErrors = "";
    const resourceSupervisor = new NativeSupervisor(
      process.env.MACHDOCH_CLOUD_SUPERVISOR,
      (kind, bytes) => {
        if (kind === "stdout") resourceOutput += bytes.toString("utf8");
        else resourceErrors += bytes.toString("utf8");
      },
    );
    try {
      await resourceSupervisor.prepareReceipt(
        join(directory, "resource-stopped.json"),
        randomUUID(),
      );
      await resourceSupervisor.start({
        anchorId: await resourceSupervisor.anchor(),
        allowanceMs: 10000,
        maxDurationMs: 15000,
        memoryLimitBytes: 512 * 1024 * 1024,
        program: process.execPath,
        args: [
          "--import",
          "@oxc-node/core/register",
          scriptPath,
          "owner",
          resourceRequest,
          "resources",
        ],
        directory: root,
        environment: {
          SystemRoot: process.env.SystemRoot,
          PATH: dirname(process.execPath),
          LOCALAPPDATA: resourceInput.stateDirectory,
          TEMP: resourceInput.stateDirectory,
        },
      });
      await awaitCondition(() => {
        if (resourceSupervisor.signal.aborted)
          throw new Error(resourceErrors || "Resource probe stopped");
        return resourceOutput.includes("\n");
      }, "The sandbox job was not inspected");
      const proof = JSON.parse(resourceOutput.trim());
      assert.equal(proof.memory, 512 * 1024 * 1024);
      assert.equal(proof.processes, 128);
      assert.equal(proof.cpuFlags & 5, 5);
      assert.ok(proof.cpuRate > 0 && proof.cpuRate <= 10000);
      assert.equal(proof.sandboxIncluded, true);
      passed(
        "The sandbox belongs to its supervisor's memory, CPU and process-limited job",
      );
    } finally {
      await resourceSupervisor.close();
    }

    const streamInput = await inputFor(
      "stream",
      "const chunks=[];process.stdin.on('data',b=>chunks.push(b));process.stdin.on('end',()=>process.stdout.write(Buffer.concat(chunks)))",
    );
    const streamRequestPath = join(directory, "stream-request.json");
    await writeFile(streamRequestPath, JSON.stringify(streamInput));
    const frames = [];
    const streamSupervisor = new NativeSupervisor(
      process.env.MACHDOCH_CLOUD_SUPERVISOR,
      (kind, bytes) => {
        if (kind === "stdout") frames.push(bytes);
      },
    );
    try {
      const receiptPath = join(directory, "stream-stopped.json");
      await streamSupervisor.prepareReceipt(receiptPath, randomUUID());
      await streamSupervisor.start({
        anchorId: await streamSupervisor.anchor(),
        allowanceMs: 8000,
        maxDurationMs: 15000,
        memoryLimitBytes: 512 * 1024 * 1024,
        program: process.execPath,
        args: [
          "--import",
          "@oxc-node/core/register",
          scriptPath,
          "owner",
          streamRequestPath,
        ],
        directory: root,
        environment: {
          SystemRoot: process.env.SystemRoot,
          PATH: dirname(process.execPath),
          LOCALAPPDATA: streamInput.stateDirectory,
          TEMP: streamInput.stateDirectory,
        },
      });
      const payload = Buffer.from(
        JSON.stringify({
          message: "broker response",
          data: "元🙂".repeat(30000),
        }),
      );
      await streamSupervisor.writeInput(payload);
      await streamSupervisor.writeInput(null);
      await awaitCondition(
        () => Buffer.concat(frames).length === payload.length,
        "Supervised sandbox output was not delivered",
      );
      assert.deepEqual(Buffer.concat(frames), payload);
      passed(
        "Native supervisor relays broker frames and EOF through the sandbox without exposing a network listener",
      );
    } finally {
      await streamSupervisor.close();
    }
    const watchdogInput = await inputFor(
      "lease",
      `
const cp=require('node:child_process');
const child=cp.spawn(process.execPath,['-e',"const fs=require('node:fs');fs.writeFileSync('descendant.pid',String(process.pid));setInterval(()=>{},1000)"],{detached:true,stdio:'ignore'});child.unref();setInterval(()=>{},1000);`,
    );
    const requestPath = join(directory, "lease-request.json");
    await writeFile(requestPath, JSON.stringify(watchdogInput));
    const supervisor = new NativeSupervisor(
      process.env.MACHDOCH_CLOUD_SUPERVISOR,
    );
    try {
      const environmentId = randomUUID();
      const receiptPath = join(directory, "stopped.json");
      await supervisor.prepareReceipt(receiptPath, environmentId);
      const anchorId = await supervisor.anchor();
      await supervisor.start({
        anchorId,
        allowanceMs: 15000,
        maxDurationMs: 15000,
        memoryLimitBytes: 512 * 1024 * 1024,
        program: process.execPath,
        args: [
          "--import",
          "@oxc-node/core/register",
          scriptPath,
          "owner",
          requestPath,
          "stall",
        ],
        directory: root,
        environment: {
          SystemRoot: process.env.SystemRoot,
          PATH: dirname(process.execPath),
          LOCALAPPDATA: watchdogInput.stateDirectory,
          TEMP: watchdogInput.stateDirectory,
        },
      });
      let descendantPid;
      await awaitCondition(async () => {
        try {
          descendantPid = Number(
            await readFile(
              join(watchdogInput.checkoutDirectory, "descendant.pid"),
              "utf8",
            ),
          );
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        return !!descendantPid;
      }, "Supervised sandbox descendant did not start");
      await supervisor.renew(await supervisor.anchor(), 1000);
      let receipt;
      await awaitCondition(async () => {
        try {
          receipt = JSON.parse(await readFile(receiptPath, "utf8"));
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        return !!receipt;
      }, "Native watchdog did not confirm termination");
      assert.equal(receipt.environmentId, environmentId);
      assert.equal(receipt.reason, "lease_expired");
      assert.equal(receipt.processTreeStopped, true);
      assert.throws(() => process.kill(descendantPid, 0), { code: "ESRCH" });
      passed(
        "Native lease watchdog terminates the sandbox and detached descendants while its JavaScript owner is stalled",
      );
    } finally {
      await supervisor.close();
    }
    await writeFile(
      join(directory, "results.json"),
      JSON.stringify(
        {
          checks,
          node: process.version,
          platform: process.platform,
          agentExecuted: false,
        },
        null,
        2,
      ),
    );
    process.stdout.write(`Client sandbox evidence: ${directory}\n`);
  } finally {
    await new Promise((done) => server.close(done));
    await new Promise((done) => ipv6Server.close(done));
  }
}
