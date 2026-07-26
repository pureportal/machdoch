import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import {
  isAbsolute,
  normalize,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  compareCanonicalStrings,
  stableJson,
} from "../provider-enrollment/digests.js";
import { readOpenedFileExactly } from "../_helpers/read-opened-file-exactly.helper.js";
import { InstructionSystemError } from "./types.js";

export const MAX_INSTRUCTION_SOURCE_BYTES = 128 * 1024;
export const MAX_INSTRUCTION_ENVELOPE_BYTES = 128 * 1024;
export const INSTRUCTION_ADVISORY_BYTES = 32 * 1024;
export const INSTRUCTION_ADVISORY_LINES = 200;
export const INSTRUCTION_PROVIDER_RESERVE_TOKENS = 16 * 1024;
export const MAX_DISCOVERED_DIRECTORIES = 50_000;
export const MAX_DISCOVERED_LOCAL_FILES = 256;

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const UTF8_ENCODER = new TextEncoder();
const WINDOWS_DRIVE_PATH = /^[a-z]:/iu;

export const utf8ByteLength = (value: string): number =>
  UTF8_ENCODER.encode(value).byteLength;

export const unicodeCodePointLength = (value: string): number =>
  Array.from(value).length;

/**
 * A portable admission-control upper bound when the selected provider's exact
 * tokenizer is unavailable. Average prose ratios such as four bytes per token
 * can underestimate code, symbols, or non-ASCII input and are not safe here.
 */
export const estimateConservativeTokensFromUtf8Bytes = (
  byteLength: number,
): number => Math.max(0, Math.ceil(byteLength));

export const sha256 = (value: string | NodeJS.ArrayBufferView): string =>
  createHash("sha256").update(value).digest("hex");

export const canonicalDigest = (value: unknown): string =>
  sha256(stableJson(value));

export { compareCanonicalStrings };

export const normalizeInstructionBody = (
  input: Uint8Array | string,
  sourceLabel: string,
): string => {
  let body: string;
  try {
    body = typeof input === "string" ? input : UTF8_DECODER.decode(input);
  } catch (error) {
    throw new InstructionSystemError(
      "INSTRUCTION_INVALID_UTF8",
      `${sourceLabel} is not valid UTF-8.`,
      [],
      { cause: error },
    );
  }

  if (body.startsWith("\uFEFF")) {
    body = body.slice(1);
  }
  body = body.replace(/\r\n?/gu, "\n");

  if (body.includes("\0")) {
    throw new InstructionSystemError(
      "INSTRUCTION_NUL_BYTE",
      `${sourceLabel} contains a NUL character.`,
    );
  }
  if (body.trim().length === 0) {
    throw new InstructionSystemError(
      "INSTRUCTION_EMPTY",
      `${sourceLabel} is empty.`,
    );
  }
  const byteLength = utf8ByteLength(body);
  if (byteLength > MAX_INSTRUCTION_SOURCE_BYTES) {
    throw new InstructionSystemError(
      "INSTRUCTION_SOURCE_TOO_LARGE",
      `${sourceLabel} is ${byteLength} bytes; the limit is ${MAX_INSTRUCTION_SOURCE_BYTES} bytes.`,
    );
  }
  return body;
};

export const readNormalizedInstructionFile = async (
  path: string,
  sourceLabel = path,
): Promise<{
  body: string;
  digest: string;
  byteLength: number;
  lineCount: number;
  identity: string;
}> => {
  let firstIdentity = "";
  let bytes: Buffer | undefined;
  const observations: string[] = [];

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const beforePath = await lstat(path);
    if (!beforePath.isFile() || beforePath.isSymbolicLink()) {
      throw new InstructionSystemError(
        "INSTRUCTION_NOT_REGULAR_FILE",
        `${sourceLabel} is not a regular file or is a link.`,
      );
    }
    if (beforePath.size > MAX_INSTRUCTION_SOURCE_BYTES + 3) {
      throw new InstructionSystemError(
        "INSTRUCTION_SOURCE_TOO_LARGE",
        `${sourceLabel} exceeds the ${MAX_INSTRUCTION_SOURCE_BYTES}-byte source limit.`,
      );
    }

    let handle;
    let before;
    let after;
    try {
      handle = await open(
        path,
        constants.O_RDONLY |
          (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
      );
      before = await handle.stat();
      bytes = await readOpenedFileExactly(handle, before.size);
      after = await handle.stat();
    } catch (error) {
      throw new InstructionSystemError(
        "INSTRUCTION_SOURCE_UNREADABLE",
        `${sourceLabel} could not be opened safely for reading.`,
        [],
        { cause: error },
      );
    } finally {
      await handle?.close();
    }
    const afterPath = await lstat(path);
    const beforeIdentity = [
      beforePath.dev,
      beforePath.ino,
      beforePath.size,
      beforePath.mtimeMs,
    ].join(":");
    const openedIdentity = [
      before.dev,
      before.ino,
      before.size,
      before.mtimeMs,
    ].join(":");
    const afterIdentity = [
      afterPath.dev,
      afterPath.ino,
      afterPath.size,
      afterPath.mtimeMs,
    ].join(":");
    observations.push(
      `attempt=${attempt + 1};path-before=${beforeIdentity};opened=${openedIdentity};path-after=${afterIdentity}`,
    );
    const stable =
      !afterPath.isSymbolicLink() &&
      afterPath.isFile() &&
      beforePath.dev === before.dev &&
      beforePath.ino === before.ino &&
      before.dev === after.dev &&
      before.ino === after.ino &&
      before.size === after.size &&
      before.mtimeMs === after.mtimeMs &&
      after.dev === afterPath.dev &&
      after.ino === afterPath.ino &&
      after.size === afterPath.size &&
      after.mtimeMs === afterPath.mtimeMs;
    if (stable) {
      firstIdentity = `${beforeIdentity}:${afterIdentity}`;
      break;
    }
    if (attempt === 1) {
      throw new InstructionSystemError(
        "SOURCE_CHANGED_DURING_RESOLUTION",
        `${sourceLabel} changed while it was being read on both bounded attempts.`,
        [
          {
            code: "SOURCE_CHANGED_DURING_RESOLUTION",
            severity: "error",
            message: `${sourceLabel} did not retain the same file identity while it was read.`,
            details: { observations },
          },
        ],
      );
    }
  }

  const body = normalizeInstructionBody(bytes ?? new Uint8Array(), sourceLabel);
  return {
    body,
    digest: sha256(body),
    byteLength: utf8ByteLength(body),
    lineCount: body.split("\n").length,
    identity: firstIdentity,
  };
};

export const normalizeProfileName = (name: string): string => {
  const normalized = name.trim().normalize("NFKC");
  if (normalized.length === 0) {
    throw new InstructionSystemError(
      "PROFILE_NAME_EMPTY",
      "Profile names cannot be empty.",
    );
  }
  if (unicodeCodePointLength(normalized) > 200) {
    throw new InstructionSystemError(
      "PROFILE_NAME_TOO_LONG",
      "Profile names cannot exceed 200 characters.",
    );
  }
  return normalized;
};

/**
 * Create a locale-independent Unicode caseless key.
 *
 * JavaScript does not expose Unicode's CaseFolding.txt directly. Applying
 * full default upper- and lower-case mappings around NFKC handles expanding
 * mappings such as `ß` -> `SS` as well as compatibility characters, without
 * making identity depend on the host locale.
 */
export const profileNameKey = (name: string): string =>
  normalizeProfileName(name)
    .normalize("NFKC")
    .toUpperCase()
    .toLowerCase()
    .normalize("NFKC");

export const normalizeScopePath = (path: string): string => {
  const trimmed = path.trim().replaceAll("\\", "/");
  if (trimmed === ".") {
    return ".";
  }
  if (trimmed === "") {
    throw new InstructionSystemError(
      "INVALID_SCOPE_PATH",
      "Instruction scope paths cannot be empty; use \".\" for the workspace root.",
    );
  }
  if (
    trimmed.includes("\0") ||
    trimmed.startsWith("/") ||
    trimmed.startsWith("//") ||
    WINDOWS_DRIVE_PATH.test(trimmed) ||
    isAbsolute(trimmed)
  ) {
    throw new InstructionSystemError(
      "INVALID_SCOPE_PATH",
      `Instruction scope "${path}" must be a workspace-relative directory.`,
    );
  }
  const segments = trimmed.split("/");
  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === ".." ||
        segment.includes("\0"),
    )
  ) {
    throw new InstructionSystemError(
      "INVALID_SCOPE_PATH",
      `Instruction scope "${path}" contains an invalid path segment.`,
    );
  }
  const normalizedSegments = segments.filter((segment) => segment !== ".");
  return normalizedSegments.length === 0 ? "." : normalizedSegments.join("/");
};

export const scopeDepth = (path: string): number =>
  path === "." ? 0 : path.split("/").length;

export const isScopeAncestor = (
  ancestor: string,
  descendant: string,
): boolean => {
  const left = normalizeScopePath(ancestor);
  const right = normalizeScopePath(descendant);
  return left === "." || right === left || right.startsWith(`${left}/`);
};

const stripWindowsExtendedPathPrefix = (path: string): string => {
  if (process.platform !== "win32") return path;
  if (path.startsWith("\\\\?\\UNC\\")) {
    return `\\\\${path.slice("\\\\?\\UNC\\".length)}`;
  }
  return path.startsWith("\\\\?\\") ? path.slice("\\\\?\\".length) : path;
};

const comparablePath = (path: string): string => {
  const normalized = normalize(resolve(stripWindowsExtendedPathPrefix(path)));
  return process.platform === "win32"
    ? normalized.toLocaleLowerCase("en-US")
    : normalized;
};

export const pathsEqualForHost = (left: string, right: string): boolean =>
  comparablePath(left) === comparablePath(right);

export const assertContainedPath = (
  root: string,
  candidate: string,
  code = "PATH_OUTSIDE_WORKSPACE",
): void => {
  const rel = relative(resolve(root), resolve(candidate));
  if (
    rel === ".." ||
    rel.startsWith(`..${sep}`) ||
    isAbsolute(rel)
  ) {
    throw new InstructionSystemError(
      code,
      `${candidate} is outside workspace ${root}.`,
    );
  }
};

export const canonicalizeExistingWorkspaceRoot = async (
  workspaceRoot: string,
): Promise<string> => {
  const absolute = resolve(workspaceRoot);
  const metadata = await lstat(absolute).catch((error: unknown) => {
    throw new InstructionSystemError(
      "WORKSPACE_ROOT_UNREADABLE",
      `Workspace root ${absolute} cannot be read.`,
      [],
      { cause: error },
    );
  });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new InstructionSystemError(
      "WORKSPACE_ROOT_INVALID",
      `Workspace root ${absolute} must be a real directory, not a link.`,
    );
  }
  const canonical = await realpath(absolute);
  const [after, canonicalMetadata] = await Promise.all([
    lstat(absolute),
    lstat(canonical),
  ]);
  const stable =
    after.isDirectory() &&
    canonicalMetadata.isDirectory() &&
    !after.isSymbolicLink() &&
    !canonicalMetadata.isSymbolicLink() &&
    metadata.dev === after.dev &&
    metadata.ino === after.ino &&
    metadata.dev === canonicalMetadata.dev &&
    metadata.ino === canonicalMetadata.ino;
  if (!stable) {
    throw new InstructionSystemError(
      "WORKSPACE_ROOT_CHANGED",
      `Workspace root ${absolute} changed while its identity was being resolved.`,
    );
  }
  return canonical;
};

export const toPortableRelativePath = (
  root: string,
  path: string,
): string => {
  assertContainedPath(root, path);
  const value = relative(root, path).split(sep).join("/");
  return value.length === 0 ? "." : value;
};

export const deepFreeze = <T>(value: T): Readonly<T> => {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
};
