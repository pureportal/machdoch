import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { create as createTar } from "tar";

export const buildBrowserRuntimeArchive = async (
  sourceDirectory,
  outputFile,
) => {
  const directory = await mkdtemp(join(tmpdir(), "machdoch-browser-runtime-"));
  try {
    await cp(sourceDirectory, directory, {
      recursive: true,
      preserveTimestamps: true,
    });
    const files = (
      await readdir(directory, { recursive: true, withFileTypes: true })
    )
      .filter((entry) => entry.isFile())
      .map((entry) => relative(directory, join(entry.parentPath, entry.name)))
      .sort();
    if (files.length === 0) {
      throw new Error("The browser runtime package contains no files.");
    }
    await createTar.asyncFile(
      {
        cwd: directory,
        file: outputFile,
        gzip: true,
        portable: true,
        strict: true,
        prefix: "node_modules/playwright-core",
      },
      files,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};
