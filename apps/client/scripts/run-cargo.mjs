import { spawn } from "node:child_process";
import { prepareWindowsNativeToolchain } from "./windows-native-toolchain.mjs";

try {
  const environment = prepareWindowsNativeToolchain({ ...process.env });
  const child = spawn("cargo", process.argv.slice(2), {
    env: environment,
    stdio: "inherit",
    windowsHide: true,
  });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => child.kill(signal));
  }
  child.on("error", (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  child.on("exit", (code) => {
    process.exitCode = code ?? 1;
  });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
