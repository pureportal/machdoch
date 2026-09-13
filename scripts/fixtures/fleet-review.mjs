import { productFixture } from "./fleet-product.mjs";

export function fleetReviewFixture() {
  const snapshot = productFixture();
  const initial = snapshot.shell.sessions[0];
  const messageTemplate = snapshot.shell.visibleMessages[0];
  snapshot.shell.sessions.push({
    ...initial,
    id: "session_second",
    title: "Second session",
    tags: [],
    status: "empty",
  });
  snapshot.shell.visibleMessages.push({
    ...snapshot.shell.visibleMessages[3],
    id: "message_code",
    content:
      "```js\nconst status = 'ready';\n```\n\n" +
      "Review the task results before continuing.\n\n".repeat(30),
  });
  const drafts = new Map(
    snapshot.shell.sessions.map((session) => [session.id, ""]),
  );
  const messages = new Map([
    [initial.id, snapshot.shell.visibleMessages],
    ["session_second", []],
  ]);
  const state = {
    snapshot,
    commands: [],
    offline: false,
    delay: 0,
    snapshotDelay: 0,
    failNext: null,
    async install(page) {
      await page.route("**/product/snapshot", async (route) => {
        if (state.snapshotDelay)
          await new Promise((resolve) =>
            setTimeout(resolve, state.snapshotDelay),
          );
        await route.fulfill({
          status: state.offline ? 503 : 200,
          json: state.offline
            ? { error: "Instance is offline." }
            : state.snapshot,
        });
      });
      await page.route("**/product/commands", async (route) => {
        const command = route.request().postDataJSON();
        state.commands.push(command);
        if (state.delay)
          await new Promise((resolve) => setTimeout(resolve, state.delay));
        if (state.failNext === command.kind) {
          state.failNext = null;
          await route.fulfill({
            status: 409,
            json: {
              error: "The instance could not complete this command. Try again.",
            },
          });
          return;
        }
        const shell = state.snapshot.shell;
        const session = shell.sessions.find(
          (item) => item.id === command.sessionId,
        );
        switch (command.kind) {
          case "create-session": {
            const created = {
              ...initial,
              id: `session_created_${state.commands.length}`,
              title: "New task",
              workspace: command.workspace,
              status: "empty",
              tags: [],
              messageCount: 0,
              createdAt: Date.now(),
              updatedAt: Date.now(),
            };
            shell.sessions.push(created);
            drafts.set(created.id, "");
            messages.set(created.id, []);
            shell.activeSessionId = created.id;
            shell.composer.sessionId = created.id;
            shell.composer.workspace = created.workspace;
            shell.composer.draft = "";
            shell.visibleMessages = messages.get(created.id);
            break;
          }
          case "create-project":
            shell.projectLibrary.projects.push({
              id: `00000000-0000-4000-8000-${String(state.commands.length).padStart(12, "0")}`,
              name: command.name,
              workspace: `${shell.projectLibrary.root}/${command.name}`,
              kind: "empty",
              status: "ready",
              initializeGit: command.initializeGit,
              createdAt: Date.now(),
              updatedAt: Date.now(),
            });
            break;
          case "update-draft":
            drafts.set(command.sessionId, command.prompt);
            if (shell.composer.sessionId === command.sessionId)
              shell.composer.draft = command.prompt;
            break;
          case "submit-message":
            messages.get(command.sessionId).push({
              ...messageTemplate,
              id: `sent_${state.commands.length}`,
              role: "user",
              content: command.prompt,
            });
            break;
          case "activate-session":
            shell.activeSessionId = session.id;
            shell.composer.sessionId = session.id;
            shell.composer.draft = drafts.get(session.id);
            shell.visibleMessages = messages.get(session.id);
            break;
          case "rename-session":
            session.title = command.title;
            break;
          case "tag-session":
            session.tags = command.tags;
            break;
          case "pin-session":
            if (session.pinnedAt) delete session.pinnedAt;
            else session.pinnedAt = Date.now();
            break;
          case "archive-session":
            if (session.archivedAt !== undefined) delete session.archivedAt;
            else session.archivedAt = Date.now();
            break;
          case "duplicate-session":
          case "branch-session": {
            const created = {
              ...session,
              id: `session_copy_${state.commands.length}`,
              title: `${session.title} copy`,
              tags: [...session.tags],
            };
            delete created.archivedAt;
            delete created.pinnedAt;
            shell.sessions.push(created);
            messages.set(created.id, structuredClone(messages.get(session.id)));
            drafts.set(created.id, "");
            shell.activeSessionId = created.id;
            shell.composer.sessionId = created.id;
            shell.composer.draft = "";
            shell.visibleMessages = messages.get(created.id);
            break;
          }
          case "delete-session": {
            shell.sessions = shell.sessions.filter(
              (item) => item.id !== command.sessionId,
            );
            messages.delete(command.sessionId);
            drafts.delete(command.sessionId);
            if (shell.activeSessionId === command.sessionId) {
              const next = shell.sessions[0];
              shell.activeSessionId = next.id;
              shell.composer.sessionId = next.id;
              shell.composer.draft = drafts.get(next.id);
              shell.visibleMessages = messages.get(next.id);
            }
            break;
          }
          case "delete-context-pack":
            shell.contextPacks = shell.contextPacks.filter(
              (pack) => pack.id !== command.contextPackId,
            );
            break;
          case "apply-context-pack":
            shell.contextPacks.find(
              (pack) => pack.id === command.contextPackId,
            ).matched = true;
            break;
          case "forget-session-memory":
            shell.composer.sessionMemory = shell.composer.sessionMemory.filter(
              (entry) => entry.id !== command.memoryId,
            );
            break;
          case "set-session-memory":
            shell.composer.sessionMemoryEnabled = command.enabled;
            break;
          case "cancel-media-run":
            shell.media.runs.find((run) => run.id === command.runId).status =
              "canceled";
            shell.media.busy = false;
            break;
          case "generate-media":
            delete shell.media.error;
            break;
          case "cancel":
            for (const task of state.snapshot.sessions) {
              if (task.taskId === command.taskId) {
                task.cancellable = false;
                task.state = "cancelled";
              }
            }
            for (const item of shell.sessions) {
              if (item.runningTaskId === command.taskId)
                delete item.runningTaskId;
            }
            shell.composer.isExecuting = false;
            break;
          case "set-session-model":
            session.provider = command.provider;
            session.model = command.model;
            shell.composer.model = command.model;
            shell.composer.modelLabel = shell.composer.modelCatalog
              .flatMap((provider) => provider.models)
              .find((model) => model.id === command.model).label;
            break;
          case "set-session-reasoning":
            session.reasoning = command.reasoning;
            shell.composer.reasoning = command.reasoning;
            break;
          case "clear-session-reasoning":
            delete session.reasoning;
            shell.composer.reasoning = shell.composer.defaultReasoning;
            break;
          case "set-session-workspace":
            session.workspace = command.workspace;
            shell.composer.workspace = command.workspace;
            break;
          case "clear-session-workspace":
            delete session.workspace;
            delete shell.composer.workspace;
            break;
          case "scheduler-pause":
            shell.scheduler.jobs.find(
              (job) => job.id === command.jobId,
            ).status = "paused";
            break;
          case "scheduler-resume":
            shell.scheduler.jobs.find(
              (job) => job.id === command.jobId,
            ).status = "active";
            break;
          case "scheduler-delete":
            shell.scheduler.jobs = shell.scheduler.jobs.filter(
              (job) => job.id !== command.jobId,
            );
            break;
          case "scheduler-cancel-run":
            shell.scheduler.runs.find(
              (run) => run.id === command.runId,
            ).status = "cancelled";
            break;
        }
        state.snapshot.eventId += 1;
        await route.fulfill({
          status: 202,
          json: { commandId: command.commandId, duplicate: false },
        });
      });
    },
  };
  return state;
}

export function fleetRunsFixture(workspace) {
  return {
    snapshot: {
      workspace,
      revision: "review-1",
      document: {
        schemaVersion: 2,
        configurations: [
          {
            id: "frontend",
            name: "Frontend",
            kind: "task",
            primary: true,
            command: "pnpm run dev",
            workingDirectory: ".",
            ports: [4173],
          },
        ],
      },
      statuses: [
        {
          id: "frontend",
          state: "stopped",
          pid: null,
          startedAt: null,
          exitCode: null,
          restartCount: 0,
          health: null,
          logs: [
            {
              sequence: 1,
              at: Date.now(),
              stream: "stdout",
              line: "Review fixture output",
            },
          ],
        },
      ],
      host: {
        platform: "win32",
        uptimeSeconds: 3600,
        cpuPercent: 12,
        totalMemory: 16 * 1024 ** 3,
        freeMemory: 8 * 1024 ** 3,
        serviceMemory: 0.2 * 1024 ** 3,
      },
    },
    previewsEnabled: false,
    previews: [],
  };
}
