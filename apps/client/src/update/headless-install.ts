import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  chmod,
  lstat,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { x as extract } from "tar";
import { satisfies, valid } from "semver";

const execute = promisify(execFile);

async function synchronizeDirectoryEntry(path: string): Promise<void> {
  if (process.platform !== "linux") return;
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function synchronizeDirectory(path: string): Promise<void> {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) await synchronizeDirectory(child);
    else {
      const file = await open(child, "r+");
      try {
        await file.sync();
      } finally {
        await file.close();
      }
    }
  }
  await synchronizeDirectoryEntry(path);
}

export async function installHeadlessUpdate(
  root: string,
  archive: string,
  version: string,
): Promise<void> {
  if (
    !valid(version) ||
    version.includes("-") ||
    resolve(root) === dirname(resolve(root))
  ) {
    throw new Error("Invalid headless installation path or version.");
  }
  const releases = join(root, "releases");
  if (
    (await lstat(root)).isSymbolicLink() ||
    (await lstat(releases)).isSymbolicLink()
  ) {
    throw new Error(
      "The headless installation directories must not be symbolic links.",
    );
  }
  const currentPath = join(root, "current");
  const previous = (await readFile(currentPath, "utf8")).trim();
  if (!valid(previous))
    throw new Error("The installed release pointer is invalid.");
  const stage = await mkdtemp(join(releases, ".update-"));
  if (dirname(stage) !== resolve(releases))
    throw new Error("Invalid update staging path.");
  const target = join(releases, version);
  let published = false;
  let activated = false;
  try {
    let archiveError: string | undefined;
    let bytes = 0;
    let entries = 0;
    const paths = new Set<string>();
    await extract({
      file: archive,
      cwd: stage,
      strict: true,
      filter(path, entry) {
        bytes += entry.size;
        entries += 1;
        const segments = path.replace(/\/$/, "").split("/");
        const unsafe =
          segments[0] !== "machdoch" ||
          segments.some(
            (segment) =>
              !segment ||
              segment === "." ||
              segment === ".." ||
              segment.includes("\\") ||
              segment.includes(":") ||
              Array.from(segment).some(
                (character) => character.charCodeAt(0) < 32,
              ),
          ) ||
          !("type" in entry) ||
          !["File", "Directory"].includes("type" in entry ? entry.type : "") ||
          paths.has(path) ||
          entries > 50_000 ||
          bytes > 2 * 1024 ** 3;
        paths.add(path);
        if (unsafe)
          archiveError =
            "The update archive contains unsafe or oversized entries.";
        return !unsafe;
      },
    });
    if (archiveError) throw new Error(archiveError);
    const extracted = join(stage, "machdoch");
    const payload = join(extracted, "releases", version);
    const metadata = JSON.parse(
      await readFile(join(payload, "package.json"), "utf8"),
    ) as { name?: string; version?: string; engines?: { node?: string } };
    if (
      metadata.name !== "machdoch-headless" ||
      metadata.version !== version ||
      (await readFile(join(extracted, "current"), "utf8")).trim() !== version ||
      typeof metadata.engines?.node !== "string" ||
      !satisfies(process.versions.node, metadata.engines.node)
    )
      throw new Error(
        "The update has invalid package metadata or requires a newer Node.js version.",
      );
    for (const file of [
      "machdoch-cli.cjs",
      "node_modules/playwright-core/package.json",
      "LICENSE",
      "NOTICE",
      "EULA.md",
      "THIRD_PARTY_NOTICES.md",
    ]) {
      if (!(await lstat(join(payload, file))).isFile())
        throw new Error(`The update is missing ${file}.`);
    }
    await execute(
      process.execPath,
      [join(payload, "machdoch-cli.cjs"), "update", "--help"],
      {
        timeout: 30_000,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      },
    );
    await synchronizeDirectory(payload);
    await rename(payload, target);
    published = true;
    await synchronizeDirectoryEntry(releases);
    const pointer = join(stage, "current");
    const handle = await open(pointer, "wx", 0o644);
    try {
      await handle.writeFile(`${version}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if ((await readFile(currentPath, "utf8")).trim() !== previous)
      throw new Error(
        "Another updater changed the active release. Run the update again.",
      );
    await rename(pointer, currentPath);
    activated = true;
    await synchronizeDirectoryEntry(root);
  } finally {
    if (published && !activated)
      await rm(target, { recursive: true, force: true });
    await rm(stage, { recursive: true, force: true });
  }
}

export async function installAppImageUpdate(
  path: string,
  downloaded: string,
): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink())
    throw new Error("The AppImage path must be a regular file.");
  await chmod(downloaded, metadata.mode & 0o777);
  const file = await open(downloaded, "r+");
  try {
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(downloaded, path);
  await synchronizeDirectoryEntry(dirname(path));
}
