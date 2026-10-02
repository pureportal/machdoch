import { constants } from "node:fs";
import { copyFile, mkdtemp } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  parseRalphScopeRegistry,
  RalphScopeRegistryInvalidError,
  readRalphScopeRegistryFile,
  type RalphScopeRegistry,
} from "./ralph-scope-registry.helper.js";

export const readRalphScopeRegistryForDiscovery = async (
  path: string,
  options: Parameters<typeof readRalphScopeRegistryFile>[1] & {
    markdownPath?: string;
    assertOwnership: () => Promise<void>;
  },
): Promise<{
  registry: RalphScopeRegistry;
  recovery?: { archiveDirectory: string; reason: string };
}> => {
  try {
    return { registry: await readRalphScopeRegistryFile(path, options) };
  } catch (error) {
    if (!(error instanceof RalphScopeRegistryInvalidError)) {
      throw error;
    }
    await options.assertOwnership();
    const archiveDirectory = await mkdtemp(
      join(dirname(path), ".invalid-scope-registry-"),
    );
    await copyFile(
      path,
      join(archiveDirectory, basename(path)),
      constants.COPYFILE_EXCL,
    );
    if (options.markdownPath) {
      try {
        await copyFile(
          options.markdownPath,
          join(archiveDirectory, "scope-registry.md"),
          constants.COPYFILE_EXCL,
        );
      } catch (archiveError) {
        if ((archiveError as NodeJS.ErrnoException).code !== "ENOENT") {
          throw archiveError;
        }
      }
    }
    await options.assertOwnership();
    return {
      registry: parseRalphScopeRegistry(undefined, options),
      recovery: { archiveDirectory, reason: error.message },
    };
  }
};
