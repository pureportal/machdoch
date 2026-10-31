const CLAUDE_AUTHENTICATION_FAILURE_PATTERN =
  /^(?:Failed to authenticate: OAuth session expired and could not be refreshed|(?:Not logged in|Login expired) · Please run \/login|Authentication required · Sign in again to continue)$/u;

export const isClaudeAuthenticationFailure = (lastMessage: string): boolean =>
  CLAUDE_AUTHENTICATION_FAILURE_PATTERN.test(
    lastMessage.trim().split(/\r?\n/u).at(-1)?.trim() ?? "",
  );

export const CLAUDE_AUTHENTICATION_RECOVERY =
  "Claude sign-in is required. Run `claude auth login` on this machine as the same OS user running Machdoch, then retry the task.";
