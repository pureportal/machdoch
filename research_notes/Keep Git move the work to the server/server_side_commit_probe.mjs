import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [
  sourceRepository,
  workerArgument = "8",
  changeArgument = "10",
  modeArgument = "optimistic,sequenced",
] = process.argv.slice(2);
if (!sourceRepository) {
  console.error(
    "Usage: node server_side_commit_probe.mjs <source repo> [workers] [changes per worker] [optimistic,sequenced]",
  );
  process.exit(2);
}
const workerCount = Number(workerArgument);
const changesPerWorker = Number(changeArgument);
const modes = modeArgument.split(",");
const fixturePath = "probe/shared.txt";
const fixtureLineCount = workerCount * changesPerWorker * 6 + 10;
const identity = {
  GIT_AUTHOR_NAME: "probe",
  GIT_AUTHOR_EMAIL: "probe@example.invalid",
  GIT_COMMITTER_NAME: "probe",
  GIT_COMMITTER_EMAIL: "probe@example.invalid",
};

function git(args, { cwd, input, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: { ...process.env, ...identity, ...env },
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString("utf8").trim(),
        stderr: Buffer.concat(stderr).toString("utf8").trim(),
      }),
    );
    child.stdin.end(input ?? "");
  });
}

async function gitOk(args, options) {
  const result = await git(args, options);
  if (result.code !== 0)
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

async function timed(action) {
  const start = performance.now();
  const value = await action();
  return { value, milliseconds: performance.now() - start };
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

async function readFileAt(bare, revision, path) {
  return gitOk(["-C", bare, "cat-file", "blob", `${revision}:${path}`]);
}

async function commitFile(bare, scratch, base, path, content, message) {
  const blob = await gitOk(["-C", bare, "hash-object", "-w", "--stdin"], {
    input: content,
  });
  const env = { GIT_INDEX_FILE: scratch };
  await gitOk(["-C", bare, "read-tree", base], { env });
  await gitOk(
    ["-C", bare, "update-index", "--add", "--cacheinfo", `100644,${blob},${path}`],
    { env },
  );
  const tree = await gitOk(["-C", bare, "write-tree"], { env });
  return gitOk(["-C", bare, "commit-tree", tree, "-p", base, "-m", message]);
}

async function land(bare, candidate, parent, message, stats) {
  let expected = parent;
  let current = candidate;
  let currentParent = parent;
  for (;;) {
    const update = await git([
      "-C",
      bare,
      "update-ref",
      "refs/heads/main",
      current,
      expected,
    ]);
    if (update.code === 0) return "landed";
    const tip = await gitOk(["-C", bare, "rev-parse", "refs/heads/main"]);
    if (tip === expected) {
      stats.lockRetries += 1;
      continue;
    }
    stats.rebases += 1;
    const merge = await git([
      "-C",
      bare,
      "merge-tree",
      "--write-tree",
      `--merge-base=${currentParent}`,
      tip,
      current,
    ]);
    if (merge.code === 1) return "conflict";
    if (merge.code !== 0) throw new Error(merge.stderr);
    const tree = merge.stdout.split("\n")[0];
    current = await gitOk(["-C", bare, "commit-tree", tree, "-p", tip, "-m", message]);
    currentParent = tip;
    expected = tip;
  }
}

function editLine(content, lineIndex, text) {
  const lines = content.split("\n");
  lines[lineIndex] = text;
  return lines.join("\n") + "\n";
}

const scenarios = {
  disjoint: async ({ bare, base }, worker, change) => ({
    path: `probe/w${worker}-c${change}.txt`,
    content: `worker ${worker} change ${change}\n`,
  }),
  "same file, separate lines": async ({ bare, base }, worker, change) => ({
    path: fixturePath,
    content: editLine(
      await readFileAt(bare, base, fixturePath),
      (worker * changesPerWorker + change) * 6 + 3,
      `edited by worker ${worker} change ${change}`,
    ),
  }),
  "same line": async ({ bare, base }, worker, change) => ({
    path: fixturePath,
    content: editLine(
      await readFileAt(bare, base, fixturePath),
      1,
      `contested by worker ${worker} change ${change}`,
    ),
  }),
};

async function rebaseOnto(bare, candidate, parent, tip, message) {
  const merge = await git([
    "-C",
    bare,
    "merge-tree",
    "--write-tree",
    `--merge-base=${parent}`,
    tip,
    candidate,
  ]);
  if (merge.code === 1) return undefined;
  if (merge.code !== 0) throw new Error(merge.stderr);
  return gitOk([
    "-C",
    bare,
    "commit-tree",
    merge.stdout.split("\n")[0],
    "-p",
    tip,
    "-m",
    message,
  ]);
}

async function runSequencedScenario(bare, root, name, buildChange) {
  const stats = { landed: 0, conflicts: 0 };
  const base = await gitOk(["-C", bare, "rev-parse", "refs/heads/main"]);
  const queue = [];
  const authoring = await timed(() =>
    Promise.all(
      Array.from({ length: workerCount }, async (_, worker) => {
        const scratch = join(root, `index-sequenced-${name.replace(/\W+/g, "-")}-${worker}`);
        for (let change = 0; change < changesPerWorker; change += 1) {
          const { path, content } = await buildChange({ bare, base }, worker, change);
          const message = `${name}: worker ${worker} change ${change}`;
          queue.push({
            message,
            candidate: await commitFile(bare, scratch, base, path, content, message),
          });
        }
      }),
    ),
  );
  const landing = await timed(async () => {
    let tip = base;
    for (const { candidate, message } of queue) {
      const rebased = await rebaseOnto(bare, candidate, base, tip, message);
      if (!rebased) {
        stats.conflicts += 1;
        continue;
      }
      await gitOk(["-C", bare, "update-ref", "refs/heads/main", rebased, tip]);
      tip = rebased;
      stats.landed += 1;
    }
  });
  const added = Number(
    await gitOk(["-C", bare, "rev-list", "--count", `${base}..refs/heads/main`]),
  );
  return {
    mode: "sequenced",
    scenario: name,
    attempted: workerCount * changesPerWorker,
    ...stats,
    commitsAddedToMain: added,
    parallelAuthoringSeconds: Number((authoring.milliseconds / 1000).toFixed(2)),
    sequencedLandingSeconds: Number((landing.milliseconds / 1000).toFixed(2)),
    landedPerSecond: Number((stats.landed / (landing.milliseconds / 1000)).toFixed(1)),
  };
}

async function runOptimisticScenario(bare, root, name, buildChange) {
  const stats = { landed: 0, conflicts: 0, rebases: 0, lockRetries: 0 };
  const latencies = [];
  const startTip = await gitOk(["-C", bare, "rev-parse", "refs/heads/main"]);
  const { milliseconds } = await timed(() =>
    Promise.all(
      Array.from({ length: workerCount }, async (_, worker) => {
        const scratch = join(root, `index-${name.replace(/\W+/g, "-")}-${worker}`);
        for (let change = 0; change < changesPerWorker; change += 1) {
          const { milliseconds: latency } = await timed(async () => {
            const base = await gitOk(["-C", bare, "rev-parse", "refs/heads/main"]);
            const { path, content } = await buildChange({ bare, base }, worker, change);
            const message = `${name}: worker ${worker} change ${change}`;
            const candidate = await commitFile(bare, scratch, base, path, content, message);
            const outcome = await land(bare, candidate, base, message, stats);
            stats[outcome === "landed" ? "landed" : "conflicts"] += 1;
          });
          latencies.push(latency);
        }
      }),
    ),
  );
  const added = Number(
    await gitOk(["-C", bare, "rev-list", "--count", `${startTip}..refs/heads/main`]),
  );
  return {
    mode: "optimistic",
    scenario: name,
    attempted: workerCount * changesPerWorker,
    ...stats,
    commitsAddedToMain: added,
    wallSeconds: Number((milliseconds / 1000).toFixed(2)),
    landedPerSecond: Number((stats.landed / (milliseconds / 1000)).toFixed(1)),
    medianChangeMs: Math.round(percentile(latencies, 0.5)),
    p95ChangeMs: Math.round(percentile(latencies, 0.95)),
  };
}

const root = await mkdtemp(join(tmpdir(), "server-side-commit-probe-"));
try {
  const bare = join(root, "repository.git");
  const clone = await timed(() =>
    gitOk(["clone", "--quiet", "--bare", "--no-local", sourceRepository, bare]),
  );
  const head = await gitOk(["-C", bare, "rev-parse", "HEAD"]);
  await gitOk(["-C", bare, "update-ref", "refs/heads/main", head]);
  const fileCount = Number(
    (await gitOk(["-C", bare, "ls-tree", "-r", "--name-only", "main"])).split("\n").length,
  );
  const checkout = await timed(() =>
    gitOk(["-C", bare, "worktree", "add", "--quiet", "--detach", join(root, "checkout"), "main"]),
  );
  const fixture = Array.from({ length: fixtureLineCount }, (_, line) => `line ${line}`).join("\n") + "\n";
  const fixtureCommit = await commitFile(
    bare,
    join(root, "index-fixture"),
    head,
    fixturePath,
    fixture,
    "probe fixture",
  );
  await gitOk(["-C", bare, "update-ref", "refs/heads/main", fixtureCommit, head]);
  const singleCommit = await timed(() =>
    commitFile(bare, join(root, "index-single"), fixtureCommit, "probe/single.txt", "single\n", "single"),
  );
  const runners = {
    optimistic: runOptimisticScenario,
    sequenced: runSequencedScenario,
  };
  const results = [];
  for (const mode of modes)
    for (const [name, buildChange] of Object.entries(scenarios))
      results.push(await runners[mode](bare, root, name, buildChange));
  const integrity = await git(["-C", bare, "fsck", "--connectivity-only", "--no-progress"]);
  console.log(
    JSON.stringify(
      {
        gitVersion: await gitOk(["--version"]),
        trackedFiles: fileCount,
        workers: workerCount,
        changesPerWorker,
        fullLocalCloneSeconds: Number((clone.milliseconds / 1000).toFixed(2)),
        fullCheckoutSeconds: Number((checkout.milliseconds / 1000).toFixed(2)),
        serverSideCommitMs: Math.round(singleCommit.milliseconds),
        scenarios: results,
        connectivityCheckPassed: integrity.code === 0,
      },
      null,
      2,
    ),
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
