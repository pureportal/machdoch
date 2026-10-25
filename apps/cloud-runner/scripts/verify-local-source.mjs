import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { exportClientSourcePack } from "../../client/src/core/cloud/source-pack.ts";
import { VirtualMachineSandbox } from "../../../packages/cloud-client/src/worker/sandbox/virtual-machine.ts";
import { importBytes, exportBytes, shell } from "../../../packages/cloud-client/src/worker/guest-operations.ts";

assert.ok(
  process.env.MACHDOCH_CLOUD_SOURCE_RUNTIME,
  "Select the source export runtime.",
);
assert.ok(process.env.MACHDOCH_SANDBOX_CONFIG, "Select the sandbox runtime.");
const runtime = JSON.parse(
  await readFile(process.env.MACHDOCH_CLOUD_SOURCE_RUNTIME, "utf8"),
);
const configuration = {
  ...JSON.parse(await readFile(process.env.MACHDOCH_SANDBOX_CONFIG, "utf8")),
  backend: "whpx",
};
const directory = resolve("../../.tmp/cloud-local-source", randomUUID());
const source = join(directory, "source"),
  exports = join(directory, "exports");
await mkdir(source, { recursive: true });
await mkdir(exports);
function git(path, args, input) {
  const child = spawnSync(
    runtime.git.path,
    [
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
      input,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      env: {
        SystemRoot: process.env.SystemRoot,
        GIT_CONFIG_GLOBAL: "NUL",
        GIT_CONFIG_SYSTEM: "NUL",
      },
    },
  );
  assert.equal(child.status, 0, child.stderr?.toString());
  return child.stdout;
}
git(source, ["init", "-q", "--template="]);
await writeFile(join(source, "README"), "Local source\n");
git(source, ["add", "README"]);
git(source, [
  "-c",
  "user.name=Fixture",
  "-c",
  "user.email=fixture@example.test",
  "commit",
  "-qm",
  "Local source",
]);
const baseCommit = git(source, ["rev-parse", "HEAD"]).toString().trim();
await writeFile(join(source, "README"), "Uncommitted user work\n");
await writeFile(join(source, "private.txt"), "Never included\n");
const pack = await exportClientSourcePack(
  { repositoryRoot: source, gitDirectory: join(source, ".git") },
  baseCommit,
  exports,
  runtime,
  new AbortController().signal,
);
const checks = [],
  stopped = [];
async function machine(run) {
  const sandbox = await VirtualMachineSandbox.create(configuration, {
    directory,
    environmentId: randomUUID(),
  });
  try {
    await sandbox.start(await sandbox.supervisor.anchor(), 60000, 60000);
    return await run({ sandbox, signal: sandbox.supervisor.signal });
  } finally {
    stopped.push(await sandbox.close());
  }
}
async function prepare(environment, bytes = pack.bytes) {
  await importBytes(environment, "source.pack", bytes);
  return environment.sandbox.call(
    "prepare_local_repository",
    { commit: baseCommit },
    environment.signal,
  );
}
const bundle = await machine(async (environment) => {
  assert.equal((await prepare(environment)).ok, true);
  let primary = 0;
  const result = await environment.sandbox.call(
    "run_agent",
    {
      start: JSON.stringify({
        kind: "start",
        task: "Append client task change to README.",
        provider: "openai",
        model: "fixture",
        contextLimitBytes: 49152,
        durationMs: 30000,
      }),
    },
    environment.signal,
    undefined,
    async (request) => {
      let response;
      if (!request.tools.length)
        response = {
          text: JSON.stringify({
            outcome: "success",
            helpfulLessonIds: [],
            harmfulLessonIds: [],
            lessons: [],
          }),
          toolCalls: [],
        };
      else if (
        request.tools.some((tool) => tool.name === "report_autopilot_decision")
      )
        response = {
          text: "",
          toolCalls: [
            {
              id: "review",
              name: "report_autopilot_decision",
              arguments: {
                decision: "complete",
                confidence: "high",
                rationale: "README changed",
                missingRequirements: [],
                requiredActions: [],
              },
            },
          ],
        };
      else {
        assert.ok(++primary <= 2);
        response = {
          text: "",
          toolCalls:
            primary === 1
              ? [
                  {
                    id: "edit",
                    name: "replace_in_file",
                    arguments: {
                      path: "README",
                      oldText: "Local source\n",
                      newText: "Local source\nclient task change\n",
                      replaceAll: false,
                    },
                  },
                ]
              : [
                  {
                    id: "done",
                    name: "submit_final_response",
                    arguments: {
                      summary: "Updated README.",
                      status: "completed",
                      blockerReason: "",
                      markdown: "Updated README.",
                      highlights: [],
                      relatedFiles: [],
                      verification: [],
                      followUps: [],
                    },
                  },
                ],
        };
      }
      return {
        kind: "inference_result",
        requestId: request.requestId,
        response,
      };
    },
  );
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.result.status, "executed");
  assert.equal(result.result.processTreeStopped, true);
  const snapshot = await environment.sandbox.call(
    "snapshot_candidate",
    { baseCommit },
    environment.signal,
  );
  assert.ok(snapshot.ok, JSON.stringify(snapshot));
  const descriptor = await environment.sandbox.call(
    "describe_artifact",
    { path: "candidate.bundle" },
    environment.signal,
  );
  assert.ok(descriptor.ok, JSON.stringify(descriptor));
  const bytes = await exportBytes(
    environment,
    "candidate.bundle",
    descriptor.result.byteLength,
  );
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    descriptor.result.sha256,
  );
  checks.push(
    "Pinned local source imported with no repository broker; shared agent produced a candidate after stopping",
  );
  return { bytes, commit: snapshot.result.candidateCommit };
});
await machine(async (environment) => {
  assert.equal((await prepare(environment)).ok, true);
  await importBytes(environment, "candidate.bundle", bundle.bytes);
  const restored = await shell(
    environment,
    `git -c core.hooksPath=/dev/null fetch /tmp/machdoch-artifacts/candidate.bundle refs/machdoch/candidate && git -c core.hooksPath=/dev/null checkout --detach FETCH_HEAD && test "$(git rev-parse HEAD)" = '${bundle.commit}'`,
  );
  assert.equal(restored.exitCode, 0, restored.stderr);
  assert.equal(
    (
      await environment.sandbox.call(
        "freeze_repository",
        {},
        environment.signal,
      )
    ).ok,
    true,
  );
  const verified = await shell(
    environment,
    `node -e "const fs=require('node:fs'),a=require('node:assert/strict');a.equal(fs.readFileSync('README','utf8'),'Local source\\nclient task change\\n');a.ok(!fs.existsSync('private.txt'));a.throws(()=>fs.writeFileSync('README','tampered'));console.log('Verified')"`,
  );
  assert.equal(verified.exitCode, 0, verified.stderr);
  checks.push(
    "Candidate restored and independently verified in a fresh VM with source writes denied",
  );
});
const foreign = git(
  source,
  ["hash-object", "-w", "--stdin"],
  Buffer.from("Unrelated private object"),
)
  .toString()
  .trim();
const polluted = git(
  source,
  ["pack-objects", "--stdout"],
  Buffer.from(
    git(source, [
      "rev-list",
      "--objects",
      "--no-object-names",
      baseCommit,
    ]).toString() +
      foreign +
      "\n",
  ),
);
await machine(async (environment) => {
  const result = await prepare(environment, polluted);
  assert.equal(result.ok, false);
  checks.push(
    "Unrelated objects in a source pack are rejected before agent execution",
  );
});
await machine(async (environment) => {
  const damaged = Buffer.from(pack.bytes);
  damaged[damaged.length - 1] ^= 1;
  assert.equal((await prepare(environment, damaged)).ok, false);
  checks.push("Corrupt source packs are rejected before agent execution");
});
assert.equal(
  await readFile(join(source, "README"), "utf8"),
  "Uncommitted user work\n",
);
assert.equal(
  await readFile(join(source, "private.txt"), "utf8"),
  "Never included\n",
);
assert.ok(stopped.every((receipt) => receipt.processTreeStopped));
await writeFile(
  join(directory, "results.json"),
  JSON.stringify(
    { checks, baseCommit, candidateCommit: bundle.commit, stopped },
    null,
    2,
  ),
);
process.stdout.write(
  `PASS Local source through shared agent and independent validation.\nEvidence: ${directory}\n`,
);
