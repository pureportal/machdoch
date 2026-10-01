import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, toNamespacedPath } from "node:path";
import { afterEach, beforeEach, describe, mock, test } from "node:test";
import { prepareWindowsNativeToolchain } from "./windows-native-toolchain.mjs";

void describe(
  "Windows native toolchain",
  { skip: process.platform !== "win32" },
  () => {
    const actualSpawnSync = childProcess.spawnSync;
    const environmentMarker = "__MACHDOCH_NATIVE_ENVIRONMENT__";
    let installationPath;
    let setupResult;
    let setupOptions;
    let useCommandShell;
    let toolWorkingDirectories;

    beforeEach(() => {
      installationPath = "C:\\Visual Studio Build Tools";
      useCommandShell = false;
      toolWorkingDirectories = [];
      setupResult = {
        status: 0,
        stdout: [
          "[DEBUG] compiler=ready",
          `${environmentMarker} `,
          "Path=C:\\Compiler;C:\\Windows",
          "VSCMD_ARG_TGT_ARCH=x64",
          "INCLUDE=C:\\Headers",
          "CUSTOM_VALUE=one=two",
          "=C:=C:\\Work",
        ].join("\r\n"),
        stderr: "",
      };
      setupOptions = undefined;
      mock.method(fs, "existsSync", () => true);
      mock.method(fs, "readFileSync", () => "14.50.35717\r\n");
      mock.method(childProcess, "spawnSync", (command, args, options) => {
        if (basename(command) === "vswhere.exe") {
          return {
            status: 0,
            stdout: JSON.stringify([
              { installationPath, installationVersion: "18.4.11620.152" },
            ]),
          };
        }
        if (basename(command) === "cmd.exe") {
          setupOptions = options;
          return useCommandShell
            ? actualSpawnSync(command, args, options)
            : setupResult;
        }
        assert.ok(["cmake", "ninja"].includes(command));
        assert.deepEqual(args, ["--version"]);
        toolWorkingDirectories.push(options.cwd);
        return { status: 0 };
      });
      syncBuiltinESMExports();
    });

    afterEach(() => {
      mock.restoreAll();
      syncBuiltinESMExports();
    });

    void test("initializes outside the workspace and imports only environment values", () => {
      const environment = { LOCALAPPDATA: "C:\\Local", PaTh: "C:\\Windows" };
      const result = prepareWindowsNativeToolchain(environment);

      assert.equal(result, environment);
      assert.equal(setupOptions.cwd, installationPath);
      assert.equal(setupOptions.timeout, 120_000);
      assert.equal(setupOptions.env.VSCMD_SKIP_SENDTELEMETRY, "1");
      assert.equal(result.VSCMD_ARG_TGT_ARCH, "x64");
      assert.equal(result.INCLUDE, "C:\\Headers");
      assert.equal(result.CUSTOM_VALUE, "one=two");
      assert.equal(result.CMAKE_GENERATOR, "Ninja");
      assert.equal(
        result.LIBCLANG_PATH,
        join("C:\\Local", "machdoch", "toolchains", "llvm", "bin"),
      );
      assert.ok(result.PaTh.endsWith("C:\\Compiler;C:\\Windows"));
      assert.equal(result.Path, undefined);
      assert.equal(result["[DEBUG] compiler"], undefined);
      assert.equal(result["=C:"], undefined);
    });

    void test("reports a timeout and preserves its cause without exposing environment values", () => {
      const timeoutError = Object.assign(
        new Error("spawnSync cmd.exe ETIMEDOUT"),
        {
          code: "ETIMEDOUT",
        },
      );
      setupResult = {
        status: null,
        error: timeoutError,
        stdout: `Compiler setup started\r\n${environmentMarker} \r\nAPI_TOKEN=private-value`,
        stderr: "",
      };

      assert.throws(
        () => prepareWindowsNativeToolchain({}),
        (error) => {
          assert.match(error.message, /timed out after 120 seconds/u);
          assert.match(error.message, /Compiler setup started/u);
          assert.doesNotMatch(error.message, /API_TOKEN|private-value/u);
          assert.equal(error.cause, timeoutError);
          return true;
        },
      );
    });

    void test("reports compiler diagnostics from both output streams", () => {
      setupResult = {
        status: 1,
        stdout: "[ERROR] Windows SDK was not found.\r\n",
        stderr: "The system cannot find the path specified.\r\n",
      };

      assert.throws(
        () => prepareWindowsNativeToolchain({}),
        (error) => {
          assert.match(error.message, /Windows SDK was not found/u);
          assert.match(error.message, /cannot find the path/u);
          return true;
        },
      );
    });

    void test("reports process-launch failures", () => {
      const launchError = Object.assign(new Error("spawnSync cmd.exe ENOENT"), {
        code: "ENOENT",
      });
      setupResult = { status: null, error: launchError };

      assert.throws(
        () => prepareWindowsNativeToolchain({}),
        (error) => {
          assert.match(error.message, /ENOENT/u);
          assert.equal(error.cause, launchError);
          return true;
        },
      );
    });

    void test("rejects successful setup that does not return an environment", () => {
      setupResult = {
        status: 0,
        stdout: "Compiler setup started\r\n",
        stderr: "",
      };

      assert.throws(
        () => prepareWindowsNativeToolchain({}),
        /did not return the x64 compiler environment/u,
      );
    });

    void test("captures real batch output from a workspace with an extended path", () => {
      installationPath = fs.mkdtempSync(
        join(tmpdir(), "machdoch native toolchain "),
      );
      const setupDirectory = join(installationPath, "VC", "Auxiliary", "Build");
      const originalDirectory = process.cwd();
      try {
        fs.mkdirSync(setupDirectory, { recursive: true });
        fs.writeFileSync(
          join(setupDirectory, "vcvarsall.bat"),
          '@echo off\r\nif not "%VSCMD_SKIP_SENDTELEMETRY%"=="1" exit /b 1\r\nset "VSCMD_ARG_TGT_ARCH=x64"\r\nexit /b 0\r\n',
        );
        useCommandShell = true;
        process.chdir(toNamespacedPath(originalDirectory));

        const result = prepareWindowsNativeToolchain({ ...process.env });

        assert.equal(result.VSCMD_ARG_TGT_ARCH, "x64");
        assert.equal(setupOptions.cwd, installationPath);
        assert.deepEqual(toolWorkingDirectories, [
          fs.realpathSync.native(originalDirectory),
          fs.realpathSync.native(originalDirectory),
        ]);
      } finally {
        process.chdir(originalDirectory);
        assert.equal(dirname(installationPath), tmpdir());
        assert.ok(
          basename(installationPath).startsWith("machdoch native toolchain "),
        );
        fs.rmSync(installationPath, { recursive: true, force: true });
      }
    });
  },
);

void test(
  "leaves other platforms unchanged",
  { skip: process.platform === "win32" },
  () => {
    const environment = { PATH: "/usr/bin" };
    assert.equal(prepareWindowsNativeToolchain(environment), environment);
  },
);
