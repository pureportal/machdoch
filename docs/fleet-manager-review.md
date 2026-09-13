# Fleet Manager review

Reviewed on 13 September 2026 using the existing Fleet Manager process at `http://127.0.0.1:43188` and Playwright with Microsoft Edge.

The startup failure came from the ignored local `apps/fleet-manager/fleet-manager.json`: `settingsManager.limits.maximumPromptsPerProfile` was missing. It now matches the checked-in example value, `128`. Configuration validation now identifies the failing file. The existing watcher recovered after the changes; no additional development server was launched.

Changes implemented:

- Coalesced queued draft saves so typing does not block Send. Draft text, submission locks, and failure recovery survive session and view changes. Commands stop dispatching while disconnected.
- Added Stop task beside the composer and a Latest message control for long conversations.
- Added instance search and status filtering, with revoked instances outside the default list. Loading, empty, and failed requests have distinct states and recovery controls.
- Replaced custom confirmation overlays with shared Radix dialogs. Fixed clipping from the chat header, focus trapping and restoration, pending dismissal, inline failure recovery, and touch target sizes. Session deletion uses the same dialog behavior.
- Fixed title/tag editing during snapshot refresh, Escape cancellation, duplicate tag submission, model-search IME handling, and rejected clipboard writes. Unchanged markdown stays mounted during polling, preserving copy feedback and scroll interactions.
- Made Activity tabs readable and keyboard navigable, corrected the dashboard navigation spacing, and simplified project and service views.
- Fixed project forms closing while submission was pending. Service project lookup can be retried, recovered polls clear stale errors, and an empty project list no longer stays in a loading state.

Playwright coverage uses 1440×960, 768×1024, 390×844, and 320×640 viewports. It checks horizontal overflow, composer/dialog bounds, keyboard focus, navigation, forms, error recovery, and screenshots.

| Area | Verification |
| --- | --- |
| Authentication and enrollment | Live server: rejected and accepted sign-in, creation and revocation of a temporary enrollment key, sign-out. |
| Instance inventory | Live offline instance inspected; controlled responses exercised filtering, empty/error recovery, and failed revocation without revoking an existing instance. |
| Chat and tasks | Running UI with intercepted host responses: send and failed-send recovery, slow draft writes, session changes, Stop task, model selection and IME, conversation scrolling, disconnection/reconnection, Activity tabs, and clipboard denial/retry. |
| Scheduler, RALPH, and media | Running UI with intercepted host responses: pause/delete/cancel/retry, required flow inputs and execution requests, generation confirmation, asset preview, loading/empty/error states, and dialog behavior. |
| Projects and services | Running UI with intercepted host responses: search, project validation and retry, clone/import forms, new/resumed tasks, service lookup retry, polling recovery, logs, and no-project state. |

Checks completed:

- `pnpm verify:fleet-review`: all four viewport runs passed with no unexpected browser errors. The final run completed sign-out and recorded `passed: true`.
- Product UI DOM suite: 114 tests passed across 9 files, including focused regressions for draft races, header editing, and markdown refreshes. Existing clipboard and IME tests also pass.
- Fleet Manager check: lint, typecheck, and 78 tests passed.
- Final Product UI check, Fleet Manager lint/typecheck, and desktop-client UI typecheck passed.
- Fleet Manager production build passed. Node emits its existing experimental SQLite warning.

Run the browser suite with `pnpm verify:fleet-review` against an already running app. It uses the local configuration and seed credentials, with optional `MACHDOCH_FLEET_UI_URL`, `MACHDOCH_FLEET_UI_USERNAME`, `MACHDOCH_FLEET_UI_PASSWORD`, and `CHROME_PATH` overrides. Screenshots and `verification.json` are written to `.machdoch/e2e/fleet-review`; credentials and browser storage state are not written to the report. The suite revokes the enrollment key it creates and signs out its own session.

The enrolled host was offline, so actual host task execution, cloning, media generation, service launches, and private previews could not be verified. Settings Manager is disabled in this setup and was inspected in code only. Testing used Edge viewport emulation, not physical mobile keyboards or Safari/Firefox. Draft retention covers the current instance console; a browser reload still depends on the last draft saved to the host.

The existing watcher restarted during earlier verification attempts. The final browser run completed with builds and source edits paused, and Fleet Manager remained healthy.

## Second iteration — 13 September 2026

The results above describe the first iteration. This review started with a healthy `/healthz`, used the existing process at `http://127.0.0.1:43188`, and reran the original Playwright suite successfully before making changes. No development server was started or host configuration changed.

Changes implemented:

- Session, message, composer, Activity, and service actions now reflect pending or disconnected state. An open model picker closes on disconnection. Failed session creation or selection keeps the session panel open and shows an inline error.
- Failed title and tag saves retain the edit through subsequent snapshots. Archived sessions now offer **Restore session**, using the host's existing archive toggle. Lifecycle coverage now includes pin/unpin, archive/restore, duplicate, branch, successful deletion, and failed session selection.
- Added expandable **Task details** in Activity with progress and keyboard-scrollable logs. Expansion survives polling. Improved Activity text sizes and wrapping, and made command errors wrap instead of truncating them.
- Activity instruction and scheduler failures now remain distinct from loading and empty states, with Retry controls. Context-pack deletion uses the shared dialog with failure recovery, pending dismissal protection, and focus restoration to Activity.
- Added account-load recovery and prevented editing an unloaded account. Account updates explain their sign-out consequence. Enrollment inventory failures no longer claim there are no keys; recovery clears the load error, and the inventory header wraps at narrow widths.
- Service commands stay successful when the following status refresh fails, preventing a saved form from inviting duplicate submission and preventing a successfully opened preview from being closed by a polling failure. Stale service controls stay disabled until status recovers. Service fields are protected during submission, and invalid JSON feedback appears beside the configuration save controls.
- Media loading and errors no longer look like empty asset/activity collections. Fixed a generation recovery dead end: the host retains asynchronous generation errors until another request, so a previous error must not disable Generate when a model is ready.

Fresh verification:

| Area | Result |
| --- | --- |
| Running application | Live health check, rejected/accepted sign-in, temporary enrollment-key creation/revocation, and sign-out passed. |
| Live availability | Enrolled host remains **offline**; its live product snapshot returns **503**. Settings Manager remains **disabled**; `/settings` returns **404** and has no navigation entry. The browser report now records these checks separately under `live`. |
| Responsive browser review | Expanded `pnpm verify:fleet-review` passed at 1440 × 960, 768 × 1024, 390 × 844, and 320 × 640. `verification.json` records `passed: true` with no unexpected browser errors. Screenshots were inspected at desktop, tablet, mobile, and narrow widths. |
| Remote console fixtures | Rechecked the original chat/task, project, scheduler, RALPH, media, and service flows. Added title/tag retry, lifecycle actions, disconnected controls, all Activity tabs, task logs/progress, nested context deletion, session memory, media generation failure/retry/cancellation, service save conflict/retry, successful save followed by failed refresh, start/restart/stop, and invalid configuration coverage. No real services or generation jobs were started. |
| Dashboard fixtures | Added delayed/failed account loading and retry, browser-session revocation failure/retry, enrollment inventory recovery, and clipboard denial/retry without changing the real owner account or revoking an existing browser session. |
| Automated checks | Product UI: **124 tests in 10 files**, lint, and typecheck passed. Fleet Manager: lint, typecheck, and **78 tests** passed. Desktop-client UI typecheck and `git diff --check` passed. |
| Production build | `pnpm build:fleet-manager` passed. The existing SQLite experimental warning remains. After the build, `/healthz` and `/login` still returned 200. |

Actual host task execution, project cloning/import, media generation, service launches, and private previews remain unverified live because the host is offline. The preview refresh fix was inspected in code; the same command/refresh handling was exercised through service fixtures. Settings Manager's enabled workflows remain code-inspected only. Tests use Microsoft Edge viewport/touch emulation, not physical mobile keyboards or Safari/Firefox. Draft retention across browser reloads still depends on the last draft saved to the host.

## Third iteration — 13 September 2026

Resumed the existing working tree after the interrupted attempts. The earlier review changes and additional unfinished chat work were preserved. `/healthz` returned 200 before browser testing; all work used the existing Fleet Manager at `http://127.0.0.1:43188`. No development server was started, host configuration changed, or existing account/session revoked.

Changes completed in this iteration:

- Preserved failed messages when a newer draft is typed during submission. **Message not sent** keeps the original text available through session/view changes, with **Add to draft** and **Discard** controls. Both actions return focus to the composer. Sending stays blocked until the failure is resolved, preventing a later failure from replacing the first unsent message.
- Added whole-message **Copy**, including the original Markdown. It works while disconnected, retains success feedback through unchanged snapshots, and handles clipboard denial without losing access to the text.
- Added **Open chat** for tasks linked to a running chat and completed **New chat** from Activity workspaces. Successful navigation closes Activity and opens Chat, including when invoked from Media Studio; rejected commands keep Activity open for retry.
- Completed keyboard-operable composer menus and separated **Provider default** reasoning from **Workspace default**. Corrected menu accessible names and removed an obsolete mobile positioning rule that clipped long menus above and beside the viewport. Expanded options now wrap before squeezing the model picker into a clipped, undersized control at 320 pixels. Menus close when remote commands become unavailable. Touch Enter inserts a newline; desktop Enter retains its send behavior. Session searches with no results offer **Clear filters**.
- Removed the console's dead Settings link when Settings Manager is disabled. The console now uses the same server availability check as dashboard navigation.
- Added service configuration conflict recovery. Polling no longer leaves an editable stale revision inviting repeated failed saves: the draft remains intact, saving is blocked, and **Reload configuration** requires confirmation before discarding edits. Failed reloads retain both the draft and dialog for retry; successful reloads restore focus to the editor and use the latest revision. The editor is now a separate component, and a running service explains why configuration saving is unavailable.

The initial browser run reproduced the unfinished menu tests' naming mismatch. Subsequent mobile inspection exposed the positioning defect. The tests now wait for keyboard focus changes and distinguish console Activity from Media Studio Activity. Enter handling checks the current pointer at keydown, with a regression for delayed responsive state; recovery actions and workspace menus also receive actual Playwright touch taps. A standalone browser probe demonstrated that full-page screenshots reset Edge's touch emulation to the machine's native pointer. Review captures now use the visible viewport, which preserves touch emulation; the phone keyboard test asserts the native coarse-pointer state. Existing title/tag editing, Restore session, deletion dialogs, task progress/logs, disconnected actions, account/enrollment recovery, media retries, and service command/refresh separation are included in the expanded review.

Fresh verification:

| Area | Result |
| --- | --- |
| Live application | Health, rejected/accepted sign-in, temporary enrollment-key creation/revocation, and sign-out passed. The enrolled host is still **offline** and its product snapshot returns **503**; opening the console and retrying were also checked live. Settings Manager is still **disabled** and `/settings` returns **404**. |
| Responsive browser review | Expanded `pnpm verify:fleet-review` passed at **1440 × 960**, **768 × 1024**, **390 × 844**, and **320 × 640**. `.machdoch/e2e/fleet-review/verification.json` records **55 result groups**, `passed: true`, and no unexpected browser errors. After the final toolbar wrapping adjustment, the affected chat workflows passed again at all four sizes, including the new model-picker touch-target assertion; `chat-verification.json` also records a pass with no browser errors. Desktop, tablet, phone, and narrow screenshots were inspected. |
| New browser coverage | Failed-message recovery/discard, touch Enter, long menus and keyboard navigation, provider-default reasoning, workspace selection, offline message copy/retry, task-to-chat navigation, workspace chat creation/retry, and disabled Settings navigation. |
| Services and previews | Added configuration conflict/reload cancellation, failure/retry, focus restoration, and saving with the latest revision. Preview fixtures exercise blocked popups, rejected launch requests, invalid launch URLs, a real browser popup surviving failed status refresh, and close failure/retry. These tests intercept the host APIs; no service or host preview is launched. |
| Automated checks | Product UI: **132 tests in 11 files**, lint, and typecheck passed. Fleet Manager: **78 tests in 14 files**, lint, and typecheck passed. Desktop-client UI typecheck passed. |
| Production build | `pnpm build:fleet-manager` passed. `/healthz` and `/login` both returned 200 afterward. Node's existing experimental SQLite warning remains. |

Live host execution, cloning/import, media generation, service launches, preview proxying, and backend routing remain unverified because the enrolled host is offline. Preview browser behavior now has fixture coverage instead of code inspection alone. Settings Manager's enabled profile, assignment, history, and secret workflows remain untested in the browser; code inspection flags initial-load recovery and profile response ordering for an enabled-mode follow-up. Testing uses Edge viewport/touch emulation, not physical keyboards or Safari/Firefox. Unsent-message recovery lasts within the current console; leaving or reloading the instance page still depends on the last draft saved to the host.

The existing watcher briefly stopped accepting HTTP during a follow-up probe and recovered on its own. No restart was requested or duplicate service launched.

## Fourth iteration — 13 September 2026

Started with a fresh 200 response from `/healthz` and reran the existing four-viewport review successfully. The enrolled host still reported offline, its product snapshot returned 503, and Settings remained disabled with `/settings` returning 404. Existing working-tree changes were preserved. No service was started, runtime configuration changed, or real Settings data written.

This iteration prioritized the previously untested Settings workflows. A Playwright probe using the actual Settings components reproduced an unsaved API-key field carrying over to another profile, an older response replacing the most recently selected profile, and an initial-load error with no retry. Code inspection also found destructive conflict recovery, unprotected pending forms, assignment races, and a default-provider context pack that could not be saved.

Implemented changes:

- Profile selection now ignores superseded responses, clears the previous editor during loading, and isolates editor state by profile. Initial and individual-profile failures have Retry controls and remain distinct from empty results.
- Added confirmed **Reload profile** after revision conflicts. Failed saves and failed reloads retain the draft; successful reloads use the latest revision and restore focus. Successful profile, secret, and history updates use the returned profile directly, avoiding a follow-up inventory failure that could invite duplicate submissions.
- Serialized profile changes and disabled profile/tab navigation during pending saves. Assignment changes also protect navigation, invalidate older reads, show the submitted selection while pending, and retain a successful assignment if the subsequent refresh fails. Stale controls remain disabled until retry or polling recovers.
- Consolidated profile, instruction, context-pack, and prompt forms into a shared Settings dialog. Fields, Cancel, Close, and Escape are protected during submission; errors appear inside the dialog. Failed saves refocus the submit button and keep the footer visible, including in long phone-sized dialogs. Removed competing field autofocus so closing returns focus to the opener.
- Fixed default-provider context packs serializing a disabled model field as the text `"null"`. The form now submits an actual null model. Prompt validation errors can be corrected without reopening the form. API-key forms support Enter submission, preserve failed values, clear successful values, and show errors beside the affected key.
- Added explicit loading/error/retry states for history and assignment lists. History requests ignore obsolete responses. Restoring and deleting profiles retain confirmation failure recovery.
- Replaced the tall profile list with a compact selector below the desktop breakpoint. Profile tabs now expose proper tab semantics, support arrow/Home/End keys, and scroll the focused tab into view. Secret rows, assignment controls, and document headers fit narrow content areas.

New verification support:

`pnpm verify:fleet-settings` compiles the production Settings components and application styles in memory, then uses Playwright interception for the document, assets, and Settings APIs on the existing origin. It does not start a server or enable Settings. The harness matches the dashboard's content widths and uses the actual server document validator for fixture mutations. Only synthetic API-key values are used. These checks are also included in `pnpm verify:fleet-review`.

The Settings browser checks cover delayed/failed loads, response ordering, cross-profile field isolation, keyboard tabs, touch activation, duplicate submission prevention, blocked pending dismissal, save/reload conflicts, create/edit/validation/retry for instructions/packs/prompts, secret save/removal, assignment/unassignment and polling recovery, revoked/empty assignment lists, history loading/restoration, and profile deletion. They assert dialog and recovery-button bounds, focus, and page overflow. Screenshots were inspected at desktop, tablet, phone, and 320-pixel widths. Reports distinguish this component/API fixture coverage from live checks; report files are reset at startup to avoid retaining an earlier pass after a blocked run.

Fresh verification:

| Area | Result |
| --- | --- |
| Live application | Health, rejected/accepted sign-in, temporary enrollment-key creation/revocation, sign-out, and the offline console's Retry path passed in both the initial and final full reviews. The final live checks still recorded an offline host (snapshot 503) and disabled Settings (page 404). |
| Full browser review | After the production build, the expanded `pnpm verify:fleet-review` passed all four viewport runs with source edits paused. `verification.json` records 59 result groups, `passed: true`, and no unexpected browser errors. Coverage includes failed-message recovery/copy, task-to-chat navigation, service configuration and preview recovery, mobile composer menus, session actions, Activity, projects, scheduler, RALPH, media, dashboard forms, and Settings. Remote and Settings responses were intercepted. |
| Settings browser coverage | Expanded `pnpm verify:fleet-settings` passed at 1440 × 960, 768 × 1024, 390 × 844, and 320 × 640 with no unexpected browser errors. These are production-component fixtures, not live enabled Settings checks. |
| Automated checks | Fleet Manager: 78 tests passed. Product UI: 132 DOM tests, lint, and typecheck passed. Desktop-client UI typecheck, Fleet Manager lint, and `git diff --check` passed. |
| Production build | `pnpm build:fleet-manager` passed, including TypeScript checking. `/healthz` and `/login` returned 200 after the final browser review. Node's existing experimental SQLite warning remains. |

One follow-up Settings run stopped at its initial health request with `ECONNREFUSED`. The existing managed process subsequently logged that it was listening again, and `/healthz` returned 200. Workspace status reported the same managed Fleet Manager parent process with healthy status and no recorded supervisor restart. The underlying worker restart trigger was not established; no restart was requested.

Remaining limitations: the offline host prevents live task execution, cloning/import, media generation, services, preview proxying, and host routing checks. Settings' enabled page, encryption-key configuration, and end-to-end delivery remain unverified on the running installation; its browser components now have fixture coverage, and existing API tests exercise an isolated enabled test runtime. Viewport/touch emulation does not verify physical mobile keyboards or Safari/Firefox. Unsent chat recovery still lasts within the current console, and Settings edits still need saving before changing profiles/tabs or leaving the page.
