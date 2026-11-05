# Notes for "Keep Git, move the work to the server"

Research dates: 2026-11-04 to 2026-11-05. Repository: 40.1.1, HEAD `05f0762a`.

## Local checks

| Check | Result |
|---|---|
| Cloud repository URL contract | `githubRepositorySchema` accepts only `https://github.com/<owner>/<name>`: `packages/fleet-protocol/src/cloud-repository.ts:3-16`; used only in `apps/cloud/src/server/cloud/execution/repositories.ts` |
| Runner repository endpoint | Operations `advertise` and `fetch` only; 64 MiB per response (`cloud-repository.ts:41`), 512 MiB and 128 transfers per run, four pending per organization (`repositories.ts`) |
| Cloud domain tables for source | Only `cloud_repository_transfers` (`migrations/011-repository-transfers.sql`); no repository, change set or review tables |
| Linked-client checkout | Per attempt: `git init`, `fetch --depth=1` of the base commit, `checkout -B machdoch/task/<attempt>` inside a per-worker cooperative lock with a 10-minute timeout: `apps/client/src/core/cloud/managed-workspace.ts:19-21`, `:156`, `:244-277`, `:327` |
| Candidate hand-off | Guest builds `refs/machdoch/candidate` with `commit-tree`, then a bundle and a binary patch: `apps/cloud-runner/guest/candidate.ts:5-31`; client side `apps/client/src/core/cloud/native-candidate.ts:47-182`, branch `machdoch/<slug>-<run>` at `:174` |
| Cloud server image | `apps/cloud/Dockerfile` does not install Git |
| Local Git | 2.53.0.windows.2. `merge-tree --write-tree` stable; `replay` and `last-modified` marked EXPERIMENTAL; `backfill`, `scalar`, `sparse-checkout` present |
| jj, Sapling, GitButler CLIs | Not installed; not tested |

## Probe

Script: [`server_side_commit_probe.mjs`](server_side_commit_probe.mjs). Run it with `node server_side_commit_probe.mjs <repository> [workers] [changes per worker] [optimistic,sequenced]`. It clones the source into a fresh temporary bare repository, adds a 490-line fixture file and deletes everything at the end.

- Raw output: [`probe-optimistic.json`](probe-optimistic.json) (first run, before the `mode` field existed) and [`probe-sequenced.json`](probe-sequenced.json).
- Workload: 8 concurrent writers with 10 changes each, per scenario. A change is `hash-object -w`, `read-tree` into a private index, `update-index --cacheinfo`, `write-tree` and `commit-tree`.
- Optimistic mode: `update-ref refs/heads/main <new> <old>`. On a lost race it runs `merge-tree --write-tree --merge-base=<parent> <tip> <candidate>`, then `commit-tree`, and retries.
- Sequenced mode: all candidates are built in parallel from one base; a single loop then rebases each onto the tip and applies `update-ref`.
- Both runs finished with `git fsck --connectivity-only` passing, and `rev-list --count` matched the landed count in every scenario.
- Timing noise: during the session, five runs of `git --version` took 325–713 ms (min/median). `cat-file -p HEAD:package.json` took 425–971 ms, `grep` over `HEAD` 1.98–2.53 s, and `merge-tree --write-tree HEAD~20 HEAD~5` 0.52–0.93 s. The first unrepeated pass was slower still (`cat-file` 6.5 s). Clone and checkout times also differed about twofold between the two probe runs. Treat every duration as process start-up on a loaded Windows machine.

## Sources by read depth

**Primary page read through a summarizing fetch:** Anthropic, "Redesigning source control at Anthropic" (Oct 13, 2026; two passes, the second asking for verbatim quotes); Simon Willison's commentary; Cursor, "Git at any scale" (Vicent Martí, Aug 18, 2026); InfoQ on Continuity; Cursor Origin docs overview; GitLab next-gen SCM (Aug 26, 2026) and "Scaling Git for the agentic software factory" (Oct 13, 2026); GitHub changelogs for stacked PRs GA (Oct 6, 2026) and the async merge API (Oct 1, 2026); Entire launch post (Oct 26, 2026) and the Hacker News thread; Zed DeltaDB (Jun 11, 2026); GitButler parallel-agents docs; Meta Sapling post (2022); Software Engineering at Google, ch. 22; Dataconomy on the OpenAI report (Mar 4, 2026); Unite.AI on the OpenAI–Pierre deal (Nov 4, 2026).

**arXiv abstract pages:** 2607.04697 (agent PR conflict rates), 2610.04779 (MergeGym), 2609.25396 (stale), 2608.00947 (Claim Plane).

**Search snippets only:** Google CACM 2016 figures; jj at Google (GitButler's JJ Con 2026 recap, plus earlier secondary reports); Microsoft GVFS and Scalar; Uber SubmitQueue; Octoverse 2026 (Visual Studio Magazine and others; merge-rate figures conflict, so they are not cited); Pierre product details (HN, PyPI, DEV); Ona acquisition; Cursor–Graphite acquisition; Git 3.0 timing (GitLab's 2.56 post, LWN); Forgejo license change (LWN); gitoxide status (GitHub discussion); jj docs on conflicts and the operation log; Mergiraf; Turso AgentFS; Diversion.

Not fetched: Gerrit's Change-Id documentation, cited from prior knowledge.

Fetch failures: the New Stack article on Entire returned navigation only; devops.com returned 403; two Cursor Origin doc pages returned 404; the Tom's Hardware page was truncated.

Read but left out of the report: Mergiraf (structural merge is useful later but not decision-changing), Turso AgentFS (copy-on-write agent sessions overlap with the existing VM sandboxes), Diversion (no technical detail found), NP-Bench 2610.07261 (simulation only), and Octoverse merge-rate figures (sources disagree).
