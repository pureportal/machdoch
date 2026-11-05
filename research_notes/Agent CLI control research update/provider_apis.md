# Provider API agent features for machdoch's API-driven runtime (as of 2026-10-30)

Legend: dates in parentheses are the source's own date (changelog entry or "last updated"). "Undated doc" means the page carries no date and was read on 2026-10-30. `[>6mo]` marks a source date before 2026-04-30. No API calls were made; everything below is from documentation and from reading machdoch's source. Statements about machdoch's runtime behaviour on current models come from reading code, not from running it.

## Anthropic: which server-side features would improve the agent runtime?

### Takeaway
Anthropic now has the richest set of cache-preserving and context-shrinking controls, but machdoch uses almost none of them. Reading the code turned up two things to fix before adding features: only the system prompt has a cache breakpoint, and the main loop's default `tool_choice: any` is documented to return 400 on Opus 5.5, Sonnet 5.5 and Fable 5.1.

### Cited Findings

**Current machdoch use (source reading, working tree on 2026-10-30)**
- The one `cache_control` in `packages/model-runtime/src` is on the system prompt block (`packages/model-runtime/src/providers/anthropic-adapter.ts:145`). There is no top-level automatic `cache_control` and no breakpoint on messages, so the system prompt and tools are cached but conversation history is not.
- `createAnthropicToolSelection` defaults to `tool_choice: {type: "any", disable_parallel_tool_use: true}` (`anthropic-adapter.ts:35-46`). A search of `apps/client/src/core/*.ts` finds `toolChoice` only in `cloud/model-adapter.ts`, so the local agent runtime appears to take this default. `anthropic-adapter.spec.ts:28-29` asserts `type: "any"`.
- Every tool is sent with `strict: true` (`anthropic-adapter.ts:123`). Default `max_tokens` is 4,096 unless reasoning is `xhigh` or `max` (`anthropic-adapter.ts:50-52`).
- Already used: `output_config.effort` and `output_config.format` (`anthropic-adapter.ts:60-87`), and thinking signature deltas (`anthropic-adapter.ts:442-448`).
- Not found in the adapter: `context_management`, `compaction`, `defer_loading`, `allowed_callers`, `eager_input_streaming`, `task_budget`, the advisor tool, or Message Batches.
- `@anthropic-ai/sdk` is pinned at `^0.104.2` (`packages/model-runtime/package.json:16`). TypeScript SDK 1.0.0 and API version `2026-10-21` shipped with breaking changes ([release notes](https://platform.claude.com/docs/en/release-notes/overview), 2026-10-21).

**Compatibility facts that affect the current adapter**
- `tool_choice` types `any` and `tool` return 400 on Fable 5.1 and Mythos 5.1 (2026-09-01), Opus 5.5 (2026-09-22) and Sonnet 5.5 (2026-09-28). The documented replacement is `auto` with strict tool use ([release notes](https://platform.claude.com/docs/en/release-notes/overview)).
- On Fable 5.1, for accounts created on or after 2026-08-31, replaying a thinking block after `system`, `tools` or an earlier message changed returns 400 (2026-09-01). On Haiku 5.5 such a request "can also return a 400 error" (2026-10-07) ([release notes](https://platform.claude.com/docs/en/release-notes/overview)).
- Opus 5.5 has always-on adaptive thinking and rejects `thinking: disabled` or `enabled` (2026-09-22) ([release notes](https://platform.claude.com/docs/en/release-notes/overview)). Anthropic advises `max_tokens` of at least 64k at `xhigh` or `max` effort ([task budgets](https://platform.claude.com/docs/en/build-with-claude/task-budgets), undated doc).

**Feature catalogue**

| Feature | API surface | Status | Pricing implication | What machdoch could do | Source |
|---|---|---|---|---|---|
| Automatic prompt caching | Top-level `cache_control: {type:"ephemeral"}`; breakpoint moves forward by itself; uses one of 4 slots | Available (2026-02-19 `[>6mo]`) | 5m write 1.25x, 1h write 2x, read 0.1x by default; read 0.05x on Opus 5.5 and Sonnet 5.5; 0.025x on Fable 5.1 and Mythos 5.1 | One-line change to cache history on every turn | [Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) (undated doc); [release notes](https://platform.claude.com/docs/en/release-notes/overview) |
| 1-hour TTL | `"ttl": "1h"`; 1h entries must precede 5m ones | GA, no header (2025-08-13 `[>6mo]`) | 2x write. 5m clock starts at request start, so long streams eat the window | Use for goal runs whose tools often exceed 5 minutes | [Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) |
| Cache diagnostics | `diagnostics` object on request; `previous_message_id` | GA on Claude API (2026-09-23) | None stated | Log divergence points in dev builds to find cache breaks | [Release notes](https://platform.claude.com/docs/en/release-notes/overview) |
| Context editing | `context_management.edits` with `clear_tool_uses_20250919`, `clear_thinking_20251015`; `trigger`, `keep`, `clear_at_least`, `exclude_tools`, `clear_tool_inputs` | Beta, `context-management-2025-06-27`; ZDR eligible except Covered Models | Clearing invalidates the cached prefix; `clear_at_least` exists to justify the rewrite | Clear old file reads and command output while keeping the client's history intact | [Context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing) (undated doc) |
| Threshold compaction | `compact_20260112` edit; trigger default 150k, minimum 50k; `pause_after_compaction`, `instructions` | Beta, `compact-2026-01-12` (launched 2026-02-05 `[>6mo]`); ZDR eligible except Covered Models | Extra sampling step, billed; sum `usage.iterations`; top-level usage excludes it. Resending the block costs nothing | Lowest-effort auto compaction | [Threshold compaction](https://platform.claude.com/docs/en/build-with-claude/compaction-threshold) (undated doc) |
| On-demand compaction | Top-level `compaction: {type:"summarize", instructions}`; returns signed block placed first in `messages`; keep-recent-turns and background variants | Beta, `compact-2026-09-04` (2026-09-14); header required on every later request carrying the block | Billed like any request; top-level input and output are zero, so sum `usage.iterations` | Anthropic's recommended default; compact between goal iterations, in background, with machdoch's own instructions | [Compaction overview](https://platform.claude.com/docs/en/build-with-claude/compaction); [on demand](https://platform.claude.com/docs/en/build-with-claude/compaction-on-demand) (undated docs) |
| Memory tool | `{"type":"memory_20250818","name":"memory"}`; client-run commands `view`, `create`, `str_replace`, `insert`, `delete`, `rename` | GA, no header (2026-02 `[>6mo]`); ZDR eligible except Covered Models, HIPAA eligible | Tokens only. API adds a short instruction to the system prompt, and memory reads enter context | Back it with machdoch's memory store; must enforce `/memories` path validation | [Memory tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool) (undated doc) |
| Programmatic tool calling | `code_execution_20260120` or later plus `allowed_callers` on tools; `caller` on `tool_use`; `container` reuse | GA on Claude API; ZDR not eligible, data retained up to 30 days | "Tool results from programmatic calls do not count toward your input/output token usage". Free with web search or fetch, otherwise $0.05/container-hour after 1,550 free hours, 5-minute minimum | Batch file reads and searches into one model turn | [PTC](https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling) (undated doc); [pricing](https://platform.claude.com/docs/en/about-claude/pricing) |
| Tool search | `tool_search_tool_regex_20251119` or `_bm25_`; `defer_loading: true`; custom search via `tool_reference` | GA; ZDR eligible except Covered Models | Not metered separately. Example: ~55k tokens of definitions reduced by over 85%. Prefix untouched, so cache preserved | Defer MCP tools; keep 3-5 core tools loaded. Recommended at 10+ tools or >10k tokens | [Tool search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool) (undated doc) |
| Inline and mid-conversation tool changes | `role:"system"` message with `tool_addition`, `tool_removal`; `inline-tools-2026-09-15`, `mid-conversation-tool-changes-2026-07-01` | Beta (2026-07-24, 2026-09-22) | Cache survives | Enable tools by phase without a cache break | [Mid-conversation messages](https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages) (undated doc); [release notes](https://platform.claude.com/docs/en/release-notes/overview) |
| Mid-conversation system messages | `{"role":"system"}` in `messages`; `clear_at:"next_user_message"` (beta `mid-conversation-system-clear-at-2026-08-21`) | System messages GA, not on Sonnet 5; `clear_at` beta (2026-09-01) | Cleared messages cost no input tokens | Per-turn reminders and goal state without growing the prompt. On Sonnet 5.5 and Haiku 5.5, a system message right after a tool result may be ignored as untrusted | [Mid-conversation messages](https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages) |
| Effort, per-message effort | `output_config.effort` (GA 2026-02-05 `[>6mo]`, `xhigh` 2026-04-16 `[>6mo]`); per-message via system message, `mid-conversation-output-config-2026-07-01` | Effort GA; per-message beta (2026-09-01) | Top-level effort change always invalidates messages cache; per-message form preserves it | Raise effort on hard turns, lower on mechanical ones, without a cache miss | [Release notes](https://platform.claude.com/docs/en/release-notes/overview); [prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) |
| Advisor tool | `{"type":"advisor_20260301","name":"advisor","model":..., "max_uses", "max_tokens", "caching"}` | Beta, `advisor-tool-2026-03-01` (2026-04-09 `[>6mo]`); ZDR eligible except Covered Models | Advisor billed at its own rates, reported only in `usage.iterations`. Typical output 400-700 text tokens, 1,400-1,800 with thinking. Advisor caching breaks even around 3 calls. Vendor claim: Sonnet plus Opus advisor costs similar or less | Run goal loops on Sonnet or Haiku with Opus consulted; `max_tokens: 2048` cut output about 7x in Anthropic testing | [Advisor](https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool) (undated doc) |
| Task budgets | `output_config.task_budget: {type:"tokens", total, remaining}`; minimum 20k | Beta, `task-budgets-2026-03-13` (2026-04-16 `[>6mo]`); not on Sonnet 5, Opus 4.6 | Advisory, not a cap. Changing `remaining` per request breaks cache. Too-small budgets can cause refusal-like behaviour | Set once per goal iteration so the model finishes gracefully; pair with machdoch's hard limits | [Task budgets](https://platform.claude.com/docs/en/build-with-claude/task-budgets) (undated doc) |
| Model switching | Change `model`; no dedicated page or parameter found. Send full history and let the API filter thinking blocks | Behaviour documented, not a feature flag | Dropped blocks are not billed, but on Claude 5.1+ a dropped block changes the prefix from that block onward | Prefer advisor to switching; if switching, never strip thinking client-side. Fable 5.1 reads Opus 5.5 blocks, not the reverse | [Thinking](https://platform.claude.com/docs/en/build-with-claude/thinking) (via search summary); [prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) |
| Refusal fallback | `fallbacks` param; `"default"` mode needs `server-side-fallback-2026-07-01` | Beta (2026-06-09, 2026-07-24); not on Batches | Billed at fallback model's rates | Handle classifier refusals in long runs without failing the run | [Release notes](https://platform.claude.com/docs/en/release-notes/overview) |
| Structured outputs | `output_config.format`; strict tools | GA on Claude API (2026-01-29 `[>6mo]`) | Tokens only | Already used | [Release notes](https://platform.claude.com/docs/en/release-notes/overview) |
| Fine-grained tool streaming | `eager_input_streaming: true` per tool | GA, no header (2026-02-05 `[>6mo]`) | None | Live preview of large file writes; must guard against invalid JSON | [Fine-grained streaming](https://platform.claude.com/docs/en/agents-and-tools/tool-use/fine-grained-tool-streaming) (undated doc) |
| Code execution | `code_execution_20260120` (REPL state, 2026-06-18), `_20260521` (discloses 90-second cell limit, 2026-06-11) | No header | See PTC row. Files in the request bill execution time even if the tool is not called | Needed only for PTC and Skills | [Release notes](https://platform.claude.com/docs/en/release-notes/overview); [pricing](https://platform.claude.com/docs/en/about-claude/pricing) |
| Skills API | `/v1/skills`; `skill_ids` in `container` with code execution | GA (2026-08-19); ZDR not eligible | ~100 tokens per skill metadata, under 5k when triggered. API runtime has no network and no package install | Low value: machdoch has local skills with real filesystem access | [Skills](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview) (undated doc) |
| Files API | `/v1/files` | GA (2026-08-19) | Not checked | Reuse large attachments by reference | [Release notes](https://platform.claude.com/docs/en/release-notes/overview) |
| Message Batches | Async batch; 100k requests or 256 MB; most finish within 1 hour, expire at 24h | GA; ZDR not eligible, 29-day retention | 50% off input and output; stacks with caching; 1-hour TTL advised for shared context | Helper calls that can wait: memory consolidation, reasoning-bank work | [Batch](https://platform.claude.com/docs/en/build-with-claude/batch-processing) (undated doc) |
| Tool Runner | SDK `client.beta.messages.toolRunner`, `max_iterations`; compaction via `compact_20260112` edit | Beta, SDK-side | None | Not useful: docs direct human-in-the-loop, custom logging or conditional execution to the manual loop, which machdoch already has | [Tool Runner](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-runner) (undated doc) |
| Managed Agents | `/v1/agents`, `/v1/sessions`, `/v1/environments`; events over SSE; webhooks, outcomes, multiagent, dynamic workflows (2026-10-09), scheduled deployments, memory stores, self-hosted sandboxes, session budgets (hard cap, 2026-08-07), `auto` permissions (2026-09-10) | Beta, `managed-agents-2026-04-01` (2026-04-08 `[>6mo]`); Dreams and MCP tunnels research preview; not ZDR or HIPAA eligible | Tokens at list rates plus $0.08/session-hour while `running`; no batch discount; web search $10/1k | A separate backend type, not an adapter option. Could serve machdoch cloud runs | [Managed Agents](https://platform.claude.com/docs/en/managed-agents/overview) (undated doc); [pricing](https://platform.claude.com/docs/en/about-claude/pricing); [release notes](https://platform.claude.com/docs/en/release-notes/overview) |
| Observability | OpenTelemetry export (beta, 2026-10-14); Usage and Cost Analytics API (beta, 2026-10-29) | Beta | None stated | Org-level reconciliation of machdoch's token counters | [Release notes](https://platform.claude.com/docs/en/release-notes/overview) |

**Current prices per MTok (input / 5m write / 1h write / read / output)** from [prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) and [pricing](https://platform.claude.com/docs/en/about-claude/pricing) (undated docs):
- Fable 5.1: $10 / $12.50 / $20 / $0.25 / $50.
- Opus 5.5: $4 / $5 / $8 / $0.20 / $20. Fast mode is $8 / $40 input and output.
- Sonnet 5.5: $2 / $2.50 / $4 / $0.10 / $10.
- Haiku 5.5, prompts up to 100k: $0.10 / $0.125 / $0.20 / $0.01 / $0.50.
- Haiku 5.5, prompts over 100k: $0.50 / $0.625 / $1 / $0.05 / $2.50. Prompt length counts cache reads and writes.
- Other models from Claude 4.6 onward include the 1M context at standard rates.

**Constraints that limit combinations**
- PTC does not support `strict: true` tools or `disable_parallel_tool_use: true`, and `tool_choice` cannot force programmatic calling ([PTC](https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling)). Idle containers are reclaimed after about 5 minutes, and a pending programmatic tool call times out after about 4 minutes (same source).
- `allowed_callers` is not a security boundary (same source).
- `compaction` and `context_management` cannot be on the same request, and images, documents and fetched URLs in the summarized range are lost ([on demand](https://platform.claude.com/docs/en/build-with-claude/compaction-on-demand)).
- A per-message effort level does not survive compaction, and task budget `remaining` with compaction returns 400 (same source).
- Thinking in kept turns fails the prefix check if machdoch uses its own summarizer ([compaction overview](https://platform.claude.com/docs/en/build-with-claude/compaction)).

### Inferences
- Priority order for machdoch: (1) fix `tool_choice: any` for current models, since `FINAL_RESPONSE_TOOL_NAME` in `agent-runtime.ts` is the likely reason forced tool use exists; (2) add top-level automatic caching; (3) allow parallel tool calls; (4) adopt context editing, then on-demand compaction; (5) add tool search if the MCP tool count is high.
- PTC conflicts directly with machdoch's defaults: all tools are strict and parallel use is disabled. Adopting it means a per-tool policy, and accepting that it is not ZDR eligible. It suits read-only tools, not writes.
- The default `max_tokens` of 4,096 looks risky on always-on adaptive thinking models because thinking shares that limit. Worth checking against real `max_tokens` stop rates.
- The memory tool is a schema plus a prompt convention, so its value is the built-in behaviour. machdoch's existing memory consolidation (`apps/client/src/core/memory-consolidation.ts`) could sit behind the handler. Claude Managed Agents, Skills API and Tool Runner are low priority for a product with its own loop and local tools.

### Gaps
- Whether the prompt cache survives a model switch on Anthropic: no statement found in the portions read. The `prompt-caching` page's section on this was past the portion that was read.
- machdoch's behaviour on Opus 5.5 was not tested because API calls were excluded, so the 400 is what the docs predict for the code as read.
- The threshold-compaction supported model list and the cost of Files API storage were not extracted.

## OpenAI: which server-side features would improve the agent runtime?

### Takeaway
machdoch is on the right API (Responses, including multi-agent beta), but it does not use compaction, Flex or the GPT-5.6+ cache controls. Agent Builder, Evals and reusable prompts are all shutting down on 2026-11-30, so none should be adopted; the new surface worth tracking is the Agents API, which is a replacement harness rather than an adapter feature.

### Cited Findings

**Current machdoch use (source reading)**
- Responses API with `previous_response_id`, `store`, `prompt_cache_key` built from a digest of model, system prompt and tools, `reasoning.effort`, `mode: "pro"`, `text.format` JSON schema, and `multi_agent` with the `responses_multi_agent=v1` beta (`packages/model-runtime/src/providers/openai-adapter.ts:77-133, 333-357, 424`; `packages/model-runtime/src/provider-prompt-cache.ts:19-28`).
- Sends `parallel_tool_calls: false` and defaults `tool_choice` to `required` (`openai-adapter.ts:56-65`).
- Not found in the adapter: `context_management`, `service_tier`, `prompt_cache_options`.

**Feature catalogue**

| Feature | API surface | Status | Pricing implication | What machdoch could do | Source |
|---|---|---|---|---|---|
| Server-side compaction | `context_management: [{type:"compaction", compact_threshold:200000}]` on `/responses`; encrypted compaction item in output | Launched 2026-02-10 `[>6mo]`; page has no status label | Pricing not on page. `context_management` is a setting that can affect the cached prefix | Enable on long runs; works with `previous_response_id` and `store:false` | [Compaction](https://developers.openai.com/api/docs/guides/compaction) (undated doc); [changelog](https://developers.openai.com/api/docs/changelog) |
| Standalone compaction | `POST /responses/compact`; output window passed on as-is, not pruned | Same | Pricing not on page | Compact at machdoch-chosen points such as goal boundaries | [Compaction](https://developers.openai.com/api/docs/guides/compaction) |
| Prompt caching, GPT-5.6+ | Implicit by default, or `prompt_cache_options.mode:"explicit"` with `prompt_cache_breakpoint` (up to 4 writes); `ttl` `"30m"` default or `"12h"`; `prewarm:true` | Launched with GPT-5.6 (2026-07-09); 12h added 2026-10-20 | 30m write 1.25x, 12h write 2.5x, read 0.1x (0.05x on GPT-6.1 Sol, Terra). Earlier models have no write charge. Cached tokens count toward TPM | Move off `prompt_cache_retention`. `prompt_cache_key` is now optional, for accounting only, on 5.6+ | [Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching) (undated doc); [changelog](https://developers.openai.com/api/docs/changelog) |
| Cache diagnostics | Prompt Cache Diagnostics, Caching dashboard; usage `cached_tokens`, `cache_write_tokens` | GA in Responses for GPT-5.6+ (2026-09-08) | None stated | Add `cache_write_tokens` to machdoch's usage model | [Changelog](https://developers.openai.com/api/docs/changelog) |
| Mid-run effort change | `configuration_update` input item; leave `reasoning.effort` unchanged | Available on GPT-6, standard single-agent requests only (2026-09-03) | Preserves cache prefix | Same use as Anthropic per-message effort | [Using GPT-6](https://developers.openai.com/api/docs/guides/latest-model) (undated doc); [changelog](https://developers.openai.com/api/docs/changelog) |
| Background mode | `background:true`; poll `GET /v1/responses/{id}`; resume stream with `?stream=true&starting_after=<sequence_number>`; `POST .../cancel` | Status not labelled | Data held about 10 minutes even with `store:false`. Higher time to first token | Pro-mode and long requests that outlive a connection | [Background](https://developers.openai.com/api/docs/guides/background) (undated doc) |
| Webhooks | Standard Webhooks; `response.completed`, batch and session events; `webhook-id` for idempotency | Status not labelled | None | Cloud runner only: needs a public endpoint. Retries for up to 72h | [Webhooks](https://developers.openai.com/api/docs/guides/webhooks) (undated doc) |
| Conversations | `conversations.create`; `conversation` param; not subject to the 30-day TTL | Named replacement for Assistants, shut down 2026-08-26 | Prior input is still billed as input, also with `previous_response_id` | Little value while machdoch keeps its own history | [Conversation state](https://developers.openai.com/api/docs/guides/conversation-state) (undated doc); [deprecations](https://developers.openai.com/api/docs/deprecations) |
| Flex | `service_tier:"flex"` | Beta with limited models; 429 when no capacity, not charged | Batch rates, including cached reads | Default for unattended goal runs, falling back to `auto` on 429; raise timeout to 15 minutes | [Flex](https://developers.openai.com/api/docs/guides/flex-processing) (undated doc); [pricing](https://developers.openai.com/api/docs/pricing) |
| Fast and Ultrafast | Fast replaced Priority (2026-07-30); Ultrafast for Sol and Astra (2026-09-29, 2026-10-08) | Available; projects can restrict tiers (2026-10-21) | Fast 2x standard; Ultrafast 6x on the listed models | Interactive turns only, opt-in | [Pricing](https://developers.openai.com/api/docs/pricing); [changelog](https://developers.openai.com/api/docs/changelog) |
| Programmatic tool calling | `{"type":"programmatic_tool_calling"}`; `allowed_callers: ["direct","programmatic"]`; `program`, `program_output` items | Added with GPT-5.6 (2026-07-09); page has no status label | Fresh V8 runtime, no container cost stated in search summary. ZDR possible without a persistent container | Same use as Anthropic PTC, without a remote Python container | [PTC](https://developers.openai.com/api/docs/guides/tools-programmatic-tool-calling) (undated doc); [changelog](https://developers.openai.com/api/docs/changelog) |
| Tool search | `{"type":"tool_search"}`, `defer_loading:true`, namespaces, `execution:"client"` | GPT-5.4 and later (2026-03-05 `[>6mo]`) | Discovered tools injected at end of context so cache carries over | Same as Anthropic. A running program cannot invoke tool search | [Tool search](https://developers.openai.com/api/docs/guides/tools-tool-search) (undated doc) |
| Async tools, mid-turn steering | `async:true` on a tool; steering over WebSocket | Available (2026-09-03) | None stated | Long builds run while the model continues; user corrections without restarting | [Using GPT-6](https://developers.openai.com/api/docs/guides/latest-model); [async tools](https://developers.openai.com/api/docs/guides/async-tool-calling) |
| Multi-agent | `multi_agent: {enabled, max_concurrent_subagents}`, default 3 | Beta; GPT-6.1 Sol and all GPT-5.6 | Can raise token use. Implicit per-agent compaction; `/responses/compact` not supported | Already integrated; note `/responses/compact` conflict | [Multi-agent](https://developers.openai.com/api/docs/guides/responses-multi-agent) (undated doc) |
| Shell | `type:"shell"`; `environment` `container_auto`, `container_reference` or `local`; `network_policy` allowlist | Hosted shell launched 2026-02-10 `[>6mo]`; page has no status label | Containers $0.03 (1 GB) to $1.92 (64 GB) per 20 minutes, billed by the minute, 5-minute minimum | `local` mode could replace a custom shell tool schema; hosted is for cloud | [Shell](https://developers.openai.com/api/docs/guides/tools-shell) (undated doc); [pricing](https://developers.openai.com/api/docs/pricing) |
| Apply patch | `type:"apply_patch"`; `apply_patch_call` with V4A diffs; client-executed | Page lists GPT-5.1 to 5.5 but examples use `gpt-6-astra` | Tokens only | Alternative to a custom edit tool; machdoch must own atomicity and path validation | [Apply patch](https://developers.openai.com/api/docs/guides/tools-apply-patch) (undated doc) |
| Hosted tools | Web search $10/1k plus content tokens; file search $2.50/1k plus $0.10/GB/day | Available | As listed | Only if machdoch lacks a local equivalent | [Pricing](https://developers.openai.com/api/docs/pricing) |
| Agents API | `POST /v1/agents/sessions`, `OpenAI-Beta: agents=v1`; managed Codex harness, compaction, recovery; hosted or self-hosted sandboxes; steering; computer use (2026-09-29); prewarming (2026-10-09) | Public beta (2026-09-10); US residency only; no ZDR | No separate fee: model rates, tool rates, container rates. Sandbox compute billed only during active turns (2026-10-09) | Separate backend type, closest to machdoch's Codex CLI integration | [Agents API](https://developers.openai.com/api/docs/guides/agents-api/overview) (undated doc); [changelog](https://developers.openai.com/api/docs/changelog) |
| Agents SDK | Runner, handoffs, sessions (`MemorySession`, `OpenAIConversationsSession`), input, output and tool guardrails, tracing, sandbox agents, MCP | Sandboxes added 2026-04-15 `[>6mo]`; TypeScript SDK gained sandbox agents and an open-source harness 2026-05-06 | SDK itself has no fee stated | Conceptual reference only: it would replace rather than sit under machdoch's loop | [Agents guide](https://developers.openai.com/api/docs/guides/agents) (undated doc); [JS SDK docs](https://openai.github.io/openai-agents-js/); [changelog](https://developers.openai.com/api/docs/changelog) |
| Agent Builder | Visual builder | Deprecated 2026-06-03, shutdown 2026-11-30 | n/a | Do not adopt | [Deprecations](https://developers.openai.com/api/docs/deprecations) |
| ChatKit | UI kit | "Remains available" | Not checked | Not relevant, machdoch has its own UI | [Deprecations](https://developers.openai.com/api/docs/deprecations) |
| Evals | Dashboard and API | Read-only 2026-10-31, shutdown 2026-11-30; replacement Promptfoo | n/a | Do not adopt; any existing use needs migrating now | [Deprecations](https://developers.openai.com/api/docs/deprecations) |
| Reusable prompts | `v1/prompts` | Shutdown 2026-11-30 | n/a | Keep prompts in code, as machdoch does | [Deprecations](https://developers.openai.com/api/docs/deprecations) |

**Prices per MTok (input / cached / output, standard)** from [pricing](https://developers.openai.com/api/docs/pricing) (undated doc; rates apply up to 272K input; higher above it):
- `gpt-6-astra`: $10 / $1.00 / $50. Above 272K: $20 input, $75 output.
- `gpt-6.1-sol`: $2 / $0.10 / $10; 30m write $2.50, 12h write $5.00.
- `gpt-6.1-terra`: $1 / $0.05 / $5.
- `gpt-6-sol`: $2 / $0.20 / $10.
- `gpt-6-luna`: $0.10 / $0.01 / $0.50.
- Batch and Flex are half of these for each listed model, including cached input.

### Inferences
- With GPT-5.6+, OpenAI charges for cache writes just as Anthropic does, so compaction and prefix changes now carry a real rewrite cost, which was not the case on earlier OpenAI models. Any caching logic in machdoch written for the old model should be reviewed.
- `prompt_cache_key` built from a digest of tools and system prompt is harmless but no longer does routing on GPT-5.6+. On 5.6+ machdoch could use it to account per project instead.
- Flex is the simplest large saving on the OpenAI path for goal runs. It halves every line item, including the dominant one, with a retry path to `auto`.
- `parallel_tool_calls:false` multiplies round trips. It is also listed as a cache-relevant setting, so changing it should be a one-time decision, not a per-turn toggle.

### Gaps
- Compaction pricing and how much of the prefix survives it: the guide does not state this.
- Agents SDK tracing defaults and sandbox agent details: the fetched pages returned only navigation, one page returned 404, and the [launch post](https://openai.com/index/the-next-evolution-of-the-agents-sdk/) and [Agents API FAQ](https://help.openai.com/en/articles/20001551-agents-api-beta-faq) returned 403.
- Computer use and tool search prices are not on the pricing page.
- The Decisions API (GA 2026-10-22, [changelog](https://developers.openai.com/api/docs/changelog)) was not researched. It might be relevant to goal evaluation, but that is unverified.

## Google: which server-side features would improve the agent runtime?

### Takeaway
machdoch already uses the Interactions API, statelessly, which is a sound choice but leaves implicit caching as the only cache mechanism: explicit caching is unavailable on Interactions and on Gemini 4 onward. The practical items are the 2,050-token caching rule for small tool results, the Flex tier, and the scheduled price doubling on 2026-12-01 and 2027-01-01.

### Cited Findings

**Current machdoch use (source reading)**
- `packages/model-runtime/src/providers/google-interactions.ts`: `store: false`, `background: false`, full `input` history on each call, function tools, `thinking_level`, `response_format`, signature delta handling, and `total_cached_tokens` mapped to usage (lines 37-38, 148-205, 322-326).
- No `previous_interaction_id` and no `service_tier` in the file.

**Feature catalogue**

| Feature | API surface | Status | Pricing implication | What machdoch could do | Source |
|---|---|---|---|---|---|
| Interactions API | `POST /v1beta/interactions`; `store` default true; `previous_interaction_id`; `tools`, `system_instruction`, `generation_config` per turn | GA "as of June 2026"; page updated 2026-10-15 | Retention 55 days paid, 1 day free; paid projects can choose 7, 14, 28 or 55 | Already used | [Interactions](https://ai.google.dev/gemini-api/docs/interactions); [GA post](https://blog.google/innovation-and-ai/technology/developers-tools/interactions-api-general-availability/) |
| Stateful mode | `store:true` with `previous_interaction_id`; server handles thought signatures | GA | Google says it can improve cache hit rates; earlier turns remain stored for the retention period | Option for users without privacy constraints; reduces upload size per turn | [Interactions](https://ai.google.dev/gemini-api/docs/interactions); [thinking](https://ai.google.dev/gemini-api/docs/thinking) |
| Implicit caching | Automatic on 2.5 and newer; `usage.total_cached_tokens` | Available | Argon read $0.10, 3.8 Flash $0.075. Minimum 4,096 tokens on Argon, 3.8 Flash, 3.6 Flash, 3.1 Pro. On Gemini 4+, the full previous request is cached only if the new request adds at least 2,050 tokens; otherwise the last 2,050 are reprocessed at standard rate | Keep the prefix stable; measure small-tool-result turns | [Caching](https://ai.google.dev/gemini-api/docs/caching) (undated doc); [pricing](https://ai.google.dev/gemini-api/docs/pricing) |
| Explicit caching | `generateContent` only; not on Interactions; not on Gemini 4 Argon onward | Restricted | Storage per hour: $0.50 on 3.8 Flash, $4.50 on 3.1 Pro (per MTok) | Not available on machdoch's current path | [Caching](https://ai.google.dev/gemini-api/docs/caching); [pricing](https://ai.google.dev/gemini-api/docs/pricing) |
| Thought signatures | Stateless: resend all thought blocks and built-in tool signatures unedited. On Interactions, signatures appear only on thought and built-in tool steps. Switching models: resend them | Current | Thinking billed in full as output, though only a summary is returned | Already handled; do not prune thought steps from history | [Thinking](https://ai.google.dev/gemini-api/docs/thinking) (undated doc) |
| Flex, Priority | Service tiers (2026-04-01 `[>6mo]`) | Available | Flex 50% off including cache reads; Priority 1.8x (Argon $3.60 vs $2.00 input) | Flex for unattended runs | [Changelog](https://ai.google.dev/gemini-api/docs/changelog); [pricing](https://ai.google.dev/gemini-api/docs/pricing) |
| Batch mode | `batches.create`, `batchGenerateContent`; webhooks `batch.succeeded`, `batch.failed` (2026-05-04) | "Only available with the generateContent API"; 24h target, expires at 48h | 50% off; context caching allowed | Helper calls would need a separate `generateContent` path | [Batch](https://ai.google.dev/gemini-api/docs/batch-api) (undated doc); [changelog](https://ai.google.dev/gemini-api/docs/changelog) |
| Deep Research agent | `agent:"deep-research-preview-04-2026"` or `deep-research-max-preview-04-2026`; `background:true` required; `collaborative_planning`; MCP and File Search tools | Preview (versions 2026-04-21 `[>6mo]`). `deep-research-pro-preview-12-2025` shut down 2026-10-23 | Inference at list rates including intermediate reasoning, plus tool fees | Offer as a delegated research tool, not in the main loop | [Deep research](https://ai.google.dev/gemini-api/docs/deep-research) (undated doc); [changelog](https://ai.google.dev/gemini-api/docs/changelog); [pricing](https://ai.google.dev/gemini-api/docs/pricing) |
| Managed Agents, Antigravity | `agent:"antigravity-preview-09-2026"`, `agent_config`, environments, secrets via egress proxy, allowlists | Public preview (2026-05-19); page updated 2026-10-09 | Tokens at standard rates, about 100k to 3M per interaction. Environment compute not billed during preview. Environments deleted after 7 days idle; 1,000 agent limit | Separate backend type; free compute is temporary | [Agents](https://ai.google.dev/gemini-api/docs/agents); [changelog](https://ai.google.dev/gemini-api/docs/changelog) |
| Computer Use | `computer_use` tool with `environment` browser, mobile or desktop; `safety_decision`, `safety_acknowledgement` | Preview; page updated 2026-10-22. Models: Argon, 3.8 Flash (recommended), 3.5 Flash-Lite, 3 Flash Preview | Regular token rates | Could back a browser tool; client still executes actions, must handle confirmations | [Computer Use](https://ai.google.dev/gemini-api/docs/computer-use); [pricing](https://ai.google.dev/gemini-api/docs/pricing) |
| File Search | `fileSearchStores`, `uploadToFileSearchStore`, `file_search` tool on Interactions | Available; cannot combine with Google Search or URL Context | Indexing embeddings $0.15/MTok; storage and query embeddings free; retrieved tokens at model rate | Project knowledge retrieval without local embedding infrastructure | [File Search](https://ai.google.dev/gemini-api/docs/file-search) (undated doc); [pricing](https://ai.google.dev/gemini-api/docs/pricing) |
| Built-in plus custom tools | Mixed in one request (2026-03-18 `[>6mo]`) | Available | Search $14/1k after 5,000 free per month on Gemini 3+; code execution no runtime charge | Add Google Search next to local tools | [Changelog](https://ai.google.dev/gemini-api/docs/changelog); [pricing](https://ai.google.dev/gemini-api/docs/pricing) |
| Agent Development Kit | Framework in Python, TypeScript, Go, Java, Kotlin; TypeScript 2.0 GA banner; context compression, model context caching pages; A2A | Open source; docs moved to adk.dev | No fee stated | Not relevant to machdoch's own loop, aside from A2A interop | [ADK](https://adk.dev/) (undated page) |

**Prices per MTok (input / output / cache read, standard)** from [pricing](https://ai.google.dev/gemini-api/docs/pricing) (undated doc):
- Gemini 4 Argon: $2 / $10 / $0.10, doubling to $4 / $20 / $0.20 on 2026-12-01.
- Gemini 3.8 Flash and 3.6 Flash: $0.75 / $3.75 / $0.075, doubling to $1.50 / $7.50 / $0.15 on 2027-01-01.
- Gemini 3.5 Flash-Lite: $0.30 / $2.50 / $0.03.
- Gemini 3.1 Pro Preview: $2 / $12 / $0.20 up to 200k, $4 / $18 / $0.40 above.
- Gemini 3.7 Flash has introductory pricing through 2026-12-31 ([changelog](https://ai.google.dev/gemini-api/docs/changelog), 2026-08-13).

**Other limits and changes**
- Interactions lacks Batch, automatic function calling and explicit caching, and remote MCP is not yet supported on Gemini 3 ([Interactions](https://ai.google.dev/gemini-api/docs/interactions), 2026-10-15).
- `background=true` is incompatible with `store=false` (same source).
- `generateContent` storage became on by default for new paid projects on 2026-10-26 ([changelog](https://ai.google.dev/gemini-api/docs/changelog)).
- `temperature`, `top_p` and `top_k` deprecated on 2026-07-21 (same source).

### Inferences
- The 2,050-token rule penalises agent loops that make many small tool calls on Gemini 4: each small turn reprocesses 2,050 tokens at the full input rate. At Argon's $2/MTok, that is about $0.004 per such turn, or 20 times the read price for those tokens. It is small per turn but adds up across thousands of turns. Parallel calls that bundle results would help.
- machdoch's `store:false` and stateless history is the correct privacy default, and it keeps all three adapters in the same shape. Moving to `previous_interaction_id` is optional and has no documented token price advantage beyond "can improve cache hit rates".
- Budget forecasts for Gemini goal runs should use the doubled prices.

### Gaps
- No Gemini equivalent to tool search, context editing or server-side compaction appeared in the changelog or the pages read. That is absence in what was read, not a Google statement.
- Service tier parameter name on Interactions was not extracted.
- Batch and context caching rates for Gemini 3.7 Flash and 3.5 Flash are not on the pricing page.
- machdoch sends `api_version: "v1"` (`google-interactions.ts:187`) while the guide shows a `v1beta` URL. Not verified whether this matters; the SDK may map it.

## Cross-provider: which features can sit behind one abstraction, and which should stay provider-specific?

### Takeaway
Abstract the cost and context controls (cache policy, usage accounting, compaction, effort changes, service tier, deferred tools) as capabilities with per-provider mappings. Keep thinking continuity, advisor, context editing, Skills and any provider-run harness specific.

### Cited Findings
- **Deferred tools:** Anthropic and OpenAI both use `defer_loading: true` with a search tool ([Anthropic](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool), [OpenAI](https://developers.openai.com/api/docs/guides/tools-tool-search)).
- **Programmatic calling:** both use `allowed_callers`, but runtimes differ. Anthropic runs async Python in a container and is not ZDR eligible; OpenAI runs JavaScript in a fresh V8 and supports ZDR without a persistent container ([Anthropic](https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling), [OpenAI](https://developers.openai.com/api/docs/guides/tools-programmatic-tool-calling)).
- **Compaction output:** Anthropic returns a signed, readable block that must be resent unchanged ([Anthropic](https://platform.claude.com/docs/en/build-with-claude/compaction-on-demand)). OpenAI returns an encrypted opaque item ([OpenAI](https://developers.openai.com/api/docs/guides/compaction)).
- **Effort mid-run:** Anthropic uses a `role:"system"` message with `output_config.effort` ([Anthropic](https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages)). OpenAI uses a `configuration_update` item ([OpenAI](https://developers.openai.com/api/docs/guides/latest-model)). Gemini sets `thinking_level` per request ([Interactions](https://ai.google.dev/gemini-api/docs/interactions), [thinking](https://ai.google.dev/gemini-api/docs/thinking)).
- **Usage shape differs:** Anthropic needs `usage.iterations` to count compaction and advisor tokens ([advisor](https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool), [compaction](https://platform.claude.com/docs/en/build-with-claude/compaction-on-demand)). OpenAI reports `cached_tokens` and `cache_write_tokens` ([OpenAI](https://developers.openai.com/api/docs/guides/prompt-caching)). Gemini reports `total_cached_tokens` and `total_thought_tokens` ([caching](https://ai.google.dev/gemini-api/docs/caching), [thinking](https://ai.google.dev/gemini-api/docs/thinking)).
- **Managed harnesses share the agent, environment, session and event model:** Anthropic ([overview](https://platform.claude.com/docs/en/managed-agents/overview)), OpenAI ([overview](https://developers.openai.com/api/docs/guides/agents-api/overview)), Google ([agents](https://ai.google.dev/gemini-api/docs/agents)). All three are beta or preview. Anthropic and OpenAI state no ZDR.

### Inferences

**Good candidates for one interface in `packages/model-runtime`**

| Capability | Anthropic | OpenAI | Google |
|---|---|---|---|
| `cachePolicy` (`auto`, TTL hint) | top-level `cache_control`, `ttl` | `prompt_cache_options` | no-op, implicit |
| `usage` normalization (input, cache read, cache write, output, thinking, sub-iterations) | sum `usage.iterations` | `cached_tokens`, `cache_write_tokens` | `total_cached_tokens`, `total_thought_tokens` |
| `compact(history)` returning an opaque item | on-demand `compaction` | `/responses/compact` | capability false; keep client-side summarizer |
| `autoCompactAt` | `compact_20260112` | `compact_threshold` | false |
| `setEffort` mid-run | system message | `configuration_update` | per-request `thinking_level` |
| `serviceTier` (`standard`, `flex`, `fast`) | `speed` for fast; no flex found | `service_tier` | tier setting |
| `deferredTools` | `defer_loading` | `defer_loading` | false |
| `parallelTools` | drop `disable_parallel_tool_use` | `parallel_tool_calls` | not checked |
| `batchSubmit` for helpers | Message Batches | Batch API | `generateContent` batch only |
| `cost table per model`, including threshold cliffs | Haiku 5.5 100k | 272K | 3.1 Pro 200k |

**Share the concept but keep separate policies**
- Programmatic calling: a shared `allowed_callers`-like flag per tool, but ZDR, strict-mode and runtime differences need per-provider gating.
- Background and resumable requests: OpenAI and Google have them for model calls. On Anthropic the equivalent is Batches or Managed Agents, not a Messages flag.

**Keep provider-specific**
- Thinking and reasoning continuity, including signatures, prefix checks and `input_transformations`. Adapters must keep treating history as append-only and opaque.
- Anthropic context editing, advisor tool, task budgets, `clear_at`, inline tools.
- OpenAI hosted multi-agent, `apply_patch` V4A format, WebSocket steering, async tools.
- Google Deep Research, File Search stores, Computer Use safety decisions.
- Claude Managed Agents, OpenAI Agents API and Gemini Managed Agents. These replace machdoch's loop, so they fit next to the CLI backends (`claude-cli`, `codex-cli`) as a provider type, not inside the model adapter.
- Skills APIs: the API-side runtime constraints make them poor substitutes for machdoch's local skills.

### Gaps
- Anthropic has no Flex tier in the pages read; only Batch, standard and fast were seen, plus Priority Tier mentioned on the advisor page without prices.
- Compatibility of each provider's compaction with machdoch's Langdock adapters was not examined.

## Cross-provider: which features give the largest token-cost savings for long agent runs?

### Takeaway
Cache reads are already cheap, so the 9.9M figure is likely not the largest dollar line unless output is small. Reads scale with context size times request count, so the biggest levers are making sure history is cached at all, then fewer requests (parallel tools, programmatic calling), then smaller context (tool search, clearing, compaction), then Flex on unattended runs.

### Cited Findings
- Reads as a share of input price: Opus 5.5 and Sonnet 5.5 0.05x, Fable 5.1 0.025x, others 0.1x ([Anthropic](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)). GPT-6.1 Sol and Terra 0.05x, other GPT-5.6+ 0.1x ([OpenAI](https://developers.openai.com/api/docs/guides/prompt-caching)). Argon 0.05x ([Google pricing](https://ai.google.dev/gemini-api/docs/pricing)).
- Anthropic's example of ~55k tokens of tool definitions cut by over 85% ([tool search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool)).
- Anthropic PTC results do not count toward token usage ([PTC](https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling)). OpenAI says only that PTC can reduce intermediate output in context, and recommends measuring against a baseline ([OpenAI PTC](https://developers.openai.com/api/docs/guides/tools-programmatic-tool-calling)).
- Anthropic and OpenAI writes are 1.25x for short TTL ([Anthropic](https://platform.claude.com/docs/en/build-with-claude/prompt-caching), [OpenAI](https://developers.openai.com/api/docs/guides/prompt-caching)).
- Flex is half price on OpenAI and Gemini, cached input included ([OpenAI pricing](https://developers.openai.com/api/docs/pricing), [Google pricing](https://ai.google.dev/gemini-api/docs/pricing)).
- Cheapest helper-call models: Haiku 5.5 at $0.10 / $0.50 under 100k ([Anthropic](https://platform.claude.com/docs/en/about-claude/pricing)), `gpt-6-luna` at $0.10 / $0.50 ([OpenAI](https://developers.openai.com/api/docs/pricing)), Gemini 3.5 Flash-Lite at $0.30 / $2.50 ([Google](https://ai.google.dev/gemini-api/docs/pricing)).
- machdoch routes helper calls through a configurable internal task model (`apps/client/src/core/internal-task-model.ts:23-43`), required before these AI tasks run.

### Inferences

**Cost of the reference run's 9.9M cache reads (calculation from the prices above)**

| Model | 9.9M at cache-read rate | 9.9M at uncached input rate |
|---|---|---|
| Opus 5.5 | $1.98 | $39.60 |
| Sonnet 5.5 | $0.99 | $19.80 |
| Fable 5.1 | $2.48 | $99.00 |
| Haiku 5.5, prompts under 100k | $0.10 | $0.99 |
| `gpt-6.1-sol` | $0.99 ($0.50 Flex) | $19.80 |
| `gpt-6-astra` | $9.90 | $99.00 |
| Gemini 4 Argon | $0.99 ($1.98 from 2026-12-01) | $19.80 |

**What this means**
- Token share is not dollar share. On Opus 5.5, if the other 0.3M tokens were all output, they cost $6.00 and reads are 25% of the $7.98 total. If they were all 5m writes, they cost $1.50 and reads are 57%. The split of those 0.3M tokens decides which lever matters, and it was not provided. machdoch should display cost per category, not just tokens.
- A 97% read share is unlikely on the direct Anthropic path as the code stands, because history is not cached there. The run probably used another path (a CLI backend, OpenAI or Gemini), but this cannot be confirmed from the information given.
- Reads are the sum of prefix size over requests. 9.9M could be about 99 requests at 100k average context, or about 200 at 50k. Halving either factor halves the read bill.

**Ranked levers (my judgment; estimates are illustrative, none measured on machdoch)**
1. **Cache history on the Anthropic API path.** Add top-level `cache_control`. For the same history tokens this is up to 20x cheaper on Opus 5.5, ignoring writes. Effort is one line. By far the largest effect if that path is in real use.
2. **Allow parallel tool calls.** machdoch forces serial calls on both Anthropic and OpenAI. Each extra round trip re-reads the whole prefix. If half of tool calls could pair up with another call, requests fall by about 25%; if all could, by about 50%. Reads fall by a similar share. Needs safety rules for tools that must not run concurrently.
3. **Flex for unattended runs on OpenAI and Gemini.** A flat 50% on every category, with a fallback on capacity errors. Longer latency only. No Anthropic equivalent found; Batches do not fit an interactive loop.
4. **Tool search or deferred tools (Anthropic, OpenAI).** Definitions are re-read on every request. At Anthropic's example size, 55k tokens over 99 requests is about 5.4M reads, of which 85% would go. This could be a large part of the 9.9M if many MCP tools are attached, so measure tool token counts first.
5. **Tool-result clearing and compaction.** Worth it once context is large. Worked example on Opus 5.5, shrinking 200k to 30k with a 5k summary: costs about 62.5k base-token equivalents (summary output 25k, reading old context 10k, writing new context 37.5k, minus 10k for the read no longer needed) and saves 8.5k per later request, so break-even is about 7 requests. At 0.1x read models it is about 4. Avoid repeated small clears; use `clear_at_least`. On Anthropic prefer server-side options because client edits can break thinking validity.
6. **Compact below price cliffs.** Haiku 5.5 goes up 5x above 100k for the whole request. OpenAI rates rise above 272K. Gemini 3.1 Pro rises above 200k. Make the compaction trigger model-aware.
7. **Programmatic calling for read-heavy steps.** Removes both round trips and intermediate results from context. Potentially larger than 2, but requires per-tool policy and, on Anthropic, dropping `strict` for those tools and accepting no ZDR.
8. **Route work to cheaper tiers.** Move helpers to Haiku 5.5, Luna or Flash-Lite, and use Batches for memory consolidation where latency allows. On Anthropic the advisor pattern keeps most tokens at executor rates. Note Sonnet 5.5 is half of Opus 5.5 at every rate.
9. **Avoid cache breaks.** Use per-message effort and `configuration_update`, inline tools, and stable tool order. A break costs a full rewrite at 1.25x. Use cache diagnostics to find them. For Anthropic, consider 1h TTL when tools regularly run past 5 minutes; OpenAI's 30m default rarely has this problem.
10. **Lower effort on mechanical turns.** Thinking is billed as output at 5x the input rate, so this reduces the expensive category rather than the 9.9M. May exceed the other levers in dollars if output dominates.

### Gaps
- The actual provider, model and category split of the 10.2M-token run: needed to rank levers with confidence. machdoch's own usage logs should have it.
- No provider publishes a measured saving for compaction on long agent runs in the pages read. The break-even above is arithmetic on list prices.
- Page coverage: Compaction overview, on-demand compaction, memory tool, tool search, task budgets, Managed Agents overview, Skills, fine-grained streaming and September to October Anthropic release notes were read as source text. Most other pages were read through a fetch tool's summary, and several long pages were truncated, so unlabelled status on OpenAI pages may mean the summary missed a label.
