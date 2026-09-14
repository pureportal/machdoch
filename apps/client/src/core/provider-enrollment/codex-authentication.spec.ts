import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeFileAtomically } from "../_helpers/write-file-atomically.helper.js";
import { linkCodexAuthentication } from "./codex-authentication.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, symlink: vi.fn(actual.symlink) };
});

let root: string;
let sourceHome: string;
let sourcePath: string;
let isolatedHome: string;
const initialAuthentication = JSON.stringify({
  tokens: { access_token: "fixture-access", refresh_token: "fixture-refresh" },
});
const refreshedAuthentication = JSON.stringify({
  tokens: {
    access_token: "refreshed-access",
    refresh_token: "refreshed-token",
  },
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "machdoch-codex-auth-test-"));
  sourceHome = join(root, "source");
  sourcePath = join(sourceHome, "auth.json");
  isolatedHome = join(root, "run");
  await Promise.all([mkdir(sourceHome), mkdir(isolatedHome)]);
  vi.stubEnv("CODEX_HOME", sourceHome);
  vi.mocked(symlink).mockClear();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe("Codex authentication sharing", () => {
  it("persists native token refreshes immediately and keeps source permissions", async () => {
    await writeFile(sourcePath, initialAuthentication, { mode: 0o600 });
    expect(await linkCodexAuthentication(isolatedHome)).toBe(true);
    const isolatedPath = join(isolatedHome, "auth.json");
    expect((await lstat(isolatedPath)).isSymbolicLink()).toBe(true);
    expect(await realpath(isolatedPath)).toBe(await realpath(sourcePath));

    await writeFile(isolatedPath, refreshedAuthentication);

    expect(await readFile(sourcePath, "utf8")).toBe(refreshedAuthentication);
    if (process.platform !== "win32") {
      expect((await stat(sourcePath)).mode & 0o777).toBe(0o600);
    }
    await rm(isolatedHome, { recursive: true });
    expect(await readFile(sourcePath, "utf8")).toBe(refreshedAuthentication);
  });

  it("shares refreshes across concurrent runs and keeps a newer login during cleanup", async () => {
    await writeFile(sourcePath, initialAuthentication);
    const otherHome = join(root, "other-run");
    await mkdir(otherHome);
    await Promise.all([
      linkCodexAuthentication(isolatedHome),
      linkCodexAuthentication(otherHome),
    ]);
    await writeFile(join(isolatedHome, "auth.json"), refreshedAuthentication);
    expect(await readFile(join(otherHome, "auth.json"), "utf8")).toBe(
      refreshedAuthentication,
    );

    const newLogin = '{"tokens":{"refresh_token":"new-login"}}';
    await writeFileAtomically(sourcePath, newLogin);
    expect(await readFile(join(isolatedHome, "auth.json"), "utf8")).toBe(
      newLogin,
    );
    expect(await readFile(join(otherHome, "auth.json"), "utf8")).toBe(newLogin);
    await rm(isolatedHome, { recursive: true });
    expect(await readFile(sourcePath, "utf8")).toBe(newLogin);
    expect(await readFile(join(otherHome, "auth.json"), "utf8")).toBe(newLogin);
  });

  it("does not create credentials when there is no file login", async () => {
    expect(await linkCodexAuthentication(isolatedHome)).toBe(false);
    expect(symlink).not.toHaveBeenCalled();
    await expect(lstat(join(isolatedHome, "auth.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(lstat(sourcePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps nested runs linked to the saved login after parent cleanup", async () => {
    await writeFile(sourcePath, initialAuthentication);
    await linkCodexAuthentication(isolatedHome);
    const nestedHome = join(root, "nested-run");
    await mkdir(nestedHome);
    vi.stubEnv("CODEX_HOME", isolatedHome);
    await linkCodexAuthentication(nestedHome);
    await rm(isolatedHome, { recursive: true });

    await writeFile(join(nestedHome, "auth.json"), refreshedAuthentication);
    expect(await readFile(sourcePath, "utf8")).toBe(refreshedAuthentication);
  });

  it("rejects non-file credentials before creating a run link", async () => {
    await mkdir(sourcePath);
    await expect(linkCodexAuthentication(isolatedHome)).rejects.toThrow(
      "must be a regular, unlinked file",
    );
    expect(symlink).not.toHaveBeenCalled();
  });

  it("reports link failures without creating a disposable credential copy", async () => {
    await writeFile(sourcePath, initialAuthentication);
    vi.mocked(symlink).mockRejectedValueOnce(
      Object.assign(new Error("fixture permission denied"), { code: "EPERM" }),
    );

    await expect(linkCodexAuthentication(isolatedHome)).rejects.toThrow(
      "Codex credentials could not be linked into the isolated run.",
    );
    await expect(lstat(join(isolatedHome, "auth.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(sourcePath, "utf8")).toBe(initialAuthentication);
  });
});
