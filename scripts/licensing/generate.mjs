import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { collectNpmPackages } from "./npm.mjs";
import { collectRustPackages } from "./rust.mjs";
import {
  copyPackageLegalFiles,
  hashFiles,
  writePackageIndex,
} from "./files.mjs";
import { collectNodeLicense } from "./node.mjs";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const profiles = {
  headless: {
    workspaces: ["apps/client"],
    output: "apps/client/dist/legal-headless",
  },
  desktop: {
    workspaces: ["apps/client"],
    output: "apps/client/dist/legal-desktop",
  },
  "fleet-manager": {
    workspaces: ["apps/fleet-manager", "apps/client"],
    output: "apps/fleet-manager/dist/legal",
  },
  landing: { workspaces: ["apps/landing"], output: "apps/landing/dist/legal" },
};
const profileName = process.argv[2];
const profile = profiles[profileName];
if (!profile || process.argv.length > 3) {
  throw new Error(
    "Usage: node scripts/licensing/generate.mjs headless|desktop|fleet-manager|landing",
  );
}
const inputFiles = [
  "package.json",
  "pnpm-lock.yaml",
  "legal/third-party/supplemental.json",
  ...profile.workspaces.map((workspace) => `${workspace}/package.json`),
  "packages/fleet-protocol/package.json",
  "packages/product-ui/package.json",
  "packages/analytics/package.json",
  "packages/media-studio/package.json",
];
if (profileName === "desktop") {
  inputFiles.push(
    "apps/client/src-tauri/Cargo.toml",
    "apps/client/src-tauri/Cargo.lock",
    "packages/fleet-protocol/Cargo.toml",
    "apps/client/scripts/local-speech-assets.json",
    "apps/client/src-tauri/python/local_speech_requirements.txt",
    "apps/client/src-tauri/resources/speech-legal/python-packages.json",
    "apps/client/src-tauri/resources/speech-legal/python-native.json",
  );
  if (process.platform === "win32")
    inputFiles.push(
      "apps/client/src-tauri/resources/speech-legal/windows-runtime.json",
    );
}
async function collectInputHashes() {
  const hashes = {};
  for (const file of inputFiles) {
    hashes[file] = createHash("sha256")
      .update(await readFile(join(repositoryRoot, file)))
      .digest("hex");
  }
  return hashes;
}
const inputs = await collectInputHashes();
const outputDirectory = join(repositoryRoot, profile.output);
const outputParent = dirname(outputDirectory);
await mkdir(outputParent, { recursive: true });
const stage = await mkdtemp(join(outputParent, ".legal-stage-"));
if (dirname(stage) !== outputParent)
  throw new Error("Unexpected licence staging directory.");
try {
  for (const name of [
    "LICENSE",
    "NOTICE",
    "EULA.md",
    "THIRD_PARTY_NOTICES.md",
  ]) {
    await cp(join(repositoryRoot, name), join(stage, name));
  }
  await cp(join(repositoryRoot, "legal"), join(stage, "legal"), {
    recursive: true,
  });
  await cp(
    join(repositoryRoot, "docs/licensing"),
    join(stage, "docs/licensing"),
    { recursive: true },
  );
  for (const file of [
    "apps/client/src-tauri/python/LICENSE-fizgig.txt",
    "apps/client/src-tauri/python/THIRD_PARTY_NOTICES-fizgig.md",
    "apps/client/src-tauri/python/LICENSE-MuseTalk.txt",
    "apps/client/src-tauri/python/LICENSE-RefMod-MIT.txt",
    "apps/client/src-tauri/python/LICENSE-H3-PromptBuilder-MIT.txt",
    "apps/client/src-tauri/python/NOTICE-RefMod.txt",
    "apps/client/src-tauri/python/LICENSE-diffusers-training.txt",
    "apps/client/src-tauri/python/LICENSE-DMAD.txt",
    "apps/client/src-tauri/python/NOTICE-DMAD.txt",
    "apps/client/src-tauri/resources/whisper/LICENSE-whisper.cpp.txt",
    "apps/client/src-tauri/resources/whisper/LICENSE-whisper-model.txt",
    "apps/client/src-tauri/resources/whisper/LICENSE-vulkan-loader.txt",
  ]) {
    await mkdir(dirname(join(stage, file)), { recursive: true });
    await cp(join(repositoryRoot, file), join(stage, file));
  }
  if (profileName === "desktop") {
    await cp(
      join(repositoryRoot, "apps/client/src-tauri/resources/speech-legal"),
      join(stage, "speech"),
      { recursive: true },
    );
    await cp(
      join(repositoryRoot, "apps/client/scripts/local-speech-assets.json"),
      join(stage, "speech/assets.json"),
    );
  }
  const metadata = JSON.parse(
    await readFile(join(repositoryRoot, "package.json"), "utf8"),
  );
  const packages = await collectNpmPackages(repositoryRoot, profile.workspaces);
  let target;
  let node;
  if (profileName === "desktop") {
    const rustVersion = execFileSync("rustc", ["-vV"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
    });
    target =
      process.env.TAURI_ENV_TARGET_TRIPLE ||
      rustVersion.match(/^host: (.+)$/mu)?.[1];
    if (!target) throw new Error("Cannot determine the Rust release target.");
    packages.push(
      ...(await collectRustPackages(
        join(repositoryRoot, "apps/client/src-tauri/Cargo.toml"),
        target,
      )),
    );
  }
  if (profileName === "desktop" || profileName === "fleet-manager") {
    node = await collectNodeLicense(
      process.env.MACHDOCH_NODE_BINARY || process.execPath,
      stage,
    );
  }
  const entries = [];
  const missing = [];
  const supplements = JSON.parse(
    await readFile(
      join(repositoryRoot, "legal/third-party/supplemental.json"),
      "utf8",
    ),
  );
  for (const dependency of packages) {
    try {
      const supplementalFiles =
        supplements.find(
          (record) =>
            record.ecosystem === dependency.ecosystem &&
            record.name === dependency.name &&
            record.version === dependency.version,
        )?.files ?? [];
      entries.push(
        await copyPackageLegalFiles(
          dependency,
          stage,
          supplementalFiles.map(({ file, ...metadata }) => ({
            path: join(repositoryRoot, file),
            ...metadata,
          })),
        ),
      );
    } catch (error) {
      missing.push(error.message);
    }
  }
  if (missing.length > 0) {
    throw new Error(`Incomplete third-party notices:\n${missing.join("\n")}`);
  }
  await writePackageIndex(stage, entries);
  const currentInputs = await collectInputHashes();
  const changedInputs = inputFiles.filter(
    (file) => currentInputs[file] !== inputs[file],
  );
  if (changedInputs.length > 0) {
    throw new Error(
      `Release inputs changed while collecting notices: ${changedInputs.join(", ")}. Run the licence generator again.`,
    );
  }
  await writeFile(
    join(stage, "manifest.json"),
    `${JSON.stringify({ profile: profileName, version: metadata.version, ...(target ? { target } : {}), ...(node ? { node } : {}), inputs, packages: entries, files: await hashFiles(stage) }, null, 2)}\n`,
  );
  if (
    dirname(outputDirectory) !== outputParent ||
    !outputDirectory.startsWith(
      `${repositoryRoot}${process.platform === "win32" ? "\\" : "/"}`,
    )
  ) {
    throw new Error(
      "Refusing to replace a licence directory outside the workspace.",
    );
  }
  await rm(outputDirectory, { recursive: true, force: true });
  await rename(stage, outputDirectory);
  console.log(
    `Collected ${entries.length} dependency notice sets in ${profile.output}.`,
  );
} finally {
  await rm(stage, { recursive: true, force: true });
}
