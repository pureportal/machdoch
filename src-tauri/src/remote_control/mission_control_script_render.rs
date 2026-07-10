pub(super) fn mission_control_script_render() -> &'static str {
    r##"    let pairingToken = new URLSearchParams(location.hash.slice(1)).get("pair")
      || new URLSearchParams(location.hash.slice(1)).get("token")
      || new URLSearchParams(location.search).get("pair")
      || new URLSearchParams(location.search).get("token")
      || "";
    let latestSnapshot = null;
    let selectedSessionId = "";
    const connection = document.getElementById("connection");
    const remotePromptForm = document.getElementById("remotePromptForm");
    const remotePrompt = document.getElementById("remotePrompt");
    const shellSessions = document.getElementById("shellSessions");
    const runtimePanel = document.getElementById("runtimePanel");
    const sessionHeader = document.getElementById("sessionHeader");
    const conversation = document.getElementById("conversation");
    const providerSelect = document.getElementById("providerSelect");
    const modelInput = document.getElementById("modelInput");
    const modeSelect = document.getElementById("modeSelect");
    const reasoningSelect = document.getElementById("reasoningSelect");
    const composerMeta = document.getElementById("composerMeta");
    const tasks = document.getElementById("tasks");
    const schedulerPanel = document.getElementById("schedulerPanel");
    const contextPacks = document.getElementById("contextPacks");
    const commands = document.getElementById("commands");
    const toast = document.getElementById("toast");
    const terminalStates = new Set(["completed", "planned", "blocked", "unsupported", "cancelled"]);
    const supportedReasoningModes = ["default", "none", "minimal", "low", "medium", "high", "xhigh", "max"];

    if (pairingToken) {
      history.replaceState(null, "", location.pathname);
    }

    function api(path) {
      return path;
    }

    function authHeaders(extra = {}, includePairingToken = false) {
      const headers = {
        ...extra,
        "X-Machdoch-Remote": "1"
      };
      if (includePairingToken && pairingToken) {
        headers.Authorization = `Bearer ${pairingToken}`;
      }
      return headers;
    }

    async function establishSession() {
      if (!pairingToken) {
        return;
      }

      const response = await fetch(api("/api/session"), {
        method: "POST",
        headers: authHeaders({}, true)
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const pairedResponse = await fetch(api("/api/status"), { headers: authHeaders() });
        if (pairedResponse.ok) return;
        throw new Error(payload.error || "Session setup failed.");
      }
    }

    function escapeHtml(value) {
      return String(value ?? "").replace(/[&<>"']/g, (char) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        "\"": "&quot;",
        "'": "&#39;"
      })[char]);
    }

    function age(timestamp) {
      if (!timestamp) return "";
      const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
      if (seconds < 60) return `${seconds}s ago`;
      const minutes = Math.round(seconds / 60);
      if (minutes < 60) return `${minutes}m ago`;
      return `${Math.round(minutes / 60)}h ago`;
    }

    function selectedShell() {
      return latestSnapshot?.shell || null;
    }

    function selectedSession(shell = selectedShell()) {
      if (!shell?.sessions?.length) return null;
      return shell.sessions.find((session) => session.id === selectedSessionId)
        || shell.sessions.find((session) => session.id === shell.activeSessionId)
        || shell.sessions[0];
    }

    function supportedReasoningValue(value, fallback = "default") {
      return supportedReasoningModes.includes(value) ? value : fallback;
    }

    async function sendCommand(command) {
      command.commandId ||= globalThis.crypto?.randomUUID?.()
        || `command-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const request = () => fetch("/api/command", {
          method: "POST",
          headers: {
            ...authHeaders(),
            "Content-Type": "application/json",
          },
          body: JSON.stringify(command)
        });
      let response;
      try {
        response = await request();
      } catch {
        response = await request();
      }
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Command failed.");
      toast.textContent = "Command queued locally.";
      setTimeout(() => { toast.textContent = ""; }, 2200);
    }

    function button(command, label, extra = "", className = "secondary") {
      return `<button class="${className}" data-command="${escapeHtml(command)}" ${extra} type="button">${escapeHtml(label)}</button>`;
    }

    function renderCommands(items) {
      if (!items.length) {
        commands.innerHTML = '<p class="empty">No remote commands yet.</p>';
        return;
      }
      commands.innerHTML = items.map((item) => `
        <div class="command">
          <strong>${escapeHtml(item.kind)}</strong>
          ${item.taskId ? `<div>task: ${escapeHtml(item.taskId)}</div>` : ""}
          ${item.sessionId ? `<div>session: ${escapeHtml(item.sessionId)}</div>` : ""}
          ${item.targetPreview ? `<div>${escapeHtml(item.targetPreview)}</div>` : ""}
          ${item.promptPreview ? `<div>${escapeHtml(item.promptPreview)}</div>` : ""}
          <div class="meta">${age(item.createdAt)}</div>
        </div>
      `).join("");
    }

    function renderTasks(items) {
      if (!items.length) {
        tasks.innerHTML = '<p class="empty">No task progress has streamed yet.</p>';
        return;
      }

      tasks.innerHTML = items.map((session) => {
        const isTerminal = terminalStates.has(session.state);
        const logs = [...(session.logs || [])].slice(-8).reverse();
        const timeline = [...(session.timeline || [])].slice(-8).reverse();
        return `
          <article class="task">
            <header>
              <div>
                <strong>${escapeHtml(session.task)}</strong>
                <div class="meta">
                  <span class="pill">${escapeHtml(session.state)}</span>
                  <span class="pill">${escapeHtml(session.mode)}</span>
                  <span>${age(session.updatedAt)}</span>
                </div>
              </div>
            </header>
            <div class="task-body">
              <p class="message">${escapeHtml(session.message)}</p>
              <div class="actions">
                <button class="danger" data-kind="cancel" data-task="${escapeHtml(session.taskId)}" ${session.cancellable ? "" : "disabled"}>Cancel</button>
                <button data-kind="retry" data-task="${escapeHtml(session.taskId)}" ${isTerminal ? "" : "disabled"}>Retry</button>
                <button data-kind="continue" data-task="${escapeHtml(session.taskId)}" ${isTerminal ? "" : "disabled"}>Continue</button>
              </div>
              <form data-followup="${escapeHtml(session.taskId)}">
                <textarea name="prompt" placeholder="Queue a follow-up prompt"></textarea>
                <button type="submit">Queue Follow-up</button>
              </form>
              <div>
                <h3>Streamed Logs</h3>
                <div class="logs">
                  ${logs.length ? logs.map((log) => `<div class="log">${escapeHtml(log.chunk)}</div>`).join("") : '<p class="empty">No stdout or stderr chunks yet.</p>'}
                </div>
              </div>
              <div>
                <h3>Timeline</h3>
                <div class="timeline">
                  ${timeline.length ? timeline.map((entry) => `<div class="event"><strong>${escapeHtml(entry.label)}</strong><div>${escapeHtml(entry.detail || entry.phase)}</div></div>`).join("") : '<p class="empty">No timeline events yet.</p>'}
                </div>
              </div>
            </div>
          </article>
        `;
      }).join("");
    }

    function renderShellSessions(shell) {
      if (!shell?.sessions?.length) {
        shellSessions.innerHTML = '<p class="empty">No desktop sessions yet.</p>';
        return;
      }

      const active = selectedSession(shell);
      selectedSessionId = active?.id || "";
      shellSessions.innerHTML = shell.sessions.map((session) => `
        <button class="item ${session.id === selectedSessionId ? "active" : ""}" data-select-session="${escapeHtml(session.id)}" type="button">
          <strong>${escapeHtml(session.title)}</strong>
          <div class="meta">
            <span class="pill">${escapeHtml(session.status)}</span>
            <span>${escapeHtml(session.provider)} / ${escapeHtml(session.model)}</span>
            ${session.pinnedAt ? '<span class="pill good">pinned</span>' : ""}
          </div>
          <div class="meta">${escapeHtml(session.workspace || "No workspace")}</div>
        </button>
      `).join("");
    }

    function renderRuntime(shell) {
      const runtime = shell?.runtime;
      if (!runtime) {
        runtimePanel.innerHTML = '<p class="empty">No runtime snapshot yet.</p>';
        return;
      }

      runtimePanel.innerHTML = `
        <div class="panel">
          <div class="meta">
            <span class="pill ${runtime.hasAnyProvider ? "good" : "bad"}">${runtime.hasAnyProvider ? "provider ready" : "provider missing"}</span>
            <span class="pill">${escapeHtml(runtime.mode || "mode unknown")}</span>
            ${runtime.loading ? '<span class="pill">loading</span>' : ""}
          </div>
          ${runtime.error ? `<div class="event">${escapeHtml(runtime.error)}</div>` : ""}
          <div class="stack">
            ${(runtime.providerStatuses || []).map((provider) => `
              <div class="meta">
                <span class="pill ${provider.available ? "good" : "bad"}">${escapeHtml(provider.provider)}</span>
                <span>${escapeHtml(provider.available ? "configured" : provider.reason || "not configured")}</span>
              </div>
            `).join("")}
          </div>
          <div class="meta">
            <span class="pill ${runtime.uiControl?.available ? "good" : "bad"}">UI control</span>
            <span>${escapeHtml(runtime.uiControl?.reason || (runtime.uiControl?.available ? "available" : "unavailable"))}</span>
          </div>
          <div class="meta">
            <span class="pill ${runtime.webSearch?.available ? "good" : "bad"}">web search</span>
            <span>${escapeHtml(runtime.webSearch?.reason || (runtime.webSearch?.available ? "available" : "unavailable"))}</span>
          </div>
        </div>
      `;
    }

    function renderSessionHeader(shell) {
      const session = selectedSession(shell);
      if (!session) {
        sessionHeader.innerHTML = '<p class="empty">Select or create a session.</p>';
        return;
      }
      const defaultReasoning = supportedReasoningValue(shell?.composer?.defaultReasoning, "default");
      const effectiveReasoning = session.effectiveReasoning || defaultReasoning;
      const reasoningSource = session.reasoning
        ? `override: ${session.reasoning}`
        : `default: ${defaultReasoning}`;

      sessionHeader.innerHTML = `
        <div class="row">
          <input id="sessionTitle" value="${escapeHtml(session.title)}" aria-label="Session title">
          <button class="secondary" id="saveTitle" type="button">Rename</button>
          ${button("pin-session", session.pinnedAt ? "Unpin" : "Pin", `data-session-id="${escapeHtml(session.id)}" ${session.canPin ? "" : "disabled"}`)}
          ${button("branch-session", "Branch", `data-session-id="${escapeHtml(session.id)}" ${session.canBranch ? "" : "disabled"}`)}
          ${button("duplicate-session", "Duplicate", `data-session-id="${escapeHtml(session.id)}" ${session.canDuplicate ? "" : "disabled"}`)}
          ${button("archive-session", "Archive", `data-session-id="${escapeHtml(session.id)}" ${session.canArchive ? "" : "disabled"}`)}
          ${button("delete-session", "Delete", `data-session-id="${escapeHtml(session.id)}" ${session.canDelete ? "" : "disabled"}`, "danger")}
        </div>
        <div class="meta">
          <span class="pill">${escapeHtml(session.status)}</span>
          <span class="pill">${escapeHtml(session.effectiveMode)}</span>
          <span class="pill">reasoning ${escapeHtml(effectiveReasoning)}</span>
          <span class="pill">${escapeHtml(reasoningSource)}</span>
          <span>${escapeHtml(session.workspace || "No workspace")}</span>
          ${(session.tags || []).map((tag) => `<span class="pill">${escapeHtml(tag)}</span>`).join("")}
        </div>
        <div class="row">
          <input id="tagInput" value="${escapeHtml((session.tags || []).join(", "))}" aria-label="Tags" placeholder="tag, tag">
          <button class="secondary" id="saveTags" type="button">Save Tags</button>
          ${button("clear-session-history", "Clear History", `data-session-id="${escapeHtml(session.id)}"`)}
        </div>
      `;
    }

    function renderConversation(shell) {
      if (!shell?.visibleMessages?.length) {
        conversation.innerHTML = '<p class="empty">No conversation messages yet.</p>';
        return;
      }

      conversation.innerHTML = shell.visibleMessages.map((message) => `
        <article class="message ${escapeHtml(message.role)}">
          <div class="meta">
            <span class="pill">${escapeHtml(message.role)}</span>
            ${message.taskId ? `<span>${escapeHtml(message.taskId)}</span>` : ""}
            ${message.createdAt ? `<span>${age(message.createdAt)}</span>` : ""}
          </div>
          <div class="content">${escapeHtml(message.content)}</div>
          ${(message.attachments || []).length ? `<div class="meta">${message.attachments.map((attachment) => `<span class="pill">${escapeHtml(attachment.kind)}:${escapeHtml(attachment.name)}</span>`).join("")}</div>` : ""}
          ${message.source ? `
            <div class="stack">
              ${(message.source.entries || []).slice(-6).map((entry) => `<div class="trace"><strong>${escapeHtml(entry.label)}</strong><div>${escapeHtml(entry.detail)}</div></div>`).join("")}
              ${(message.source.timeline || []).slice(-6).map((entry) => `<div class="trace"><strong>${escapeHtml(entry.label)}</strong><div>${escapeHtml(entry.detail)}</div></div>`).join("")}
            </div>
          ` : ""}
          <div class="actions">
            <button class="secondary" data-message-action="retry" data-message-id="${escapeHtml(message.id)}" data-task="${escapeHtml(message.taskId || "")}" ${message.actions?.canRetry && message.taskId ? "" : "disabled"}>Retry</button>
            <button class="secondary" data-message-action="continue" data-message-id="${escapeHtml(message.id)}" data-task="${escapeHtml(message.taskId || "")}" ${message.actions?.canContinue && message.taskId ? "" : "disabled"}>Continue</button>
            <button class="secondary" data-message-action="save-message-context-pack" data-message-id="${escapeHtml(message.id)}" ${message.actions?.canSaveAsContextPack ? "" : "disabled"}>Save Pack</button>
            <button class="secondary" data-message-action="${message.actions?.isSpeaking ? "stop-speaking" : "speak-message"}" data-message-id="${escapeHtml(message.id)}" ${message.actions?.canSpeak || message.actions?.isSpeaking ? "" : "disabled"}>${message.actions?.isSpeaking ? "Stop" : "Speak"}</button>
          </div>
        </article>
      `).join("");
    }

    function renderComposer(shell) {
      const composer = shell?.composer;
      const session = selectedSession(shell);
      if (!composer || !session) return;

      if (document.activeElement !== remotePrompt) {
        remotePrompt.value = composer.draft || "";
      }
      providerSelect.innerHTML = (composer.chooserProviders || []).map((provider) => `
        <option value="${escapeHtml(provider)}" ${provider === composer.provider ? "selected" : ""}>${escapeHtml(provider)}</option>
      `).join("");
      if (document.activeElement !== modelInput) {
        modelInput.value = composer.model || "";
      }
      modeSelect.value = session.mode || composer.defaultMode || "machdoch";
      const defaultReasoning = supportedReasoningValue(composer.defaultReasoning, "default");
      const selectedReasoning = supportedReasoningValue(session.reasoning || "default", "default");
      const effectiveReasoning = session.effectiveReasoning || composer.reasoning || defaultReasoning;
      reasoningSelect.value = selectedReasoning;
      composerMeta.innerHTML = `
        <span class="pill ${composer.canSend ? "good" : "bad"}">${composer.canSend ? "ready" : "blocked"}</span>
        <span>${escapeHtml(composer.sendDisabledReason || composer.workspaceLabel || "No workspace")}</span>
        <span class="pill">effective reasoning: ${escapeHtml(effectiveReasoning)}</span>
        <span class="pill">${escapeHtml(session.reasoning ? `session override: ${session.reasoning}` : `default reasoning: ${defaultReasoning}`)}</span>
        <span class="pill ${composer.sessionMemoryEnabled ? "good" : ""}">session memory</span>
        <span class="pill ${composer.globalMemoryEnabled ? "good" : ""}">global memory</span>
        <span class="pill ${composer.uiControlEnabled ? "good" : ""}">UI control</span>
        ${(composer.attachments || []).map((attachment) => `<span class="pill">${escapeHtml(attachment.kind)}:${escapeHtml(attachment.name)} <button data-remove-attachment="${escapeHtml(attachment.id)}" type="button">x</button></span>`).join("")}
        ${(shell.promptHistory || []).slice(-6).reverse().map((prompt) => `<button class="secondary" data-history-prompt="${escapeHtml(prompt)}" type="button">${escapeHtml(prompt.slice(0, 36))}</button>`).join("")}
      `;
    }

    function renderScheduler(shell) {
      const scheduler = shell?.scheduler;
      if (!scheduler) {
        schedulerPanel.innerHTML = '<p class="empty">No scheduler state yet.</p>';
        return;
      }
      const jobs = scheduler.jobs || [];
      const runs = scheduler.runs || [];
      schedulerPanel.innerHTML = `
        <div class="meta">
          <span class="pill">${escapeHtml(scheduler.workspaceRoot || "No workspace")}</span>
          ${scheduler.loading ? '<span class="pill">loading</span>' : ""}
          ${scheduler.error ? `<span class="pill bad">${escapeHtml(scheduler.error)}</span>` : ""}
        </div>
        ${jobs.length ? jobs.slice(0, 8).map((job) => `
          <div class="event">
            <strong>${escapeHtml(job.name)}</strong>
            <div class="meta"><span class="pill">${escapeHtml(job.status)}</span><span>${escapeHtml(job.schedule)}</span></div>
            <div>${escapeHtml(job.promptPreview || "")}</div>
            <div class="actions">
              ${button("scheduler-trigger", "Run", `data-job-id="${escapeHtml(job.id)}" data-workspace="${escapeHtml(scheduler.workspaceRoot || "")}`)}
              ${job.status === "paused"
                ? button("scheduler-resume", "Resume", `data-job-id="${escapeHtml(job.id)}" data-workspace="${escapeHtml(scheduler.workspaceRoot || "")}`)
                : button("scheduler-pause", "Pause", `data-job-id="${escapeHtml(job.id)}" data-workspace="${escapeHtml(scheduler.workspaceRoot || "")}`)}
              ${button("scheduler-delete", "Delete", `data-job-id="${escapeHtml(job.id)}" data-workspace="${escapeHtml(scheduler.workspaceRoot || "")}`, "danger")}
            </div>
          </div>
        `).join("") : '<p class="empty">No scheduler jobs.</p>'}
        ${runs.length ? runs.slice(0, 8).map((run) => `
          <div class="event">
            <strong>${escapeHtml(run.status)}</strong>
            <div class="meta"><span>${escapeHtml(run.id)}</span><span>${age(run.updatedAt)}</span></div>
            ${run.error ? `<div>${escapeHtml(run.error)}</div>` : ""}
            <div class="actions">
              ${button("scheduler-retry-run", "Retry", `data-run-id="${escapeHtml(run.id)}" data-workspace="${escapeHtml(scheduler.workspaceRoot || "")}`)}
              ${button("scheduler-cancel-run", "Cancel", `data-run-id="${escapeHtml(run.id)}" data-workspace="${escapeHtml(scheduler.workspaceRoot || "")}`, "danger")}
            </div>
          </div>
        `).join("") : ""}
      `;
    }

    function renderContextPacks(shell) {
      const packs = shell?.contextPacks || [];
      const session = selectedSession(shell);
      if (!packs.length || !session) {
        contextPacks.innerHTML = '<p class="empty">No context packs for this workspace.</p>';
        return;
      }

      contextPacks.innerHTML = packs.map((pack) => `
        <div class="event">
          <strong>${escapeHtml(pack.name)}</strong>
          <div>${escapeHtml(pack.promptPreview || pack.instructionsPreview || "")}</div>
          <div class="meta">
            <span class="pill">${escapeHtml(pack.scopeLabel || pack.scope || (pack.workspace ? "Workspace" : "Global"))}</span>
            <span class="pill">${pack.attachmentCount} attachments</span>
            ${pack.matched ? '<span class="pill good">matched</span>' : ""}
          </div>
          <div class="actions">
            ${button("apply-context-pack", "Apply", `data-session-id="${escapeHtml(session.id)}" data-context-pack-id="${escapeHtml(pack.id)}"`)}
            ${button("delete-context-pack", "Delete", `data-context-pack-id="${escapeHtml(pack.id)}"`, "danger")}
          </div>
        </div>
      `).join("");
    }

    function renderShell(shell) {
      renderShellSessions(shell);
      renderRuntime(shell);
      renderSessionHeader(shell);
      renderConversation(shell);
      renderComposer(shell);
      renderScheduler(shell);
      renderContextPacks(shell);
    }

    function render(snapshot) {
      latestSnapshot = snapshot;
      connection.textContent = snapshot.enabled ? `Live (${snapshot.sessions.length})` : "Disabled";
      renderShell(snapshot.shell || null);
      renderTasks(snapshot.sessions || []);
      renderCommands(snapshot.commands || []);
    }

"##
}
