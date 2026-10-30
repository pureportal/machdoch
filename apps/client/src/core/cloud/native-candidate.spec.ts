import { afterEach, expect, it } from "vitest";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { workspaceGit } from "./repository.js";
import {
  prepareValidationCheckout,
  publishCandidateBranch,
  requireUnchangedCandidate,
  runNativeCheck,
  snapshotNativeCandidate,
} from "./native-candidate.js";

const roots: string[] = [];
const testRoot = resolve("../../.tmp/cloud-native-tests");
const signal = new AbortController().signal;

async function repository() {
  await mkdir(testRoot, { recursive: true });
  const root = await mkdtemp(join(testRoot, "case-"));
  roots.push(root);
  const source = join(root, "source");
  const checkout = join(root, "checkout");
  for (const directory of [source, checkout]) {
    await mkdir(directory);
    await workspaceGit(directory, [
      "init",
      "--template=",
      "--initial-branch=main",
    ]);
  }
  await writeFile(join(source, "README.md"), "base\n");
  await workspaceGit(source, ["add", "README.md"]);
  await workspaceGit(source, [
    "-c",
    "user.name=Verification",
    "-c",
    "user.email=verify@example.test",
    "commit",
    "-m",
    "Base",
  ]);
  const baseCommit = (await workspaceGit(source, ["rev-parse", "HEAD"])).trim();
  await workspaceGit(checkout, [
    "fetch",
    "--no-tags",
    "--depth=1",
    "--",
    source,
    baseCommit,
  ]);
  await workspaceGit(checkout, ["checkout", "--detach", baseCommit]);
  return { root, source, checkout, baseCommit };
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    const canonical = await realpath(root);
    if (!canonical.startsWith((await realpath(testRoot)) + sep))
      throw new Error("Refusing to clean an unrelated test directory");
    await rm(canonical, { recursive: true, force: true });
  }
});

it("verifies agent changes in an independent checkout and publishes only a new branch", async () => {
  const fixture = await repository();
  await writeFile(
    join(fixture.checkout, "README.md"),
    "changed by the agent\n",
  );
  await writeFile(join(fixture.checkout, "notes.txt"), "new file\n");
  const candidate = await snapshotNativeCandidate(
    fixture.checkout,
    fixture.baseCommit,
    join(fixture.root, "artifacts"),
    signal,
  );
  expect(candidate.candidateCommit).toMatch(/^[a-f0-9]{40}$/);
  expect(candidate.patch.toString()).toContain("changed by the agent");
  expect(candidate.patch.toString()).toContain("notes.txt");
  const validation = await prepareValidationCheckout({
    directory: join(fixture.root, "validation"),
    repositoryRoot: fixture.source,
    baseCommit: fixture.baseCommit,
    bundlePath: candidate.bundlePath,
    candidateCommit: candidate.candidateCommit,
    signal,
  });
  expect(await readFile(join(validation, "notes.txt"), "utf8")).toBe(
    "new file\n",
  );
  const passed = await runNativeCheck(
    validation,
    undefined,
    {
      name: "readme",
      command: "git grep -q agent -- README.md",
      timeoutSeconds: 30,
    },
    candidate.candidateCommit,
    signal,
  );
  expect(passed).toMatchObject({
    name: "readme",
    exitCode: 0,
    timedOut: false,
    candidateCommit: candidate.candidateCommit,
  });
  const failed = await runNativeCheck(
    validation,
    undefined,
    {
      name: "missing",
      command: "git grep -q unrelated -- README.md",
      timeoutSeconds: 30,
    },
    candidate.candidateCommit,
    signal,
  );
  expect(failed.exitCode).not.toBe(0);
  await requireUnchangedCandidate(validation, signal);
  await writeFile(join(validation, "README.md"), "modified by a check\n");
  await expect(requireUnchangedCandidate(validation, signal)).rejects.toThrow(
    "changed tracked files",
  );
  const status = await workspaceGit(fixture.source, ["status", "--porcelain"]);
  const branch = await publishCandidateBranch({
    repositoryRoot: fixture.source,
    bundlePath: candidate.bundlePath,
    title: "Update the README: native agents!",
    runId: "0123456789abcdef",
    signal,
  });
  expect(branch).toBe("machdoch/update-the-readme-native-agents-01234567");
  expect(
    (await workspaceGit(fixture.source, ["rev-parse", branch])).trim(),
  ).toBe(candidate.candidateCommit);
  expect(
    (await workspaceGit(fixture.source, ["rev-parse", "HEAD"])).trim(),
  ).toBe(fixture.baseCommit);
  expect(await workspaceGit(fixture.source, ["status", "--porcelain"])).toBe(
    status,
  );
  expect(await readFile(join(fixture.source, "README.md"), "utf8")).toBe(
    "base\n",
  );
});

it("runs checks without the cloud runner credential", async () => {
  const fixture = await repository();
  const candidate = await snapshotNativeCandidate(
    fixture.checkout,
    fixture.baseCommit,
    join(fixture.root, "artifacts"),
    signal,
  );
  const previous = process.env.MACHDOCH_CLOUD_RUNNER_TOKEN;
  process.env.MACHDOCH_CLOUD_RUNNER_TOKEN = "mch_cloud_worker_private";
  try {
    const evidence = await runNativeCheck(
      fixture.checkout,
      undefined,
      {
        name: "credential",
        command: `node -e "process.exit(process.env.MACHDOCH_CLOUD_RUNNER_TOKEN ? 3 : 0)"`,
        timeoutSeconds: 30,
      },
      candidate.candidateCommit,
      signal,
    );
    expect(evidence.exitCode).toBe(0);
  } finally {
    if (previous === undefined) delete process.env.MACHDOCH_CLOUD_RUNNER_TOKEN;
    else process.env.MACHDOCH_CLOUD_RUNNER_TOKEN = previous;
  }
});

it("stops a check that exceeds its time limit", async () => {
  const fixture = await repository();
  const candidate = await snapshotNativeCandidate(
    fixture.checkout,
    fixture.baseCommit,
    join(fixture.root, "artifacts"),
    signal,
  );
  const evidence = await runNativeCheck(
    fixture.checkout,
    undefined,
    {
      name: "slow",
      command: `node -e "setTimeout(() => {}, 60000)"`,
      timeoutSeconds: 1,
    },
    candidate.candidateCommit,
    signal,
  );
  expect(evidence.timedOut).toBe(true);
  expect(evidence.durationMs).toBeLessThan(20000);
});
