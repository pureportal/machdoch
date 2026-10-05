import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function verifyAndroidController({
  serial,
  origin,
  fixtureRoot,
  apkPath,
}) {
  assert.match(
    serial,
    /^emulator-\d+$/,
    "Use an isolated emulator for Android verification.",
  );
  const adbPath = join(
    process.env.ANDROID_HOME ??
      join(process.env.LOCALAPPDATA, "Android", "Sdk"),
    "platform-tools",
    process.platform === "win32" ? "adb.exe" : "adb",
  );
  const adb = (...args) =>
    new Promise((resolve, reject) => {
      const child = spawn(adbPath, ["-s", serial, ...args], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const output = [];
      const errors = [];
      child.stdout.on("data", (chunk) => output.push(chunk));
      child.stderr.on("data", (chunk) => errors.push(chunk));
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`Android command timed out: ${args[0]}`));
      }, 45000);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(Buffer.concat(output));
        else
          reject(
            new Error(
              `Android command failed (${code}): ${Buffer.concat(errors)}`,
            ),
          );
      });
    });
  const nodes = async () => {
    await adb(
      "shell",
      "uiautomator",
      "dump",
      "--compressed",
      "/sdcard/fleet-verification.xml",
    );
    const xml = (
      await adb("shell", "cat", "/sdcard/fleet-verification.xml")
    ).toString();
    await writeFile(join(fixtureRoot, "android-ui.xml"), xml);
    if (xml.includes("System UI isn't responding")) {
      throw new Error("Android emulator System UI is not responding.");
    }
    return [...xml.matchAll(/<node\s[^>]*>/g)].map(([node]) =>
      Object.fromEntries(
        [...node.matchAll(/([\w-]+)="([^"]*)"/g)].map((match) => [
          match[1],
          match[2],
        ]),
      ),
    );
  };
  const find = async (predicate) => {
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      const found = (await nodes()).find(predicate);
      if (found) return found;
    }
    throw new Error("Android control did not appear.");
  };
  const tap = async (node) => {
    const bounds = node.bounds.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
    assert.ok(bounds);
    await adb(
      "shell",
      "input",
      "tap",
      String(Math.round((Number(bounds[1]) + Number(bounds[3])) / 2)),
      String(Math.round((Number(bounds[2]) + Number(bounds[4])) / 2)),
    );
  };
  const openForm = async () => {
    await adb("shell", "input", "keyevent", "KEYCODE_WAKEUP");
    await adb("shell", "wm", "dismiss-keyguard");
    await adb("shell", "pm", "clear", "com.machdoch.fleet");
    await adb(
      "shell",
      "am",
      "start",
      "-n",
      "com.machdoch.fleet/.FleetActivity",
    );
    return find((node) => node.class === "android.widget.EditText");
  };
  const connect = async (url) => {
    await tap(await openForm());
    await adb("shell", "input", "text", url);
    await adb("shell", "input", "keyevent", "KEYCODE_BACK");
    await tap(await find((node) => /^connect$/i.test(node.text)));
  };
  const port = new URL(origin).port;
  assert.equal(
    (await adb("shell", "getprop", "ro.kernel.qemu")).toString().trim(),
    "1",
  );
  await adb("install", "-r", apkPath);
  await adb("reverse", `tcp:${port}`, `tcp:${port}`);
  try {
    await connect(`http://127.0.0.1:${port}`);
    await find(
      (node) =>
        node.class === "android.widget.EditText" &&
        node.text === `http://127.0.0.1:${port}`,
    );
    assert.equal(
      (await nodes()).some((node) => node.class === "android.webkit.WebView"),
      false,
    );
    await writeFile(
      join(fixtureRoot, "android-origin-validation.png"),
      await adb("exec-out", "screencap", "-p"),
    );
    await connect(origin);
    await find(
      (node) =>
        node.text ===
        "The connection is not secure. Fix the Fleet Manager HTTPS certificate and try again.",
    );
    await writeFile(
      join(fixtureRoot, "android-certificate-rejection.png"),
      await adb("exec-out", "screencap", "-p"),
    );
    await tap(await find((node) => /^change manager$/i.test(node.text)));
    await find((node) => node.class === "android.widget.EditText");
    return "The debug Android APK installed and opened on an Android 36 emulator, rejected cleartext origins and an untrusted TLS certificate, and returned to manager selection.";
  } catch (error) {
    await writeFile(
      join(fixtureRoot, "android-failure.png"),
      await adb("exec-out", "screencap", "-p"),
    );
    await writeFile(
      join(fixtureRoot, "android-runtime.log"),
      await adb("logcat", "-d", "-s", "AndroidRuntime"),
    );
    throw error;
  } finally {
    await adb("shell", "am", "force-stop", "com.machdoch.fleet");
    await adb("reverse", "--remove", `tcp:${port}`);
  }
}
