import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const directory = fileURLToPath(new URL("..", import.meta.url));
const java = process.env.JAVA_HOME
  ? resolve(
      process.env.JAVA_HOME,
      "bin",
      process.platform === "win32" ? "java.exe" : "java",
    )
  : "java";
const processHandle = spawn(
  java,
  [
    "-classpath",
    resolve(directory, "gradle/wrapper/gradle-wrapper.jar"),
    "org.gradle.wrapper.GradleWrapperMain",
    "--no-daemon",
    "--console=plain",
    ...process.argv.slice(2),
  ],
  {
    cwd: directory,
    stdio: "inherit",
    windowsHide: true,
  },
);
processHandle.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
processHandle.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
