import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { VirtualMachineSandbox } from "../../../packages/cloud-client/src/worker/sandbox/virtual-machine.ts";
import { shell } from "../../../packages/cloud-client/src/worker/guest-operations.ts";

assert.ok(
  process.env.MACHDOCH_SANDBOX_CONFIG,
  "Select a trusted sandbox artifact manifest.",
);
const artifacts = JSON.parse(
  await readFile(process.env.MACHDOCH_SANDBOX_CONFIG, "utf8"),
);
const backend = process.platform === "win32" ? "whpx" : "kvm";
const configuration = {
  ...artifacts,
  backend,
  ...(backend === "kvm"
    ? { cgroupRoot: process.env.MACHDOCH_TEST_CGROUP_ROOT }
    : {}),
};
const root = fileURLToPath(new URL("../../../", import.meta.url));
const directory = resolve(
  root,
  ".tmp/shared-agent-vm-verification",
  randomUUID(),
);
await mkdir(directory, { recursive: true });
const checks = [],
  executions = [];
for (const scenario of [
  "complete",
  "large-response",
  "context-limit",
  "detached",
]) {
  const sandbox = await VirtualMachineSandbox.create(configuration, {
    directory,
    environmentId: randomUUID(),
  });
  let requests = 0,
    primary = 0,
    limited;
  const content = ["large-response", "context-limit"].includes(scenario)
    ? "λ".repeat(40000)
    : "Shared Machdoch runtime in Linux VM";
  try {
    await sandbox.start(await sandbox.supervisor.anchor(), 45000, 60000);
    const environment = { sandbox, signal: sandbox.supervisor.signal };
    const start = {
      kind: "start",
      task: "Create shared-result.txt using the supplied fixture instructions",
      provider: "openai",
      model: "fixture",
      contextLimitBytes: 49152,
      durationMs: 30000,
    };
    const response = await sandbox.call(
      "run_agent",
      { start: JSON.stringify(start) },
      environment.signal,
      undefined,
      async (request, signal) => {
        signal.throwIfAborted();
        assert.ok(++requests <= 20);
        let result;
        if (!request.tools.length) {
          assert.equal(
            request.modelOptions.structuredOutput.name,
            "reasoning_bank_lessons",
          );
          result = {
            text: JSON.stringify({
              outcome: "success",
              helpfulLessonIds: [],
              harmfulLessonIds: [],
              lessons: [
                {
                  title: "Keep task learning private",
                  description:
                    "Persist learned context outside source changes.",
                  content:
                    "Keep generated task learning in private runtime storage, separate from source artifacts.",
                  triggerTerms: ["task learning"],
                  confidence: 0.9,
                  applicability: {
                    taskTerms: [],
                    excludedTaskTerms: [],
                    maxAgeDays: null,
                  },
                },
              ],
            }),
            toolCalls: [],
          };
        } else if (
          request.tools.some(
            (tool) => tool.name === "report_autopilot_decision",
          )
        ) {
          result = {
            text: "",
            toolCalls: [
              {
                id: "review",
                name: "report_autopilot_decision",
                arguments: {
                  decision: "complete",
                  confidence: "high",
                  rationale: "File exists",
                  missingRequirements: [],
                  requiredActions: [],
                },
              },
            ],
          };
        } else {
          assert.ok(request.tools.some((tool) => tool.name === "create_file"));
          assert.ok(
            request.tools.some((tool) => tool.name === "run_shell_command"),
          );
          assert.ok(
            !request.tools.some((tool) =>
              /scheduler|schedule|workflow|mcp|browser|speech|parallel/iu.test(
                tool.name,
              ),
            ),
          );
          const messages = JSON.parse(request.context).messages;
          if (scenario === "context-limit" && primary === 1 && !limited) {
            const bytes = Buffer.byteLength(messages[0].content) + 2048;
            assert.ok(Buffer.byteLength(request.context) > bytes);
            limited = { id: request.requestId, bytes };
            return {
              kind: "inference_limit",
              requestId: request.requestId,
              contextLimitBytes: bytes,
            };
          }
          if (limited) {
            assert.notEqual(request.requestId, limited.id);
            assert.ok(Buffer.byteLength(request.context) <= limited.bytes);
          }
          primary++;
          let calls;
          if (scenario === "detached" && primary === 1) {
            calls = [
              {
                id: "script",
                name: "create_file",
                arguments: {
                  path: "worker.cjs",
                  content:
                    "const fs=require('node:fs'),a=require('node:assert/strict');a.equal(process.getuid(),1000);const group=fs.readFileSync('/proc/self/cgroup','utf8').trim();a.equal(group,'0::/agent');a.match(fs.readFileSync('/proc/self/status','utf8'),/NoNewPrivs:\\s+1/);a.throws(()=>fs.writeFileSync('/sys/fs/cgroup/cgroup.procs',String(process.pid)));fs.writeFileSync('shared-result.tmp',JSON.stringify({pid:process.pid,group}));fs.renameSync('shared-result.tmp','shared-result.txt');setInterval(()=>fs.appendFileSync('ticks.txt','tick'),20);",
                },
              },
            ];
          } else if (scenario === "detached" && primary === 2) {
            calls = [
              {
                id: "spawn",
                name: "start_detached_command",
                arguments: { command: "node worker.cjs" },
              },
            ];
          } else if (scenario === "detached" && primary === 3) {
            const readiness =
              "const fs=require('node:fs'),{setTimeout:wait}=require('node:timers/promises');(async()=>{const end=Date.now()+5000;while(!fs.existsSync('shared-result.txt')){if(Date.now()>=end)throw Error('Detached worker did not become ready');await wait(20);}console.log(fs.readFileSync('shared-result.txt','utf8'));})().catch(e=>{console.error(e);process.exitCode=1;});";
            calls = [
              {
                id: "ready",
                name: "run_shell_command",
                arguments: {
                  command:
                    "node -e '" + readiness.replaceAll("'", "'\\''") + "'",
                },
              },
            ];
          } else if (scenario !== "detached" && primary === 1) {
            calls = [
              {
                id: "create",
                name: "create_file",
                arguments: { path: "shared-result.txt", content },
              },
            ];
          } else {
            if (scenario === "detached")
              assert.ok(
                messages.some(
                  (message) =>
                    message.role === "tool" &&
                    message.name === "run_shell_command" &&
                    String(message.output).includes("/agent"),
                ),
                "Detached worker readiness failed",
              );
            calls = [
              {
                id: "done",
                name: "submit_final_response",
                arguments: {
                  summary: "Created shared-result.txt.",
                  status: "completed",
                  blockerReason: "",
                  markdown: "Created shared-result.txt.",
                  highlights: [],
                  relatedFiles: [],
                  verification: [],
                  followUps: [],
                },
              },
            ];
          }
          result = { text: "", toolCalls: calls };
        }
        return {
          kind: "inference_result",
          requestId: request.requestId,
          response: result,
        };
      },
    );
    assert.equal(response.ok, true, JSON.stringify(response));
    assert.equal(response.result.status, "executed", response.result.summary);
    assert.equal(response.result.processTreeStopped, true);
    if (scenario === "context-limit") assert.ok(limited);
    const expected =
      scenario === "detached"
        ? "a.equal(JSON.parse(text).group,'0::/agent');"
        : `a.equal(require('node:crypto').createHash('sha256').update(text).digest('hex'),'${createHash("sha256").update(content).digest("hex")}');`;
    const script = `const fs=require('node:fs'),a=require('node:assert/strict');const pids=fs.readFileSync('/sys/fs/cgroup/agent/cgroup.procs','utf8').trim().split(String.fromCharCode(10)).filter(Boolean).map(Number);a.ok(pids.every(pid=>pid===process.pid||pid===process.ppid));a.throws(()=>fs.appendFileSync('/opt/machdoch/shared-agent.cjs','changed'));a.ok(!fs.existsSync('/workspace/.machdoch'));a.equal(JSON.parse(fs.readFileSync('/run/workspace/state/reasoning-bank.json','utf8')).lessons.length,1);const text=fs.readFileSync('shared-result.txt','utf8');${expected}console.log(JSON.stringify({bytes:Buffer.byteLength(text),uid:process.getuid()}));`;
    const command = "node -e '" + script.replaceAll("'", "'\\''") + "'";
    const verified = await shell(environment, command);
    assert.equal(verified.exitCode, 0, verified.stderr);
    executions.push({
      scenario,
      requests,
      result: response.result,
      verification: JSON.parse(verified.stdout),
    });
    checks.push(
      `${scenario}: broker exchange, shared engine, exact output and empty agent process group`,
    );
    console.log(`PASS ${checks.at(-1)}`);
  } finally {
    const receipt = await sandbox.close();
    assert.equal(receipt.processTreeStopped, true);
  }
}
const collector = await VirtualMachineSandbox.create(configuration, {
  directory,
  environmentId: randomUUID(),
});
try {
  await collector.start(await collector.supervisor.anchor(), 45000, 60000);
  const environment = {
    sandbox: collector,
    signal: collector.supervisor.signal,
  };
  const initial = await shell(
    environment,
    "git -c init.templateDir= init -q && printf fixture > README && git -c core.hooksPath=/dev/null add README && git -c user.name=Fixture -c user.email=fixture@example.test commit -qm base && git rev-parse HEAD",
  );
  assert.equal(initial.exitCode, 0, initial.stderr);
  const baseCommit = initial.stdout.trim();
  assert.match(baseCommit, /^[a-f0-9]{40}$/);
  const descendant =
    "const fs=require('node:fs');fs.writeFileSync('snapshot-child.json',JSON.stringify({pid:process.pid,group:fs.readFileSync('/proc/self/cgroup','utf8').trim()}));process.send('ready');setInterval(()=>fs.appendFileSync('snapshot-ticks','tick'),20);";
  const hook = `const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{detached:true,stdio:['ignore','ignore','ignore','ipc']});child.once('message',()=>{child.disconnect();child.unref();process.stdin.pipe(process.stdout);});`;
  for (const [path, content] of [
    ["hook.cjs", hook],
    [".gitattributes", "README filter=adversarial\n"],
    ["README", "changed source\n"],
  ]) {
    const written = await collector.call(
      "write_file",
      { path, content },
      environment.signal,
    );
    assert.equal(written.ok, true, JSON.stringify(written));
  }
  const configured = await shell(
    environment,
    "git config filter.adversarial.clean 'node hook.cjs'",
  );
  assert.equal(configured.exitCode, 0, configured.stderr);
  const candidate = await collector.call(
    "snapshot_candidate",
    { baseCommit },
    environment.signal,
  );
  assert.equal(candidate.ok, true, JSON.stringify(candidate));
  const code =
    "const fs=require('node:fs'),a=require('node:assert/strict'),child=JSON.parse(fs.readFileSync('snapshot-child.json','utf8'));a.equal(child.group,'0::/agent');const pids=fs.readFileSync('/sys/fs/cgroup/agent/cgroup.procs','utf8').trim().split(String.fromCharCode(10)).filter(Boolean).map(Number);a.ok(pids.every(pid=>pid===process.pid||pid===process.ppid));console.log('collector descendants stopped');";
  const verified = await shell(
    environment,
    "node -e '" + code.replaceAll("'", "'\\''") + "'",
  );
  assert.equal(verified.exitCode, 0, verified.stderr);
  checks.push(
    "Git snapshot filters and detached descendants remain in the bounded workload and stop before artifact export",
  );
  console.log(`PASS ${checks.at(-1)}`);
} finally {
  assert.equal((await collector.close()).processTreeStopped, true);
}
await writeFile(
  join(directory, "results.json"),
  JSON.stringify(
    { checks, executions, backend, modelTransport: "controlled host fixture" },
    null,
    2,
  ),
);
console.log(`Shared agent VM evidence: ${directory}`);
