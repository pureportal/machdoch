# Notes for "Experts are verifiers, not personas"

Research date: 2026-11-01. Repository: 39.0.0, HEAD `c0aa7678`.

## Local checks

| Check | Result |
|---|---|
| `list_research_projects`, `search_workspace_knowledge` through the running app's MCP server | Both fail: `no such module: fts5` |
| MCP server process | `%LOCALAPPDATA%\machdoch\runtime\machdoch-node-39.0.0-c064b3b803d0d7c4.exe` |
| That runtime | Node 22.13.1, SQLite 3.47.2, no FTS compile options, `CREATE VIRTUAL TABLE ... USING fts5` fails |
| Local `node` | v24.14.1, the same statement succeeds |
| Node pin | `node@22.13` in `.github/workflows/release.yml:335`, `:722`, `installer.yml:101`; `engines` `>=22.13` in both `package.json` files |
| Build check | `apps/client/src-tauri/build.rs` `validate_runtime` runs `--version` and `--check` on the bundle |
| `%LOCALAPPDATA%\machdoch\runtime` | 138 entries, 5.84 GB, including bundles back to 10.2.0 |
| `list_managed_skills` | Empty |
| `instruction-library.json` | 6 profiles (5 global, 1 tagged, 0 with a match rule), 0 workspaces with tags. Counts only |
| `mcp.json` | pixellab, playwright, tauri, blockbench, build123d enabled |

## Code facts

- Catalog tells the agent to choose and read skills: `managed-skill-delivery.ts:17`
- Native skill files for Codex and Copilot only: `provider-enrollment/materializer.ts:1083`
- Copilot run-scoped `--agent`: `provider-enrollment/materializer.ts:739`
- Skill catalog is part of the session instruction digest: `_helpers/external-agent-provider.ts:2578`
- Verification delegation mode exists: `_helpers/external-agent-provider.ts:327-343`
- Dedicated review model: `review-model.ts`
- Tag and match rules: `instruction-system/automatic-selection.spec.ts`
- Adaptive planning is regex-based with no domain signal: `adaptive-controller.ts:62-67`
- Context7 preset present, `enabled: false`: `mcp/presets.ts:72-81`

## Figures re-checked against the papers

SWE-Clar pass rates and r = 0.89; Memory Tax LongMemEval-s table (Luna results use a 20% question subset; no system beats two-round RAG, some beat one-round).

## Sources by read depth

**Large part through a summarizing fetch:** SkillsBench 1.1 post; Agent Skill Evolution 2610.04832 (first 100K characters); Agent Skills Can Be Harmful 2608.11888; Single-agent with skills 2601.04748 (first 100K); SkillOpt 2605.23904 (first 100K); PRISM 2603.18507 (first 100K); VISTA 2605.26144; Coding with Eyes 2604.19750; WebUIProof 2610.02617 (first 100K); Agent-as-a-Router 2606.22902 (first 100K); Vercel post; Anthropic finance agents; Vals Finance Agent v2.1; HealthAgentBench; Puget Unreal MCP; Claude subagents docs (first 100K); Codex subagents docs; SWE-Clar 2610.31854; Memory Tax 2610.34073 (first 100K).

**Abstract page only:** SWE-Skills-Bench 2603.15401; CraftBench-UE 2609.23142; Context files 2607.27250; ETH 2602.11988; Instruction adherence 2605.10039; Mint-Agent 2608.16386; mimeo 2609.00453; Task and session routing 2608.14641; TDAD 2603.17973; SWE-Bench 5G 2604.26278; Skill Drift 2605.10990; SkillCorpus 2607.15557; Adversarial Review 2608.18167; SkillRet 2605.05726; SkillBrowser 2610.23554; How skills are maintained 2607.00911; Cura 1T 2607.15314; Harness-native routing 2607.11399; Task-targeted models 2608.13675; Skill evaluation survey 2606.11435.

**Search snippets only:** IEEE role prompting; Wharton 2512.05858; agent frameworks 2511.00872; GPT-Rosalind (pages returned 403); ClawHub and Snyk figures (secondary); Vals SkillsBench board; GDPval; domain benchmark guide (Kili); Codex and Copilot third-party guides.

Read but left out of the report: SkillRet, SkillBrowser, harness-native routing, the task-targeted models paper and the skill survey. They add nothing decision-changing beyond the sources cited, or their abstracts give no numbers.
