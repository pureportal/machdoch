pub(super) fn mission_control_script_events() -> &'static str {
    r##"    remotePromptForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const prompt = remotePrompt.value.trim();
      if (!prompt) return;
      remotePrompt.value = "";
      const session = selectedSession();
      void sendCommand({
        kind: "follow-up",
        sessionId: session?.id,
        prompt
      }).catch((error) => { toast.textContent = error.message; });
    });

    tasks.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-kind]");
      if (!button) return;
      void sendCommand({
        kind: button.dataset.kind,
        taskId: button.dataset.task
      }).catch((error) => { toast.textContent = error.message; });
    });

    tasks.addEventListener("submit", (event) => {
      const form = event.target.closest("form[data-followup]");
      if (!form) return;
      event.preventDefault();
      const textarea = form.elements.prompt;
      const prompt = textarea.value.trim();
      if (!prompt) return;
      textarea.value = "";
      void sendCommand({
        kind: "follow-up",
        taskId: form.dataset.followup,
        prompt
      }).catch((error) => { toast.textContent = error.message; });
    });

    shellSessions.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-select-session]");
      if (!button) return;
      selectedSessionId = button.dataset.selectSession;
      render(latestSnapshot);
      void sendCommand({ kind: "activate-session", sessionId: selectedSessionId })
        .catch((error) => { toast.textContent = error.message; });
    });

    document.addEventListener("click", (event) => {
      const commandButton = event.target.closest("button[data-command]");
      if (commandButton) {
        void sendCommand({
          kind: commandButton.dataset.command,
          sessionId: commandButton.dataset.sessionId,
          jobId: commandButton.dataset.jobId,
          runId: commandButton.dataset.runId,
          contextPackId: commandButton.dataset.contextPackId,
          workspace: commandButton.dataset.workspace
        }).catch((error) => { toast.textContent = error.message; });
        return;
      }

      const selected = selectedSession();
      if (!selected) return;

      if (event.target.closest("#saveTitle")) {
        const title = document.getElementById("sessionTitle")?.value || "";
        void sendCommand({ kind: "rename-session", sessionId: selected.id, title })
          .catch((error) => { toast.textContent = error.message; });
        return;
      }

      if (event.target.closest("#saveTags")) {
        const tags = (document.getElementById("tagInput")?.value || "")
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean);
        void sendCommand({ kind: "tag-session", sessionId: selected.id, tags })
          .catch((error) => { toast.textContent = error.message; });
        return;
      }

      if (event.target.closest("#saveDraft")) {
        void sendCommand({ kind: "update-draft", sessionId: selected.id, prompt: remotePrompt.value })
          .catch((error) => { toast.textContent = error.message; });
        return;
      }

      if (event.target.closest("#cancelActiveTask")) {
        const taskId = selected.runningTaskId;
        if (taskId) {
          void sendCommand({ kind: "cancel", taskId }).catch((error) => { toast.textContent = error.message; });
        }
        return;
      }

      const toggle = event.target.closest("button[data-toggle]");
      if (toggle) {
        const composer = selectedShell()?.composer;
        const toggleKind = toggle.dataset.toggle;
        const command = toggleKind === "session-memory"
          ? { kind: "set-session-memory", enabled: !composer?.sessionMemoryEnabled }
          : toggleKind === "global-memory"
            ? { kind: "set-global-memory", enabled: !composer?.globalMemoryEnabled }
            : { kind: "set-ui-control", enabled: !composer?.uiControlEnabled };
        void sendCommand({ ...command, sessionId: selected.id }).catch((error) => { toast.textContent = error.message; });
        return;
      }

      const attachment = event.target.closest("button[data-remove-attachment]");
      if (attachment) {
        void sendCommand({ kind: "remove-attachment", sessionId: selected.id, attachmentId: attachment.dataset.removeAttachment })
          .catch((error) => { toast.textContent = error.message; });
        return;
      }

      const historyPrompt = event.target.closest("button[data-history-prompt]");
      if (historyPrompt) {
        remotePrompt.value = historyPrompt.dataset.historyPrompt || "";
      }
    });

    document.addEventListener("change", (event) => {
      const selected = selectedSession();
      if (!selected) return;

      if (event.target === providerSelect || event.target === modelInput) {
        const provider = providerSelect.value;
        const model = modelInput.value.trim();
        if (provider && model) {
          void sendCommand({ kind: "set-session-model", sessionId: selected.id, provider, model })
            .catch((error) => { toast.textContent = error.message; });
        }
        return;
      }

      if (event.target === modeSelect) {
        if (modeSelect.value === "ask" || modeSelect.value === "machdoch") {
          void sendCommand({ kind: "set-session-mode", sessionId: selected.id, mode: modeSelect.value })
            .catch((error) => { toast.textContent = error.message; });
        }
        return;
      }

      if (event.target === reasoningSelect) {
        if (supportedReasoningModes.includes(reasoningSelect.value)) {
          void sendCommand({ kind: "set-session-reasoning", sessionId: selected.id, reasoning: reasoningSelect.value })
            .catch((error) => { toast.textContent = error.message; });
        }
      }
    });

    conversation.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-message-action]");
      if (!button) return;
      const session = selectedSession();
      if (!session) return;
      const action = button.dataset.messageAction;
      if (action === "retry" || action === "continue") {
        void sendCommand({ kind: action, taskId: button.dataset.task })
          .catch((error) => { toast.textContent = error.message; });
        return;
      }
      void sendCommand({
        kind: action,
        sessionId: session.id,
        messageId: button.dataset.messageId
      }).catch((error) => { toast.textContent = error.message; });
    });

    document.getElementById("createSession").addEventListener("click", () => {
      void sendCommand({ kind: "create-session", workspace: selectedShell()?.composer?.workspace })
        .catch((error) => { toast.textContent = error.message; });
    });

    void establishSession()
      .then(() => fetch(api("/api/status"), { headers: authHeaders() }))
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("This browser is not paired. Open the latest QR/link from desktop.")))
      .then(render)
      .then(() => {
        const events = new EventSource(api("/api/events"), { withCredentials: true });
        events.addEventListener("snapshot", (event) => render(JSON.parse(event.data)));
        events.onerror = () => { connection.textContent = "Reconnecting"; };
      })
      .catch((error) => { connection.textContent = error.message; });
"##
}
