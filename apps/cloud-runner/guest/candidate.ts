import { open, readdir, lstat, lchown } from "node:fs/promises";
import { constants } from "node:fs";
import { runShell } from "./shell.ts";

export async function snapshotCandidate(input: Record<string, unknown>) {
  if (
    typeof input.baseCommit !== "string" ||
    !/^[a-f0-9]{40}$/.test(input.baseCommit)
  )
    throw new Error("Use a full base commit SHA");
  const result = await runShell({
    command: `set -eu
mkdir -p /tmp/machdoch-artifacts
git -c core.hooksPath=/dev/null -c core.fsmonitor=false add -A
tree=$(git write-tree)
candidate=$(printf 'Machdoch task result\\n' | git -c user.name='Machdoch agent' -c user.email='agent@machdoch.invalid' commit-tree "$tree" -p '${input.baseCommit}')
git update-ref refs/machdoch/candidate "$candidate"
git bundle create /tmp/machdoch-artifacts/candidate.bundle refs/machdoch/candidate '^${input.baseCommit}'
git diff --no-ext-diff --no-textconv --binary '${input.baseCommit}' "$candidate" > /tmp/machdoch-artifacts/changes.patch
printf '%s\\n%s\\n' "$candidate" "$tree"`,
    timeoutMs: 300000,
  });
  if (result.exitCode !== 0 || result.timedOut || result.truncated)
    throw new Error("Candidate snapshot failed: " + result.stderr.slice(-2000));
  const [candidateCommit, tree] = result.stdout.trim().split("\n");
  if (
    !/^[a-f0-9]{40}$/.test(candidateCommit ?? "") ||
    !/^[a-f0-9]{40}$/.test(tree ?? "")
  )
    throw new Error("Candidate snapshot returned an invalid identity");
  return { candidateCommit, tree };
}

export async function freezeRepository() {
  let count = 0;
  async function freeze(
    path: string,
    metadata: boolean,
    depth: number,
  ): Promise<void> {
    if (++count > 100000 || depth > 128)
      throw new Error("Repository exceeds the validation file limit");
    const entry = await lstat(path);
    if (entry.isSymbolicLink()) {
      await lchown(path, 0, 0);
      return;
    }
    const file = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const info = await file.stat();
      if (!info.isDirectory() && !info.isFile())
        throw new Error("Validation only supports regular repository files");
      await file.chown(0, 0);
      await file.chmod(
        info.isDirectory()
          ? metadata
            ? 0o555
            : 0o1777
          : info.mode & 0o111
            ? 0o555
            : 0o444,
      );
      if (info.isDirectory())
        for (const name of await readdir(`/proc/self/fd/${file.fd}`))
          await freeze(
            `/proc/self/fd/${file.fd}/${name}`,
            metadata || name === ".git",
            depth + 1,
          );
    } finally {
      await file.close();
    }
  }
  await freeze("/workspace", false, 0);
  return { frozen: true };
}
