import { existsSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, parse, relative, resolve } from "node:path";

const DANGEROUS_PATH_PATTERN =
  /(^|[\\/])(\.ssh|\.gnupg|\.aws|\.azure|\.kube|\.docker|secrets?|credentials?)([\\/]|$)|(^|[\\/])\.env(\.|$)/iu;

export const isPathInside = (root: string, candidate: string): boolean => {
  const relativePath = relative(root, candidate);

  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !isAbsolute(relativePath))
  );
};

export const isDangerousRalphWatchRoot = (path: string): boolean => {
  const resolved = resolve(path);
  const root = parse(resolved).root;
  const home = resolve(homedir());

  return (
    resolved === root ||
    resolved === home ||
    DANGEROUS_PATH_PATTERN.test(resolved)
  );
};

export const canonicalizeExistingRalphWatchPath = async (
  path: string,
): Promise<string> => {
  const resolved = resolve(path);

  return existsSync(resolved) ? realpath(resolved) : resolved;
};

const assertRalphWatchDirectory = async (
  path: string,
  label: string,
): Promise<void> => {
  const metadata = await stat(path);

  if (!metadata.isDirectory()) {
    throw new Error(`Expected ${label} to be a directory: ${path}`);
  }
};

export const normalizeRalphWatchPath = async (
  path: string,
  label: string,
  allowDangerousRoots: boolean,
): Promise<string> => {
  const trimmed = path.trim();

  if (!trimmed || !isAbsolute(trimmed)) {
    throw new Error(`Expected ${label} to be an absolute path.`);
  }

  const resolved = await canonicalizeExistingRalphWatchPath(trimmed);
  await assertRalphWatchDirectory(resolved, label);

  if (!allowDangerousRoots && isDangerousRalphWatchRoot(resolved)) {
    throw new Error(`Refusing to watch dangerous or overly broad path: ${resolved}`);
  }

  return resolved;
};
