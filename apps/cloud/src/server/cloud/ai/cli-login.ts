import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type {
  CloudCliLogin,
  CloudCliProvider,
} from "@machdoch/fleet-protocol/cloud-providers";
import type { CloudActor } from "../../../lib/cloud-contract";
import { CloudError } from "../access";
import {
  cliEnvironment,
  codexFileCredentials,
  defaultCliCommand,
  prepareCliHome,
  stopProcessTree,
  type CliCommand,
} from "./cli-process";
import type { CloudAiProviders } from "./providers";

const loginTimeoutMs = 30 * 60_000;
const statusTimeoutMs = 20_000;
const promptWaitMs = 15_000;
const outputLimit = 16_000;

const loginArgs: Record<CloudCliProvider, string[]> = {
  "claude-code-cli": ["auth", "login"],
  "codex-cli": ["login", "--device-auth", ...codexFileCredentials],
  "copilot-cli": ["login", "--device-code"],
};

const signedOut: CloudCliLogin = {
  state: "signed-out",
  account: null,
  url: null,
  code: null,
  acceptsCode: false,
  message: null,
};

interface CliTarget {
  provider: CloudCliProvider;
  home: string;
}

interface LoginSession {
  child: ChildProcessWithoutNullStreams;
  output: string;
  login: CloudCliLogin;
  timer: NodeJS.Timeout;
}

function plainText(output: string): string {
  return stripVTControlCharacters(output).replace(/\r/g, "");
}

export function parseLoginPrompt(
  provider: CloudCliProvider,
  output: string,
): Pick<CloudCliLogin, "url" | "code" | "acceptsCode"> {
  const text = plainText(output);
  const url = /https:\/\/[^\s"'<>]+/.exec(text)?.[0] ?? null;
  const code =
    provider === "claude-code-cli"
      ? null
      : (/\b[A-Z0-9]{4,}-[A-Z0-9]{4,}\b/.exec(
          text.replace(/https:\/\/\S+/g, ""),
        )?.[0] ?? null);
  return { url, code, acceptsCode: /paste code/i.test(text) };
}

export function loginFailureMessage(output: string): string {
  const lines = plainText(output)
    .replace(/paste code here if prompted\s*>/gi, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return (lines.at(-1) ?? "Sign-in did not complete.").slice(0, 300);
}

export function parseLoginStatus(
  provider: CloudCliProvider,
  exitCode: number | null,
  output: string,
): { signedIn: boolean; account: string | null } {
  if (provider === "claude-code-cli") {
    try {
      const status = JSON.parse(output) as Record<string, unknown>;
      if (status.loggedIn !== true) return { signedIn: false, account: null };
      const account = [status.email, status.orgName].find(
        (value) => typeof value === "string" && value,
      );
      return {
        signedIn: true,
        account:
          (account as string | undefined) ??
          (typeof status.subscriptionType === "string"
            ? `Claude ${status.subscriptionType}`
            : null),
      };
    } catch {
      return { signedIn: false, account: null };
    }
  }
  if (provider === "codex-cli") {
    const match = /Logged in using (.+)/i.exec(plainText(output));
    return exitCode === 0 && match
      ? { signedIn: true, account: match[1]!.trim() }
      : { signedIn: false, account: null };
  }
  try {
    const config = JSON.parse(output.replace(/^\s*\/\/.*$/gm, "")) as Record<
      string,
      unknown
    >;
    const user = config.lastLoggedInUser as Record<string, unknown> | undefined;
    return typeof user?.login === "string"
      ? { signedIn: true, account: user.login }
      : { signedIn: false, account: null };
  } catch {
    return { signedIn: false, account: null };
  }
}

function runOnce(
  command: CliCommand,
  args: string[],
  target: CliTarget,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command.file, [...command.prefixArgs, ...args], {
      cwd: target.home,
      env: cliEnvironment(target.provider, target.home),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => stopProcessTree(child.pid), statusTimeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = (stdout + chunk.toString("utf8")).slice(-outputLimit);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-outputLimit);
    });
    child.once("error", () => {
      clearTimeout(timer);
      resolve({ exitCode: null, stdout, stderr });
    });
    child.once("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr });
    });
  });
}

export class CloudCliLogins {
  private readonly sessions = new Map<string, LoginSession>();

  constructor(
    private readonly providers: CloudAiProviders,
    private readonly command: (
      provider: CloudCliProvider,
    ) => CliCommand = defaultCliCommand,
  ) {}

  async get(actor: CloudActor, id: string): Promise<CloudCliLogin> {
    const target = await this.providers.cliProvider(actor, id);
    const session = this.sessions.get(this.key(actor, id));
    if (session?.login.state === "waiting") return session.login;
    const status = await this.status(target);
    if (status.signedIn)
      return { ...signedOut, state: "signed-in", account: status.account };
    return session?.login ?? signedOut;
  }

  async start(actor: CloudActor, id: string): Promise<CloudCliLogin> {
    const target = await this.providers.cliProvider(actor, id);
    const key = this.key(actor, id);
    this.stop(key);
    await prepareCliHome(target.home);
    const command = this.command(target.provider);
    const child = spawn(
      command.file,
      [...command.prefixArgs, ...loginArgs[target.provider]],
      {
        cwd: target.home,
        env: cliEnvironment(target.provider, target.home),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        detached: process.platform !== "win32",
      },
    );
    const session: LoginSession = {
      child,
      output: "",
      login: { ...signedOut, state: "waiting" },
      timer: setTimeout(() => {
        stopProcessTree(child.pid);
        this.fail(session, "Sign-in timed out. Start it again.");
      }, loginTimeoutMs),
    };
    session.timer.unref();
    this.sessions.set(key, session);
    const append = (chunk: Buffer) => {
      session.output = (session.output + chunk.toString("utf8")).slice(
        -outputLimit,
      );
      if (session.login.state === "waiting")
        session.login = {
          ...session.login,
          ...parseLoginPrompt(target.provider, session.output),
        };
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.stdin.on("error", () => undefined);
    child.once("error", (error: NodeJS.ErrnoException) =>
      this.fail(
        session,
        error.code === "ENOENT"
          ? "The CLI is not installed on the cloud host."
          : error.message,
      ),
    );
    child.once(
      "close",
      (exitCode) => void this.settle(target, session, exitCode),
    );
    await this.waitWhile(
      () => session.login.state === "waiting" && !session.login.url,
      promptWaitMs,
    );
    return session.login;
  }

  async submitCode(
    actor: CloudActor,
    id: string,
    code: string,
  ): Promise<CloudCliLogin> {
    await this.providers.cliProvider(actor, id);
    const session = this.sessions.get(this.key(actor, id));
    if (session?.login.state !== "waiting" || !session.login.acceptsCode)
      throw new CloudError(
        409,
        "cli_login_inactive",
        "Start the sign-in again before entering a code.",
      );
    session.child.stdin.write(`${code}\n`);
    await this.waitWhile(() => session.login.state === "waiting", promptWaitMs);
    return session.login.state === "waiting"
      ? session.login
      : this.get(actor, id);
  }

  async cancel(actor: CloudActor, id: string): Promise<CloudCliLogin> {
    await this.providers.cliProvider(actor, id);
    this.stop(this.key(actor, id));
    return this.get(actor, id);
  }

  close(): void {
    for (const key of [...this.sessions.keys()]) this.stop(key);
  }

  private key(actor: CloudActor, id: string): string {
    return `${actor.organizationId}/${id}`;
  }

  private stop(key: string): void {
    const session = this.sessions.get(key);
    if (!session) return;
    this.sessions.delete(key);
    clearTimeout(session.timer);
    if (session.child.exitCode === null) stopProcessTree(session.child.pid);
  }

  private fail(session: LoginSession, message: string): void {
    clearTimeout(session.timer);
    if (session.login.state === "waiting")
      session.login = { ...signedOut, state: "failed", message };
  }

  private async settle(
    target: CliTarget,
    session: LoginSession,
    exitCode: number | null,
  ): Promise<void> {
    clearTimeout(session.timer);
    if (session.login.state !== "waiting") return;
    if (exitCode !== 0) {
      this.fail(session, loginFailureMessage(session.output));
      return;
    }
    const status = await this.status(target);
    session.login = status.signedIn
      ? { ...signedOut, state: "signed-in", account: status.account }
      : {
          ...signedOut,
          state: "failed",
          message: "Sign-in did not complete.",
        };
  }

  private async status(
    target: CliTarget,
  ): Promise<{ signedIn: boolean; account: string | null }> {
    if (target.provider === "copilot-cli") {
      const config = await readFile(
        join(target.home, "config.json"),
        "utf8",
      ).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return "";
        throw error;
      });
      return parseLoginStatus(target.provider, 0, config);
    }
    await prepareCliHome(target.home);
    const { exitCode, stdout, stderr } = await runOnce(
      this.command(target.provider),
      target.provider === "claude-code-cli"
        ? ["auth", "status", "--json"]
        : ["login", "status", ...codexFileCredentials],
      target,
    );
    return parseLoginStatus(
      target.provider,
      exitCode,
      target.provider === "claude-code-cli" ? stdout : `${stdout}${stderr}`,
    );
  }

  private async waitWhile(
    pending: () => boolean,
    timeoutMs: number,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (pending() && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
