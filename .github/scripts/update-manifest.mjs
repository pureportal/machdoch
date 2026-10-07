import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalInstallerNames } from "./release-assets.mjs";

export const updateTargets = {
  "machdoch-windows-x64.msi": "windows-x86_64-msi",
  "machdoch-windows-x64-setup.exe": "windows-x86_64-nsis",
  "machdoch-linux-amd64.deb": "linux-x86_64-deb",
  "machdoch-linux-arm64.deb": "linux-aarch64-deb",
  "machdoch-linux-x86_64.rpm": "linux-x86_64-rpm",
  "machdoch-linux-amd64.AppImage": "linux-x86_64-appimage",
  "machdoch-headless.tar.gz": "linux-headless",
};

export async function buildUpdateManifest(directory, version, notes = "") {
  if (!/^\d+\.\d+\.\d+$/.test(version))
    throw new Error("Updater releases must use a stable version.");
  const platforms = {};
  for (const [name, target] of Object.entries(updateTargets)) {
    const artifact = join(directory, name);
    const signature = (await readFile(`${artifact}.sig`, "utf8")).trim();
    const comment = Buffer.from(signature, "base64")
      .toString("utf8")
      .split(/\r?\n/)[2];
    if (!comment?.split("\t").includes(`version:${version}`))
      throw new Error(`Signature is not bound to ${version}: ${name}`);
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(artifact)) hash.update(chunk);
    platforms[target] = {
      url: `https://github.com/pureportal/machdoch/releases/download/v${version}/${name}`,
      signature,
      sha256: hash.digest("hex"),
      size: (await stat(artifact)).size,
    };
  }
  return { version, notes, pub_date: new Date().toISOString(), platforms };
}

export function validateUpdateAssetNames(names) {
  const expected = [
    ...canonicalInstallerNames,
    "machdoch-headless.tar.gz",
  ].flatMap((name) => [name, `${name}.sig`]);
  expected.push("latest.json");
  const missing = expected.filter(
    (name) => names.filter((candidate) => candidate === name).length !== 1,
  );
  if (missing.length)
    throw new Error(
      `Missing or duplicated update assets: ${missing.join(", ")}`,
    );
}

async function main() {
  const [command, directory, configurationPath, notesPath] =
    process.argv.slice(2);
  if (!directory || !configurationPath)
    throw new Error(
      "Usage: update-manifest.mjs <sign|build|verify> <directory|release-json> <tauri-config> [release-json]",
    );
  const configuration = JSON.parse(await readFile(configurationPath, "utf8"));
  if (command === "sign") {
    if (!process.env.TAURI_SIGNING_PRIVATE_KEY)
      throw new Error(
        "TAURI_SIGNING_PRIVATE_KEY is required to publish signed updates.",
      );
    const client = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../apps/client",
    );
    const require = createRequire(join(client, "package.json"));
    const signer = require.resolve("@tauri-apps/cli/tauri.js");
    for (const name of await readdir(directory)) {
      if (!Object.hasOwn(updateTargets, name)) continue;
      execFileSync(
        process.execPath,
        [
          signer,
          "signer",
          "sign",
          "--app-version",
          configuration.version,
          resolve(directory, name),
        ],
        {
          cwd: client,
          stdio: ["ignore", "ignore", "pipe"],
          windowsHide: true,
        },
      );
      const signature = (
        await readFile(join(directory, `${name}.sig`), "utf8")
      ).trim();
      const comment = Buffer.from(signature, "base64")
        .toString("utf8")
        .split(/\r?\n/)[2];
      if (!comment?.split("\t").includes(`version:${configuration.version}`))
        throw new Error(`Signer did not bind the version: ${name}`);
    }
    return;
  }
  if (command === "build") {
    const notes = notesPath
      ? JSON.parse(await readFile(notesPath, "utf8")).body
      : "";
    const manifest = await buildUpdateManifest(
      directory,
      configuration.version,
      notes ?? "",
    );
    await writeFile(
      join(directory, "latest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    return;
  }
  if (command === "verify") {
    const release = JSON.parse(await readFile(directory, "utf8"));
    validateUpdateAssetNames(release.assets.map((asset) => asset.name));
    return;
  }
  throw new Error(`Unknown updater command: ${command}`);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
