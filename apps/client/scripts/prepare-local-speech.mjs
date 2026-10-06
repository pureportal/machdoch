import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { x as extractTar } from "tar";
import { downloadVerifiedAsset } from "./download-verified-asset.mjs";
import { prepareWindowsSpeechRuntime } from "./windows-speech-runtime.mjs";

const root = resolve(import.meta.dirname, "../src-tauri/resources/speech");
const legal = resolve(
  import.meta.dirname,
  "../src-tauri/resources/speech-legal",
);
const raw = await readFile(
  new URL("local-speech-assets.json", import.meta.url),
  "utf8",
);
const manifest = JSON.parse(raw);
const platform = `${process.platform}-${process.arch}`;
const assets = manifest.platforms[platform];
if (!assets)
  throw new Error(`Local speech packaging is unavailable for ${platform}.`);
const run = (command, args) =>
  new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { stdio: "inherit", windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolveRun()
        : reject(new Error(`${command} exited with code ${code}.`)),
    );
  });
async function prepare() {
  await mkdir(root, { recursive: true });
  const lockPath = join(root, ".prepare.lock");
  const lock = await open(lockPath, "wx").catch((error) => {
    if (error.code === "EEXIST")
      throw new Error(
        `Local speech preparation is already running. If it has stopped, remove ${lockPath} and retry.`,
        { cause: error },
      );
    throw error;
  });
  try {
    for (const asset of manifest.models)
      await downloadVerifiedAsset(asset, join(root, asset.path));
    await downloadVerifiedAsset(
      assets.needle,
      join(root, "bin", assets.needle.path),
    );
    for (const asset of manifest.licenses)
      await downloadVerifiedAsset(asset, join(legal, asset.path));
    if (process.platform !== "win32")
      await chmod(join(root, "bin", assets.needle.path), 0o755);
    const python = join(
      root,
      "runtime",
      process.platform === "win32" ? "python.exe" : "bin/python3",
    );
    const archive = join(root, "python.tar.gz");
    await downloadVerifiedAsset(assets.python, archive);
    if (!(await stat(python).catch(() => null))) {
      const staging = join(root, `python-extract-${process.pid}`);
      await mkdir(staging);
      try {
        await extractTar.asyncFile(
          {
            file: archive,
            cwd: staging,
            strict: true,
          },
          [],
        );
        await rename(join(staging, "python"), join(root, "runtime"));
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
    }
    if (assets.windowsRuntime)
      await prepareWindowsSpeechRuntime(
        assets.windowsRuntime,
        root,
        legal,
        python,
        resolve(import.meta.dirname, "../../../LICENSE"),
      );
    if (process.argv.includes("--download-only")) return;
    const input = createHash("sha256")
      .update(raw)
      .update(
        await readFile(
          new URL(
            "../src-tauri/python/local_speech_requirements.txt",
            import.meta.url,
          ),
        ),
      )
      .update(
        await readFile(
          new URL(
            "../src-tauri/python/prepare_local_speech.py",
            import.meta.url,
          ),
        ),
      )
      .update(
        await readFile(
          new URL(
            "../src-tauri/python/prepare_speech_native_licenses.py",
            import.meta.url,
          ),
        ),
      )
      .update(
        await readFile(new URL("windows-speech-runtime.mjs", import.meta.url)),
      )
      .digest("hex");
    const readyPath = join(root, "runtime-ready.json");
    const ready = await readFile(readyPath, "utf8")
      .then(JSON.parse)
      .catch(() => null);
    const nativeArgs = [
      "-I",
      resolve(
        import.meta.dirname,
        "../src-tauri/python/prepare_speech_native_licenses.py",
      ),
      "--resource-dir",
      root,
      "--legal-dir",
      legal,
      "--manifest",
      resolve(import.meta.dirname, "local-speech-assets.json"),
    ];
    if (ready?.input !== input || ready?.platform !== platform) {
      await run(python, [
        "-I",
        "-m",
        "pip",
        "--isolated",
        "install",
        "--disable-pip-version-check",
        "--only-binary=:all:",
        "torch==2.8.0",
        ...(process.platform === "darwin"
          ? []
          : ["--index-url", "https://download.pytorch.org/whl/cpu"]),
      ]);
      await run(python, [
        "-I",
        "-m",
        "pip",
        "--isolated",
        "install",
        "--disable-pip-version-check",
        "--only-binary=:all:",
        "--report",
        join(root, "python-packages.json"),
        "-r",
        resolve(
          import.meta.dirname,
          "../src-tauri/python/local_speech_requirements.txt",
        ),
      ]);
      await run(python, nativeArgs);
      await run(python, [
        "-I",
        resolve(
          import.meta.dirname,
          "../src-tauri/python/prepare_local_speech.py",
        ),
        "--resource-dir",
        root,
        "--legal-dir",
        legal,
      ]);
      await writeFile(
        readyPath,
        JSON.stringify({ input, platform }, null, 2) + "\n",
      );
    } else {
      try {
        await run(python, [...nativeArgs, "--verify"]);
        await run(python, [
          "-I",
          resolve(
            import.meta.dirname,
            "../src-tauri/python/prepare_local_speech.py",
          ),
          "--resource-dir",
          root,
          "--legal-dir",
          legal,
          "--verify",
        ]);
      } catch (error) {
        await rm(readyPath, { force: true });
        throw new Error(
          "The speech resources failed verification. Run preparation again to restore them.",
          { cause: error },
        );
      }
    }
  } finally {
    await lock.close();
    await rm(lockPath);
  }
}

await prepare();
