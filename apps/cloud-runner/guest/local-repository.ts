import { runShell } from "./shell.ts";

export async function prepareLocalRepository(input: Record<string, unknown>) {
  if (typeof input.commit !== "string" || !/^[a-f0-9]{40}$/.test(input.commit))
    throw new Error("Use a full commit SHA");
  const result = await runShell({
    command: `set -eu
test ! -e .git
git -c init.templateDir= init -q
printf '%s\\n' '${input.commit}' > .git/shallow
git -c core.hooksPath=/dev/null index-pack --strict --stdin --max-input-size=67108864 < /tmp/machdoch-artifacts/source.pack
test "$(git cat-file -t '${input.commit}')" = commit
git update-ref refs/machdoch/base '${input.commit}'
git fsck --strict --no-reflogs --unreachable '${input.commit}' > /tmp/machdoch-artifacts/source-objects.txt
test ! -s /tmp/machdoch-artifacts/source-objects.txt
git ls-tree -r --format='%(objectmode)' '${input.commit}' > /tmp/machdoch-artifacts/source-modes.txt
if grep -q '^160000$' /tmp/machdoch-artifacts/source-modes.txt; then
  printf 'Submodule source is not available\\n' >&2
  exit 1
fi
git -c core.hooksPath=/dev/null checkout --detach '${input.commit}'
test "$(git rev-parse HEAD)" = '${input.commit}'`,
    timeoutMs: 60000,
  });
  if (result.exitCode !== 0 || result.timedOut || result.truncated)
    throw new Error(
      "The local source pack is invalid or exceeds this environment's limits.",
    );
  return { baseCommit: input.commit };
}
