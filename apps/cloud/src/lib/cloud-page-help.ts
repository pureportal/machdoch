import type { SidebarPageHref } from "./cloud-sidebar-contract";

const help: Partial<Record<SidebarPageHref, string>> = {
  "/cloud/pulse": `
**Write with Agent** posts an update for each chosen project. Agent reads the project's issues and earlier updates and follows the Pulse **Instructions**, which set the TL;DR, health and structure.

To post updates on a timetable, add a [loop](/cloud/loops) with the action **Write project updates**.
`,
  "/cloud/reviews": `
Reviews match pull requests to the GitHub and GitLab accounts linked on your account page. Pull requests you opened appear by what they need next; requests for your review appear until you submit one.
`,
  "/cloud/activity": `
- **Agent**: answers, questions and proposals.
- **Tasks**: state changes, runner steps and model calls with model, tokens and duration.
- **Clients**: task results, scheduled jobs, errors and disconnects reported by linked clients. Only owners and administrators see these.

Members see their own Agent activity and the tasks of teams they can access.
`,
  "/cloud/tasks": `
Open an issue and choose **Delegate**. The menu lists the [execution profiles](/cloud/settings/execution) of the issue's team and project; the profile decides where the task runs, on which repository and with which model.

A result only counts once the profile's required checks pass. On a linked client, a verified result is added to the local repository as a \`machdoch/…\` branch. The working tree and existing branches stay untouched.
`,
  "/cloud/initiatives": `
A **project** is time-bound and delivers one result. An **initiative** is a longer-term goal that tracks several projects together. Choose its projects when you create or edit the initiative.
`,
  "/cloud/releases": `
![Product, release, posts, channels](/help/release-flow.svg)

A release collects the product's completed issues since its previous release and adds a draft post for every enabled channel. **Write with Agent** drafts notes, posts and visuals in the product's voice. Posts are approved, then scheduled or published.

Set up [Products](/cloud/releases/products) and [Connections](/cloud/releases/connections) first.
`,
  "/cloud/releases/products": `
- **Brand kit** and **Voice**: what posts and visuals look and sound like.
- **Production**: the teams whose completed issues count as shipped, and a sandbox brief for capturing screenshots with mock data.
- **Channels**: LinkedIn, Reddit or webhooks, each with its own writing rules, media format and approval requirement.
`,
  "/cloud/releases/connections": `
Add the LinkedIn or Reddit app credentials, copy the shown redirect URL into that app, then connect an account. Product channels post through these accounts.

Posting to LinkedIn company pages needs the Community Management API.
`,
  "/cloud/loops": `
A loop is an **automation** that reacts to events or webhooks, or a **schedule** that runs at set times. It runs in a cloud sandbox, on a linked client or in a runner pool.

Actions run with the loop owner's permissions. A loop's own changes never trigger it again. Budgets, code access and trusted sources are set in **Settings → Loops**.
`,
  "/enrollment": `
1. Create an enrollment key.
2. In the Machdoch desktop app, open **machdoch.cloud → Remote access** and enter this Cloud's URL, the key and a device name.
3. The device appears under [Devices](/instances).

Each key links one device.
`,
  "/settings": `
Not to be confused with [execution profiles](/cloud/settings/execution), which decide where AI tasks run.
`,
  "/cloud/settings/security": `
Add the **MCP URL** as a remote MCP server in the app, then sign in when it asks. The app appears here once connected.

An app gets the access of your role, never administration permissions. **Disconnect** revokes it.
`,
  "/cloud/settings/ai": `
- **API key**: requests go directly to the provider's API.
- **Sign in** (Claude, Codex and Copilot CLIs): Cloud runs the CLI's own login on the server, so no API key is needed.

Agent and sandbox tasks use these providers. Tasks on a linked client use that client's own agent instead.

**Daily tokens** and **Parallel requests** limit each provider. **Token usage** shows today's consumption.
`,
  "/cloud/settings/execution": `
Each project gets one setup: pick the repository and the AI works from the latest commit of its default branch. Checks are suggested from the repository's own scripts.

To hand an issue to AI, choose **Machdoch AI** as its assignee, or use **Assign to AI** on the issue. This also works for many issues at once from the issue list. The AI then:

1. changes the code in a sandbox,
2. runs the checks again in a fresh sandbox,
3. gets an independent AI review that approves the change or sends it back, for up to three rounds,
4. opens a pull request.

With **Autopilot** on, the pull request merges once the repository's own checks pass. A person decides instead when tests were removed or skipped, sensitive areas such as security, billing, migrations or infrastructure changed, the change is very large, or the review did not approve it. Closing or canceling the issue removes its pull request and branch.

With **Check pull requests** on, every new pull request and every new push to it is checked in a sandbox. The AI builds it, runs its tests and inspects the changed screens when the sandbox has a browser. The configured checks then run in a fresh sandbox, an independent AI review reads the pull request's diff, and the verdict is posted as a comment on the pull request. Machdoch's own branches and draft pull requests are skipped.

| Runs on | Where |
| --- | --- |
| Cloud sandbox | In a sandbox managed by Cloud |
| Client sandbox | In a Linux sandbox on a linked client |
| Linked client | Codex CLI, Claude Code or Machdoch in a checkout on a linked client |

Tasks wait until a **runner** of the setup picks them up. For a linked client, connect the local checkout with \`machdoch cloud connect\` and start the runner with **Run tasks** in the desktop app or \`machdoch cloud run <connection id>\`.

Sandbox targets use models from [AI providers](/cloud/settings/ai).
`,
};

export const pageHelp: ReadonlyMap<string, string> = new Map(
  Object.entries(help).map(([href, content]) => [href, content.trim()]),
);
