import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";

const legalName =
  /^(?:licen[sc]e(?:[s._-]|$)|copying(?:[._-]|$)|copyright(?:[._-]|$)|notice(?:[s._-]|$)|third[-_ ]?party(?:[-_ ]?(?:notices?|licen[sc]es?))?(?:[._ -]|$)|patents(?:[._-]|$)|authors(?:[._-]|$)|eula(?:[._-]|$))/iu;
const excludedDirectories = new Set([
  "node_modules",
  ".git",
  "target",
  "__pycache__",
]);

export async function findLegalFiles(
  directory,
  root = directory,
  insideLegalDirectory = false,
) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const matches = legalName.test(entry.name);
    if (entry.isDirectory() && !excludedDirectories.has(entry.name)) {
      files.push(
        ...(await findLegalFiles(path, root, insideLegalDirectory || matches)),
      );
    } else if (entry.isFile()) {
      const readme = /^readme(?:\.[a-z]+)?$/iu.test(entry.name);
      const containsFullGrant =
        readme &&
        /Permission is hereby granted[\s\S]+THE SOFTWARE IS PROVIDED/iu.test(
          await readFile(path, "utf8"),
        );
      if (matches || insideLegalDirectory || containsFullGrant) {
        files.push(relative(root, path).split(sep).join("/"));
      }
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}

export function packageDestination(packageMetadata) {
  return `${packageMetadata.ecosystem}/${encodeURIComponent(packageMetadata.name)}@${encodeURIComponent(packageMetadata.version)}`;
}

export async function copyPackageLegalFiles(
  packageMetadata,
  outputDirectory,
  supplementalFiles = [],
) {
  const destination = packageDestination(packageMetadata);
  const files = await findLegalFiles(packageMetadata.directory);
  const packageManifest =
    packageMetadata.ecosystem === "npm" ? "package.json" : "Cargo.toml";
  if (files.length === 0 && supplementalFiles.length === 0) {
    throw new Error(
      `No licence/notice files found for ${packageMetadata.name}@${packageMetadata.version}. Add verified full upstream legal files before distributing it.`,
    );
  }
  files.push(packageManifest);
  const copiedFiles = [];
  for (const file of [...new Set(files)]) {
    const target = join(outputDirectory, destination, file);
    await mkdir(dirname(target), { recursive: true });
    await cp(join(packageMetadata.directory, file), target);
    copiedFiles.push(`${destination}/${file}`);
  }
  for (const { path, source, sha256 } of supplementalFiles) {
    const contents = await readFile(path);
    if (createHash("sha256").update(contents).digest("hex") !== sha256) {
      throw new Error(`Supplemental legal file failed its hash check: ${path}`);
    }
    const name = `upstream/${new URL(source).pathname.split("/").at(-1)}`;
    const target = join(outputDirectory, destination, name);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents);
    copiedFiles.push(`${destination}/${name}`);
  }
  let sourceDirectory;
  if (
    packageMetadata.ecosystem === "cargo" &&
    packageMetadata.license === "MPL-2.0"
  ) {
    sourceDirectory = `sources/${encodeURIComponent(packageMetadata.name)}@${encodeURIComponent(packageMetadata.version)}`;
    await cp(
      packageMetadata.directory,
      join(outputDirectory, sourceDirectory),
      { recursive: true },
    );
  }
  const { ecosystem, name, version, license, repository } = packageMetadata;
  return {
    ecosystem,
    name,
    version,
    license,
    repository,
    files: copiedFiles.sort((left, right) => left.localeCompare(right)),
    ...(supplementalFiles.length
      ? { upstreamSources: supplementalFiles.map(({ source }) => source) }
      : {}),
    ...(sourceDirectory ? { sourceDirectory } : {}),
  };
}

export async function hashFiles(directory, root = directory) {
  const files = {};
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort(
    (left, right) => left.name.localeCompare(right.name),
  )) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      Object.assign(files, await hashFiles(path, root));
    } else if (entry.isFile()) {
      const file = relative(root, path).split(sep).join("/");
      if (file !== "manifest.json") {
        files[file] = createHash("sha256")
          .update(await readFile(path))
          .digest("hex");
      }
    } else {
      throw new Error(`Unsupported entry in licence bundle: ${path}`);
    }
  }
  return files;
}

export async function writePackageIndex(directory, packages) {
  const rows = packages.map(
    ({ ecosystem, name, version, license, files, sourceDirectory }) =>
      `| ${ecosystem} | ${name.replaceAll("|", "\\|")} | ${version} | ${license.replaceAll("|", "\\|")} | [Legal files](${files[0].split("/").slice(0, 2).map(encodeURIComponent).join("/")}/)${sourceDirectory ? `; [source](${sourceDirectory.split("/").map(encodeURIComponent).join("/")}/)` : ""} |`,
  );
  await writeFile(
    join(directory, "DEPENDENCIES.md"),
    [
      "# Dependency notices",
      "",
      "This inventory covers the installed production graphs collected for this build, including dependencies that may be removed during bundling. Each component retains its own licence. Legal files and supplemental standard terms accompany this index; their sources are recorded in the manifest and supplemental index.",
      "",
      "MPL-only Rust crate sources are included under `sources/`. Replacements of LGPL libraries and other rights granted by component licences are not restricted by Machdoch's end-user terms. This bundle does not supply source/build materials for every separately distributed GPL/LGPL binary.",
      "",
      "| Ecosystem | Component | Version | Licence | Files |",
      "| --- | --- | --- | --- | --- |",
      ...rows,
      "",
    ].join("\n"),
  );
}
