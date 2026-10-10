# Codex authentication investigation

Machdoch was treating an unrecoverable Codex sign-in failure as an ordinary task failure. That allowed automatic task retries, Ralph's default infinite retries, explicit error loops, and scheduler retries to repeatedly start Codex with the same unusable credentials. The process also forwarded repeated authentication diagnostics until Codex exited.

The fix stops the Codex process tree after a permanent authentication diagnostic, displays one recovery message, and returns an authentication blocker. Ralph retains a checkpoint for manual resume and marks the run as unsuitable for automatic retry. Goal execution also stops before asking the same unauthenticated provider to evaluate the result. A successful resumed attempt supersedes the saved authentication failure.

## Credential storage

The existing credential-sharing fix, commit `4b863874`, already links each isolated run's `auth.json` to the saved login. Codex owns OAuth refresh; Machdoch does not implement or call OpenAI's refresh endpoint. Codex's current file backend truncates and writes through that link, so refreshed credentials survive both failed tasks and cleanup. A local fixture using Codex CLI 0.159.1 confirmed this behavior without using an actual account.

An isolated `CODEX_HOME` cannot reuse the original home's keyring entry: Codex derives that entry's identifier from the canonical home path. Machdoch's isolated runs therefore consistently select file credentials. Keyring-only sign-in remains unsupported by this adapter; its recovery command explicitly creates a file login rather than signing into an unrelated keyring entry:

```sh
codex -c 'cli_auth_credentials_store="file"' login --device-auth
```

Run this on the machine running Machdoch, as the same OS user, with the usual provider `CODEX_HOME`. A different OS user, machine, or credential directory has a different saved login. Already invalidated credentials require interactive sign-in; the application cannot repair them automatically.

## Upstream findings

- [OpenAI authentication documentation](https://developers.openai.com/codex/auth) describes cached credentials, automatic refresh, file/keyring storage, and device sign-in for headless machines.
- [OpenAI app-server documentation](https://developers.openai.com/codex/app-server) distinguishes Codex-managed ChatGPT authentication from externally managed tokens. Machdoch uses the managed credentials, so it should leave token renewal to Codex.
- [OpenAI's authentication retry-storm fix](https://github.com/openai/codex/pull/15530), merged March 24, 2026, makes permanent refresh failures terminal for the current in-memory authentication snapshot. Repeatedly starting new processes still creates new snapshots, so Machdoch must also stop its own retries.
- [Codex credential storage implementation](https://github.com/openai/codex/blob/main/codex-rs/login/src/auth/storage.rs) confirms file writes and keyring identifiers derived from `CODEX_HOME`.
- [OpenAI's response to the proposed concurrent-refresh diagnosis](https://github.com/openai/codex/issues/10332) explains that the server permits brief refresh-token reuse. Simultaneous processes alone do not prove the cause of this error. Stale credential copies and actual upstream failures must be distinguished from an immediate race.

## Verification limits

Regression coverage includes permanent versus transient errors, MCP authentication exclusions, structured errors, split stderr chunks, bounded diagnostics, Windows process-tree termination, simulated Unix process-group termination, infinite flow retries, scheduler outcome classification, and manual resume after sign-in. Existing credential tests cover concurrent sharing, refreshed credentials, new login replacement, and cleanup.

No live account was logged out or refreshed during this investigation. Native Linux execution could not run because the available WSL distributions reference missing disk files (`ERROR_PATH_NOT_FOUND`). The cause of the user's actual token invalidation therefore remains unconfirmed; the application retry storm and isolated-home storage mismatch are established implementation findings.
