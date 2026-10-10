const CODEX_AUTHENTICATION_FAILURE_PATTERN =
  /refresh_token_(?:reused|expired|invalidated)|Your access token could not be refreshed|not logged in|Please (?:log in|sign in) (?:to|with) (?:Codex|ChatGPT)|auth_token_missing/iu;

export const isCodexAuthenticationFailure = (diagnostic: string): boolean =>
  diagnostic
    .split(/\r?\n/u)
    .some(
      (line) =>
        !/\bmcp\b|\bmcp[_:]/iu.test(line) &&
        CODEX_AUTHENTICATION_FAILURE_PATTERN.test(line),
    );

export const CODEX_AUTHENTICATION_RECOVERY =
  'Codex sign-in is required. Run `codex -c cli_auth_credentials_store="file" login --device-auth` on this machine as the same OS user running Machdoch, using your usual CODEX_HOME, then retry the task.';
