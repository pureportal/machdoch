import { execFile } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  downloadVerifiedAsset,
  sha256File,
} from "./download-verified-asset.mjs";

const execute = promisify(execFile);
const flatFilename = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

export function validateCabinet(bytes) {
  if (
    bytes.length < 36 ||
    bytes.toString("ascii", 0, 4) !== "MSCF" ||
    bytes.readUInt32LE(4) !== 0 ||
    bytes.readUInt32LE(12) !== 0 ||
    bytes.readUInt32LE(20) !== 0 ||
    bytes.readUInt32LE(8) < 36 ||
    bytes.readUInt32LE(8) > bytes.length ||
    bytes[24] !== 3 ||
    bytes[25] !== 1 ||
    ![0, 4].includes(bytes.readUInt16LE(30))
  )
    throw new Error("Invalid Windows runtime cabinet header.");
  bytes = bytes.subarray(0, bytes.readUInt32LE(8));
  const reserved = bytes.readUInt16LE(30) === 4;
  if (reserved && bytes.length < 40)
    throw new Error("Invalid Windows runtime cabinet reserve.");
  const headerSize = reserved ? 40 + bytes.readUInt16LE(36) : 36;
  const folderSize = 8 + (reserved ? bytes[38] : 0);
  const folderCount = bytes.readUInt16LE(26);
  const fileCount = bytes.readUInt16LE(28);
  let offset = bytes.readUInt32LE(16);
  if (
    !folderCount ||
    !fileCount ||
    fileCount > 1024 ||
    offset < headerSize + folderCount * folderSize
  )
    throw new Error("Invalid Windows runtime cabinet table.");
  const names = new Set();
  let totalSize = 0;
  for (let index = 0; index < fileCount; index++) {
    if (
      offset + 16 >= bytes.length ||
      bytes.readUInt16LE(offset + 8) >= folderCount
    )
      throw new Error("Invalid Windows runtime cabinet entry.");
    totalSize += bytes.readUInt32LE(offset);
    const end = bytes.indexOf(0, offset + 16);
    if (end < 0 || totalSize > 128 * 1024 * 1024)
      throw new Error("Invalid Windows runtime cabinet contents.");
    const name = bytes.toString("utf8", offset + 16, end);
    if (!flatFilename.test(name) || names.has(name.toLowerCase()))
      throw new Error(`Unsafe Windows runtime cabinet filename: ${name}.`);
    names.add(name.toLowerCase());
    offset = end + 1;
  }
  return names;
}

async function verifyRuntimeFiles(files, directories) {
  for (const directory of directories) {
    for (const file of files) {
      const path = join(directory, file.name);
      const info = await stat(path).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (
        !info?.isFile() ||
        info.size !== file.size ||
        (await sha256File(path)) !== file.sha256
      )
        return false;
    }
  }
  return true;
}

async function extractRuntime(asset, archive, root, directories) {
  const bytes = await readFile(archive);
  const end = asset.containerOffset + asset.containerSize;
  if (
    !Number.isSafeInteger(asset.containerOffset) ||
    asset.containerOffset < 0 ||
    !Number.isSafeInteger(end) ||
    end > bytes.length
  )
    throw new Error("Invalid Windows runtime container bounds.");
  const container = bytes.subarray(asset.containerOffset, end);
  if (!validateCabinet(container).has(asset.cabinet.toLowerCase()))
    throw new Error("The Windows runtime cabinet is missing.");
  const staging = await mkdtemp(join(root, ".windows-runtime-extract-"));
  if (dirname(resolve(staging)) !== resolve(root))
    throw new Error(
      "Windows runtime staging is outside its resource directory.",
    );
  const expand = join(process.env.SystemRoot, "System32", "expand.exe");
  try {
    const containerPath = join(staging, "container.cab");
    const cabinetDirectory = join(staging, "cabinet");
    const filesDirectory = join(staging, "files");
    await mkdir(cabinetDirectory);
    await mkdir(filesDirectory);
    await writeFile(containerPath, container);
    const options = {
      windowsHide: true,
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
    };
    await execute(
      expand,
      [`-F:${asset.cabinet}`, containerPath, cabinetDirectory],
      options,
    );
    const cabinetPath = join(cabinetDirectory, asset.cabinet);
    const names = validateCabinet(await readFile(cabinetPath));
    for (const file of asset.files) {
      if (
        !flatFilename.test(file.name) ||
        !flatFilename.test(file.source) ||
        !names.has(file.source.toLowerCase())
      )
        throw new Error(`Invalid Windows runtime file: ${file.name}.`);
    }
    await execute(expand, ["-F:*", cabinetPath, filesDirectory], options);
    for (const file of asset.files) {
      const source = join(filesDirectory, file.source);
      if (
        (await stat(source)).size !== file.size ||
        (await sha256File(source)) !== file.sha256
      )
        throw new Error(
          `Windows runtime integrity check failed: ${file.name}.`,
        );
      for (const directory of directories) {
        await mkdir(directory, { recursive: true });
        await copyFile(source, join(directory, file.name));
      }
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

const extractLicense = `
import sys
from xml.etree import ElementTree
from zipfile import ZipFile
with ZipFile(sys.argv[1]) as archive:
    document = ElementTree.fromstring(archive.read("word/document.xml"))
    namespace = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
    paragraphs = ["".join(node.text or "" for node in paragraph.findall(".//w:t", namespace)) for paragraph in document.findall(".//w:p", namespace)]
    sys.stdout.buffer.write(("\\n".join(paragraphs) + "\\n").encode("utf-8"))
`;

export async function prepareWindowsSpeechRuntime(
  asset,
  root,
  legal,
  python,
  projectLicense,
) {
  if (
    !flatFilename.test(asset.cabinet) ||
    !asset.files.length ||
    asset.files.some(
      (file) =>
        !flatFilename.test(file.name) || !flatFilename.test(file.source),
    )
  )
    throw new Error("Invalid Windows runtime asset paths.");
  const archive = join(root, asset.path);
  await downloadVerifiedAsset(asset, archive);
  for (const license of [
    asset.license,
    asset.distributionLicense,
    asset.distributionList,
  ])
    await downloadVerifiedAsset(license, join(legal, license.path));
  const directories = [join(root, "windows-runtime"), join(root, "runtime")];
  if (!(await verifyRuntimeFiles(asset.files, directories))) {
    await extractRuntime(asset, archive, root, directories);
    if (!(await verifyRuntimeFiles(asset.files, directories)))
      throw new Error(
        "The application-local Windows runtime failed verification.",
      );
  }
  const legalFiles = [];
  let runtimeTerms;
  for (const license of [asset.license, asset.distributionLicense]) {
    const source = join(legal, license.path);
    const { stdout } = await execute(
      python,
      ["-I", "-c", extractLicense, source],
      {
        windowsHide: true,
        encoding: "utf8",
        timeout: 60_000,
        maxBuffer: 1024 * 1024,
      },
    );
    if (!stdout.includes("MICROSOFT SOFTWARE LICENSE TERMS"))
      throw new Error("The Windows runtime licence text is missing.");
    const path = license.path.replace(/\.docx$/, ".txt");
    await writeFile(join(legal, path), stdout);
    legalFiles.push({ path, sha256: await sha256File(join(legal, path)) });
    if (license === asset.license) runtimeTerms = stdout;
  }
  const installerPath = "windows-runtime/INSTALLER-LICENSE.txt";
  await writeFile(
    join(legal, installerPath),
    `${await readFile(projectLicense, "utf8")}\n\nMicrosoft Visual C++ runtime\n\nThe bundled Microsoft runtime is subject to the following terms. By installing Machdoch, you accept these terms for that component.\n\n${runtimeTerms}`,
  );
  legalFiles.push({
    path: installerPath,
    sha256: await sha256File(join(legal, installerPath)),
  });
  await writeFile(
    join(legal, "windows-runtime.json"),
    `${JSON.stringify(
      {
        version: asset.version,
        source: { url: asset.url, sha256: asset.sha256 },
        files: asset.files.map(({ source: _source, ...file }) => file),
        licenses: [
          asset.license,
          asset.distributionLicense,
          asset.distributionList,
          ...legalFiles,
        ],
      },
      null,
      2,
    )}\n`,
  );
  console.log(
    `Verified application-local Windows C++ runtime ${asset.version}: ${asset.files.length} DLLs.`,
  );
}
