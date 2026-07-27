import { lstat, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import {
  MAX_DISCOVERED_DIRECTORIES,
  MAX_DISCOVERED_LOCAL_FILES,
  assertContainedPath,
  canonicalizeExistingWorkspaceRoot,
  compareCanonicalStrings,
  readNormalizedInstructionFile,
  toPortableRelativePath,
} from "./normalization.js";
import {
  InstructionSystemError,
  type InstructionDiagnostic,
  type LocalInstructionRecord,
} from "./types.js";

const IGNORED_DIRECTORY_NAMES = new Set([
  ".git",
  ".machdoch",
  "node_modules",
  "coverage",
  "dist",
  "build",
  "target",
]);

const hostNameKey = (value: string): string =>
  process.platform === "win32" ? value.toLocaleLowerCase("en-US") : value;

const sameDirectoryIdentity = (
  left: Awaited<ReturnType<typeof lstat>>,
  right: Awaited<ReturnType<typeof lstat>>,
): boolean =>
  left.isDirectory() &&
  right.isDirectory() &&
  !left.isSymbolicLink() &&
  !right.isSymbolicLink() &&
  left.dev === right.dev &&
  left.ino === right.ino;

const scopeFromInstructionPath = (relativePath: string): string => {
  const segments = relativePath.split("/");
  segments.pop();
  return segments.length === 0 ? "." : segments.join("/");
};

export interface LocalInstructionDiscovery {
  files: LocalInstructionRecord[];
  diagnostics: InstructionDiagnostic[];
  visitedDirectories: number;
}

export const discoverLocalInstructions = async (
  workspaceRoot: string,
): Promise<LocalInstructionDiscovery> => {
  const canonicalRoot = await canonicalizeExistingWorkspaceRoot(workspaceRoot);
  const diagnostics: InstructionDiagnostic[] = [];
  const files: LocalInstructionRecord[] = [];
  let visitedDirectories = 0;

  const visit = async (directory: string): Promise<void> => {
    visitedDirectories += 1;
    if (visitedDirectories > MAX_DISCOVERED_DIRECTORIES) {
      throw new InstructionSystemError(
        "LOCAL_INSTRUCTION_DIRECTORY_LIMIT",
        `Instruction discovery exceeded ${MAX_DISCOVERED_DIRECTORIES} directories.`,
        diagnostics,
      );
    }

    const beforeResolution = await lstat(directory);
    if (!beforeResolution.isDirectory() || beforeResolution.isSymbolicLink()) {
      throw new InstructionSystemError(
        "LOCAL_INSTRUCTION_LINK_SKIPPED",
        `Instruction discovery refused a linked or non-directory path at ${directory}.`,
        diagnostics,
      );
    }
    const directoryRealPath = await realpath(directory);
    assertContainedPath(
      canonicalRoot,
      directoryRealPath,
      "LOCAL_INSTRUCTION_ESCAPE",
    );
    const [afterResolution, resolvedMetadata] = await Promise.all([
      lstat(directory),
      lstat(directoryRealPath),
    ]);
    if (
      !sameDirectoryIdentity(beforeResolution, afterResolution) ||
      !sameDirectoryIdentity(beforeResolution, resolvedMetadata)
    ) {
      throw new InstructionSystemError(
        "SOURCE_CHANGED_DURING_RESOLUTION",
        `Instruction directory ${directory} changed while its identity was being resolved.`,
        diagnostics,
      );
    }
    // Use the verified canonical spelling and recheck its identity after the
    // directory read. Node does not expose portable openat-style traversal.
    directory = directoryRealPath;
    const entries = await readdir(directory, { withFileTypes: true }).catch(
      (error: unknown) => {
        throw new InstructionSystemError(
          "LOCAL_INSTRUCTION_DIRECTORY_UNREADABLE",
          `Instruction discovery cannot read ${directory}.`,
          diagnostics,
          { cause: error },
        );
      },
    );
    entries.sort((left, right) =>
      compareCanonicalStrings(hostNameKey(left.name), hostNameKey(right.name)),
    );
    const afterRead = await lstat(directory);
    if (!sameDirectoryIdentity(beforeResolution, afterRead)) {
      throw new InstructionSystemError(
        "SOURCE_CHANGED_DURING_RESOLUTION",
        `Instruction directory ${directory} changed while it was being scanned.`,
        diagnostics,
      );
    }

    const agentsMatches = entries.filter(
      (entry) => hostNameKey(entry.name) === hostNameKey("AGENTS.md"),
    );
    if (agentsMatches.length > 1) {
      diagnostics.push({
        code: "LOCAL_INSTRUCTION_CASE_COLLISION",
        severity: "warning",
        message: `Skipped multiple case variants of AGENTS.md in ${toPortableRelativePath(canonicalRoot, directory)}.`,
        relativePath: toPortableRelativePath(canonicalRoot, directory),
      });
    }
    const agentsEntry =
      agentsMatches.length === 1 ? agentsMatches[0] : undefined;
    if (agentsEntry) {
      const path = join(directory, agentsEntry.name);
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink() || !metadata.isFile()) {
        diagnostics.push({
          code: "LOCAL_INSTRUCTION_NOT_REGULAR_FILE",
          severity: "warning",
          message: `Skipped ${toPortableRelativePath(canonicalRoot, path)} because instruction files must be regular, unlinked files.`,
          relativePath: toPortableRelativePath(canonicalRoot, path),
        });
      } else {
        const candidateRelativePath = toPortableRelativePath(
          canonicalRoot,
          path,
        );
        try {
          const pathReal = await realpath(path);
          assertContainedPath(
            canonicalRoot,
            pathReal,
            "LOCAL_INSTRUCTION_ESCAPE",
          );
          const relativePath = toPortableRelativePath(canonicalRoot, pathReal);
          const normalized = await readNormalizedInstructionFile(
            pathReal,
            relativePath,
          );
          if (files.length < MAX_DISCOVERED_LOCAL_FILES) {
            files.push({
              id: `local:${relativePath}`,
              relativePath,
              scopePath: scopeFromInstructionPath(relativePath),
              ...normalized,
            });
          } else {
            diagnostics.push({
              code: "LOCAL_INSTRUCTION_FILE_LIMIT",
              severity: "warning",
              message: `Skipped ${relativePath} because the ${MAX_DISCOVERED_LOCAL_FILES}-file instruction discovery limit was reached.`,
              relativePath,
            });
          }
          if (agentsEntry.name !== "AGENTS.md") {
            diagnostics.push({
              code: "LOCAL_INSTRUCTION_CASE_NORMALIZED",
              severity: "warning",
              message: `${relativePath} was matched case-insensitively as AGENTS.md on this host.`,
              relativePath,
            });
          }
        } catch (error) {
          diagnostics.push({
            code:
              error instanceof InstructionSystemError
                ? error.code
                : "LOCAL_INSTRUCTION_INVALID",
            severity: "warning",
            message: `Skipped invalid instruction file ${candidateRelativePath}: ${error instanceof Error ? error.message : String(error)}`,
            relativePath: candidateRelativePath,
          });
        }
      }
    }

    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        diagnostics.push({
          code: "LOCAL_INSTRUCTION_LINK_SKIPPED",
          severity: "warning",
          message: `Skipped linked entry ${toPortableRelativePath(
            canonicalRoot,
            join(directory, entry.name),
          )}.`,
          relativePath: toPortableRelativePath(
            canonicalRoot,
            join(directory, entry.name),
          ),
        });
        continue;
      }
      if (!entry.isDirectory()) continue;
      if (IGNORED_DIRECTORY_NAMES.has(hostNameKey(entry.name))) {
        diagnostics.push({
          code: "LOCAL_INSTRUCTION_DIRECTORY_IGNORED",
          severity: "info",
          message: `Skipped ignored directory ${toPortableRelativePath(
            canonicalRoot,
            join(directory, entry.name),
          )}.`,
          relativePath: toPortableRelativePath(
            canonicalRoot,
            join(directory, entry.name),
          ),
        });
        continue;
      }
      const child = join(directory, entry.name);
      const metadata = await lstat(child);
      if (metadata.isSymbolicLink()) continue;
      await visit(child);
    }
  };

  await visit(canonicalRoot);
  files.sort((left, right) => {
    const leftDepth =
      left.scopePath === "." ? 0 : left.scopePath.split("/").length;
    const rightDepth =
      right.scopePath === "." ? 0 : right.scopePath.split("/").length;
    return (
      leftDepth - rightDepth ||
      compareCanonicalStrings(
        hostNameKey(left.scopePath),
        hostNameKey(right.scopePath),
      )
    );
  });

  return { files, diagnostics, visitedDirectories };
};
