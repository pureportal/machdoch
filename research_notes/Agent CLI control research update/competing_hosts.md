# Competing agent hosts and orchestrators (as of 2026-10-30)

Evidence tags: **(P)** I opened the primary page. **(S)** seen only in a search result summary, page not opened; treat details as weaker, and open the URL before quoting because the summaries did not always tie a claim to one specific link. **(A)** anecdotal user comment. **[>6 mo]** source is older than 2026-04-30. Star counts come from GitHub repo pages fetched 2026-10-30 because the `gh` API lookup hung; those pages did not show commit dates, so repo activity is not verified by commit date. Fit judgements about machdoch rest on the brief, not on reading its code.

## Which hosts matter now, and which exist and are active?

### Takeaway
The market has consolidated around first-party or well-funded hosts: Claude Code desktop/web, the Codex app, Cursor, GitHub/VS Code, Devin Desktop and Conductor. Standalone open-source orchestrators have thinned out: Vibe Kanban's company closed, Crystal is deprecated, and Omnara looks quiet.

### Cited Findings

| Product | Status | Latest dated evidence |
|---|---|---|
| Conductor | Very active. Near-weekly releases, $22m Series A per site banner; macOS only per third parties (S) | 0.92.0 on 2026-10-23 — [changelog](https://www.conductor.build/changelog) (P); [docs banner](https://www.conductor.build/docs/reference/diff-viewer) (S); [Mac-only guide](https://codepick.dev/en/guides/conductor-build-intro/) (S) |
| Claude Code desktop/web | Active; scheduled tasks are still research preview | Bundled Claude Code 2.1.308 in Conductor 0.92, 2026-10-23 — [Conductor](https://www.conductor.build/changelog/0.92.0-remote-control) (P); [scheduled tasks docs](https://code.claude.com/docs/en/routines) (P, undated) |
| Codex app/CLI/mobile | Very active | CLI 0.166.0 on 2026-10-29, iOS entry on 2026-10-22 — [changelog](https://learn.chatgpt.com/docs/changelog) (P) |
| Cursor | Very active | Agent SDK on 2026-10-20 — [changelog](https://cursor.com/changelog) (P) |
| GitHub Agent HQ / VS Code Agents window | Active. Claude and Codex agents were public preview in Feb [>6 mo]; I found no GA notice | [VS Code September roundup, 2026-10-01](https://github.blog/changelog/2026-10-01-github-copilot-in-vs-code-september-2026-releases) (P); [metrics API, 2026-08-07](https://github.blog/changelog/2026-08-07-copilot-usage-metrics-api-adds-agent-app-activity/) (P); [Feb preview](https://github.blog/changelog/2026-02-04-claude-and-codex-are-now-available-in-public-preview-on-github/) (S) |
| Devin / Windsurf | Windsurf was relaunched as Devin Desktop on 2026-06-02 (S). Devin ships several notes a week | [Release notes to 2026-10-28](https://docs.devin.ai/release-notes/overview) (P); [rebrand](https://runtimewire.com/article/cognition-turns-windsurf-into-devin-desktop-a-command-center-for-coding-agents) (S) |
| Factory | Active. $150M Series C at $1.5B [>6 mo]; v0.245.0 on 2026-10-20 per an unofficial tracker | [Sacra](https://sacra.com/research/factory) (S); [tracker](https://www.havoptic.com/tools/factory-droid) (S) |
| JetBrains Air / Junie | Active. Air public preview March [>6 mo]; in-IDE EAP October. Blog returned 403 to my fetch | [EAP post](https://blog.jetbrains.com/ai/2026/10/air-in-ides-eap/) (S); [preview post](https://blog.jetbrains.com/air/2026/03/air-launches-as-public-preview-a-new-wave-of-dev-tooling-built-on-26-years-of-experience/) (S) |
| Zed agent panel | Active as of my latest source. 1.0 on 2026-04-29 [>6 mo, by a day]; Terminal Threads 2026-05-20 | [Terminal Threads](https://zed.dev/blog/terminal-threads) (S); [parallel agents docs](https://zed.dev/docs/ai/parallel-agents) (S) |
| Warp / Oz | Active as of May; no newer dated entry retrieved. Oz launched February [>6 mo]; multi-harness in May via a secondary summary | [launch](https://warp.dev/newsroom/2026/2/10/warp-launches-oz-the-orchestration-platform-for-cloud-coding-agents) (S); [plushcap May summary](https://www.plushcap.com/companies/warp/blog/summaries/2026/5) (S); [OpenAI story, 2026-05-27](https://openai.com/index/warp) (S) |
| Google Antigravity | Exists. 2.0 launched at I/O in May with a rocky rollout. No official Sept/Oct changelog found; Wikipedia (undated) says the IDE last shipped in August while desktop and CLI keep updating | [Wikipedia](https://en.wikipedia.org/wiki/Google_Antigravity) (S); [forum thread](https://discuss.ai.google.dev/t/antigravity-2-0-2-changelog/146835) (S) |
| Happy | Open source, MIT, 24.4k stars. Adds multi-harness and multiplayer sessions | [repo](https://github.com/slopus/happy) (P) |
| Omnara | Exists but possibly quiet: a third-party listing shows the last app update on 2026-03-06 [>6 mo]; 4.3 rating from 18 ratings | [listing snapshot](https://apppricinglab.com/app/apple/6748426727) (S); [App Store](https://apps.apple.com/app/id6748426727) (S) |
| Claude Squad | Exists, 8.7k stars, tmux and worktrees; recency not confirmed | [repo](https://github.com/smtg-ai/claude-squad) (P) |
| Sculptor (Imbue) | Exists, small: 242 stars. Newest dated item I found is a blog from 2026-04-26 [>6 mo] | [repo](https://github.com/imbue-ai/sculptor) (P); [blog](https://imbue.com/blog/containers) (S) |
| Crystal | Deprecated in February 2026 in favour of Nimbalyst [>6 mo]; 3.1k stars | [repo README](https://github.com/stravu/crystal) (P) |
| Vibe Kanban | Company shut down 2026-04-10 [>6 mo]; repo says it is sunsetting and has 28.5k stars. Community maintenance per secondary sources. The official shutdown page refused my connection | [repo](https://github.com/BloopAI/vibe-kanban) (P); [Nimbalyst write-up, a competitor](https://nimbalyst.com/blog/vibe-kanban-after-bloop-whats-next/) (S) |
| Gas Town / Gas City | Gas Town 1.0 in April, Gas City successor announced 2026-04-24 [>6 mo]. Yegge's later "Continuous Thunderdome" setup was still being debated in August | [Gas Town coverage](https://codex.danielvaughan.com/2026/04/08/gas-town-multi-agent-factory/) (S); [Danjou, 2026-08-18](https://julien.danjou.info/blog/steve-yegge-deleted-the-wrong-thing) (P) |

Newer names not on the brief's list:
- Orca is listed at about 39k stars, but only by a competitor's page and unverified — [Superset](https://superset.sh/compare/orca-alternative) (S).
- Superset reported 3,200+ stars in March [>6 mo] — [Morph](https://www.morphllm.com/comparisons/superset-vs-conductor-vs-emdash) (S).
- Emdash (YC W26) assigns tickets from Linear, GitHub or Jira to a chosen agent — [same comparison](https://www.morphllm.com/comparisons/superset-vs-conductor-vs-emdash) (S).

Feature comparison. "Yes" means I found a source, which is cited in the sections below. A blank means I did not find it, not that it is absent.

| Capability | Conductor | Claude Code desktop/web | Codex | Cursor | VS Code / Agent HQ | Devin | Happy |
|---|---|---|---|---|---|---|---|
| Worktree or isolated parallel work | Yes | Yes | Yes | Yes | Yes | Cloud sessions | |
| Compare attempts (best-of-N) | | | | Yes | Yes (assign several agents) | | |
| Task board | Sections only | | | | | Yes (Command Center) | |
| Inline diff comments to agent | Yes | Yes | | Design Mode for UI | | Suggest from diff lines | |
| CI and PR-comment fix loop | Checks tab | Yes (Auto-fix) | | | Yes (agent merge, preview) | Devin Review | |
| Mobile approvals | | Yes | Yes | Auto-approved in July | | | Yes |
| Mobile steer | Yes | Yes | Yes | Yes | | | Yes |
| Mobile stop | Yes | | Background commands | | | | |
| Push notifications | | Yes | | Yes | Desktop badge only | | Yes |
| Schedules | Yes | Yes | Yes | Yes | Yes (preview) | Yes | |
| Event triggers | GitHub | GitHub, API | | GitHub, GitLab, Bitbucket, Slack, webhook, cron | | Slack, GitHub, Linear | |
| Real-time multi-user session | Yes (alpha in July) | | | | | | Yes |
| Per-user budgets | | Org/workspace level (S) | | | Yes | | |

### Inferences
- Stars do not predict survival. Vibe Kanban had 28.5k stars when its company closed.
- machdoch's direct competitors are multi-harness hosts: Conductor, VS Code/Agent HQ, Devin Desktop (via ACP), JetBrains Air, Happy and Warp Oz. Claude Code desktop and the Codex app are single-harness, but they set user expectations.
- Fleet management with shared settings across devices did not surface as a named feature among competitors. Conductor syncs model favourites and Devin syncs UI preferences, which are much narrower. This may be a real differentiator, though my searches did not target it.

### Gaps
- I could not verify commit dates, so "active" for Claude Squad, Happy and Sculptor is unconfirmed by commit history.
- No current Warp changelog entries: the landing page I fetched had none and I did not open the 2026 page.
- No dated official Antigravity release after May.
- Conductor user counts are not public as far as I found.

## Parallel work: worktrees, boards, side-by-side, best-of-N, merge queues

### Takeaway
Worktree isolation is now table stakes. Best-of-N ships in at least two major products, but I found no measurement of its value. Merge queues are contested for agents and are mostly delegated to GitHub rather than rebuilt.

### Cited Findings
- Cursor `/worktree` and `/best-of-n` run one task across several models, each in its own worktree, then compare; Agent Tabs show chats side by side (2026-04-02) [>6 mo] — [Cursor 3.0](https://cursor.com/changelog/3-0) (P).
- Agent HQ can assign an issue to Copilot, Claude, Codex or several at once to compare results [>6 mo] — [The New Stack](https://thenewstack.io/github-agent-hq/) (S).
- Coder's mux documents best-of-N and suggests starting at 3 or 5 — [mux docs](https://mux.coder.com/agents/best-of-n.md) (S).
- Claude Code desktop stores worktrees in `.claude/worktrees/` and offers split view — [desktop docs](https://code.claude.com/docs/en/desktop) (P).
- Zed starts threads in new worktrees with detached HEAD and groups them under the main project — [Zed docs](https://zed.dev/docs/ai/parallel-agents) (S).
- Codex 0.165.0 added a repository filter and directory grouping to its agent command center to make linked worktrees navigable (2026-10-27) — [changelog](https://learn.chatgpt.com/docs/changelog) (P).
- Conductor Dispatcher opens a prompt box for new workspaces, with a "create more" toggle for firing off a queue of tasks (0.63.0, June) — [changelog](https://www.conductor.build/changelog/0.63.0-cursor-support-dispatcher) (P).
- Conductor also added manual ordering and sidebar sections, and hides routine-created workspaces from Home by default in cloud organisations — [0.85.0](https://www.conductor.build/changelog/0.85.0-sections-routines-and-a-new-model-picker) (P); [0.92.0](https://www.conductor.build/changelog/0.92.0-remote-control) (P).
- Devin Desktop's default workspace is a Kanban-style Agent Command Center for local and cloud tasks (June) — [RuntimeWire](https://runtimewire.com/article/cognition-turns-windsurf-into-devin-desktop-a-command-center-for-coding-agents) (S). Nimbalyst also has a kanban view — [listing](https://aiidelist.com/ide/nimbalyst.md) (S).
- Sculptor runs each agent in Docker. Pairing Mode mirrors an agent's container into your IDE, stashing local work and restoring it afterwards — [docs](https://docs.imbue.com/features/pairing-mode) (S, undated).
- Merge queues:
  - Claude Code desktop's Merge when ready turns on GitHub auto-merge and respects a base branch merge queue — [desktop docs](https://code.claude.com/docs/en/desktop) (P).
  - VS Code agent merge (preview) handles review feedback, failed checks, conflicts and workflow reruns — [roundup](https://github.blog/changelog/2026-10-01-github-copilot-in-vs-code-september-2026-releases) (P).
  - Gas Town's Refinery runs verification gates and isolates failed merge requests — [Cloud Native Now](https://cloudnativenow.com/features/gas-town-what-kubernetes-for-ai-coding-agents-actually-looks-like/) (S).
- Danjou (who sells merge queues, so has an interest) reports Yegge dropped gating main at 175–250 commits a day from about 40 agents. His counter-design keeps the gate and sends each failure back to the owning agent — [Danjou, 2026-08-18](https://julien.danjou.info/blog/steve-yegge-deleted-the-wrong-thing) (P).

### Inferences
- The most reusable merge idea is failure attribution: routing a failing check back to the session that made the change. A host can do this without running its own queue, and machdoch already has steering to deliver it.
- Conductor's decision to hide routine workspaces suggests automation output clutters the main list. Any scheduling feature needs a separate view from day one.
- A board is a cheap view over state machdoch already has. I found no evidence boards themselves drive retention, so build it as a view, not a product pillar.

### Gaps
- No source measures whether best-of-N beats a single attempt at equal cost for coding. The nearest data is token-variance and spend studies, covered under rejected features.
- No user sentiment on best-of-N specifically was found.

## Review and handoff: inline comments, PRs, checkpoints, summaries

### Takeaway
Inline diff comments sent back in a batch, plus a CI and PR-comment repair loop, are the strongest common pattern among leading hosts. Checkpoints are less prominent in current docs.

### Cited Findings
- Claude Code desktop: hover a diff line, add comments, submit all with Ctrl+Enter, and Claude produces a new diff. `/code-review` findings offer Walk through in diff, Fix this one and Apply fixes — [desktop docs](https://code.claude.com/docs/en/desktop) (P).
- Claude Code Auto-fix handles failing checks and new review comments on a PR. It needs `gh` — [desktop docs](https://code.claude.com/docs/en/desktop) (P).
- Conductor: comment on changed lines and send to the agent, resolve GitHub threads, revert files, and use a Review action with per-repo guidance. A Checks tab combines git status, PR metadata, CI, deployments, comments and todos as merge blockers. Archived workspaces can be restored — [review guide](https://conductor.build/docs/guides/review-and-merge) (P).
- Conductor also lets you edit files directly in diffs (0.84.0, 2026-09-02) — [changelog](https://www.conductor.build/changelog) (P) — and syncs GitHub comments into the diff — [0.73.0](https://www.conductor.build/changelog/0.73.0-pr-page) (S).
- Conductor checkpoints shipped at 0.19.0 — [changelog](https://www.conductor.build/changelog) (P) — but the current review guide does not mention them, and one listing says they depend on the harness — [listing](https://aiidelist.com/ide/conductor.md) (S).
- Devin Review: automatic PR reviews from a session's PR card, suggestions from selected diff lines, findings quoted into chat, a rules editor, and merge method remembered per repo and branch (October) — [release notes](https://docs.devin.ai/release-notes/overview) (P).
- Cursor Security Review posts one comment per PR on exploitable bugs. Vendor chart: average review time fell from 4.8 to 3.8 minutes, and acceptance rose from about 45–50% to 60–70%. Rollouts writes a monitoring plan before merge, then compares against baseline and can open a revert PR for approval. No adoption numbers are given for Rollouts — [Cursor blog](https://cursor.com/blog/rollouts-and-security-reviewer) (P).
- Cursor Design Mode annotates UI elements in the browser for the agent [>6 mo] — [Cursor 3.0](https://cursor.com/changelog/3-0) (P). Cursor Canvases can be built by cloud agents and shared by link (2026-10-16) — [changelog](https://cursor.com/changelog) (P).
- VS Code suggests Mark as Done after a session's PRs merge, with configurable cleanup (preview), and offers a PR form from Copilot, Claude or Codex sessions — [roundup](https://github.blog/changelog/2026-10-01-github-copilot-in-vs-code-september-2026-releases) (P).
- Handoff:
  - Claude Code desktop moves a session to cloud via Open in > Cloud, carrying a conversation summary, but not from SSH or WSL — [desktop docs](https://code.claude.com/docs/en/desktop) (P).
  - Cursor iOS sends a local plan to cloud and returns it to the computer — [forum launch post, 2026-06-29](https://forum.cursor.com/t/cursor-mobile-app-for-ios/163417) (P).
  - VS Code continues a Codex conversation from the ChatGPT app — [roundup](https://github.blog/changelog/2026-10-01-github-copilot-in-vs-code-september-2026-releases) (P).
  - Codex added thread handoff between hosts on 2026-07-09 per an unofficial changelog — [gradually.ai](https://www.gradually.ai/changelogs/codex-app/) (S).

### Inferences
- Four vendors ship review closely tied to the agent loop, and Cursor's vendor chart is the only quantified result. Hard adoption evidence is thin, but convergence is strong.
- For multi-harness hosts, batching comments into one steering message works across all CLIs. Checkpoints depend on the harness, so they are harder to offer uniformly.

### Gaps
- No independent adoption data for inline comments.
- I did not confirm whether Codex's app has inline comments: its overview page only links a [code review page](https://learn.chatgpt.com/docs/app) that I did not open.

## Remote and mobile control

### Takeaway
Steering, approvals and stop from a phone are now a shipped baseline: Conductor, Codex, Claude Code and Cursor all added or expanded local-agent remote control during 2026. This is machdoch.cloud's most urgent gap. Cursor's remote agents, as of July, skipped the approval step, which shows what not to copy.

### Cited Findings
- Conductor Remote Control (0.92.0, 2026-10-23, Experimental): QR pairing. From iOS you browse and create workspaces, read chats, send messages, pick models and stop agents. It stays connected while the window is hidden and keeps a plugged-in Mac awake while the phone is connected — [changelog](https://www.conductor.build/changelog/0.92.0-remote-control) (P).
- Conductor for iOS is free and requires iOS 26+ (App Store v1.0 dated September 14) — [RuntimeWire](https://runtimewire.com/article/conductor-iphone-app-cloud-coding-agents) (P).
- Codex mobile: start tasks, send instructions, Approve / Always approve / Deny commands, and inspect diffs and test results across cloud and connected computers — [docs](https://learn.chatgpt.com/docs/mobile) (P).
- Codex setup is QR per phone per host, on macOS or Windows, and admins may need to enable it — [remote connections](https://learn.chatgpt.com/docs/remote-connections) (S). GA on all plans 2026-06-25 — [ChatGPT release notes](https://help.openai.com/en/articles/6825453-chatgpt-release-notes) (S).
- Codex iOS on 2026-10-22 added a pill above the composer to view and stop background commands on remote hosts, and `@` mentions of chats on other hosts. CLI 0.166.0 gave pairing a 35-second deadline — [changelog](https://learn.chatgpt.com/docs/changelog) (P).
- Claude Code Remote Control: the local session makes outbound HTTPS only and opens no inbound ports. It registers, polls and streams via Anthropic's API. Conversation and subagent progress sync across devices, and sessions reconnect after sleep or network loss — [docs](https://code.claude.com/docs/en/remote-control) (P).
- Claude Code Remote Control is limited to subscriptions, not API keys. An Owner must enable it on Team and Enterprise. It is unavailable with Zero Data Retention or HIPAA, and Trusted Devices is optional — [docs](https://code.claude.com/docs/en/remote-control) (P).
- Claude Code push has two toggles, proactive and actions required, and is skipped while you are focused on the terminal. `CLAUDE_CLIENT_PRESENCE_FILE` extends presence detection to any window — [docs](https://code.claude.com/docs/en/remote-control) (P).
- Cursor iOS public beta was 2026-06-29, with Live Activities and push on finish, input needed or ready for review, plus diffs, merge and voice — [forum](https://forum.cursor.com/t/cursor-mobile-app-for-ios/163417) (P). Local remote control lets you view and message agents and has a keep-awake setting. Enterprise admins must enable it — [changelog, 2026-10-06](https://cursor.com/changelog/remote-control-local-agents) (P).
- Cursor staff stated on 2026-07-23 that remote-controlled agents run with commands auto-approved, ignoring the user's allowlist, with a fix on the backlog — [forum](https://forum.cursor.com/t/ios-remote-control-command-allowlist/166447) (P, A). I did not confirm whether this has changed.
- Cursor forum reports: existing local agents not showing on iOS, and setup only available from the Agents Window — [feature request](https://forum.cursor.com/t/enable-local-agents-visibility-on-ios-app/166896) (S, A); [setup help](https://forum.cursor.com/t/cant-make-remote-control-work/169050) (S, A). Launch complaints: iOS 18 could not install, and no Android date — [forum](https://forum.cursor.com/t/cursor-mobile-app-for-ios/163417) (P, A).
- Codex pairing reports: Android pairing succeeds with no session, and an endless authorisation loop — [Android thread](https://community.openai.com/t/windows-remote-qr-pairing-succeeds-but-android-clients-cannot-establish-session-nextconnectioncount-0-on-26-818-31338/1391597) (S, A); [loop thread](https://community.openai.com/t/codex-remote-from-mobile-endless-loop/1402800) (S, A).
- Claude Code changelog fixes show typical sync failures: mobile and web showing the wrong permission mode, and connecting silently switching the model — [v2.1.202](https://dev.classmethod.jp/en/articles/20260707-cc-updates-v2-1-202/) (S); [June updates](https://dev.classmethod.jp/en/articles/20260630-cc-updates-v2-1-196/) (S).
- Happy: MIT, end-to-end encrypted mobile sync, push via APNs and FCM, supports Claude, Codex, Grok and Gemini plus ACP harnesses, and multiplayer sessions where participants watch and steer — [repo](https://github.com/slopus/happy) (P). A 4.9/5 from 938 reviews figure comes from one blog and is unverified — [Grass blog](https://codeongrass.com/blog/is-there-a-mobile-app-for-claude-code/) (S).
- Claude Dispatch is a persistent Cowork chat you message from a phone, which starts Code sessions and pushes on finish or approval — [desktop docs](https://code.claude.com/docs/en/desktop) (P).
- VS Code 1.138 added browser-addressable session links — [1.138 notes](https://code.visualstudio.com/updates/v1_138) (S). Its agent host renders one session in several windows — [Visual Studio Magazine, July](https://visualstudiomagazine.com/articles/2026/07/16/vs-code-1129-introduces-agent-host-and-experimental-agents-window-editor.aspx?p=1) (S).

### Inferences
- The expected action set is now list, read, message, approve or deny, stop, plus push when input is needed. machdoch.cloud's missing steering and stop relay fall squarely inside it.
- Outbound-only registration with a server routing to clients, as Claude Code uses, fits a fleet host well because devices need no inbound ports.
- Pairing is where user complaints cluster, so treat first-run pairing and reconnection as a tested flow, not an afterthought.
- Omnara's apparent stall, against first-party remote control in Claude Code, Codex and Cursor, suggests a pure remote-control wrapper is hard to sustain. Happy's open source and encryption may explain its stronger traction, but that is speculative.

### Gaps
- Conductor's relay security model is not described beyond QR pairing.
- I did not find whether Conductor remote control supports approvals.
- No usage figures for any mobile surface.

## Automation: schedules, triggers and recurring agents

### Takeaway
Schedules are now common across the major hosts. The differences are in event sources and in how much sits in cloud rather than local. Slack, GitHub and Linear triggers are where Devin and Cursor lead.

### Cited Findings
- Claude Code scheduled tasks (formerly routines, research preview): schedule, API POST with bearer token, or GitHub event triggers, combinable on one task. Each event starts a new session. They run on Anthropic cloud or an org's self-hosted environment. Tasks belong to an individual account and are not shared with teammates. Webhook events above hourly caps are dropped — [docs](https://code.claude.com/docs/en/routines) (P).
- Codex: standalone scheduled tasks, or scheduled inside an existing chat — [app docs](https://learn.chatgpt.com/docs/app) (P).
- Cursor Agent SDK (2026-10-20): channels can wake agents on GitHub, GitLab, Bitbucket, Slack, webhook and cron events — [changelog](https://cursor.com/changelog) (P). Automations were later moved into the Agents Window with multi-repo or no-repo setups — [AI Catchup](https://aicatchup.com/news/cursor-3-5-automations-agents-window-multi-repo-no-repo) (S; dates in secondary sources conflict).
- Conductor Routines (0.85.0, 2026-09-09): schedule or GitHub Action, cloud only, Pro and Team. The team says it uses them for internal reports, daily stand-up help and finding small problems in system prompts — [changelog](https://www.conductor.build/changelog/0.85.0-sections-routines-and-a-new-model-picker) (P).
- Conductor API (alpha, 0.77.0, July) creates cloud workspaces, sends prompts and reads replies. Users built Slackbots, mobile apps and internal tools — [changelog](https://www.conductor.build/changelog/0.77.0-early-access-multiplayer-api-background-tasks-performance) (P).
- Devin: Slack reaction triggers, GitHub issue assignment triggers, Linear-triggered sessions that can spawn children, schedules with start and end dates, and Oncall GA on 2026-10-19 — [release notes](https://docs.devin.ai/release-notes/overview) (P).
- VS Code Automations (preview): hourly, daily, weekly or on demand, from a template or prompt — [roundup](https://github.blog/changelog/2026-10-01-github-copilot-in-vs-code-september-2026-releases) (P).
- Warp Oz: launch agents interactively or programmatically, schedule recurring workflows, and run many in parallel [>6 mo] — [press release](https://warp.dev/newsroom/2026/2/10/warp-launches-oz-the-orchestration-platform-for-cloud-coding-agents) (S).
- Factory: Missions decompose long work across agents. Sacra reports 14% run over 24 hours and the longest ran 16 days — [Sacra](https://sacra.com/research/factory) (S).
- GitHub issue and Project views show agent activity [>6 mo] — [changelog](https://github.blog/changelog/2026-03-26-agent-activity-in-github-issues-and-projects/) (S).

### Inferences
- machdoch's fleet is a natural place to run schedules on a chosen device, which the cloud-first competitors do not emphasise. Claude Code tasks being tied to one person's account suggests team-owned schedules are an open slot.
- A public API appears to have been a cheap way for Conductor to get third-party bots and mobile clients, since users built them within the alpha.

### Gaps
- No data on how many users keep recurring agents running after trying them, and no failure-rate data.

## Team features: shared config, usage, budgets, governance

### Takeaway
Budgets at user, cost-centre and org level are real and demanded after high-profile overspending. GitHub has the most complete controls I found. Shared skills are converging as the unit of team knowledge.

### Cited Findings
- GitHub budgets layer across user, cost centre, org and enterprise, with the most specific taking precedence — [docs](https://docs.github.com/en/copilot/concepts/billing/budgets-for-usage-based-billing) (S). Per-user amounts on cost centres were REST-only on 2026-06-30 — [changelog](https://github.blog/changelog/2026-06-30-per-user-ai-credit-budgets-available-for-cost-centers/) (S). Cost centres can cap draw from the shared credit pool — [changelog](https://github.blog/changelog/2026-07-02-cost-centers-now-support-included-usage-caps/) (S).
- GitHub's usage metrics API now breaks out third-party agent apps by agent, with job starts and session counts per day and per 28 days (2026-08-07) — [changelog](https://github.blog/changelog/2026-08-07-copilot-usage-metrics-api-adds-agent-app-activity/) (P).
- Uber capped spend at $1,500 per employee per agentic tool per month after exhausting its 2026 budget in about four months, with an internal dashboard and exceptions (secondhand report of TechCrunch) — [Let's Data Science](https://letsdatascience.com/news/uber-caps-employee-ai-coding-tool-spending-8d1bc22d) (S).
- Gartner reportedly found nearly a quarter of tech leaders spend $200–$500 per developer per month on AI coding tokens — [Larridin](https://larridin.com/blog/ai-developer-budget-per-engineer) (S; this summary did not tie the figure to a specific page, so re-check before citing).
- Anthropic's spend limits are at workspace or org level; per-user attribution needs one API key per developer, per a third-party guide. Vendors sell gateways such as LiteLLM for per-developer budgets — [Maxim](https://getmaxim.ai/articles/top-ai-gateways-for-tracking-coding-agent-spend-in-2026/) (S); [guide](https://radar.firstaimovers.com/claude-code-billing-cost-management-team-leads-2026.md) (S). I did not verify this against Anthropic's docs.
- Conductor Multiplayer (alpha): shared workspace links, presence, prompting together; agents know who sent each message; `git push` runs as the chat's sender; workspace lists show cost. When a ChatGPT Business admin's limit is hit, users can copy a request to the admin — [0.77.0](https://www.conductor.build/changelog/0.77.0-early-access-multiplayer-api-background-tasks-performance) (P); [0.92.0](https://www.conductor.build/changelog/0.92.0-remote-control) (P).
- Conductor Loadouts: favourite model sets, shareable and importable with an Equip button — [0.86.0](https://www.conductor.build/changelog/0.86.0-share-your-loadouts) (P).
- Devin: Playbooks are becoming Skills (2026-10-23), Knowledge began migrating to Skills in September, and cross-session memory arrived 2026-10-09 — [release notes](https://docs.devin.ai/release-notes/overview) (P).
- Codex: reusable prompt presets (0.164.0) and managed OpenTelemetry requirements (0.166.0) — [changelog](https://learn.chatgpt.com/docs/changelog) (P).
- Claude Code desktop: admin limits on permission modes, `disableRemoteControl`, browser site allow and block lists, and disabling local sessions on managed devices — [desktop docs](https://code.claude.com/docs/en/desktop) (P).
- Cursor: Origin App Marketplace has 20+ apps and is open to submissions (2026-10-13). Environments support up to 300 repos — [changelog](https://cursor.com/changelog) (P).
- JetBrains' open Air system spans IDEs, team workflows and governance (date conflict; one report says 2026-09-22) — [Unite.AI](https://unite.ai/jetbrains-introduces-air-an-open-system-for-agentic-development) (S).
- Jellyfish, covering about 12,000 developers: PR throughput rises with token use, but tokens per PR rise sharply — [Jellyfish](https://jellyfish.co/library/ai-coding-tool-cost-per-developer/) (S; this summary did not tie the figure to a specific page, so re-check before citing).

### Inferences
- A cross-harness cost view per person, repo and device is plausibly valuable: each vendor's dashboard covers mainly its own usage, and gateways are being sold to fill the gap. machdoch already sees usage across three CLIs. It is limited, though, by what the CLIs expose under subscription plans.
- Conductor's "copy a request to the admin" is a small touch that suggests limits hit teams often and need a human path.

### Gaps
- I did not retrieve Cursor's or Claude's admin budget docs directly, so the Cursor and Claude budget columns are incomplete.
- No competitor-specific evidence on shared rule distribution across devices.

## Which features did users reject or find overrated?

### Takeaway
The clearest rejection is forcing an agent-first UI on people who want their editor. The most repeated complaint overall is that human review capacity, not agent count, limits throughput. Most of this evidence is anecdotal.

### Cited Findings
- Cursor Agents Window default: users objected to being pushed, asked for last-used view on startup, and one suspected adoption was under target (May) — [feedback thread](https://forum.cursor.com/t/agents-window-feedback/160057) (P, A). Other threads ask to stop the push or disable it — [thread](https://forum.cursor.com/t/please-stop-pushing-the-agent-window-so-aggressively-in-ide/160204) (S, A); [thread](https://forum.cursor.com/t/i-want-to-disable-agents-window-entirely/165544) (S, A).
- Staff acknowledged the window lacks extensions, diff view and file navigation that classic mode has — [forum](https://forum.cursor.com/t/agents-window-is-not-good/157226/3) (S, A). The same May thread also praised the agents experience as faster and lighter than the editor — [feedback thread](https://forum.cursor.com/t/agents-window-feedback/160057) (P, A).
- Review bottleneck: HN commenters on the Cursor 3 thread say parallel agents help on many small tasks, but review limits speed, and switching between deep problems is very costly. One suspects many people feel busy without moving faster [>6 mo] — [HN](https://news.ycombinator.com/item?id=47619981) (P, A). Similar earlier comments are in [HN](https://news.ycombinator.com/item?id=45489884) (S, A) [>6 mo].
- Worktrees: critics say they only defer conflicts to merge and add overhead when work is separate — [HN](https://news.ycombinator.com/item?id=47619981) (P, A) [>6 mo]. Supporters say they isolate agents but are tedious by hand — [HN](https://news.ycombinator.com/item?id=46368739) (S, A) [>6 mo]. This is not a consensus.
- Gas Town: about $100/hour at full capacity (secondhand estimate) — [Every](https://every.to/context-window/inside-the-100-agent-software-factory) (S). One HN commenter called it user hostile over system-wide hooks and daemons — [HN clone](https://hacker-news-clone.nuxt.dev/item/46624883) (S, A) [>6 mo]. A comparison site notes it lacks a desktop app or diff surface — [Superset](https://superset.sh/fr/compare/gastown-alternative) (S; competitor).
- Merge queues for agents: critics say green main is not the same as good main, and that a red main is tolerable only for solo work — [Danjou](https://julien.danjou.info/blog/steve-yegge-deleted-the-wrong-thing) (P; has a commercial interest).
- Antigravity rate limits: users describe abrupt mid-task cutoffs without warning, even on paid plans, and one heavy user reported the Agent Manager's change view as incomplete on 1.x — [review](https://emergent.sh/learn/google-antigravity-review) (S); [heavy-use review](https://blog.devgenius.io/antigravity-review-my-take-after-heavy-use-8d733bde30df) (S, A). Quality of these reviews is uneven.
- Agent teams: guides warn they are overkill for most tasks, and cost claims conflict, from 3–4x a session to 3–5x cheaper, with no stated method — [Morph](https://www.morphllm.com/agent-teams-vs-subagents) (S); [MindStudio](https://www.mindstudio.ai/blog/claude-code-agent-teams-vs-sub-agents?src=aicpb) (S). I found no first-hand rejection.
- Best-of-N cost: DSPy docs note token use multiplies by up to N — [skill page](https://skillselion.com/skills/lebsral/dspy-programming-not-prompting-lms-skills/dspy-best-of-n) (S). A SWE-bench write-up reports up to 30x token variance across repeat attempts — [Tokenade](https://tokenade.net/en/case-studies/swe-bench-agent-token-study) (S; secondary). Neither measures coding outcomes.
- Vibe Kanban's paid cloud ended for lack of a sustainable model with a mostly free user base — [Nimbalyst](https://nimbalyst.com/blog/vibe-kanban-after-bloop-whats-next/) (S; competitor).

### Inferences
- Do not make agent-first views a forced default, and persist the user's last view. This is cheap to get right.
- Treat concurrency limits and review queues as first-class. Commenters propose capping concurrent PRs at reviewer capacity — [DEV](https://dev.to/max_quimby/code-got-cheap-your-attention-didnt-4fm3) (S).
- Visible usage warnings before a cutoff, which machdoch's usage display could support, directly answer the Antigravity complaint.
- Scale claims of 20+ agents appeal mainly to a small enthusiast group. I would not chase them.

### Gaps
- I found no direct Reddit threads; searches returned blogs and forums instead. No systematic survey of feature satisfaction was found. Nearly all sentiment is self-selected forum and HN comment.

## Which ideas are worth adopting?

### Takeaway
Close the remote control gap first, then build the review loop and a review-aware view of parallel work. Automation comes next, and cross-harness cost control is the best differentiator for teams. The ranking is my judgement; adoption evidence is mostly convergence between vendors rather than usage numbers.

### Cited Findings
Each item names who ships it. Sources are in the sections above.

1. **Remote steer, stop and approve relay.** Conductor 0.92 (message, model, stop), Codex mobile (Approve / Always approve / Deny, stop background commands), Claude Code Remote Control (outbound-only). Evidence: four vendors within a year; Happy at 24.4k stars. Keep approval rules intact, unlike Cursor's auto-approve as of July.
2. **Attention-aware push.** Claude Code (two toggles, skip when present), Cursor (finish, input, ready for review; Live Activities), VS Code (OS badge for results, input and PR checks, preview). Evidence: Convergent; no usage numbers.
3. **Batched inline diff comments to the agent.** Claude Code desktop, Conductor; Devin suggestions from selected diff lines. Sent as one steering message, so it works for all three CLIs.
4. **PR status and repair loop.** Claude Code Auto-fix and Merge when ready, Conductor Checks tab, VS Code agent merge (preview). Add failure routing back to the owning session, the design [Danjou](https://julien.danjou.info/blog/steve-yegge-deleted-the-wrong-thing) argues for.
5. **Fleet-targeted schedules and event triggers, in a separate view.** Claude Code tasks (schedule, API, GitHub), Conductor Routines, Cursor SDK channels, Devin Slack, Linear and GitHub triggers. Conductor hid routine workspaces from Home, so separate them at the start.
6. **Cross-harness budget and cost view.** GitHub layered budgets, per-agent metrics API; Conductor per-workspace cost; Uber-style caps show the demand. Add a warning before limits, answering the Antigravity complaints.
7. **Public API for sessions.** Conductor API alpha (users built Slackbots and mobile clients), Claude Code `/fire` endpoint, Cursor Agent SDK.
8. **Shareable config artefacts.** Conductor Loadouts (one-click Equip), Codex prompt presets, Devin's move to Skills. This extends machdoch's shared settings to teammates through a link.
9. **Shared live sessions with attribution.** Conductor Multiplayer (agents know the sender, push runs as the sender), Happy multiplayer. Alpha-stage evidence only, so a later bet.
10. **Best-of-N as an explicit, cost-labelled action.** Cursor `/best-of-n`, Agent HQ multi-assign, mux. It suits a multi-harness host, but its value is unmeasured. Start at N=2–3 and show the cost multiplier.
11. **Board as an optional view, with review-capacity limits.** Devin Command Center, Nimbalyst. Vibe Kanban's closure shows a board alone is not a business. Pair it with a limit on work awaiting review.
12. **Small quality-of-life items.** Conductor keep-awake while a phone is connected (Cursor has a similar setting), VS Code Mark as Done and cleanup after merge, VS Code addressable session links, Claude Code side chats (`/btw`).

Not recommended now: forced agent-first default (Cursor backlash), building a custom merge queue (GitHub already provides one, and the design is disputed), Gas Town-scale swarms (cost and trust complaints).

### Inferences
- Items 1–4 are the shortest path to parity for individual users. Items 5–8 build on machdoch's fleet and multi-CLI position, where single-vendor hosts are structurally weaker.

### Gaps
- Effort estimates are absent because I did not inspect machdoch's code.
- Whether each CLI exposes enough to relay approvals and stop remotely in machdoch's architecture needs checking separately.
- Claude Code Remote Control is subscription-only and blocked for ZDR and HIPAA organisations, so machdoch's own relay may serve customers it cannot.
