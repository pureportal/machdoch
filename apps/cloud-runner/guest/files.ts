import { open, mkdir, readdir, realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { constants } from "node:fs";
import { createHash } from "node:crypto";

const root = "/workspace";
function pathFor(path: unknown, allowedRoot = root): string {
  if (typeof path !== "string" || path.length > 4096 || path.includes("\0"))
    throw new Error("Invalid workspace path");
  const absolute = resolve(allowedRoot, path);
  if (absolute !== allowedRoot && !absolute.startsWith(allowedRoot + "/"))
    throw new Error("Path is outside the workspace");
  return absolute;
}
async function existingPath(
  path: unknown,
  allowedRoot = root,
): Promise<string> {
  const actual = await realpath(pathFor(path, allowedRoot));
  if (actual !== allowedRoot && !actual.startsWith(allowedRoot + "/"))
    throw new Error("Link points outside the workspace");
  return actual;
}
function boundedInteger(value: unknown, maximum: number): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > maximum
  )
    throw new Error("Invalid file range");
  return value;
}
async function createParent(directory: string): Promise<string> {
  const missing: string[] = [];
  let current = directory;
  while (true) {
    try {
      const parent = await existingPath(current);
      const target = resolve(parent, ...missing);
      await mkdir(target, { recursive: true });
      return target;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "ENOENT" ||
        current === root
      )
        throw error;
      missing.unshift(basename(current));
      current = dirname(current);
    }
  }
}
export async function readFile(
  input: Record<string, unknown>,
  allowedRoot = root,
) {
  const path = await existingPath(input.path, allowedRoot);
  const offset = boundedInteger(input.offset ?? 0, Number.MAX_SAFE_INTEGER);
  const limit = boundedInteger(input.limit ?? 65536, 262144);
  const encoding = input.encoding ?? "utf8";
  if (encoding !== "utf8" && encoding !== "base64")
    throw new Error("Invalid file encoding");
  if (limit < (encoding === "utf8" ? 4 : 1))
    throw new Error(
      "Read at least four bytes for UTF-8 text, or one byte for base64.",
    );
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error("Path is not a regular file");
    const bytes = Buffer.alloc(limit);
    const result = await file.read(bytes, 0, limit, offset);
    const contents = bytes.subarray(0, result.bytesRead);
    let content;
    if (encoding === "utf8") {
      try {
        content = new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: true,
        }).decode(contents, { stream: offset + result.bytesRead < info.size });
      } catch {
        throw new Error("File contains binary data. Read it as base64.");
      }
      if (/[\p{Cc}--[\t\n\r]]/v.test(content))
        throw new Error("File contains binary data. Read it as base64.");
    } else content = contents.toString("base64");
    return {
      content,
      encoding,
      offset,
      nextOffset:
        offset +
        (encoding === "utf8"
          ? Buffer.byteLength(content, "utf8")
          : result.bytesRead),
      size: info.size,
    };
  } finally {
    await file.close();
  }
}
export async function writeFile(input: Record<string, unknown>) {
  if (
    typeof input.content !== "string" ||
    Buffer.byteLength(input.content) > 262144
  )
    throw new Error("File content exceeds 256 KiB");
  const path = pathFor(input.path);
  const parent = await createParent(dirname(path));
  const file = await open(
    resolve(parent, basename(path)),
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_TRUNC |
      constants.O_NOFOLLOW |
      constants.O_NONBLOCK,
    0o600,
  );
  try {
    if (!(await file.stat()).isFile())
      throw new Error("Path is not a regular file");
    await file.writeFile(input.content, "utf8");
    return { path: input.path, bytes: Buffer.byteLength(input.content) };
  } finally {
    await file.close();
  }
}
export async function listFiles(input: Record<string, unknown>) {
  const entries = await readdir(await existingPath(input.path ?? "."), {
    withFileTypes: true,
  });
  entries.sort((a, b) => a.name.localeCompare(b.name, "en"));
  const offset = boundedInteger(input.offset ?? 0, 1_000_000);
  return {
    entries: entries.slice(offset, offset + 200).map((entry) => ({
      name: entry.name,
      kind: entry.isDirectory()
        ? "directory"
        : entry.isSymbolicLink()
          ? "link"
          : "file",
    })),
    nextOffset: offset + 200 < entries.length ? offset + 200 : null,
  };
}
export async function commandDirectory(path: unknown) {
  return existingPath(path ?? ".");
}

const artifactRoot = "/tmp/machdoch-artifacts";
export async function describeArtifact(input: Record<string, unknown>) {
  const path = await existingPath(input.path, artifactRoot);
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 64 * 1024 * 1024)
      throw new Error(
        "Artifact exceeds its size limit or is not a regular file",
      );
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      bytes += chunk.length;
      if (bytes > 64 * 1024 * 1024)
        throw new Error("Artifact exceeds its size limit");
      hash.update(chunk);
    }
    if (bytes !== info.size) throw new Error("Artifact changed while hashing");
    return { byteLength: bytes, sha256: hash.digest("hex") };
  } finally {
    await file.close();
  }
}
export async function writeArtifact(input: Record<string, unknown>) {
  if (
    typeof input.path !== "string" ||
    !/^[a-zA-Z0-9_.-]{1,120}$/.test(input.path) ||
    input.path === "." ||
    input.path === ".." ||
    typeof input.content !== "string" ||
    input.content.length > 43692 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      input.content,
    )
  )
    throw new Error("Invalid artifact chunk");
  const offset = boundedInteger(input.offset, 64 * 1024 * 1024);
  const bytes = Buffer.from(input.content, "base64");
  if (
    !bytes.length ||
    bytes.length > 32768 ||
    offset + bytes.length > 64 * 1024 * 1024
  )
    throw new Error("Artifact chunk exceeds its limit");
  await mkdir(artifactRoot, { recursive: true, mode: 0o700 });
  const file = await open(
    pathFor(input.path, artifactRoot),
    constants.O_RDWR |
      constants.O_CREAT |
      constants.O_NOFOLLOW |
      constants.O_NONBLOCK,
    0o600,
  );
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error("Artifact is not a regular file");
    if (offset < info.size) {
      const previous = Buffer.alloc(bytes.length);
      const read = await file.read(previous, 0, previous.length, offset);
      if (read.bytesRead !== bytes.length || !previous.equals(bytes))
        throw new Error("Conflicting artifact chunk");
      return { receivedBytes: info.size };
    }
    if (offset !== info.size) throw new Error("Artifact chunk is out of order");
    let written = 0;
    while (written < bytes.length) {
      const result = await file.write(
        bytes,
        written,
        bytes.length - written,
        offset + written,
      );
      if (!result.bytesWritten)
        throw new Error("Artifact write made no progress");
      written += result.bytesWritten;
    }
    return { receivedBytes: offset + bytes.length };
  } finally {
    await file.close();
  }
}
