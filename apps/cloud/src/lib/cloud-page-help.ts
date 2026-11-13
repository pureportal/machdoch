import type { SidebarPageHref } from "./cloud-sidebar-contract";

const help: Partial<Record<SidebarPageHref, string>> = {
  "/cloud/pulse": `
**Write with Agent** posts an update for each chosen project. Agent reads the project's issues and earlier updates and follows the Pulse **Instructions**, which set the TL;DR, health and structure.

To post updates on a timetable, add an [automation](/cloud/automations) with the action **Write project updates**.
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
Open an issue and choose **Delegate**. The menu lists the [execution profiles](/cloud/execution) of the issue's team and project; the profile decides where the task runs, on which repository and with which model.

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
  "/cloud/automations": `
An automation has a **trigger**, optional **conditions** that use the issue filters, and **actions** such as setting fields, commenting, asking Agent or starting an AI task.

Actions run with the automation owner's permissions. An automation's own changes never trigger it again.

To create issues or run AI tasks at fixed times, use [Schedules](/cloud/schedules).
`,
  "/cloud/schedules": `
A schedule either **creates an issue** or **runs an AI task** at set times.

AI task schedules use an [execution profile](/cloud/execution) and stop at **Maximum tasks**, at the **Total token allowance** or when the authorization expires. **Missed dates** decides whether missed occurrences are skipped or caught up.

To react to events instead, use [Automations](/cloud/automations).
`,
  "/enrollment": `
1. Create an enrollment key.
2. In the Machdoch desktop app, open **machdoch.cloud → Remote access** and enter this Cloud's URL, the key and a device name.
3. The device appears under [Devices](/instances).

Each key links one device.
`,
  "/settings": `
Not to be confused with [execution profiles](/cloud/execution), which decide where AI tasks run.
`,
  "/cloud/connections": `
Add the **MCP URL** as a remote MCP server in the app, then sign in when it asks. The app appears here once connected.

An app gets the access of your role, never administration permissions. **Disconnect** revokes it.
`,
  "/cloud/providers": `
- **API key**: requests go directly to the provider's API.
- **Sign in** (Claude, Codex and Copilot CLIs): Cloud runs the CLI's own login on the server, so no API key is needed.

Agent and sandbox tasks use these providers. Tasks on a linked client use that client's own agent instead.

**Daily tokens** and **Parallel requests** limit each provider. **Token usage** shows today's consumption.
`,
  "/cloud/execution": `
![Issue, execution profile, runner, required checks](/help/execution-flow.svg)

| Target | Runs |
| --- | --- |
| Cloud sandbox | In a sandbox managed by Cloud |
| Client sandbox | In a Linux sandbox on a linked client |
| Linked client | Codex CLI, Claude Code or Machdoch in a checkout on a linked client |

Each profile belongs to one project. Tasks wait until a **runner** of the profile picks them up. For a linked client, connect the local checkout with \`machdoch cloud connect\` and start the runner with **Run tasks** in the desktop app or \`machdoch cloud run <connection id>\`.

Sandbox targets use models from [AI providers](/cloud/providers).
`,
};

export const pageHelp: ReadonlyMap<string, string> = new Map(
  Object.entries(help).map(([href, content]) => [href, content.trim()]),
);
