const labels: Readonly<Record<string, string>> = {
  "answer-language": "Answer language",
  "workspace.mode": "Mode",
  "workspace.provider": "Provider",
  "workspace.model": "Model",
  "workspace.reasoning": "Reasoning",
  "workspace.reasoning-mode": "Reasoning mode",
  "workspace.context-window": "Context window",
  "workspace.offline": "Offline",
  "workspace.github-customizations": "GitHub prompts and skills",
  "workspace.auto-gitignore": "Automatic .gitignore rules",
  "web-search.provider": "Search provider",
  "agent-limits.infinite": "Unlimited agent turns",
  "agent-limits.executor-turns": "Executor turns",
  "agent-limits.autopilot-iterations": "Continuation cycles",
  "review-model": "Review model",
  "memory.global": "Global memory",
  "fleet.enabled": "Fleet connection",
  "voice.provider": "Voice provider",
  "speech-to-text.provider": "Speech recognition provider",
  "speech-to-text.input-device": "Microphone",
  "desktop.autostart-minimized": "Start minimized",
  "desktop.autostart-to-tray": "Start in tray",
  "desktop.always-run-as-administrator": "Run as administrator",
  "desktop.ai-context-max-messages": "AI context cap",
  "desktop.chat-idle-timeout-minutes": "Inactivity timeout (minutes)",
  "desktop.inactive-session-archive-days": "Inactive archive (days)",
  "desktop.archived-session-retention-days": "Archived cleanup (days)",
  "desktop.quick-voice-enabled": "Quick Chat",
  "desktop.quick-voice-shortcut": "Quick Chat shortcut",
  "desktop.quick-voice-silence-seconds": "Recording silence (seconds)",
  "desktop.quick-voice-max-messages": "Quick Chat context cap",
  "workspace-run.startup-delay-ms": "Startup delay (ms)",
  "workspace-run.health-check-interval-ms": "Health check interval (ms)",
  "workspace-run.health-check-timeout-ms": "Health check timeout (ms)",
  "workspace-run.health-check-failure-threshold":
    "Health check failure threshold",
  "workspace-run.sequential-readiness-timeout-ms": "Readiness timeout (ms)",
};

export const configSettingLabel = (setting: string): string => {
  if (labels[setting]) return labels[setting];
  const api = /^(?:api|web-search)\.(.+)\.key$/u.exec(setting);
  if (api) return `${api[1]} API key`;
  const cli = /^agent-cli\.(.+)\.path$/u.exec(setting);
  if (cli) return `${cli[1]} executable`;
  return setting;
};
