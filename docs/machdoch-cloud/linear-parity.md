# machdoch.cloud — Linear parity spec

Reference spec for the `/goal` prompts in `linear-parity-goals.md`. Each workstream (W1–W9) lists:

- **Today:** what the code already has, so you extend it and don't rebuild it
- **Build:** what to add, with requirement IDs the goals refer to
- **Proof:** where each requirement must be tested

Reference product: Linear (workspace *Alphartis SE*, team *Software Engineering › AlphaNET Cloud*).
Product rules from `product.md`, `automation.md` and `execution.md` still apply.

## Rules for all workstreams

- Extend the files listed under *Today*. Do not create a second filter model, view store, automation engine or settings page.
- Old routes keep working, either by redirecting or by rendering the new page.
- Schema changes go in a new `src/server/cloud/migrations/NNN-<name>.sql` and in `schema.sql`, with a migration test.
- All reads are authorized before filtering, ranking or counting. Writes run with the acting user's permissions. Agent-proposed changes still need confirmation.
- Use the existing cloud shell styling: compact rows, muted metadata, keyboard first. No new UI library.
- Status table at the bottom of this file: every requirement ID is marked `done (test: <file>)`, `partial`, `blocked (<reason>)` or `not started`. A claim without a test is not done.
- Checks per workstream:
  - `pnpm --filter @machdoch/cloud lint`
  - `pnpm --filter @machdoch/cloud typecheck`
  - `pnpm --filter @machdoch/cloud exec vitest run <touched tests>`
  - `pnpm --filter @machdoch/cloud build`

---

## W1 — Settings area (workspace / personal / team)

**Today:** `/cloud/settings` is one page (`components/cloud/settings.tsx`, members and invitations). The rest is scattered across separate routes: `account`, `connections`, `providers`, `execution`, plus SSO, roles, branding and Mimorii components.

**Build:**

- **W1-1** A settings shell under `/cloud/settings/<section>`. It has its own left navigation, a "Back to app" link, and a search box that matches section names and keywords.
- **W1-2** Groups and sections:
  - **Personal:** Preferences · Profile · Notifications · Code & reviews · Security & access · Connected accounts · Agent personalization
  - **Issues:** Labels · Workflow states · SLAs · Templates
  - **Projects:** Labels · Statuses · Updates
  - **Features:** AI & agents · Execution · Loops · Initiatives · Customer requests · Releases · Pulse · Integrations
  - **Administration:** Members · Roles · Invitations · SSO · Branding · Mimorii
  - **Your teams:** a tree of teams, each with workflow, cycles, estimates, triage and members
- **W1-3** Every existing settings surface appears in the shell. The old routes (`/cloud/account`, `/cloud/connections`, `/cloud/providers`, `/cloud/execution`, `/cloud/settings`) redirect to their new section.
- **W1-4** The navigation is filtered by role. Sections a role can see but not change are read-only.
- **W1-5** Personal settings are stored per user, workspace settings per organization, and team settings per team. A test shows that one user's personal change does not affect another user.

**Proof:**
- A settings route and navigation test (search, role filtering, redirects)
- A settings-scope test on the server

## W2 — Issue filters and views

**Today:**
- `lib/issue-filter-model.ts`: fields status, assignee, creator, priority, label, project, cycle, estimate (`none`/`set` only), due, created, updated, pullRequest; each condition is either "is" or "is not" over a list of values.
- `lib/cloud-view-contract.ts`: a saved view is a name, the filters as URL keys, and a `shared` flag.
- UI: `issue-filters.tsx`, `issue-filter-fields.tsx`, `issue-display-menu.tsx`, `save-view-dialog.tsx`, `saved-view-list.tsx`.

**Build:**

- **W2-1** Operators by field type:
  - *is / is not / is any of / is none of*
  - for multi-value fields such as labels: *include any of / include all of / do not include*
  - *is empty / is not empty*
  - for dates: *before / after / within last N days*
  - for cycles: *current / upcoming / previous*

  Old URLs and saved views keep loading. Migrate them or read the old format.
- **W2-2** New fields:
  - relations: *blocked, blocking, has parent, has sub-issues, duplicate*
  - exact estimate values
  - agent delegate
  - initiative
  - milestone
  - team
  - created by agent or loop
  - released in (W6)
  - SLA state (W9)
- **W2-3** Filter groups: AND at the top level, with optional OR groups. Encoded in the URL.
- **W2-4** Views gain a description, an icon, and a scope (personal / team / workspace).
- **W2-5** Views can be edited inline from the list header. The view name, description and filter chips are editable, and **Save / Cancel** sit in the header, like Linear's view edit bar.
- **W2-6** A team can pin views as tabs next to Active / Backlog / All issues.
- **W2-7** Group headers show the issue count and the sum of estimates.
- **W2-8** Natural-language filter: a model only proposes chips, which the user edits. The filter itself never calls a model.
- **W2-9** Acceptance fixture: Linear's "Can Be Picked" view can be rebuilt exactly and returns the expected issues. Its conditions:
  - labels do not include *To Be Polished*
  - estimate is not one of two values
  - cycle is any of current or upcoming
  - issue is not blocked
  - labels include any of four labels
  - no assignee
  - status is any of two statuses
- **W2-10** Server-side filtering and counting are authorized. A test shows that issues from a private team never leak through filters, counts or sums.

**Proof:**
- `issue-filter-model.test.ts`
- `cloud-view-contract.test.ts`
- `saved-views` server tests
- the "Can Be Picked" fixture test

## W3 — Agent everywhere

**Today:**
- A global `AgentPanel` is mounted in `cloud-shell.tsx`.
- Page context is attached automatically for issue, project, cycle and team (`agent-conversation.tsx`).
- `agent-context-picker.tsx` lets users add more context.
- Confirmation cards exist.

**Build:**

- **W3-1** More context kinds: pull request, saved view (with its filter), release, loop, document and repository. Each is attached automatically on its own page and can be removed.
- **W3-2** A session tray in the status bar lists running and recent agent sessions, and any of them can be reopened from any page. A session keeps running when the panel is closed or the user navigates away.
- **W3-3** The transcript has a collapsible "Worked for X" trace with tool steps. Results show as entity links.
- **W3-4** Hand-off: "Run this on…" picks where the work runs and which harness and model it uses.
  - Where: a cloud sandbox profile, a specific client device, a runner pool, or automatic.
  - Harness: machdoch, Codex CLI, Claude Code or Copilot.

  This reuses the existing execution admission. The session then streams the remote run, and the run produces a `machdoch/…` branch.
- **W3-5** The PR page has "Fix failing checks". It starts a session that reads the check logs, pushes a commit to the PR branch and explains the cause.
- **W3-6** Entry points: @agent in issue comments and in GitHub PR comments. The transcript shows "*user* relayed by machdoch".
- **W3-7** Agent personalization in personal settings:
  - instructions
  - default harness, model and placement
  - personal MCP connectors
  - allowed repositories

  Workspace and team instructions live under Features → AI & agents. Personal instructions apply only to the user's own sessions.

**Proof:** component tests for context and tray persistence, a server test for hand-off admission, and a fixture test for fix-checks.

## W4 — Loops, part 1: one surface, one model

**Today:**
- **Automations** (`lib/cloud-automation-contract.ts`, `server/cloud/automation/*`):
  - triggers: issue events, PR changed, schedule, git events, release created, automation finished, webhook, manual
  - action list: set fields, comment, create issue, ask agent, delegate, prepare release, write release posts, start client session, git actions, write project updates, run or toggle an automation, send a webhook
  - a chain limit
- **Schedules** live on a separate page (`/cloud/schedules`, `lib/cloud-schedule-contract.ts`; actions: create-issue, run-task) and have their own recurrence worker.

**Build:**

- **W4-1** A single **Loops** page at `/cloud/loops`. `/cloud/automations` and `/cloud/schedules` redirect to it. Existing automations and schedules are migrated into loops and behave the same; a migration test proves it.
- **W4-2** The list:
  - toggle between *My loops* and *All*
  - grouped by team, with nested teams shown as `Software Engineering › AlphaNET Cloud` and a "+" for each team
  - columns: name and description · trigger · executor · owner · runs (30 days) · success rate · cost (30 days) · last run · next run
  - a *Disabled* badge, search, and filters (reusing W2)
- **W4-3** A loop is versioned. Every edit creates a revision, and each run records the revision it used.
- **W4-4** New triggers: issue entered triage · project or cycle events · email intake · Sentry or Grafana alert · Teams/Slack message · client event (file watch, device online).
- **W4-5** Trusted trigger sources under Settings → Features → Loops:
  - one entry each for webhook, email intake, GitHub, GitLab, Sentry, Grafana, Teams and Slack
  - each can be turned on or off, shows "trusted by N loops", and has its own rotatable secret
  - a loop can only use sources that are on
  - an event from an untrusted source is rejected and the reason is recorded
- **W4-6** Workspace loop settings:
  - loops on or off, with a usage and cost meter
  - "Allow loops to access code": all repositories or selected ones
  - default executor
  - budget caps
  - how long run history is kept
- **W4-7** Run detail:
  - trigger payload, resolved context and revision
  - transcript and tool evidence
  - outputs with links
  - cost and tokens
  - **Replay** (same input) and **Dry-run** against a recorded event

**Proof:** loop migration test, trusted-source tests, list query test, and a dry-run test.

## W5 — Loops, part 2: richer bodies and templates

**Build (on top of W4):**

- **W5-1** Context sources: a view or filter (W2), all active projects of a team, documents, repositories (scoped by W4-6), the trigger payload, and earlier run outputs.
- **W5-2** **Loop memory:** a small key/value state kept between runs (for example a cursor or the previous summary). It can be viewed and edited on the loop page.
- **W5-3** Bodies:
  - **Prompt**
  - **RALPH flow:** a human-input step creates an Inbox item and waits
  - **Goal:** a worker plus an evaluator with success criteria
  - **Fan-out:** one sub-run per item, with a concurrency limit
- **W5-4** Executors: cloud sandbox profile · specific client device · runner pool · automatic by required capability. Plus harness (machdoch / Codex / Claude Code / Copilot) and model.
- **W5-5** Typed outputs, previewed in dry-run:
  - create or update issues, comments, labels or status
  - **append a section to a document**
  - post a project update
  - open a PR
  - write release notes
  - notify Teams, Slack or email
  - call a webhook
- **W5-6** Guardrails:
  - budget per run and per month
  - maximum duration
  - what happens when runs overlap
  - what happens to missed runs
  - chain depth (blocks A→B→A loops)
  - an approval gate before consequential outputs
  - a kill switch
  - auto-pause after N failures in a row
- **W5-7** Templates. All start disabled; installing one asks for scope and executor. They mirror the reference workspace's real loops:
  - monthly project updates for active projects
  - refresh project descriptions from a template and team members
  - agentic bug resolving (triage trigger, Sentry context, fix attempt in a sandbox, comment with questions)
  - quarterly team report appended to a document
  - monthly security & API check appended as a findings report
  - Grafana alert reconciliation (pair resolved alerts with their firing issues)
  - maintain changelog (release trigger, internal and external notes, customer update draft)
  - role detail, role overview and technical architecture documents for active projects
- **W5-8** End-to-end runs: one template runs in a cloud sandbox and one on a linked client. Both are covered by a verify script.

## W6 — Release pipelines (what shipped where)

**Today:** Releases are launch posts: products, brands, channels, posts and media (`lib/cloud-release-contract.ts`, `server/cloud/releases`). There is no deployment tracking. Keep all of it.

**Build:**

- **W6-1** A pipeline has:
  - a name and one or more teams
  - a repository plus a **path filter** (for monorepos and per-Lambda services)
  - a type: continuous or scheduled
  - environments (staging → production)
  - a source: GitHub deployment, workflow run, tag, or a generic CI/CDK webhook with a secret
- **W6-2** A release has a version, environment, time and commit range. Issues are **included automatically** from PRs merged and commits linked in that range, and can be added or removed by hand. Deployment evidence is linked.
- **W6-3** Issues get a "Released in" property, which can be filtered (W2-2). A team policy can complete an issue when it is deployed.
- **W6-4** The release page shows generated internal and external notes and a "Create launch post" button that opens the existing Release Studio.
- **W6-5** The list:
  - filter by name, plus Active/Archived
  - columns: teams · type · environment · release count · latest release
  - no limit on the number of pipelines
- **W6-6** Release events (released, failed, rolled back) are available as loop triggers.
- **W6-7** Fixture test: in a monorepo with three path-filtered pipelines, each merged PR is attached only to the pipelines whose paths it touched. Duplicate deployment events do not create duplicate releases.

## W7 — GitHub/GitLab integration: workspace and personal

**Today:**
- An org connection with a token, `automate`, OAuth app, a webhook and repositories.
- Per-team status rules (`git-status-rules.tsx`).
- Personal accounts (`GitAccount`, `git-accounts.tsx`).

**Build:**

- **W7-1** The workspace integration page lists several connections (orgs or installations). Each shows who enabled it and when, whether code access is on, and a status menu with reconnect and disconnect.
- **W7-2** Reviews & commits toggles:
  - generate review guides
  - automatically link or create an issue on merge (when off, only suggest)
  - link commits via magic words (`Fixes CLOUD-123`, `Part of CLOUD-123`), with webhook health shown
- **W7-3** Two-way issue sync per repository: status, labels, assignee and comments are mapped to a team. It stays idempotent when webhooks are delivered again.
- **W7-4** Comments in GitHub: back-links to issues, reviews and agent sessions. Separate toggles for private repos, public repos, and including the issue description.
- **W7-5** Settings → Personal → Connected accounts:
  - GitHub and GitLab, for attribution and for reviews posted as the user
  - Slack and Teams
  - Google or Outlook calendar out-of-office, which feeds triage rotation and assignee suggestions
  - personal MCP connectors (shared with W3-7)
- **W7-6** Attribution: when a personal account exists, act as the user. Otherwise act as the workspace connection and show "*user* via machdoch". If a personal account is disconnected, loops fall back to the workspace connection and do not fail.

## W8 — Code review page

**Today:** `pull-request-page.tsx` with overview, files, timeline, stack, actions and composer.

**Build:**

- **W8-1** Tabs: Overview / **Guide** / Diff. The Guide is an AI review guide that groups related changes into sections, each with its purpose and impact. It is cached per head commit and only generated when W7-2 is on.
- **W8-2** The header shows status, reviewers (human, Copilot, machdoch agent), a checks summary, the issues the PR resolves, and its position in the stack.
- **W8-3** An **Auto merge** toggle. It merges only after required checks and CODEOWNERS reviews pass, and respects the merge queue.
- **W8-4** "Fix failing checks" (W3-5) and "Address review comments" start agent sessions.

## W9 — Remaining Linear features

- **W9-1** SLAs per priority and label, with breach warnings in lists and in the Inbox.
- **W9-2** Project statuses and updates: custom statuses, an update cadence, reminders, and AI-drafted updates (a loop template).
- **W9-3** Customer requests and Asks: intake from email, Teams/Slack and webhooks into triage. Requests link to customers, deduplicate, and show a count on each issue.
- **W9-4** Notification preferences per event and per channel (in-app, email, Teams/Slack, mobile), with snooze and quiet hours.

---

## Status

| ID | Status | Proof |
| --- | --- | --- |
| W1-1 … W9-4 | not started | — |
