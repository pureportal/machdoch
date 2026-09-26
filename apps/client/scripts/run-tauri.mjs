import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, join } from "node:path";

const require = createRequire(import.meta.url);
const environment = { ...process.env };

if (
  process.platform === "win32" &&
  ["build", "dev"].includes(process.argv[2])
) {
  const programFiles = environment.ProgramFiles ?? "C:\\Program Files";
  const cmakeDirectory = join(programFiles, "CMake", "bin");
  let cmake = spawnSync("cmake", ["--version"], {
    env: environment,
    windowsHide: true,
  });

  if (
    cmake.error?.code === "ENOENT" &&
    existsSync(join(cmakeDirectory, "cmake.exe"))
  ) {
    const pathKey =
      Object.keys(environment).find((key) => key.toLowerCase() === "path") ??
      "PATH";
    environment[pathKey] =
      `${cmakeDirectory}${delimiter}${environment[pathKey] ?? ""}`;
    cmake = spawnSync("cmake", ["--version"], {
      env: environment,
      windowsHide: true,
    });
  }

  if (cmake.error || cmake.status !== 0) {
    throw new Error("CMake is required to build the Windows desktop app.");
  }

  const llvmDirectory =
    environment.LIBCLANG_PATH ?? join(programFiles, "LLVM", "bin");
  if (
    !["libclang.dll", "clang.dll"].some((name) =>
      existsSync(join(llvmDirectory, name)),
    )
  ) {
    throw new Error(
      "libclang was not found. Install LLVM and set LIBCLANG_PATH to its bin directory.",
    );
  }
  environment.LIBCLANG_PATH = llvmDirectory;

  if (!environment.CMAKE_GENERATOR && !environment.CMAKE_GENERATOR_INSTANCE) {
    const vswhere = join(
      environment["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
      "Microsoft Visual Studio",
      "Installer",
      "vswhere.exe",
    );
    if (existsSync(vswhere)) {
      const result = spawnSync(
        vswhere,
        ["-all", "-products", "*", "-format", "json"],
        {
          encoding: "utf8",
          windowsHide: true,
        },
      );
      if (result.status !== 0) {
        throw new Error(
          result.stderr || "Could not inspect Visual Studio installations",
        );
      }
      const installations = JSON.parse(result.stdout);
      const installation = installations
        .filter((item) => {
          if (!item.installationPath || !item.installationVersion) {
            return false;
          }
          const toolsetVersionFile = join(
            item.installationPath,
            "VC",
            "Auxiliary",
            "Build",
            "Microsoft.VCToolsVersion.default.txt",
          );
          if (!existsSync(toolsetVersionFile)) {
            return false;
          }
          const toolsetVersion = readFileSync(
            toolsetVersionFile,
            "utf8",
          ).trim();
          return (
            existsSync(
              join(
                item.installationPath,
                "MSBuild",
                "Current",
                "Bin",
                "MSBuild.exe",
              ),
            ) &&
            existsSync(
              join(
                item.installationPath,
                "VC",
                "Tools",
                "MSVC",
                toolsetVersion,
                "bin",
                "Hostx64",
                "x64",
                "cl.exe",
              ),
            )
          );
        })
        .sort(
          (left, right) =>
            Number(Boolean(right.isComplete)) -
              Number(Boolean(left.isComplete)) ||
            right.installationVersion.localeCompare(
              left.installationVersion,
              undefined,
              { numeric: true },
            ),
        )[0];
      if (installation) {
        const installationPath = installation.installationPath.replaceAll(
          "\\",
          "/",
        );
        environment.CMAKE_GENERATOR_INSTANCE = `${installationPath},version=${installation.installationVersion}`;
      } else {
        throw new Error(
          "Visual Studio C++ Build Tools are required to build the Windows desktop app.",
        );
      }
    } else {
      throw new Error(
        "Visual Studio C++ Build Tools are required to build the Windows desktop app.",
      );
    }
  }
}

const cli = require.resolve("@tauri-apps/cli/tauri.js");
const child = spawn(process.execPath, [cli, ...process.argv.slice(2)], {
  env: environment,
  stdio: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});

child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
