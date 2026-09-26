import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const tauriDirectory = join(repositoryRoot, "apps/client/src-tauri");
const bundleDirectory = join(tauriDirectory, "target/release/bundle");
const configuration = JSON.parse(
  await readFile(join(tauriDirectory, "tauri.conf.json"), "utf8"),
);

function run(command, argumentsList) {
  execFileSync(command, argumentsList, { stdio: "inherit" });
}

function specValue(value, field) {
  if (typeof value !== "string" || !value.trim() || /[\r\n%]/u.test(value)) {
    throw new Error(`Invalid RPM ${field}`);
  }
  return value;
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function listPayloadPaths(directory, root = directory) {
  const paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      paths.push(...(await listPayloadPaths(entryPath, root)));
      continue;
    }
    if (!entry.isFile() && !entry.isSymbolicLink()) {
      throw new Error(`Unsupported RPM payload entry: ${entryPath}`);
    }
    const packagePath = `/${relative(root, entryPath).split(sep).join("/")}`;
    if (/[\s%]/u.test(packagePath)) {
      throw new Error(`Unsupported RPM package path: ${packagePath}`);
    }
    paths.push(packagePath);
  }
  return paths;
}

function dependencyLines(name, dependencies) {
  if (!Array.isArray(dependencies)) {
    throw new Error(`RPM ${name} must be a list`);
  }
  return dependencies.map(
    (dependency) => `${name}: ${specValue(dependency, name)}`,
  );
}

const productName = specValue(configuration.productName, "name");
const version = specValue(configuration.version, "version");
const bundle = configuration.bundle;
const rpm = bundle.linux.rpm;
const deb = bundle.linux.deb;

const packageFiles = (files) =>
  Object.entries(files).sort(([left], [right]) => left.localeCompare(right));
if (
  JSON.stringify(packageFiles(rpm.files)) !==
  JSON.stringify(packageFiles(deb.files))
) {
  throw new Error("RPM and Debian package files must contain the same payload");
}
if (
  rpm.compression?.type !== "zstd" ||
  !Number.isInteger(rpm.compression.level) ||
  rpm.compression.level < 1 ||
  rpm.compression.level > 19
) {
  throw new Error("RPM compression must specify a zstd level from 1 to 19");
}

const debPath = join(
  bundleDirectory,
  "deb",
  `${productName}_${version}_amd64.deb`,
);
if (!existsSync(debPath)) {
  throw new Error(`Missing Debian package: ${debPath}`);
}

const temporaryDirectory = await mkdtemp(join(tmpdir(), "machdoch-rpm-"));
try {
  const payloadDirectory = join(temporaryDirectory, "payload");
  const manifestPath = join(temporaryDirectory, "files.list");
  const specPath = join(temporaryDirectory, `${productName}.spec`);
  const rpmDirectory = join(bundleDirectory, "rpm");
  const rpmPath = join(rpmDirectory, `${productName}-${version}-1.x86_64.rpm`);

  await Promise.all([
    mkdir(payloadDirectory),
    mkdir(join(temporaryDirectory, "BUILD")),
    mkdir(join(temporaryDirectory, "BUILDROOT")),
  ]);
  await mkdir(rpmDirectory, { recursive: true });
  run("dpkg-deb", ["--extract", debPath, payloadDirectory]);

  const payloadPaths = (await listPayloadPaths(payloadDirectory)).sort(
    (left, right) => left.localeCompare(right),
  );
  if (!payloadPaths.includes(`/usr/bin/${productName}`)) {
    throw new Error(`Debian package does not contain /usr/bin/${productName}`);
  }
  const resourceDirectories = [
    `/usr/lib/${productName}`,
    ...payloadPaths
      .filter((path) => path.startsWith(`/usr/lib/${productName}/`))
      .flatMap((path) => {
        const directories = [];
        let current = dirname(path);
        while (current !== `/usr/lib/${productName}`) {
          directories.push(current);
          current = dirname(current);
        }
        return directories;
      }),
  ];
  const manifest = [
    ...new Set(
      resourceDirectories.filter((path) =>
        existsSync(join(payloadDirectory, path)),
      ),
    ),
  ]
    .sort((left, right) => left.localeCompare(right))
    .map((path) => `%dir ${path}`)
    .concat(payloadPaths);
  await writeFile(manifestPath, `${manifest.join("\n")}\n`);

  const spec = [
    "%global debug_package %{nil}",
    "%global __os_install_post %{nil}",
    "%global _build_id_links none",
    `%global _binary_payload w${rpm.compression.level}.zstdio`,
    `Name: ${productName}`,
    `Version: ${version}`,
    "Release: 1",
    `Summary: ${specValue(bundle.shortDescription, "summary")}`,
    "License: Unspecified",
    `URL: ${specValue(bundle.homepage, "URL")}`,
    "BuildArch: x86_64",
    "AutoReqProv: no",
    ...dependencyLines("Requires", rpm.depends),
    ...dependencyLines("Recommends", rpm.recommends),
    "",
    "%description",
    specValue(bundle.longDescription, "description"),
    "",
    "%prep",
    "",
    "%build",
    "",
    "%install",
    "mkdir -p %{buildroot}",
    `cp -a --link ${shellQuote(payloadDirectory)}/. %{buildroot}/`,
    "",
    `%files -f ${manifestPath}`,
    "%defattr(-,root,root,-)",
    "",
  ].join("\n");
  await writeFile(specPath, spec);

  run("rpmbuild", [
    "-bb",
    "--define",
    `_topdir ${temporaryDirectory}`,
    "--define",
    `_rpmdir ${rpmDirectory}`,
    "--define",
    `_rpmfilename %{NAME}-%{VERSION}-%{RELEASE}.%{ARCH}.rpm`,
    specPath,
  ]);
  if (!existsSync(rpmPath)) {
    throw new Error(`RPM package was not created: ${rpmPath}`);
  }
  console.log(`Built ${basename(rpmPath)}`);
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
