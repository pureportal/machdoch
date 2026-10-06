# Fleet parity audit — 2026-10-06

The shared interface and palette requirements have working evidence. The complete goal remains open: the remote transcript and session controls do not yet expose every native client interaction, and physical device workflows have not been exercised.

## Integration

- The client, Fleet dashboard, and device view compose `ApplicationShell`, `ApplicationNavigation`, and the client theme tokens from `packages/product-ui`.
- Both composers use the canonical `AgentComposer`, `ComposerSurface`, `ComposerInput`, attachments, queue, and iteration controls. The adaptive context and compute picker and its command definitions now live in `packages/client-ui` and are used by both views.
- The remote context-pack menu now uses the complete native picker. Full documents come from the native shell store through the scoped workspace operation; mutations use native commands. It supports save/edit, variables, triggers, overrides, deletion, browser export/import, and RALPH usage lookup. The superseded apply-only composer menu was removed.
- Remote context-pack loading cancels stale responses when the session/workspace changes. It preserves the actual browser draft, refreshes authoritative documents after mutations, validates imports, and releases uploaded archives on failure.
- Browser uploads are imported into durable native attachment storage before their temporary transfer grants are released. File preview and search use the canonical client preview.
- The composer's Media Library and Create in Media Studio controls now open the same embedded Media view. A checked origin/source, readiness handshake, request identity, and acknowledgment preserve the draft across loading and navigation.
- Shared command stores now support server rendering. Server rendering has no focused document element; command focus represents that state explicitly.
- The shared mobile composer places actions below a full-width input. Screenshot review found the previous layout squeezed the input despite passing horizontal-overflow checks.
- Headless hosts explicitly reject native context-pack mutations and the native adaptive session control without recording a successful command. The native message projection exposes Save context only for user messages, matching its handler.

## Requirement evidence

| Requirement | Evidence | Limit |
| --- | --- | --- |
| Similar client and Fleet interface | Shared frame/navigation, composer surface/input/queue, complete Instructions/Scheduler, embedded native Workspace Manager/Settings/Media/RALPH; desktop/mobile screenshots | Transcript and session sidebars still have separate implementations |
| Shared components and centralized logic | Shared packages own reusable views; scoped transports delegate to canonical native handlers rather than replacing their persistence logic | Advanced composer control composition and transcript interaction controllers are not fully shared |
| Same color scheme | Computed client/Fleet palette equality, shared theme tokens, native appearance saves reflected in Fleet, desktop/mobile review | Browser and device appearance are separate preferences; users can intentionally select different values |
| All client features in the remote view | Coverage below | Not complete |

## Feature coverage

| Client area | Remote evidence | Remaining work or verification |
| --- | --- | --- |
| Instructions | Same editor/controller, native CRUD, large Unicode, stale revisions, unknown roots, browser draft retention; earlier authenticated headless campaign | Complete native/browser campaign already recorded |
| Scheduler | Same complete form/job/run views; native assignment/create/list/pause/resume/delete | Native campaign did not trigger a scheduled job |
| Workspace Manager | All six native panels; files/conflicts, Git, configuration, memory, MCP, processes and PTYs passed native API/browser checks | Headless Workspace relay is absent |
| Native run previews | Private HTTP and WebSocket tunnels, binary transfer, request isolation, restart/disconnect revocation passed earlier native campaign | Production preview DNS/cookie/popup routing needs verification |
| Settings | Same 14-section dialog; answer language/appearance saves, microphone enumeration, encrypted browser download/upload/review/import; mobile and draft preservation passed over TLS | Physical audio, LAN peer pairing, autostart and asset migration remain untested |
| Composer attachments | Browser upload, exact Unicode/CRLF bytes after grant release, rejected ungranted imports, shared preview/search passed with real native handlers | Image clipboard, directory selection, media-asset drop and every attachment kind need live coverage |
| Composer queue | Native queue edit/move/reorder, attachment add/remove/clear, removal, iteration groups/order restrictions and cancellation passed | Failed-message retry, live steering and stop-and-send need live coverage |
| Context packs | Real native creation/edit/application with variables, full Unicode documents, browser export, shared picker desktop/mobile passed; controller tests cover stale loading and failed import cleanup | Native browser picker import and RALPH usage lookup need an end-to-end check; headless editor transport is absent |
| Adaptive session control | Shared picker, strict TypeScript/Rust command and snapshot cases, session targeting and replay tests passed | Final executable/browser check follows the native rebuild; headless control is absent |
| Media handoff | Shared native generation form displayed the exact browser draft; parent handoff tests cover source/origin/readiness/acknowledgment | Final browser round trip and mobile input width check follows the production rebuild |
| Media/RALPH execution | Shared embedded views; earlier RALPH edit/run/input/resume/cancel and outage/restart campaign | Real GPU/media/audio generation and paid provider execution are unverified |
| Conversation | Shared Markdown, projected execution activity, copy/retry/continue/speech/context actions | Native message editing, original-prompt view, file-link/attachment opening, richer activity interactions and all transcript commands are not fully exposed |
| Session/keyboard interactions | Lifecycle/model/workspace/reasoning/memory/goal controls and shared composer commands | Audit remaining native shortcuts, prompt-history navigation, Quick Chat/Quick Voice and session sidebar interactions |

## Verification

Current commands passed: client core/UI type checks, shared client/product UI type checks, CLI and client UI production builds, embedded Fleet features and Next production build, 461 TypeScript protocol tests, 46 Rust protocol tests, and 44 native Fleet tests. Focused shared composer/context-pack tests passed 65 cases; seven native toolbar/headless regressions passed. Command-provider server rendering and focus tests passed after testing with `document` absent. Focused lint passed with compiler checking performed separately; the default lint invocation reports pre-existing CSS declaration diagnostics for the Fleet browser entry.

Real native checks use an isolated profile/workspace, authenticated production Fleet fixture over TLS, and a controlled loopback provider. No development server was started and no paid provider request was made.

Evidence directory: `.tmp/fleet-native-verification/com.machdoch.fleetverification.r1791257513352/`.

- `context-packs-result.json` — 13:32 UTC: native documents, variables, edits, browser export, computed palette equality, desktop/mobile picker.
- `composer-result.json` — 13:38 UTC: durable upload/preview, actual native provider adapter, queue/iteration controls and cancellation.
- `settings-browser-result.json` — 13:42 UTC: 14-section dialog, native settings/appearance, encrypted browser transfer and mobile draft preservation.
- Earlier native evidence: `instructions-result.json`, `scheduler-result.json`, `workspace-api-result.json`, `workspace-browser-result.json`, `workspace-configuration-result.json`, `workspace-runs-result.json`, `terminal-isolation-result.json`, `native-previews-result.json`, and voice results.

The remote draft and message projection is bounded to 8,000 UTF-16 units. Full context-pack documents are larger. This audit verifies full document storage/export and applies a smaller pack for the draft check; it does not establish lossless remote editing of an oversized native draft.

Physical audio, a second LAN peer, production preview routing, physical Android behavior and real generation workloads require further environment/device evidence. These limits do not turn the remaining implementation gaps into a completed goal.
