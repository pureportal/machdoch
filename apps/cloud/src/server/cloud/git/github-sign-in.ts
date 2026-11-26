import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { CloudCliLogin } from "@machdoch/fleet-protocol/cloud-providers";
import type { CloudActor } from "../../../lib/cloud-contract";
import { defaultGitApiUrls } from "../../../lib/git-providers";
import { requireMembership } from "../access";
import type { CliCommand } from "../ai/cli-process";
import type { CloudDatabase } from "../database";
import type { CloudGitAccounts } from "./accounts";

const signInTimeoutMs = 15 * 60_000;
const promptWaitMs = 15_000;
const outputLimit = 16_000;
const githubHost = "github.com";
const passedEnvironment = [
  "PATH",
  "Path",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "SystemRoot",
  "ComSpec",
  "PATHEXT",
  "TEMP",
  "TMP",
];

const accountScopes = ["repo", "workflow", "read:org"];

const signedOut: CloudCliLogin = {
  state: "signed-out",
  account: null,
  url: null,
  code: null,
  acceptsCode: false,
  message: null,
};

interface SignInSession {
  child: ChildProcessWithoutNullStreams;
  closed: Promise<void>;
  configDirectory: string;
  cleanup: Promise<void> | null;
  output: string;
  login: CloudCliLogin;
  timer: NodeJS.Timeout;
}

function plainText(output: string): string {
  return stripVTControlCharacters(output).replace(/\r/g, "");
}

function failureMessage(output: string): string {
  const line = plainText(output)
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .at(-1);
  return (line ?? "Sign-in did not complete.").slice(0, 300);
}

function githubEnvironment(configDirectory: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { NODE_ENV: process.env.NODE_ENV };
  for (const name of passedEnvironment)
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  return {
    ...environment,
    GH_CONFIG_DIR: configDirectory,
    GH_PROMPT_DISABLED: "1",
    GH_NO_UPDATE_NOTIFIER: "1",
  };
}

function readToken(
  command: CliCommand,
  configDirectory: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      command.file,
      [...command.prefixArgs, "auth", "token", "--hostname", githubHost],
      {
        env: githubEnvironment(configDirectory),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (exitCode) =>
      exitCode === 0 && stdout.trim()
        ? resolve(stdout.trim())
        : reject(new Error(failureMessage(stderr))),
    );
  });
}

export class CloudGitHubSignIn {
  private readonly sessions = new Map<string, SignInSession>();

  constructor(
    private readonly database: CloudDatabase,
    private readonly accounts: CloudGitAccounts,
    private readonly command: CliCommand = { file: "gh", prefixArgs: [] },
  ) {}

  async get(actor: CloudActor): Promise<CloudCliLogin> {
    await this.authorize(actor);
    return this.sessions.get(this.key(actor))?.login ?? signedOut;
  }

  async start(actor: CloudActor): Promise<CloudCliLogin> {
    await this.authorize(actor);
    const key = this.key(actor);
    await this.stop(key);
    const configDirectory = await mkdtemp(join(tmpdir(), "machdoch-github-"));
    const child = spawn(
      this.command.file,
      [
        ...this.command.prefixArgs,
        "auth",
        "login",
        "--hostname",
        githubHost,
        "--git-protocol",
        "https",
        "--web",
        "--insecure-storage",
        "--scopes",
        accountScopes.join(","),
      ],
      {
        env: githubEnvironment(configDirectory),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    const session: SignInSession = {
      child,
      closed: new Promise((resolve) => child.once("close", () => resolve())),
      configDirectory,
      cleanup: null,
      output: "",
      login: { ...signedOut, state: "waiting" },
      timer: setTimeout(() => {
        child.kill();
        this.fail(session, "Sign-in timed out. Start it again.");
      }, signInTimeoutMs),
    };
    session.timer.unref();
    this.sessions.set(key, session);
    const append = (chunk: Buffer) => {
      session.output = (session.output + chunk.toString("utf8")).slice(
        -outputLimit,
      );
      if (session.login.state !== "waiting") return;
      const text = plainText(session.output);
      session.login = {
        ...session.login,
        url: /https:\/\/[^\s"'<>]+/.exec(text)?.[0] ?? null,
        code: /\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/.exec(text)?.[0] ?? null,
      };
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.stdin.on("error", () => undefined);
    child.once("error", (error: NodeJS.ErrnoException) =>
      this.fail(
        session,
        error.code === "ENOENT"
          ? "The GitHub CLI is not installed on this server."
          : error.message,
      ),
    );
    child.once(
      "close",
      (exitCode) => void this.settle(actor, session, exitCode),
    );
    const deadline = Date.now() + promptWaitMs;
    while (
      session.login.state === "waiting" &&
      !(session.login.url && session.login.code) &&
      Date.now() < deadline
    )
      await new Promise((resolve) => setTimeout(resolve, 100));
    return session.login;
  }

  async cancel(actor: CloudActor): Promise<CloudCliLogin> {
    await this.authorize(actor);
    await this.stop(this.key(actor));
    return signedOut;
  }

  async close(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((key) => this.stop(key)));
  }

  private authorize(actor: CloudActor): Promise<void> {
    return this.database.transaction(async (sql) => {
      await requireMembership(sql, actor);
    });
  }

  private key(actor: CloudActor): string {
    return `${actor.organizationId}/${actor.userId}`;
  }

  private async stop(key: string): Promise<void> {
    const session = this.sessions.get(key);
    if (!session) return;
    this.sessions.delete(key);
    clearTimeout(session.timer);
    this.fail(session, "Sign-in canceled.");
    session.child.kill();
    await session.closed;
    await this.cleanup(session);
  }

  private cleanup(session: SignInSession): Promise<void> {
    return (session.cleanup ??= rm(session.configDirectory, {
      recursive: true,
      force: true,
      maxRetries: 3,
    }));
  }

  private fail(session: SignInSession, message: string): void {
    clearTimeout(session.timer);
    if (session.login.state === "waiting")
      session.login = { ...signedOut, state: "failed", message };
  }

  private async settle(
    actor: CloudActor,
    session: SignInSession,
    exitCode: number | null,
  ): Promise<void> {
    clearTimeout(session.timer);
    try {
      if (session.login.state !== "waiting") return;
      if (exitCode !== 0) {
        this.fail(session, failureMessage(session.output));
        return;
      }
      const token = await readToken(this.command, session.configDirectory);
      if (session.login.state !== "waiting") return;
      const account = await this.link(actor, token);
      session.login = { ...signedOut, state: "signed-in", account };
    } catch (error) {
      this.fail(
        session,
        error instanceof Error ? error.message : "Sign-in did not complete.",
      );
    } finally {
      await this.cleanup(session);
    }
  }

  private async link(actor: CloudActor, token: string): Promise<string> {
    const current = (await this.accounts.get(actor)).accounts.github;
    await this.accounts.connect(actor, "github", {
      revision: current?.revision ?? 0,
      apiUrl: defaultGitApiUrls.github,
      token,
    });
    return (await this.accounts.get(actor)).accounts.github!.login;
  }
}
