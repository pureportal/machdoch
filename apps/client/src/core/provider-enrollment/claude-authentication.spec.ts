import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { linkClaudeAuthentication } from "./claude-authentication.js";

let root: string;
let sourceHome: string;
let sourcePath: string;
let isolatedHome: string;
const login = JSON.stringify({ claudeAiOauth: { accessToken: "fixture-access", refreshToken: "fixture-refresh" } });
const refreshed = JSON.stringify({ claudeAiOauth: { accessToken: "refreshed-access", refreshToken: "refreshed-refresh" } });

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "machdoch-claude-auth-test-"));
  sourceHome = join(root, "source");
  sourcePath = join(sourceHome, ".credentials.json");
  isolatedHome = join(root, "run");
  await Promise.all([mkdir(sourceHome), mkdir(isolatedHome)]);
  vi.stubEnv("CLAUDE_CONFIG_DIR", sourceHome);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe("Claude authentication sharing", () => {
  it("gives the isolated config the login and writes refreshes through", async () => {
    await writeFile(sourcePath, login, { mode: 0o600 });

    expect(await linkClaudeAuthentication(isolatedHome)).toBe(true);
    const isolatedPath = join(isolatedHome, ".credentials.json");
    expect(await readFile(isolatedPath, "utf8")).toBe(login);

    await writeFile(isolatedPath, refreshed);
    expect(await readFile(sourcePath, "utf8")).toBe(refreshed);
    await rm(isolatedHome, { recursive: true });
    expect(await readFile(sourcePath, "utf8")).toBe(refreshed);
  });

  it("leaves the run without credentials when the login is not a file", async () => {
    expect(await linkClaudeAuthentication(isolatedHome)).toBe(false);
    await expect(lstat(join(isolatedHome, ".credentials.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects a credentials path that is not a regular file", async () => {
    await mkdir(sourcePath);
    await expect(linkClaudeAuthentication(isolatedHome)).rejects.toThrow(
      "must be a regular, unlinked file",
    );
  });
});
