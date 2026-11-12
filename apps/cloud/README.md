# machdoch.cloud

Self-hosted planning, AI tasks and chat, team administration, and remote access to Machdoch clients. Accounts, linked devices, settings and credentials are stored in PostgreSQL.

## Install

The Linux image is `ghcr.io/pureportal/machdoch-cloud:latest`. The only required application environment variable is:

```text
MACHDOCH_CLOUD_DATABASE_URL=postgresql://user:password@postgres:5432/machdoch
```

Start the container behind an HTTPS reverse proxy, expose port 43188, and open its public address. Create the organization and owner in the setup form. Cloud stores the public origin and generates its credential encryption key in PostgreSQL. No seed command, origin variable, encryption-key variable, SQLite volume, or Redis service is required for the application.

```bash
docker run --detach --name machdoch-cloud --restart unless-stopped \
  --publish 127.0.0.1:43188:43188 \
  --env MACHDOCH_CLOUD_DATABASE_URL \
  ghcr.io/pureportal/machdoch-cloud:latest
```

The proxy must preserve `Host`, `Origin`, `Authorization`, cookies, and WebSocket upgrades under `/api/gateway/connect/`. Configure HTTPS at the proxy. `PORT` and `MACHDOCH_CLOUD_LISTEN_ADDRESS` optionally change the listener. The default listener is `0.0.0.0:43188`.

Back up PostgreSQL, including the installation key. Optional AI execution workers, repository access, email delivery, private preview domains and artifact storage retain their own configuration requirements; configure the integrations that you use.

## Upgrade an existing installation

1. Stop the old application and take a verified backup of its database, configuration and settings key.
2. Provision PostgreSQL and set `MACHDOCH_CLOUD_DATABASE_URL` on the new image.
3. For the first start, retain the existing `/config` mounts and the settings encryption key source. The importer discovers `/config/fleet-manager.json`; a source installation elsewhere can use `serve --import-config /absolute/path/to/config.json`.
4. Start the new image on the same public address. Startup imports the owner, device credentials and revocations, enrollment grants, audit history, profile revisions, assignments, captured device settings and session routes in one PostgreSQL transaction. Secrets are decrypted with the source key and encrypted with the installation key. Existing Cloud data is never overwritten.
5. The importer compares the imported rows, verifies the committed owner, and then deletes the SQLite database and its journal files. It also removes unchanged, writable configuration and key files within the source configuration directory. Read-only mounts, symlinks, external key files and files changed during import are retained. Failed imports retain the source. A committed import whose cleanup was interrupted resumes without duplicating data, including after SQLite was deleted. Check the startup migration result before removing the old mounts and any explicit migration argument or environment variable.

Existing usernames and passwords continue to work. Sign in again in the browser; device credentials and installation identity are retained, so linked clients reconnect without reenrollment. Remote controls are available to the installation organization's owners and administrators. Other organization roles cannot control its clients.

Source account conflicts, unsupported source tables, unavailable encryption keys or a populated remote-device destination stop migration without removing source data. Stop all old application processes before upgrading. Do not run the old and new applications against the same installation concurrently.

When upgrading an installation that already used Cloud credentials, supply its existing `MACHDOCH_CLOUD_ENCRYPTION_KEY` for the first start. It is verified and persisted; it is no longer required on subsequent starts. An existing `MACHDOCH_CLOUD_ORIGIN` is likewise adopted on first initialization.

## Two-factor authentication

Every account needs an authenticator app (TOTP). After password, email-link or SSO sign-in, accounts without one set it up before they can continue and receive ten single-use recovery codes. Account → Security replaces the authenticator or the recovery codes. Owners and administrators can reset a member's two-factor authentication under Settings → Members. If no owner can sign in, run `pnpm --filter @machdoch/cloud cloud:recover-signin` with `MACHDOCH_CLOUD_DATABASE_URL`, `MACHDOCH_CLOUD_RECOVERY_ORGANIZATION_ID`, `MACHDOCH_CLOUD_RECOVERY_LOGIN` and `MACHDOCH_CLOUD_OWNER_PASSWORD`; it also resets that owner's two-factor authentication.

The upgrade that introduces two-factor authentication signs out all browser sessions and disconnects connected apps. Reconnect them after setting up two-factor authentication.

## Clients

Open **Clients** to inspect devices, enroll or revoke them, open remote workspaces, and manage profiles. The remote workspace retains chat, tasks, scheduler, RALPH, files, Git, terminal, services, previews, speech and media controls. Device-backed features still depend on the connected client's capabilities.

The [Android controller](../fleet-android/README.md) uses the same Cloud sign-in and remote views. Updated desktop and CLI clients use the Cloud name while retaining their enrolled device identity.

## Linked client agents

Create an execution profile with the **Linked client** target and choose Codex CLI, Claude Code or the client's configured Machdoch agent. Enroll a runner for the profile and link the matching local checkout with `machdoch cloud connect`. Start the runner from the desktop workspace connection (**Run tasks**) or with `machdoch cloud run <connection id>`.

Delegated issues run in a separate checkout of the profile's base commit. Required checks run in another checkout built from the uploaded candidate. A verified result is added to the local repository as a `machdoch/…` branch; the working tree, uncommitted files and existing branches are not changed.

## Agent

**Agent** answers questions about issues, projects, initiatives, cycles and teams using a configured AI provider. It looks up workspace data the user can access with read-only tools, including full comment threads, and asks a clarifying question when a request is ambiguous. It drafts new issues, issue changes (including description, estimate and labels), bulk changes across issues, archiving and restoring, issue links, comments, project status updates and triage decisions as proposals that change nothing until the user confirms them. Confirmed proposals run as the user, so they fail when the user's role or team access no longer allows the change. Issue identifiers such as `PLAT-12` in Agent answers, comments and descriptions link to the issue, and `/cloud/issues/PLAT-12` opens it. Open it from the sidebar, as a panel on any page with ⌘J (the current issue, project, cycle or team is added to its context), or as a full page. On an issue, the **Agent** menu runs common requests in one click, such as summarizing, writing acceptance criteria, breaking it into sub-issues or drafting a plan. No sandbox is started.

Attach, paste or drop images and files (up to six per message, 50 MB each) in the Agent composer. Agent sees attached images (PNG, JPEG, WebP and GIF up to 5 MB) through API providers and the Claude and Codex CLIs, and reads text, Markdown, CSV and JSON documents. It opens issue attachments with `view_attachment`, shows images in place in its answers, and can attach conversation files to new or changed issues and comments; on confirmation they are copied to the issue. Issues have an **Attachments** section, and images pasted or dropped into descriptions, acceptance criteria and comments are uploaded and shown in place. Attachments follow the access of their issue; conversation files are visible only to their owner.

Owners and administrators can let Agent hand work to a connected client: it lists online clients with `list_clients` and proposes a session with `propose_client_session`, optionally in goal mode for long-running changes. Confirming starts the session on the client. When the session belongs to an issue, the client receives a 24-hour upload link (`POST /api/v1/attachment-uploads/<token>?name=<file name>`) so the images, videos and documents it produces appear on the issue. **Resolve conflicts**, **Fix checks** and **Address comments** on pull requests start the client session right away; **Open in client** can start it, with or without goal mode.

The server image includes the Claude, Codex and Copilot CLIs for AI providers. Add a CLI provider under **AI providers** and choose **Sign in**: Cloud runs the CLI's own login on the host and shows its sign-in page and code (for Claude, paste the code shown after signing in). Each CLI provider keeps its sign-in in its own directory under `MACHDOCH_CLOUD_CLI_HOME` (default `~/.machdoch-cloud/cli`); keep it on a volume. Alternatively, enter an API key or, for Copilot, a fine-grained GitHub token with the Copilot Requests permission. `MACHDOCH_CLOUD_CLAUDE_CLI`, `MACHDOCH_CLOUD_CODEX_CLI` and `MACHDOCH_CLOUD_COPILOT_CLI` override the executables. Sandbox tasks use the same providers: their model requests run on the cloud server, so a signed-in CLI provider also powers **Cloud sandbox** and **Client sandbox** profiles.

## Automations

**Automations** run actions when something happens in a team: an issue is created, its status, priority or assignee changes, a label or comment is added, a linked pull request changes stage, a release is created, a schedule is due (optionally for each matching issue), a webhook is called, or someone runs it manually from an issue (**Automate**). Conditions use the issue filters. Actions set status or priority, assign, add or remove labels, comment, create (sub-)issues, ask Agent, start an AI task, prepare a release, let Agent write channel posts for a release or, for owners and administrators, send an HTTPS webhook or start a session on a connected client, optionally in goal mode. Writing posts can wait until enough issues or estimate points shipped since the channel's last post; smaller releases add up and the post covers them all. Text supports variables such as `{{issue.identifier}}`, `{{comment.body}}`, `{{payload.title}}` and `{{agent.answer}}`. Start from a template, such as answering `@agent` in comments, Agent triage, breaking issues into sub-issues, weekly project updates, a LinkedIn post once enough has shipped, implementing labeled issues on a client in goal mode or closing stale backlog issues. Agent can also list, explain, create and change automations from a conversation; each one is a proposal the user confirms and runs with their permissions.

Actions run with the owner's permissions; Ask Agent runs as the person who triggered the event when there is one, so its answers never exceed that person's access. Agent can post its answer as a comment and apply its proposals automatically. An automation's own changes do not trigger it again, chains stop after three automations, and each automation has a daily run limit. A webhook automation shows its address once; POST JSON to it, and include `"issue": "PLAT-12"` to run it on an issue. Connected apps can list and run automations and talk to Agent with the MCP tools `list_automations`, `run_automation`, `ask_agent`, `get_agent_conversation` and `apply_agent_proposal`.

## Releases

**Releases** turns shipped work into launch content and publishes it. Under **Products**, administrators define each product's brand kit (colors, logo, voice, audience, hashtags, call to action), the teams whose completed issues count as shipped, a sandbox brief that explains how to run the product with mock data, and its channels: LinkedIn (a member profile or company page), Reddit (one or more subreddits with post type and flair) and webhooks (Slack, Discord or JSON). Each channel has its own writing rules, media format and approval requirement.

A release collects the product's completed issues since the previous release and adds a draft post for every enabled channel. **Write with Agent** drafts the notes, one native post per channel and branded visuals using the product voice and channel rules. **Media** holds uploads, branded visuals rendered from four templates (announcement, feature spotlight, highlights, quote) in LinkedIn and video sizes, and videos composed from screenshots and recordings with intro and outro cards. **Capture in sandbox** writes a brief with a 24-hour upload link that an agent, for example on a linked client, uses to upload screenshots and recordings with `curl`. Posts are approved, then scheduled or published; every Reddit subreddit is delivered and retried separately, so retries never post twice. Owners and administrators publish; enable **Members can schedule and publish posts** on a product to let members publish. The **Prepare release** automation action and the MCP tools `create_release`, `write_release_content`, `change_release_post`, `launch_release` and `create_release_visual` automate the same flow.

Under **Connections**, add the LinkedIn and Reddit app credentials (copy the shown redirect URL into the app) and connect accounts. Posting to LinkedIn company pages needs the Community Management API. Video composition needs `ffmpeg`; the image includes it, and `MACHDOCH_CLOUD_FFMPEG` overrides the executable.

## AI activity and Mimorii

**AI activity** lists what the AI did: Agent answers, questions and proposals, task state changes, runner steps and model calls with model, tokens and duration. Members see their own Agent activity and tasks of teams they can access; owners and administrators see everything. Entries are kept for 90 days.

Connected clients are tracked too: about every 30 seconds Cloud reads each connected client's status and records task starts and outcomes with the failure reason and model, scheduled job and RALPH run results, runtime, scheduler, RALPH and instruction errors and their recovery, providers becoming unavailable, and clients disconnecting or reconnecting. Prompts are not recorded. Only owners and administrators see client activity; open it from **AI activity → Clients** or a device's **Activity** button.

To also track this activity in [Mimorii](https://mimorii.app), create a log source in Mimorii and add its token under **Settings → Mimorii**. Cloud sends each entry once as a log line labeled `service="machdoch-cloud"` and `activity` (`agent`, `task`, `step`, `model` or `client`; client entries also carry `device`), retries automatically when Mimorii is unreachable, and sends only activity recorded while the connection is enabled. Use a self-hosted Mimorii by entering its HTTPS address.

## Source

```bash
pnpm build:cloud
pnpm start:cloud
```

Use the same PostgreSQL environment variable. The application performs schema migrations before listening. The Cloud migration tests exercise password/device preservation, encrypted data, rollback, conflicting destinations and interrupted cleanup; remote API and gateway tests cover authentication, revocation and reconnect behavior.

After building, `pnpm --filter @machdoch/cloud verify:cloud:cutover` checks browser setup and client controls. `pnpm --filter @machdoch/cloud verify:cloud:migration` rehearses a SQLite upgrade against PostgreSQL. These checks create and remove their own databases on the configured test server and require Chrome, OpenSSL, and permission to create databases.
