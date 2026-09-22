import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveAgentCliProviderBinary } from "./agent-cli-providers.ts";

const temporaryDirectories: string[] = [];

const createTemporaryDirectory = async (name: string): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), `machdoch-${name}-`));
  temporaryDirectories.push(directory);
  return directory;
};

const createFile = async (path: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "");
};

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("resolveAgentCliProviderBinary", () => {
  it.each(["inherited", "supplied"])(
    "finds Copilot using mixed-case Windows environment keys from %s values",
    async (source) => {
      const directory = await createTemporaryDirectory("copilot-path");
      const binaryPath = join(directory, "copilot.custom");
      await createFile(binaryPath);

      const values = { Path: directory, PathExt: ".custom" };
      vi.stubGlobal("process", {
        ...process,
        platform: "win32",
        env: source === "inherited" ? values : { PATH: "", PATHEXT: ".exe" },
      });

      const resolution = resolveAgentCliProviderBinary(
        "copilot-cli",
        source === "inherited" ? undefined : values,
      );

      expect(resolution).toEqual({
        available: true,
        executable: binaryPath,
        provider: "copilot-cli",
        source: "path",
      });
    },
  );

  it("resolves a configured command using mixed-case Windows environment keys", async () => {
    const directory = await createTemporaryDirectory("copilot-configured-command");
    const binaryPath = join(directory, "custom-copilot.cmd");
    await createFile(binaryPath);
    vi.stubGlobal("process", { ...process, platform: "win32", env: {} });

    const resolution = resolveAgentCliProviderBinary("copilot-cli", {
      machdoch_copilot_cli_path: "custom-copilot",
      Path: directory,
      PathExt: ".cmd",
    });

    expect(resolution).toEqual({
      available: true,
      executable: binaryPath,
      provider: "copilot-cli",
      source: "configured-path",
    });
  });

  it.each([
    ["UserProfile", [".local", "bin", "copilot.exe"]],
    ["AppData", ["npm", "copilot.cmd"]],
    ["LocalAppData", ["Microsoft", "WinGet", "Links", "copilot.exe"]],
  ])("finds Copilot using mixed-case %s on Windows", async (key, segments) => {
    const directory = await createTemporaryDirectory("copilot-default-path");
    const binaryPath = join(directory, ...segments);
    await createFile(binaryPath);
    vi.stubGlobal("process", {
      ...process,
      platform: "win32",
      env: {
        USERPROFILE: join(directory, "missing"),
        APPDATA: join(directory, "missing"),
        LOCALAPPDATA: join(directory, "missing"),
      },
    });

    const resolution = resolveAgentCliProviderBinary("copilot-cli", {
      Path: "",
      [key]: directory,
    });

    expect(resolution.executable).toBe(binaryPath);
  });

  it("allows an empty Windows path override with different casing", async () => {
    const directory = await createTemporaryDirectory("copilot-cleared-path");
    const binaryPath = join(directory, "copilot.cmd");
    await createFile(binaryPath);
    vi.stubGlobal("process", {
      ...process,
      platform: "win32",
      env: { PATH: directory, PATHEXT: ".cmd" },
    });

    const resolution = resolveAgentCliProviderBinary("copilot-cli", {
      Path: "",
      USERPROFILE: directory,
      APPDATA: directory,
      LOCALAPPDATA: directory,
    });

    expect(resolution.available).toBe(false);
  });

  it("keeps environment keys case-sensitive on other platforms", async () => {
    const directory = await createTemporaryDirectory("copilot-posix-path");
    const binaryPath = join(directory, "copilot");
    await createFile(binaryPath);
    vi.stubGlobal("process", {
      ...process,
      platform: "linux",
      env: { PATH: directory },
    });

    const resolution = resolveAgentCliProviderBinary("copilot-cli", {
      Path: "",
      machdoch_copilot_cli_path: "missing-command",
    });

    expect(resolution).toEqual({
      available: true,
      executable: binaryPath,
      provider: "copilot-cli",
      source: "path",
    });
  });

  it("checks the Windows Codex app bin directory for Codex CLI", async () => {
    if (process.platform !== "win32") {
      return;
    }

    const homeDirectory = await createTemporaryDirectory("codex-app-bin");
    const localAppData = join(homeDirectory, "AppData", "Local");
    const binaryPath = join(
      localAppData,
      "OpenAI",
      "Codex",
      "bin",
      "codex.exe",
    );

    await createFile(binaryPath);

    const resolution = resolveAgentCliProviderBinary("codex-cli", {
      PATH: "",
      PATHEXT: ".CMD;.EXE",
      USERPROFILE: homeDirectory,
      LOCALAPPDATA: localAppData,
    });

    expect(resolution).toMatchObject({
      available: true,
      executable: binaryPath,
      provider: "codex-cli",
      source: "path",
    });
  });

  it("prefers the versioned Codex app binary over the legacy root binary", async () => {
    if (process.platform !== "win32") {
      return;
    }

    const homeDirectory = await createTemporaryDirectory("codex-versioned-app");
    const localAppData = join(homeDirectory, "AppData", "Local");
    const codexBinDirectory = join(
      localAppData,
      "OpenAI",
      "Codex",
      "bin",
    );
    const legacyBinaryPath = join(codexBinDirectory, "codex.exe");
    const versionedBinaryPath = join(
      codexBinDirectory,
      "current",
      "codex.exe",
    );

    await createFile(legacyBinaryPath);
    await createFile(versionedBinaryPath);

    const resolution = resolveAgentCliProviderBinary("codex-cli", {
      PATH: "",
      PATHEXT: ".CMD;.EXE",
      USERPROFILE: homeDirectory,
      LOCALAPPDATA: localAppData,
    });

    expect(resolution).toMatchObject({
      available: true,
      executable: versionedBinaryPath,
      provider: "codex-cli",
      source: "path",
    });
  });

  it("checks the Windows app execution alias directory for Codex CLI", async () => {
    if (process.platform !== "win32") {
      return;
    }

    const homeDirectory = await createTemporaryDirectory("codex-app-alias");
    const localAppData = join(homeDirectory, "AppData", "Local");
    const binaryPath = join(
      localAppData,
      "Microsoft",
      "WindowsApps",
      "codex.exe",
    );

    await createFile(binaryPath);

    const resolution = resolveAgentCliProviderBinary("codex-cli", {
      PATH: "",
      PATHEXT: ".CMD;.EXE",
      USERPROFILE: homeDirectory,
      LOCALAPPDATA: localAppData,
    });

    expect(resolution).toMatchObject({
      available: true,
      executable: binaryPath,
      provider: "codex-cli",
      source: "path",
    });
  });

  it("skips inaccessible Windows packaged app executables and falls back to Codex app bin", async () => {
    if (process.platform !== "win32") {
      return;
    }

    const homeDirectory = await createTemporaryDirectory("codex-packaged-app");
    const localAppData = join(homeDirectory, "AppData", "Local");
    const packagedDirectory = join(
      homeDirectory,
      "Program Files",
      "WindowsApps",
      "OpenAI.Codex_1.0.0.0_x64__test",
      "app",
      "resources",
    );
    const packagedBinaryPath = join(packagedDirectory, "codex.exe");
    const appBinaryPath = join(
      localAppData,
      "OpenAI",
      "Codex",
      "bin",
      "current",
      "codex.exe",
    );

    await createFile(packagedBinaryPath);
    await createFile(appBinaryPath);

    const resolution = resolveAgentCliProviderBinary("codex-cli", {
      PATH: packagedDirectory,
      PATHEXT: ".EXE",
      USERPROFILE: homeDirectory,
      LOCALAPPDATA: localAppData,
    });

    expect(resolution).toMatchObject({
      available: true,
      executable: appBinaryPath,
      provider: "codex-cli",
      source: "path",
    });
  });
});
