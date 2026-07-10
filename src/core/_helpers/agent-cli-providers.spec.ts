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
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("resolveAgentCliProviderBinary", () => {
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
