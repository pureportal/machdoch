# machdoch.cloud — Linear parity goals

Paste one goal at a time into machdoch goal mode, in order (W1 → W9). Start the next goal only when the previous one is complete.

- Each goal is under the 4,000-character limit (`MAX_GOAL_OBJECTIVE_CHARS`).
- Each goal points to `docs/machdoch-cloud/linear-parity.md` for detail.
- Each requirement can be checked by the evaluator within its 5-minute window: targeted tests, not a full suite.
- Each goal starts with a time and turn budget (`--minutes`, `--turns`): 3 h / 150 turns, or 6 h / 300 turns for W4 and W5. Change them as you like; add `--cost <USD>` for a spending cap.

## W1 — settings area (workspace / personal / team) (2533 chars)

````text
/goal --minutes 180 --turns 150 machdoch.cloud Linear parity W1: settings area (workspace / personal / team)

Repo: apps/cloud. Spec: docs/machdoch-cloud/linear-parity.md, section W1.

Today: /cloud/settings is one page (components/cloud/settings.tsx: members and invitations). Other settings live on separate routes: /cloud/account, /cloud/connections, /cloud/providers, /cloud/execution, plus SSO, roles, branding and Mimorii components.

Done when:
1. /cloud/settings/<section> has its own left navigation, a "Back to app" link, and a search box that matches section names and keywords (e.g. "2FA" finds Security & access).
2. Navigation groups: Personal (Preferences, Profile, Notifications, Code & reviews, Security & access, Connected accounts, Agent personalization); Issues (Labels, Workflow states, SLAs, Templates); Projects (Labels, Statuses, Updates); Features (AI & agents, Execution, Loops, Initiatives, Customer requests, Releases, Pulse, Integrations); Administration (Members, Roles, Invitations, SSO, Branding, Mimorii); Your teams (team tree; each team has workflow, cycles, estimates, triage, members). Sections not built yet show an empty state, not a 404.
3. Every existing settings surface is reachable in the shell. /cloud/account, /cloud/connections, /cloud/providers, /cloud/execution and the old /cloud/settings redirect to their new sections.
4. Navigation is filtered by role. Sections a role may see but not change are read-only.
5. Personal settings are stored per user, workspace settings per organization, team settings per team. A test proves user A's personal change does not affect user B.

Rules: First read the spec section and the files under "Today". Extend them; do not build parallel versions. Old routes, URLs and saved data must keep working. Schema changes: new src/server/cloud/migrations/NNN-*.sql, update schema.sql, add a migration test. Authorize reads before filtering, counting or ranking. Writes use the acting user's permissions, and agent-proposed changes still need confirmation. Use the existing cloud shell styling; no new UI library. Do not start other workstreams.
Proof: every numbered requirement has a vitest test. Mark it in the spec's Status table as "done (test: <file>)", or as "blocked (<reason>)" if it truly cannot be done. These must pass: pnpm --filter @machdoch/cloud lint, pnpm --filter @machdoch/cloud typecheck, vitest run on the touched test files, and pnpm --filter @machdoch/cloud build. Commit to branch machdoch/linear-w1-settings once all checks pass.
````

## W2 — issue filters and views (2713 chars)

````text
/goal --minutes 180 --turns 150 machdoch.cloud Linear parity W2: issue filters and views

Repo: apps/cloud. Spec: docs/machdoch-cloud/linear-parity.md, section W2.

Today: lib/issue-filter-model.ts has 12 fields, each condition "is" or "is not" over a list of values; estimate filter is only none/set. lib/cloud-view-contract.ts: a view is name + URL filters + shared. UI: issue-filters.tsx, issue-filter-fields.tsx, issue-display-menu.tsx, save-view-dialog.tsx, saved-view-list.tsx.

Done when:
1. Operators by field type: is / is not / is any of / is none of; for labels: include any of / include all of / do not include; is empty / is not empty; dates: before / after / within last N days; cycle: current / upcoming / previous. Old URLs and saved views still load.
2. New fields: blocked, blocking, has parent, has sub-issues, duplicate, exact estimate values, agent delegate, initiative, milestone, team, created by agent or loop.
3. AND at top level, optional OR groups, all encoded in the URL.
4. Views have description, icon and scope (personal / team / workspace).
5. Inline view editing from the list header: name, description and filter chips are editable, with Save / Cancel in the header.
6. Teams can pin views as tabs next to Active / Backlog / All issues.
7. Group headers show the issue count and the sum of estimates.
8. Natural-language filter: a model only proposes chips the user can edit. Running the filter never calls a model.
9. Fixture test: the "Can Be Picked" view (labels do not include To Be Polished; estimate is not one of two values; cycle is current or upcoming; not blocked; labels include any of four labels; no assignee; status is one of two) returns exactly the expected issues.
10. A test proves private-team issues never leak through filters, counts or estimate sums.

Rules: First read the spec section and the files under "Today". Extend them; do not build parallel versions. Old routes, URLs and saved data must keep working. Schema changes: new src/server/cloud/migrations/NNN-*.sql, update schema.sql, add a migration test. Authorize reads before filtering, counting or ranking. Writes use the acting user's permissions, and agent-proposed changes still need confirmation. Use the existing cloud shell styling; no new UI library. Do not start other workstreams.
Proof: every numbered requirement has a vitest test. Mark it in the spec's Status table as "done (test: <file>)", or as "blocked (<reason>)" if it truly cannot be done. These must pass: pnpm --filter @machdoch/cloud lint, pnpm --filter @machdoch/cloud typecheck, vitest run on the touched test files, and pnpm --filter @machdoch/cloud build. Commit to branch machdoch/linear-w2-filters once all checks pass.
````

## W3 — agent everywhere (2760 chars)

````text
/goal --minutes 180 --turns 150 machdoch.cloud Linear parity W3: agent everywhere

Repo: apps/cloud. Spec: docs/machdoch-cloud/linear-parity.md, section W3.

Today: a global AgentPanel is mounted in cloud-shell.tsx. agent-conversation.tsx attaches issue, project, cycle and team page context. agent-context-picker.tsx adds more. Confirmation cards exist. Execution admission lives in server/cloud/execution.

Done when:
1. New context kinds: pull request, saved view (with its filter), release, loop, document, repository. Each is attached automatically on its own page and can be removed.
2. A status-bar session tray lists running and recent agent sessions, and any can be reopened from any page. Sessions keep running when the panel is closed or the user navigates away.
3. The transcript shows a collapsible "Worked for X" trace with tool steps. Results show as entity links.
4. "Run this on…" hands the session off to a cloud sandbox profile, a specific client, a runner pool or automatic placement, with a chosen harness (machdoch, Codex CLI, Claude Code, Copilot) and model. It goes through the existing admission, streams the remote run, and produces a machdoch/… branch without touching the client's working tree.
5. The PR page has "Fix failing checks". It reads the check logs, pushes a commit to the PR branch, and explains the cause in the transcript.
6. @agent in issue comments and in GitHub PR comments starts a session. The transcript shows "<user> relayed by machdoch".
7. Settings → Personal → Agent personalization stores instructions, default harness, model and placement, personal MCP connectors and allowed repositories. Workspace and team instructions are under Features → AI & agents. Personal instructions apply only to that user's sessions (tested).
8. Agent-proposed issue edits are never applied without confirmation (tested).

Rules: First read the spec section and the files under "Today". Extend them; do not build parallel versions. Old routes, URLs and saved data must keep working. Schema changes: new src/server/cloud/migrations/NNN-*.sql, update schema.sql, add a migration test. Authorize reads before filtering, counting or ranking. Writes use the acting user's permissions, and agent-proposed changes still need confirmation. Use the existing cloud shell styling; no new UI library. Do not start other workstreams.
Proof: every numbered requirement has a vitest test. Mark it in the spec's Status table as "done (test: <file>)", or as "blocked (<reason>)" if it truly cannot be done. These must pass: pnpm --filter @machdoch/cloud lint, pnpm --filter @machdoch/cloud typecheck, vitest run on the touched test files, and pnpm --filter @machdoch/cloud build. Commit to branch machdoch/linear-w3-agent once all checks pass.
````

## W4 — Loops: one page, one model (2939 chars)

````text
/goal --minutes 360 --turns 300 machdoch.cloud Linear parity W4: Loops: one page, one model

Repo: apps/cloud. Spec: docs/machdoch-cloud/linear-parity.md, section W4.

Today: Automations (lib/cloud-automation-contract.ts, server/cloud/automation/*: triggers issue/PR/schedule/git/release/automation-finished/webhook/manual; actions list; chain limit) and Schedules (/cloud/schedules, lib/cloud-schedule-contract.ts: create-issue, run-task) are two separate pages and models.

Done when:
1. /cloud/loops is the single page. /cloud/automations and /cloud/schedules redirect to it. Every existing automation and schedule is migrated to a loop and behaves the same; a migration test compares before and after.
2. The list has My loops / All, grouping by team (nested teams as "Software Engineering › AlphaNET Cloud", "+" per team), and columns: name and description, trigger, executor, owner, runs (30d), success rate, cost (30d), last run, next run. It has a Disabled badge, search, and filters reusing the W2 filter model.
3. Loops are versioned: each edit creates a revision, and each run records the revision it used.
4. New triggers: issue entered triage, project or cycle events, email intake, Sentry alert, Grafana alert, Teams/Slack message, client event (file watch, device online).
5. Settings → Features → Loops lists trusted trigger sources (webhook, email, GitHub, GitLab, Sentry, Grafana, Teams, Slack). Each can be turned on or off, shows "trusted by N loops", and has a rotatable secret. Events from untrusted or disabled sources are rejected and the reason is recorded (tested).
6. Workspace loop settings: loops on or off with a usage and cost meter; "Allow loops to access code" for all or selected repositories (enforced, tested); default executor; budget caps; run-history retention.
7. Run detail shows trigger payload, resolved context, revision, transcript, tool evidence, outputs with links, cost and tokens. Replay re-runs the same input. Dry-run runs against a recorded event without side effects (tested).

Rules: First read the spec section and the files under "Today". Extend them; do not build parallel versions. Old routes, URLs and saved data must keep working. Schema changes: new src/server/cloud/migrations/NNN-*.sql, update schema.sql, add a migration test. Authorize reads before filtering, counting or ranking. Writes use the acting user's permissions, and agent-proposed changes still need confirmation. Use the existing cloud shell styling; no new UI library. Do not start other workstreams.
Proof: every numbered requirement has a vitest test. Mark it in the spec's Status table as "done (test: <file>)", or as "blocked (<reason>)" if it truly cannot be done. These must pass: pnpm --filter @machdoch/cloud lint, pnpm --filter @machdoch/cloud typecheck, vitest run on the touched test files, and pnpm --filter @machdoch/cloud build. Commit to branch machdoch/linear-w4-loops-core once all checks pass.
````

## W5 — Loops: richer bodies, executors and templates (3173 chars)

````text
/goal --minutes 360 --turns 300 machdoch.cloud Linear parity W5: Loops: richer bodies, executors and templates

Repo: apps/cloud. Spec: docs/machdoch-cloud/linear-parity.md, section W5.

Today: after W4, loops are one model with triggers, conditions and the old action list. RALPH flows and goal mode (worker + evaluator) exist in apps/client. Cloud sandbox profiles, runner pools and linked clients exist in server/cloud/execution.

Done when:
1. Context sources: a saved view or filter (W2), all active projects of a team, documents, repositories (limited by the W4 code-access setting), the trigger payload, and earlier run outputs.
2. Loop memory: key/value state kept between runs. It can be viewed and edited on the loop page and is passed to the next run (tested).
3. Bodies: prompt; RALPH flow (a human-input step creates an Inbox item and waits); goal (worker + evaluator with success criteria); fan-out (one sub-run per item with a concurrency limit).
4. Executor per loop: cloud sandbox profile, a specific client, a runner pool, or automatic by required capability. Plus harness (machdoch, Codex CLI, Claude Code, Copilot) and model. Unavailable capabilities are rejected before the run starts.
5. Typed outputs, all previewed in dry-run: create or update issues, comments, labels or status; append a section to a document; post a project update; open a PR; write release notes; notify Teams, Slack or email; call a webhook.
6. Guardrails (tested): budget per run and per month, reserved before dispatch; maximum duration; overlap policy; missed-run policy; chain depth (A→B→A blocked); approval gate before consequential outputs; kill switch; auto-pause after N failures in a row.
7. Templates start disabled; installing one asks for scope and executor: monthly project updates; refresh project descriptions; agentic bug resolving (triage + Sentry, fix attempt in sandbox, comment with questions); quarterly team report appended to a document; monthly security & API check report; Grafana alert reconciliation; maintain changelog (release trigger); role detail, role overview and technical architecture documents. Each passes a dry-run against fixtures.
8. A verify script runs one template end to end in a cloud sandbox and one on a linked client.

Rules: First read the spec section and the files under "Today". Extend them; do not build parallel versions. Old routes, URLs and saved data must keep working. Schema changes: new src/server/cloud/migrations/NNN-*.sql, update schema.sql, add a migration test. Authorize reads before filtering, counting or ranking. Writes use the acting user's permissions, and agent-proposed changes still need confirmation. Use the existing cloud shell styling; no new UI library. Do not start other workstreams.
Proof: every numbered requirement has a vitest test. Mark it in the spec's Status table as "done (test: <file>)", or as "blocked (<reason>)" if it truly cannot be done. These must pass: pnpm --filter @machdoch/cloud lint, pnpm --filter @machdoch/cloud typecheck, vitest run on the touched test files, and pnpm --filter @machdoch/cloud build. Commit to branch machdoch/linear-w5-loops-bodies once all checks pass.
````

## W6 — release pipelines (2472 chars)

````text
/goal --minutes 180 --turns 150 machdoch.cloud Linear parity W6: release pipelines

Repo: apps/cloud. Spec: docs/machdoch-cloud/linear-parity.md, section W6.

Today: Releases are launch posts only (lib/cloud-release-contract.ts, server/cloud/releases: products, brands, channels, posts, media). There is no deployment tracking. Keep all of it.

Done when:
1. A pipeline has a name, teams, a repository plus path filter (monorepos, per-Lambda services), a type (continuous or scheduled), environments (staging → production), and a source: GitHub deployment, workflow run, tag, or a generic CI/CDK webhook with a secret.
2. A release has a version, environment, time and commit range. Issues are attached automatically from PRs merged and commits linked in that range, and can be added or removed by hand. Deployment evidence is linked.
3. Issues get a "Released in" property, which is filterable through the W2 filter model. A team policy can complete an issue when it is deployed.
4. The release page shows generated internal and external notes and a "Create launch post" button that opens the existing Release Studio with those issues.
5. The list has a name filter, Active/Archived, and columns: teams, type, environment, release count, latest release. There is no pipeline limit.
6. Release events (released, failed, rolled back) are loop triggers.
7. Fixture test: in a monorepo with three path-filtered pipelines, each merged PR is attached only to the pipelines whose paths it touched.
8. Duplicate deployment events never create duplicate releases (tested).

Rules: First read the spec section and the files under "Today". Extend them; do not build parallel versions. Old routes, URLs and saved data must keep working. Schema changes: new src/server/cloud/migrations/NNN-*.sql, update schema.sql, add a migration test. Authorize reads before filtering, counting or ranking. Writes use the acting user's permissions, and agent-proposed changes still need confirmation. Use the existing cloud shell styling; no new UI library. Do not start other workstreams.
Proof: every numbered requirement has a vitest test. Mark it in the spec's Status table as "done (test: <file>)", or as "blocked (<reason>)" if it truly cannot be done. These must pass: pnpm --filter @machdoch/cloud lint, pnpm --filter @machdoch/cloud typecheck, vitest run on the touched test files, and pnpm --filter @machdoch/cloud build. Commit to branch machdoch/linear-w6-releases once all checks pass.
````

## W7 — GitHub/GitLab for the workspace and for each person (2679 chars)

````text
/goal --minutes 180 --turns 150 machdoch.cloud Linear parity W7: GitHub/GitLab for the workspace and for each person

Repo: apps/cloud. Spec: docs/machdoch-cloud/linear-parity.md, section W7.

Today: one org connection per provider (token, automate flag, OAuth app, webhook, repositories), per-team status rules (git-status-rules.tsx), and personal accounts (GitAccount, git-accounts.tsx). Types are in lib/cloud-git-contract.ts; server code in server/cloud/git.

Done when:
1. Settings → Features → Integrations → GitHub/GitLab lists several connections (orgs or installations). Each shows who enabled it and when, whether code access is on, and a status menu with reconnect and disconnect.
2. Reviews & commits toggles, each changing behaviour (tested with recorded webhook fixtures): generate review guides; auto-link or create an issue on merge (off = only suggest); link commits via magic words "Fixes CLOUD-123" and "Part of CLOUD-123", with webhook health shown.
3. Two-way issue sync per repository: status, labels, assignee and comments are mapped to a team. It stays idempotent when webhooks are redelivered (tested).
4. Comments in GitHub: back-links to issues, reviews and agent sessions, with separate toggles for private repos, public repos, and including the issue description.
5. Settings → Personal → Connected accounts: GitHub and GitLab (attribution, reviews posted as the user), Slack, Teams, Google or Outlook calendar out-of-office (feeds triage rotation and assignee suggestions), and personal MCP connectors.
6. Attribution: with a personal account, act as the user. Without one, act as the workspace connection and show "<user> via machdoch". If a personal account is disconnected, loops fall back to the workspace connection and do not fail (tested).

Rules: First read the spec section and the files under "Today". Extend them; do not build parallel versions. Old routes, URLs and saved data must keep working. Schema changes: new src/server/cloud/migrations/NNN-*.sql, update schema.sql, add a migration test. Authorize reads before filtering, counting or ranking. Writes use the acting user's permissions, and agent-proposed changes still need confirmation. Use the existing cloud shell styling; no new UI library. Do not start other workstreams.
Proof: every numbered requirement has a vitest test. Mark it in the spec's Status table as "done (test: <file>)", or as "blocked (<reason>)" if it truly cannot be done. These must pass: pnpm --filter @machdoch/cloud lint, pnpm --filter @machdoch/cloud typecheck, vitest run on the touched test files, and pnpm --filter @machdoch/cloud build. Commit to branch machdoch/linear-w7-git once all checks pass.
````

## W8 — code review page (2029 chars)

````text
/goal --minutes 180 --turns 150 machdoch.cloud Linear parity W8: code review page

Repo: apps/cloud. Spec: docs/machdoch-cloud/linear-parity.md, section W8.

Today: components/cloud/pull-request-page.tsx with overview, files, timeline, stack, actions and composer; reviews in lib/pull-request-reviews.ts.

Done when:
1. The PR page has tabs Overview / Guide / Diff. The Guide is an AI review guide that groups related changes into sections, each with its purpose and impact. It is cached per head commit and only generated when the W7 "generate review guides" toggle is on.
2. The header shows status, reviewers (human, Copilot, machdoch agent), a checks summary, the issues the PR resolves, and its position in the stack.
3. An Auto merge toggle merges only after required checks and CODEOWNERS reviews pass, and respects the merge queue (tested with fixtures).
4. "Fix failing checks" and "Address review comments" start agent sessions (reusing W3) that push to the PR branch and post what they changed.
5. The guide for a fixture PR is generated once per head commit and is reused when the page is opened again (tested).

Rules: First read the spec section and the files under "Today". Extend them; do not build parallel versions. Old routes, URLs and saved data must keep working. Schema changes: new src/server/cloud/migrations/NNN-*.sql, update schema.sql, add a migration test. Authorize reads before filtering, counting or ranking. Writes use the acting user's permissions, and agent-proposed changes still need confirmation. Use the existing cloud shell styling; no new UI library. Do not start other workstreams.
Proof: every numbered requirement has a vitest test. Mark it in the spec's Status table as "done (test: <file>)", or as "blocked (<reason>)" if it truly cannot be done. These must pass: pnpm --filter @machdoch/cloud lint, pnpm --filter @machdoch/cloud typecheck, vitest run on the touched test files, and pnpm --filter @machdoch/cloud build. Commit to branch machdoch/linear-w8-review once all checks pass.
````

## W9 — SLAs, project updates, customer requests, notifications (1904 chars)

````text
/goal --minutes 180 --turns 150 machdoch.cloud Linear parity W9: SLAs, project updates, customer requests, notifications

Repo: apps/cloud. Spec: docs/machdoch-cloud/linear-parity.md, section W9.

Today: triage (server/cloud/triage.ts), project updates (server/cloud/project-updates.ts), notifications (server/cloud/notifications.ts), inbox (components/cloud/inbox.tsx).

Done when:
1. SLAs can be set per priority and label. Lists show the time left, and breaches create Inbox items and a filterable SLA state.
2. Projects have custom statuses, an update cadence with reminders, and an AI-drafted update that the owner reviews before posting.
3. Customer requests and Asks: email, Teams/Slack and webhook intake create triage items. Requests link to customers, are deduplicated, and each issue shows its request count.
4. Notification preferences per event and channel (in-app, email, Teams/Slack, mobile), with snooze and quiet hours. Permissions are checked again when a notification is delivered.

Rules: First read the spec section and the files under "Today". Extend them; do not build parallel versions. Old routes, URLs and saved data must keep working. Schema changes: new src/server/cloud/migrations/NNN-*.sql, update schema.sql, add a migration test. Authorize reads before filtering, counting or ranking. Writes use the acting user's permissions, and agent-proposed changes still need confirmation. Use the existing cloud shell styling; no new UI library. Do not start other workstreams.
Proof: every numbered requirement has a vitest test. Mark it in the spec's Status table as "done (test: <file>)", or as "blocked (<reason>)" if it truly cannot be done. These must pass: pnpm --filter @machdoch/cloud lint, pnpm --filter @machdoch/cloud typecheck, vitest run on the touched test files, and pnpm --filter @machdoch/cloud build. Commit to branch machdoch/linear-w9-rest once all checks pass.
````
