/// <reference types="node" />

import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { create as createTar } from "tar";
import { describe, expect, it } from "vitest";
import { installHeadlessUpdate } from "./headless-install.js";

async function createInstallation() {
  const directory = await mkdtemp(
    join(tmpdir(), "machdoch-headless-update-test-"),
  );
  const root = join(directory, "installed");
  await mkdir(join(root, "releases", "1.0.0"), { recursive: true });
  await writeFile(join(root, "current"), "1.0.0\n");
  await writeFile(
    join(root, "releases", "1.0.0", "keep.txt"),
    "working release",
  );
  return { directory, root };
}

async function createArchive(
  directory: string,
  options: { broken?: boolean; unsafe?: boolean; node?: string } = {},
) {
  const stage = join(directory, "archive");
  const root = join(stage, "machdoch");
  const payload = join(root, "releases", "2.0.0");
  await mkdir(join(payload, "node_modules", "playwright-core"), {
    recursive: true,
  });
  await writeFile(join(root, "current"), "2.0.0\n");
  for (const [file, contents] of Object.entries({
    "package.json": JSON.stringify({
      name: "machdoch-headless",
      version: "2.0.0",
      engines: { node: options.node ?? ">=22.13" },
    }),
    "machdoch-cli.cjs": options.broken
      ? "process.exit(1)"
      : "process.stdout.write('update help')",
    "node_modules/playwright-core/package.json": "{}",
    LICENSE: "license",
    NOTICE: "notice",
    "EULA.md": "eula",
    "THIRD_PARTY_NOTICES.md": "third parties",
  }))
    await writeFile(join(payload, file), contents);
  const archive = join(directory, "update.tar.gz");
  await createTar.asyncFile(
    {
      cwd: stage,
      file: archive,
      gzip: true,
      portable: true,
      onWriteEntry(entry) {
        if (options.unsafe && entry.path.endsWith("machdoch-cli.cjs"))
          entry.path = "machdoch/../../escape.cjs";
      },
    },
    ["machdoch"],
  );
  return archive;
}

describe("headless release activation", () => {
  it("activates a complete release atomically while keeping the previous release", async () => {
    const { root, directory } = await createInstallation();
    try {
      const archive = await createArchive(directory);
      await installHeadlessUpdate(root, archive, "2.0.0");
      expect((await readFile(join(root, "current"), "utf8")).trim()).toBe(
        "2.0.0",
      );
      expect(
        await readFile(join(root, "releases", "1.0.0", "keep.txt"), "utf8"),
      ).toBe("working release");
      expect(await readdir(join(root, "releases"))).toEqual(["1.0.0", "2.0.0"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(["broken", "unsafe", "node"] as const)(
    "leaves the active release intact after a %s package failure",
    async (failure) => {
      const { root, directory } = await createInstallation();
      try {
        const archive = await createArchive(directory, {
          ...(failure === "node" ? { node: ">=999.0.0" } : { [failure]: true }),
        });
        await expect(
          installHeadlessUpdate(root, archive, "2.0.0"),
        ).rejects.toThrow();
        expect((await readFile(join(root, "current"), "utf8")).trim()).toBe(
          "1.0.0",
        );
        expect(await readdir(join(root, "releases"))).toEqual(["1.0.0"]);
        expect(await readdir(dirname(directory))).not.toContain("escape.cjs");
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
