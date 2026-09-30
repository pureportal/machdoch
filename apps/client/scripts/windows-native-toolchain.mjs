import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";

const findVisualStudio = (environment) => {
  const vswhere = join(
    environment["ProgramFiles(x86)"] ?? "C:/Program Files (x86)",
    "Microsoft Visual Studio",
    "Installer",
    "vswhere.exe",
  );
  const result = spawnSync(
    vswhere,
    ["-all", "-products", "*", "-format", "json"],
    { env: environment, encoding: "utf8", windowsHide: true, timeout: 10_000 },
  );
  if (result.error || result.status !== 0) {
    throw new Error(
      "Visual Studio C++ Build Tools are required to build the Windows desktop app.",
    );
  }
  const installation = JSON.parse(result.stdout)
    .filter((item) => {
      const versionFile = join(
        item.installationPath,
        "VC",
        "Auxiliary",
        "Build",
        "Microsoft.VCToolsVersion.default.txt",
      );
      if (!existsSync(versionFile)) {
        return false;
      }
      const version = readFileSync(versionFile, "utf8").trim();
      return existsSync(
        join(
          item.installationPath,
          "VC",
          "Tools",
          "MSVC",
          version,
          "bin",
          "Hostx64",
          "x64",
          "cl.exe",
        ),
      );
    })
    .sort((left, right) =>
      right.installationVersion.localeCompare(
        left.installationVersion,
        undefined,
        { numeric: true },
      ),
    )[0];
  if (!installation) {
    throw new Error(
      "Visual Studio C++ Build Tools are required to build the Windows desktop app.",
    );
  }
  return installation.installationPath;
};

export const prepareWindowsNativeToolchain = (environment) => {
  if (process.platform !== "win32") {
    return environment;
  }
  if (environment.WHISPER_DONT_GENERATE_BINDINGS !== undefined) {
    throw new Error(
      "Remove WHISPER_DONT_GENERATE_BINDINGS; native bindings must be generated for the current target.",
    );
  }
  const defaultLlvmDirectory = join(
    environment.LOCALAPPDATA ?? "",
    "machdoch",
    "toolchains",
    "llvm",
    "bin",
  );
  const llvmDirectory =
    environment.LIBCLANG_PATH ??
    (existsSync(join(defaultLlvmDirectory, "libclang.dll"))
      ? defaultLlvmDirectory
      : join(environment.ProgramFiles ?? "C:/Program Files", "LLVM", "bin"));
  if (
    !["libclang.dll", "clang.dll"].some((name) =>
      existsSync(join(llvmDirectory, name)),
    )
  ) {
    throw new Error(
      "libclang was not found. Install LLVM and set LIBCLANG_PATH to its bin directory.",
    );
  }
  const installationPath = findVisualStudio(environment);
  const setup = spawnSync(
    environment.ComSpec ??
      join(environment.SystemRoot ?? "C:/Windows", "System32", "cmd.exe"),
    [
      "/d",
      "/s",
      "/c",
      '""' +
        join(installationPath, "VC", "Auxiliary", "Build", "vcvarsall.bat") +
        '" x64 >nul && set"',
    ],
    {
      env: environment,
      encoding: "utf8",
      windowsHide: true,
      windowsVerbatimArguments: true,
      timeout: 30_000,
    },
  );
  if (setup.error || setup.status !== 0) {
    throw new Error(
      "Visual Studio C++ Build Tools could not initialize the x64 compiler environment.",
    );
  }
  for (const line of setup.stdout.split(/\r?\n/u)) {
    const separator = line.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const key = line.slice(0, separator);
    const existingKey = Object.keys(environment).find(
      (entry) => entry.toLowerCase() === key.toLowerCase(),
    );
    environment[existingKey ?? key] = line.slice(separator + 1);
  }
  const pathKey =
    Object.keys(environment).find((key) => key.toLowerCase() === "path") ??
    "PATH";
  const cmakeDirectory = join(
    installationPath,
    "Common7",
    "IDE",
    "CommonExtensions",
    "Microsoft",
    "CMake",
    "CMake",
    "bin",
  );
  const ninjaDirectory = join(
    installationPath,
    "Common7",
    "IDE",
    "CommonExtensions",
    "Microsoft",
    "CMake",
    "Ninja",
  );
  environment[pathKey] = [
    cmakeDirectory,
    ninjaDirectory,
    environment[pathKey] ?? "",
  ].join(delimiter);
  for (const tool of ["cmake", "ninja"]) {
    const result = spawnSync(tool, ["--version"], {
      env: environment,
      windowsHide: true,
      timeout: 10_000,
    });
    if (result.error || result.status !== 0) {
      throw new Error(
        "CMake is required together with Ninja to build the Windows desktop app.",
      );
    }
  }
  environment.LIBCLANG_PATH = llvmDirectory;
  environment.CMAKE_GENERATOR = "Ninja";
  delete environment.CMAKE_GENERATOR_INSTANCE;
  return environment;
};
