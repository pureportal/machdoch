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
});
