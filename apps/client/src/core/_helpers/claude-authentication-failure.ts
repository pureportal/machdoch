const CLAUDE_LOGIN_REFRESH_BUSY_PREFIX =
  "Failed to refresh OAuth token: another Claude Code process is refreshing it";

const EXPLICIT_CLAUDE_CREDENTIAL_KEYS = [
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
] as const;

export const isClaudeLoginRefreshBusy = (message: string): boolean =>
  message.startsWith(CLAUDE_LOGIN_REFRESH_BUSY_PREFIX);

export const createClaudeAuthenticationRecovery = (
  cliMessage: string,
  environment: NodeJS.ProcessEnv = process.env,
): string => {
  const credentialKey = EXPLICIT_CLAUDE_CREDENTIAL_KEYS.find((key) =>
    environment[key]?.trim(),
  );
  return credentialKey
    ? `${cliMessage.trim()} Replace the credential in ${credentialKey}, then retry the task.`
    : "Claude sign-in is required. Run `claude auth login` on this machine as the same OS user running Machdoch, then retry the task.";
};
