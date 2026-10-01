import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { prepareWindowsVulkanToolchain } from "./windows-vulkan-toolchain.mjs";

void describe(
  "Windows Vulkan toolchain",
  { skip: process.platform !== "win32" },
  () => {
    let directory;
    let sdkDirectory;

    beforeEach(() => {
      directory = mkdtempSync(join(tmpdir(), "machdoch-whisper-runtime-"));
      sdkDirectory = join(directory, "sdk");
      for (const name of ["Bin", "Lib", "Include/vulkan"]) {
        mkdirSync(join(sdkDirectory, name), { recursive: true });
      }
      for (const name of [
        "Bin/glslc.exe",
        "Lib/vulkan-1.lib",
        "Include/vulkan/vulkan.hpp",
      ]) {
        writeFileSync(join(sdkDirectory, name), name);
      }
    });

    afterEach(() => {
      assert.ok(
        resolve(directory).startsWith(
          `${resolve(tmpdir())}\\machdoch-whisper-runtime-`,
        ),
      );
      rmSync(directory, { recursive: true, force: true });
    });

    void test("prepares the SDK without duplicating PATH keys", () => {
      const environment = { VULKAN_SDK: sdkDirectory, PaTh: "C:\\Tools" };
      assert.equal(prepareWindowsVulkanToolchain(environment), environment);
      assert.equal(
        environment.PaTh,
        `${join(sdkDirectory, "Bin")}${delimiter}C:\\Tools`,
      );
      assert.equal(environment.PATH, undefined);
    });

    void test("reports a missing SDK with an installation instruction", () => {
      assert.throws(
        () =>
          prepareWindowsVulkanToolchain({
            VULKAN_SDK: join(directory, "missing"),
          }),
        /Install the Windows x64 Vulkan SDK and set VULKAN_SDK/u,
      );
    });

    void test("keeps an explicitly selected Cargo output directory", () => {
      const environment = {
        VULKAN_SDK: sdkDirectory,
        CARGO_TARGET_DIR: join(directory, "build"),
      };
      prepareWindowsVulkanToolchain(environment);
      assert.equal(environment.CARGO_TARGET_DIR, join(directory, "build"));
    });

    void test("reports an incomplete SDK before starting the native build", () => {
      rmSync(join(sdkDirectory, "Bin", "glslc.exe"));
      assert.throws(
        () => prepareWindowsVulkanToolchain({ VULKAN_SDK: sdkDirectory }),
        /missing Bin\/glslc\.exe.*set VULKAN_SDK/u,
      );
    });

    void test("uses the local toolchain installation when no SDK was configured", () => {
      const localSdkDirectory = join(
        directory,
        "machdoch",
        "toolchains",
        "vulkan-sdk",
      );
      for (const name of ["Bin", "Lib", "Include/vulkan"]) {
        mkdirSync(join(localSdkDirectory, name), { recursive: true });
      }
      for (const name of [
        "Bin/glslc.exe",
        "Lib/vulkan-1.lib",
        "Include/vulkan/vulkan.hpp",
      ]) {
        writeFileSync(join(localSdkDirectory, name), name);
      }
      const environment = { LOCALAPPDATA: directory };
      prepareWindowsVulkanToolchain(environment);
      assert.equal(environment.VULKAN_SDK, localSdkDirectory);
    });
  },
);

void test(
  "leaves other platforms unchanged",
  { skip: process.platform === "win32" },
  () => {
    const environment = { PATH: "/usr/bin" };
    assert.equal(prepareWindowsVulkanToolchain(environment), environment);
  },
);
