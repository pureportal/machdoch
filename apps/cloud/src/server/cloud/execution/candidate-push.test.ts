import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import { pushCandidate } from "./candidate-push";

let root: string;
const git = (directory: string, ...args: string[]) =>
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.test",
      "-c",
      "protocol.file.allow=always",
      "-C",
      directory,
      ...args,
    ],
    { encoding: "utf8" },
  ).trim();

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "machdoch-push-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 10 });
});

it("pushes a verified candidate bundle to a new branch", async () => {
  const upstream = join(root, "upstream.git");
  const work = join(root, "work");
  execFileSync("git", ["init", "--bare", "-q", "-b", "main", upstream]);
  git(upstream, "config", "uploadpack.allowFilter", "true");
  git(upstream, "config", "uploadpack.allowAnySHA1InWant", "true");
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  await writeFile(join(work, "messages.json"), '{"hello":"Hallo"}\n');
  await writeFile(join(work, "README.md"), "Project\n");
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "Base");
  git(work, "push", "-q", pathToFileURL(upstream).href, "main");
  const base = git(work, "rev-parse", "HEAD");
  await writeFile(join(work, "messages.json"), '{"hello":"Guten Tag"}\n');
  git(work, "commit", "-q", "-am", "Machdoch task result");
  const candidate = git(work, "rev-parse", "HEAD");
  git(work, "update-ref", "refs/machdoch/candidate", candidate);
  const bundlePath = join(root, "candidate.bundle");
  git(
    work,
    "bundle",
    "create",
    bundlePath,
    "refs/machdoch/candidate",
    `^${base}`,
  );

  const push = {
    cacheDirectory: join(root, "cache"),
    organizationId: "organization",
    remote: pathToFileURL(upstream).href,
    authorization: null,
    bundle: await readFile(bundlePath),
    baseCommit: base,
    candidateCommit: candidate,
    branch: "machdoch/greeting-1234abcd",
    allowFileRemote: true,
  };
  await pushCandidate(push);
  expect(
    git(upstream, "rev-parse", "refs/heads/machdoch/greeting-1234abcd"),
  ).toBe(candidate);
  expect(git(upstream, "rev-parse", "refs/heads/main")).toBe(base);

  await expect(
    pushCandidate({ ...push, candidateCommit: "f".repeat(40) }),
  ).rejects.toThrow("does not match");
}, 120_000);
