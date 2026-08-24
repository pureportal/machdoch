# AI assistant token-efficiency implementation report

Reviewed: 24 August 2026  
Implementation base: `fe9f82d` on `main`  
Scope: OpenAI, Anthropic, Google, Langdock, Codex CLI, Claude CLI, Copilot CLI, auxiliary inference, agent loops, retries, context, memory, MCP sampling, streaming, and completion.

## Outcome

Machdoch now removes two exact prompt duplications, deliberately reuses provider prompt caches, requires structured terminal results from every CLI agent, and records task-wide model usage across primary and auxiliary calls. The implementation does not lower models, reasoning effort, tool availability, history quality, memory behavior, validation, output limits, or retry policy.

The largest remaining source of logical input is still the complete tool catalog. Removing it would have the highest raw-token impact, but no provider-neutral lazy-discovery design was implemented because equivalent task success and latency have not yet been established across all seven integrations.

## Current evidence

### Stable prefixes and caching

- OpenAI recommends putting stable content first, dynamic content last, using a consistent `prompt_cache_key`, and monitoring `cached_tokens`. Exact prefix continuity also keeps an agent loop from repeatedly reprocessing its growing transcript. [OpenAI model guidance](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.5), [OpenAI Codex agent-loop analysis](https://openai.com/index/unrolling-the-codex-agent-loop/)
- The current Responses API exposes `prompt_cache_key`, cached-input tokens, and cache-write tokens. GPT-5.6 guidance notes that writes can carry a premium while reads remain discounted. [OpenAI Responses API](https://developers.openai.com/api/reference/typescript/resources/responses/methods/create), [GPT-5.6 model guidance](https://developers.openai.com/api/docs/guides/latest-model)
- Anthropic hashes the prefix in `tools` → `system` → `messages` order. A cache breakpoint on the system prompt therefore includes the preceding tool definitions. Requests below a model's minimum cacheable length still succeed without caching. [Anthropic tool caching](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-use-with-prompt-caching), [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- Gemini implicit caching is enabled by default on Gemini 2.5 and newer models. Google recommends putting large common content first, and the current JavaScript SDK exposes GenerateContent cache, reasoning, and tool-use counts in `UsageMetadata`. [Gemini context caching](https://ai.google.dev/gemini-api/docs/caching), [Google GenAI `UsageMetadata`](https://googleapis.github.io/js-genai/release_docs/interfaces/types.UsageMetadata.html)

### Tool and transcript pressure

- Anthropic recommends tool search for large catalogs, prompt caching for stable schemas, programmatic tool calling for bounded chains, and context editing for stale results. It explicitly notes that prompt caching reduces repeated processing cost, not logical context size. [Anthropic tool-context guidance](https://platform.claude.com/docs/en/agents-and-tools/tool-use/manage-tool-context)
- OpenAI similarly recommends deferred discovery and bounded tool output to control context bloat, while preserving append-only exact prefixes for caching. [OpenAI GPT-5.6 efficiency analysis](https://openai.com/index/gpt-5-6-frontier-intelligence-efficiency/)

### Streaming, structured completion, and usage

- Langdock's official custom-model contract sends `stream_options.include_usage` and expects usage statistics in the final OpenAI-compatible stream chunk. [Langdock custom-model example](https://github.com/Langdock/custom-model-example)
- Codex `exec --json` emits `item.completed`, `turn.completed`, `turn.failed`, and fatal `error` events. Its terminal usage includes input, cached input, cache-write input, output, and reasoning fields when the installed CLI exposes them. [Codex event schema](https://github.com/openai/codex/blob/main/sdk/typescript/src/events.ts), [Codex thread collector](https://github.com/openai/codex/blob/main/sdk/typescript/src/thread.ts)
- Claude Code documents `stream-json --verbose`, a terminal `result`, aggregate usage and turn metadata, and `system/api_retry` events. [Claude Code headless mode](https://code.claude.com/docs/en/headless)
- Copilot CLI documents JSONL output plus run-scoped OpenTelemetry. A `chat` span represents one provider inference and carries input, output, cache-read, and cache-creation token metadata. Content capture is off by default. [Copilot CLI reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference)

### Retry behavior

- The OpenAI and Anthropic TypeScript SDKs retry eligible failures twice by default. Those retries remain enabled because reducing the established recovery budget could reduce reliability. Machdoch now observes the SDK's actual HTTP attempts through its supported custom-fetch boundary instead of changing the policy. [OpenAI SDK configuration](https://github.com/openai/openai-node/blob/main/docs/configuration.md), [Anthropic SDK client options](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/client.ts)
- The pinned Google SDK only enters its internal retry loop when `retryOptions` is configured. Machdoch does not configure it, so its existing centralized request policy remains the only Gemini retry layer. [Google GenAI SDK request options](https://googleapis.github.io/js-genai/release_docs/interfaces/types.HttpOptions.html), [Google GenAI SDK request implementation](https://github.com/googleapis/js-genai/blob/main/src/_api_client.ts)

## Ranked safe reductions

| Rank | Change | Expected impact | Trade-off |
| ---: | --- | --- | --- |
| 1 | Cache stable tool and instruction prefixes | The recorded 77,402-character tool catalog is roughly 19,350 tokens at four characters per token. Most of that stable prefix can become a cache read on subsequent eligible turns. | Logical context tokens remain unchanged. First writes can cost more, cache hits depend on provider/model thresholds and TTLs. |
| 2 | Remove duplicate CLI conversation context | 4,680 characters removed from the recorded long-history CLI fixture: 46.0% of its external prompt, approximately 1,170 input tokens. | None; byte-identical conversation content remains once. |
| 3 | Collapse identical original/effective task fields | 4,036 characters saved per prompt for a 4,000-character unchanged task; approximately 2,018 tokens across one executor and one validator request. | Transformed tasks still retain both values, so prompt-resolution semantics remain intact. |
| 4 | Require structured CLI terminal results | Avoids treating preambles as final answers and avoids losing a valid terminal answer when a provider process keeps descendants or inherited streams alive. Potentially prevents a complete executor rerun. | Older CLI binaries without the documented structured mode are now rejected before launch. |
| 5 | Count every inference and retry | No direct token reduction, but auxiliary calls, SDK retries, CLI turns, cache activity, and unavailable fields can now be optimized without undercounting. | Small local metadata and serialization overhead; no extra model call. |

## Implementation

### Unified cache policy

Provider capability profiles now declare one of four cache modes:

- OpenAI: automatic caching with a deterministic key derived from model, system prompt, and tool schemas.
- Anthropic: an ephemeral breakpoint on the stable system prompt; by Anthropic's documented prefix order this also caches the tool catalog.
- Google: native implicit caching with stable request ordering.
- Langdock and CLI agents: provider-managed behavior; Machdoch does not inject unsupported native cache controls through a gateway or CLI.

Cache reads, cache writes, reasoning tokens, and Gemini tool-use prompt tokens are normalized separately. `cachedInputTokens` remains the cache-read value instead of combining writes and reads.

### Context construction

- External-agent prompts use the canonical prepared conversation block once. The redundant reconstruction from the same sections was removed.
- Executor and validator prompts use one `<current_task>` element when prompt resolution did not change the task. They retain `<original_task>` and `<effective_task>` when the values differ.
- No history, memory, attachment, instruction, workspace, UI-control, or run context was removed.

### Completion protocol

- Codex requires `--json` and completes only on `turn.completed`; `turn.failed` and `error` are failures.
- Claude requires `--output-format stream-json --verbose`, reconstructs top-level assistant fragments by message ID, and completes only on the terminal `result`. A missing or truncated result body does not discard a more complete assistant event.
- Copilot keeps JSONL output and completes only on the terminal `result` event.
- The previous raw non-empty-stdout completion path was removed. Structured completion can safely trigger the existing process-tree shutdown recovery after a valid terminal result.

### End-to-end usage ledger

One task-scoped recorder now covers:

- conversation summarization;
- every initial and continued executor turn;
- every validator pass;
- MCP sampling;
- memory consolidation;
- external CLI agents.

Each task report includes stage, provider, model, API/CLI path, logical model-call count, provider-request count, retry count, failures, input/output/cache/reasoning/tool-use tokens, request and response bytes, tool-definition and tool-result bytes, and aggregate model-call duration. Raw provider usage bodies are not persisted.

If an aborted auxiliary call is still settling when the task returns, the ledger records it as failed with unavailable usage and retry telemetry instead of silently omitting a potentially billable call. A late completion cannot mutate the already returned report.

The report distinguishes exact values from lower bounds:

- Codex's public terminal event provides aggregate usage but not its internal inference count or retry count, so those count fields are marked unavailable.
- Claude reports `num_turns`, usage, and retry events.
- Copilot uses a run-scoped metadata-only OTel file. Machdoch sums the `chat` spans and deletes the file with the run enrollment. Prompt, response, and tool-content capture is explicitly disabled.
- OpenAI and Anthropic SDK retries remain enabled. A custom fetch observer counts every actual HTTP attempt without logging URLs, headers, prompt content, or credentials.

Ralph block and final performance reports use the complete task ledger instead of reconstructing only visible primary calls from progress events.

## Representative measurements

Character-to-token values below are estimates at four characters per token. Provider tokenization varies.

### Prompt reductions

| Workload | Before | After | Change | Calls / retries / output |
| --- | ---: | ---: | ---: | --- |
| Recorded long-history external-agent prompt | 10,179 characters, ~2,545 input tokens | 5,499 characters, ~1,375 input tokens | −4,680 characters / −46.0%, ~1,170 tokens | One model call in both; no retry or output change |
| 4,000-character unchanged task in one prompt | 8,065 characters, ~2,016 input tokens | 4,029 characters, ~1,007 input tokens | −4,036 characters / −50.0%, ~1,009 tokens | No behavior change |
| Same task across executor + validator | 16,130 characters, ~4,033 input tokens | 8,058 characters, ~2,015 input tokens | −8,072 characters, ~2,018 tokens | Two model calls in both; no retry or output change |

### Complete-usage replay

A deterministic representative API task contains conversation summary, executor, validator, memory consolidation, and one executor retry. This comparison measures observability, not an increase in consumption.

| Metric | Earlier visible timeline | Complete task ledger |
| --- | ---: | ---: |
| Input tokens | 1,220 | 1,480 |
| Output tokens | 150 | 185 |
| Total tokens | 1,370 | 1,665 |
| Logical model calls | 2 | 4 |
| Provider requests | 2 visible; completeness unknown | 5 |
| Retries | unavailable | 1 |
| Aggregate modeled latency | 58 ms | 80 ms |
| Serialized request payload | 120,000 bytes | 123,400 bytes |

The 260 input tokens, 35 output tokens, two model calls, 22 ms, and 3,400 bytes added by the complete ledger were already consumed by summarization and memory consolidation; they were previously absent from task totals.

### Tool-prefix caching

The earlier representative executor request contained 77,402 characters of tool definitions, about 75% of its 102,660-character initial payload. The schemas remain fully available to the model. On eligible repeated turns, the new cache policy can convert most of this stable prefix from uncached processing to cache reads. A live cache-hit count was not measured because verification intentionally made no billed provider calls.

## Integration coverage

| Integration | Path | Completion | Usage and retry accounting | Cache handling |
| --- | --- | --- | --- | --- |
| OpenAI | API | Responses terminal response | Stream/non-stream usage; SDK HTTP attempts observed | Deterministic cache key, automatic prefix cache |
| Anthropic | API | Messages terminal message | Stream/non-stream usage; SDK HTTP attempts observed | Explicit stable-prefix breakpoint |
| Google | API | GenerateContent terminal response | `usageMetadata`; centralized attempts | Native implicit cache |
| Langdock | API | OpenAI, Anthropic, or Gemini route | Streaming usage requested; route-appropriate usage; observable retries | Gateway/provider managed |
| Codex | CLI | `turn.completed` only | Aggregate usage; unavailable internal counts marked | CLI/provider managed |
| Claude | CLI | terminal `result` only | Usage, `num_turns`, `system/api_retry` | CLI/provider managed |
| Copilot | CLI | terminal `result` only | Metadata-only OTel `chat` spans; unavailable retries marked | CLI/provider managed |

## Not implemented

| Proposal | Reason |
| --- | --- |
| Lazy tool discovery | It can remove most initial schema tokens, but adds a discovery turn and can miss a needed capability. Equivalent quality and latency across every provider have not been demonstrated. |
| Tool-result truncation or artifact substitution | Existing results can contain evidence needed later. No safe relevance rule can prove that discarded content will not affect task success. |
| Incremental summary-of-summary | It saves repeated summary calls, but repeated abstraction can accumulate omissions and drift. |
| Removing or weakening the validator | It would save a full model call and prompt, but directly reduces completion reliability. |
| Reducing SDK or CLI retry budgets | Fewer retries can lower token use during outages but can also reduce recovery reliability. Existing provider policies were retained and made observable. |
| Lower models, reasoning, output limits, or tool access | Prohibited by the quality and capability requirements. |
| Anthropic context editing | It deletes prior tool results under provider-specific rules. Cross-provider semantic equivalence has not been established. |
| Gemini explicit cache objects | They introduce TTL, storage, privacy, and lifecycle behavior. Native implicit caching preserves current semantics. |
| Claude `--bare` | It disables hooks, skills, plugins, and MCP-related behavior. |
| Provider-managed conversation state or compaction | It changes replay, storage, ZDR, and reasoning-item semantics. A provider-neutral quality evaluation is required first. |

## Verification

The final focused business-logic runs passed:

- 170 tests across the task usage ledger, cache policy, executor and validator prompt construction, all four API adapter paths, provider usage normalization and retry handling, MCP client sampling, all three structured CLI decoders, Copilot OTel parsing, external-agent execution, and provider capability probing;
- 112 Ralph execution and performance-report tests.

The broad non-UI command `pnpm --dir apps/client exec vitest run src/core src/cli src/shared --reporter=default` completed 2,074 assertions and one existing skip before one worker error. Four sharded reruns passed 2,073 assertions and one skip across every runnable test file. The only unexecuted file was `src/core/provider-enrollment/sync-daemon.spec.ts` (six tests): importing it deterministically aborts the Node worker on this Windows host in libuv `src\win\fs-event.c:72`. The same failure occurs when that file runs alone and before its tests start; it is unrelated to the changed modules.

The following checks passed after the final edits:

- `pnpm --dir apps/client run check`;
- `pnpm --dir apps/client run typecheck`, including core, UI static types, test types, and logic-test types;
- `pnpm --dir apps/client run build`;
- `pnpm --dir apps/client run build:cli-bundle`;
- `pnpm --dir apps/client run build:ui` (4,743 modules);
- `cargo check --manifest-path apps/client/src-tauri/Cargo.toml`.

Request-shape, streaming, tool, reasoning, completion, and usage tests cover OpenAI, Anthropic, Google, Langdock, Codex CLI, Claude CLI, and Copilot CLI. API and CLI integration behavior was verified at deterministic non-UI boundaries, not through billed provider acceptance calls.

No UI test was created or run. No dev server was started. No live model request was made, so billed cache hits, live CLI telemetry, real retries, and provider latency remain unverified.
