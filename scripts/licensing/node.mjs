import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function identifyNode(binary) {
  const version = binary === process.execPath
    ? process.version
    : execFileSync(binary, ["--version"], {
        encoding: "utf8",
        timeout: 30_000,
        windowsHide: true,
      }).trim();
  if (!/^v\d+\.\d+\.\d+$/u.test(version)) {
    throw new Error(`Cannot identify the embedded Node.js release: ${version}`);
  }
  return {
    version,
    sha256: createHash("sha256")
      .update(await readFile(binary))
      .digest("hex"),
  };
}

export async function collectNodeLicense(binary, outputDirectory) {
  const node = await identifyNode(binary);
  const url = `https://raw.githubusercontent.com/nodejs/node/${node.version}/LICENSE`;
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) {
    throw new Error(
      `Could not collect the embedded Node.js licence from ${url}: HTTP ${response.status}`,
    );
  }
  const content = await response.text();
  if (
    !content.includes("Node.js is licensed for use as follows:") ||
    !content.includes("MIT License")
  ) {
    throw new Error(`Unexpected licence document for Node.js ${node.version}`);
  }
  await mkdir(join(outputDirectory, "node"), { recursive: true });
  await writeFile(join(outputDirectory, "node/LICENSE"), content);
  return { ...node, source: url, file: "node/LICENSE" };
}
