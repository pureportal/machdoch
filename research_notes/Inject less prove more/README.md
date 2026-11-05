# Notes for "Inject less, prove more"

Research date: 2026-11-01. Repository: 39.0.0, HEAD `c0aa7678`.

## Local retrieval replay

Reads local stores only and sends nothing anywhere.

- Stores: `.machdoch/local/state/reasoning-bank.json`, `.machdoch/local/state/memory.json`
- Code under test: `retrieveReasoningLessons` (`apps/client/src/core/reasoning-bank.ts`), `retrieveConversationMemory` (`apps/client/src/core/memory-retrieval.ts`)
- Queries: the last 300 commit subjects, minus version bumps and very short subjects, leaving 258
- "Shared word" counts use `tokenizeMemoryText` on the item's combined text
- Gate tested: at least two shared words after removing an extended stoplist
- Sample: seeded random picks (seed 20261101), 25 lessons and 25 memories, from all retrievals

Reproduce from `apps/client` in Git Bash (the workspace `tsx` binary is broken on this machine):

```bash
N="$(cygpath -m "$PWD/../../research_notes/Inject less prove more")"
node --no-warnings --experimental-strip-types --import "file:///$N/ts-hook.mjs" "$N/retrieval_probe.ts"
node "$N/local_stats.mjs"
```

### Results

| Measure | Lessons | Memories |
|---|---|---|
| Stored | 240 (cap 240) | 64 (cap 64) |
| Retrieved across 258 queries | 932 | 729 |
| Per query | 3.61 | 2.83 |
| Single shared word | 67.6% | 82.3% |
| Two shared words | 26.4% | 14.7% |
| Queries with no result | 1.9% | 11.6% |
| Distinct items retrieved | 189 | 48 |
| Kept by the gate | 264 | 110 |
| Queries with no result after the gate | 45.0% | 71.3% |
| Judged useful in the sample | 9 of 25 | 4 of 25 |
| Useful among gate survivors in the sample | 6 of 9 | 1 of 3 |
| Useful items the gate dropped in the sample | 3 | 3 |

Bank counters: 1,539 retrievals, 108 helpful marks, 0 harmful marks, 47 lessons with a helpful mark, 75 never retrieved. Median age: lessons 27.3 days, memories 33.0 days. Oldest memory: 36.6 days.

For the task that started this research, the replay selected 4 lessons and 4 memories at default limits. The live run's adaptive budget injected fewer. I judged none of the replayed items useful for it. The lesson on tiled VAE decoding, which also reached the live run, shared only the word `memory`.

The labels are one judge's call from titles and short excerpts, with lenient calls counted as useful. Commit subjects are shorter than real prompts, which inflates single-word matches. Lesson and memory text is left out of these notes on purpose.

## Goal records

47 records on this machine: 1 complete, 34 paused, 11 blocked, 1 active. 20 were updated on or after 2026-10-31. None holds a verdict from the 39.0.0 verification, so its effect can't be measured yet. `local_stats.mjs` reports numeric fields and fixed status values only.

## Code facts checked

- One shared non-stopword qualifies an item: `memory-applicability.ts`, the `irrelevant-content` branch
- `can`, `new` and `check` are absent from the `memory-retrieval.ts` stoplist
- Workspace memory keeps the newest 64 by `updatedAt`: `memory.ts`, sort then slice in the normalizer
- Lessons are trimmed by confidence and helpful and harmful counts: `trimBank` in `reasoning-bank.ts`
- Helpful and harmful marks come from model review: `reasoning-bank-consolidation.ts`
- The session binding stores provider, session ID, instruction digest, history length and digest, and time, with no workspace state: `provider-session-store.ts`
- The interview is user-invoked: `task-interview.ts`, `chat-interview.ts`, `cli-interview-commands.ts`
- Workspace knowledge indexes text extensions only: `workspace-library/files.ts`
- Compaction appears only in `copilot-server-session.ts` within `apps/client/src/core`
- No agent eval suite turned up in tracked files. This was a filename search for `eval` and `bench`
- A targeted search found no tool-definition pinning in `mcp/`. MCP discovery does hash metadata, so confirm by reading before acting
- 123 `mcp__machdoch__*` tools were offered to this run, counted from its tool list

## Sources by read depth

**Full text or large part, through a summarizing fetch:** Memory Tax 2610.34073; DolphinBench 2609.24971; LongMemEval-V2 2605.12493 (first 100K characters); AMA-Bench 2602.22769 (first 100K characters); FlexA-Mem 2610.33274 (first 100K characters); KEEL 2610.34043; Stratum 2610.36153; Spine 2610.37224; Identical Runs 2609.33812; SWE-Clar 2610.31854; Progent adaptive evaluation 2606.26479; MCP-Injector 2610.32555 (first 100K characters); Dreams docs (direct).

**Abstract page only:** Epistemic Parity 2610.33128; WhoWins 2610.33201; Soei 2610.39468; Beyond Passing Tests 2610.38977; RepoTrace 2610.35333; SWE-CC 2610.06193; SWE-RPG 2608.09072; Implicit Intelligence 2602.20424; CONTRA 2610.01769; PUSV 2604.18860; Is Bash All You Need? 2609.11999; Symbolic Constraint Agents 2610.25552; Lehmann & Vahdati 2610.30499; Self-Harness 2606.09498; When Agents Fail 2610.32483; Context Is a Pipeline 2610.36114; Instruction Stacks 2610.37332; Paritok study 2609.22114; Rivet 2610.34967; LSP study 2608.13568; CARI 2610.38799; HookPry 2609.03884; Trust Region 2610.38867; Memory Files 2610.38521; PrefDiag-Bench 2610.30573; EnvOS 2610.40246; VeriCUA 2610.40578; CodeSpecWeave 2610.40256; Ask or Assume? (ACL Anthology page).

**Search result only, not opened:** Chronicle docs.

**Vendor or documentation pages through a summarizing fetch:** Cursor semantic search post, Cursor agent sandboxing post, Claude release notes, OpenAI changelog, Claude Code What's new, Cursor changelog, METR time horizons, Anthropic Managed Agents post.

## Could not confirm

- The 70.80% fully-specified comparison for Ask or Assume? came from a search summary and isn't on the ACL page, so the report leaves it out.
- Official leaderboards: the Terminal-Bench page rendered no entries. Aggregator pages disagree on SWE-bench Pro and Terminal-Bench, so the report quotes no leaderboard scores.
- An October 2026 search for comprehension or review studies of coding-agent output found little that measures it directly.
- Whether the 123 tools are costly on Codex and Copilot wasn't measured.
