import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveMachdochCliLaunch } from "../core/provider-enrollment/machdoch-cli-launch.js";

let root: string;
const children: ChildProcess[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "machdoch-cli-completion-"));
});

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await new Promise<void>((resolve) =>
        child.once("close", () => resolve()),
      );
    }
  }
  await rm(root, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 50,
  });
});

const launch = async (runner: string) => {
  const entry = fileURLToPath(new URL("./main.ts", import.meta.url));
  const descriptor = resolveMachdochCliLaunch({
    execPath: process.execPath,
    execArgv: ["--import", "@oxc-node/core/register"],
    argv: [process.execPath, entry],
    cwd: root,
    environment: {},
  });
  const fixtureEntry = join(root, "completion-main.ts");
  const fixture = join(root, "completion-runner.mjs");
  const source = await readFile(entry, "utf8");
  await writeFile(join(root, "package.json"), '{"type":"module"}');
  await writeFile(fixture, runner);
  await writeFile(
    fixtureEntry,
    source
      .replace('"./app.js"', '"./completion-runner.mjs"')
      .replace(
        '"./_helpers/cli-error.js"',
        JSON.stringify(
          new URL("./_helpers/cli-error.ts", import.meta.url).href,
        ),
      )
      .replace(
        '"./_helpers/cli-terminal.js"',
        JSON.stringify(
          new URL("./_helpers/cli-terminal.ts", import.meta.url).href,
        ),
      ),
  );
  const child = spawn(
    descriptor.command,
    [...descriptor.args.slice(0, -1), fixtureEntry, "--json", "run", "fixture"],
    { cwd: root, stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
  );
  children.push(child);
  let stdout = "";
  let stderr = "";
  child.stdout!.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr!.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  child.stdin!.end();
  return { child, closed, stdout: () => stdout, stderr: () => stderr };
};

describe("one-shot CLI process completion", () => {
  it.each([0, 130])(
    "flushes the complete answer and exits with code %s despite a leftover timer",
    async (exitCode) => {
      const text = "Completed ✓ ".repeat(30_000);
      const run = await launch(`export async function runCli() {
        setInterval(() => {}, 60_000);
        process.exitCode = ${exitCode};
        process.stdout.write(JSON.stringify({ execution: { response: { markdown: ${JSON.stringify(text)} } } }));
        return "run";
      }`);
      await vi.waitFor(() => expect(run.child.exitCode).toBe(exitCode), {
        timeout: 10_000,
      });
      expect(await run.closed).toBe(exitCode);
      expect(JSON.parse(run.stdout()).execution.response.markdown).toBe(text);
      expect(run.stderr()).toBe("");
    },
  );

  it("flushes a task error and exits despite a leftover timer", async () => {
    const run = await launch(`export async function runCli() {
      setInterval(() => {}, 60_000);
      throw new Error("Fixture failure");
    }`);
    await vi.waitFor(() => expect(run.child.exitCode).toBe(1), {
      timeout: 10_000,
    });
    expect(await run.closed).toBe(1);
    expect(JSON.parse(run.stderr())).toEqual({
      error: "Fixture failure",
      exitCode: 1,
    });
  });

  it("keeps an MCP server alive after its startup command returns", async () => {
    const run = await launch(`export async function runCli() {
      setInterval(() => {}, 60_000);
      process.stdout.write("Listening");
      return "mcp";
    }`);
    await vi.waitFor(() => expect(run.stdout()).toBe("Listening"), {
      timeout: 10_000,
    });
    expect(run.child.exitCode).toBeNull();
    expect(run.child.signalCode).toBeNull();
  });
});
