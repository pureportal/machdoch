import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import {
  createManagedSkillCatalog,
  materializeManagedSkills,
  readManagedSkillResource,
} from "./managed-skill-delivery.js";
import * as managedSkills from "./managed-skills.js";
import {
  saveManagedSkill,
  type SaveManagedSkillInput,
} from "./managed-skills.js";

describe("managed skill delivery", () => {
  let temporaryDirectory: string;
  let configDirectory: string;
  let destination: string;
  let previousConfigDirectory: string | undefined;
  const input: SaveManagedSkillInput = {
    name: "code-review",
    description: "Review code for correctness.",
    content: "# Review\n\nCheck changed behavior.",
    enabled: true,
  };

  beforeEach(async () => {
    previousConfigDirectory = process.env.MACHDOCH_USER_CONFIG_DIR;
    temporaryDirectory = await mkdtemp(
      join(await realpath(tmpdir()), "machdoch-managed-skill-delivery-"),
    );
    configDirectory = join(temporaryDirectory, "config");
    destination = join(temporaryDirectory, "delivery");
    process.env.MACHDOCH_USER_CONFIG_DIR = configDirectory;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (previousConfigDirectory === undefined) {
      delete process.env.MACHDOCH_USER_CONFIG_DIR;
    } else {
      process.env.MACHDOCH_USER_CONFIG_DIR = previousConfigDirectory;
    }
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  it.each(["absent", "disabled"])(
    "delivers nothing from an %s skill store",
    async (state) => {
      if (state === "disabled") {
        await saveManagedSkill({ ...input, enabled: false });
      }

      assert.equal(await createManagedSkillCatalog(), "");
      assert.deepEqual(await materializeManagedSkills(destination), []);
      await assert.rejects(lstat(destination), { code: "ENOENT" });
      if (state === "absent") {
        await assert.rejects(lstat(configDirectory), { code: "ENOENT" });
      }
    },
  );

  it("catalogs enabled metadata without including disabled skills or bodies", async () => {
    const description = 'Use "quotes", C:\\skills, and café.\nCheck changes.';
    const enabled = await saveManagedSkill({ ...input, description });
    const disabled = await saveManagedSkill({
      ...input,
      name: "disabled-review",
      description: "Disabled metadata.",
      content: "Disabled instructions.",
      enabled: false,
    });

    const catalog = await createManagedSkillCatalog();
    const serialized = catalog.split("\n").find((line) => line.startsWith("["));
    assert.ok(serialized);
    assert.deepEqual(JSON.parse(serialized), [
      { name: enabled.name, description: enabled.description },
    ]);
    assert.equal(catalog.includes(enabled.content), false);
    assert.equal(catalog.includes(disabled.name), false);
    assert.equal(catalog.includes(disabled.description), false);
    assert.equal(catalog.includes(disabled.content), false);
  });

  it("returns the full skill body with its resource directory", async () => {
    const skill = await saveManagedSkill(input);

    assert.deepEqual(await readManagedSkillResource(skill.name), {
      ...skill,
      directory: dirname(skill.path),
    });
  });

  it.each([
    { label: "UTF-8", content: "# Reference\n\nÜberprüfung ✓\n" },
    { label: "empty", content: "" },
  ])("reads a nested $label resource", async ({ content }) => {
    const skill = await saveManagedSkill(input);
    const path = join(dirname(skill.path), "references", "guide.md");
    await mkdir(dirname(path));
    await writeFile(path, content);

    assert.deepEqual(
      await readManagedSkillResource(skill.name, "references/guide.md"),
      { path, content },
    );
  });

  it.each(["disabled-review", "missing-review"])(
    "refuses body and resource access for %s",
    async (name) => {
      await saveManagedSkill({
        ...input,
        name: "disabled-review",
        enabled: false,
      });

      for (const path of [undefined, "SKILL.md", "SKILL.disabled.md"]) {
        await assert.rejects(
          readManagedSkillResource(name, path),
          /missing or disabled/,
        );
      }
    },
  );

  it.each([
    "../outside.txt",
    "references/../../outside.txt",
    ".",
    "references/..",
    ...(process.platform === "win32"
      ? ["..\\outside.txt", "references\\..\\..\\outside.txt"]
      : []),
  ])("rejects resource traversal %s", async (path) => {
    const skill = await saveManagedSkill(input);
    const root = dirname(skill.path);
    const outside = join(dirname(root), "outside.txt");
    await mkdir(join(root, "references"));
    await writeFile(outside, "Outside content.");

    await assert.rejects(
      readManagedSkillResource(skill.name, path),
      /inside the skill directory/,
    );
    assert.equal(await readFile(outside, "utf8"), "Outside content.");
  });

  it("rejects absolute resource paths inside and outside the skill", async () => {
    const skill = await saveManagedSkill(input);
    const outside = join(temporaryDirectory, "outside.txt");
    await writeFile(outside, "Outside content.");

    for (const path of [skill.path, outside]) {
      await assert.rejects(
        readManagedSkillResource(skill.name, path),
        /inside the skill directory/,
      );
    }
  });

  it("rejects directory resources and resources larger than one MiB", async () => {
    const skill = await saveManagedSkill(input);
    const references = join(dirname(skill.path), "references");
    await mkdir(references);
    await writeFile(
      join(references, "oversized.txt"),
      Buffer.alloc(1024 * 1024 + 1, "a"),
    );

    for (const path of ["references", "references/oversized.txt"]) {
      await assert.rejects(
        readManagedSkillResource(skill.name, path),
        /regular.*file/,
      );
    }
  });

  it("rejects resource bytes that are not valid UTF-8", async () => {
    const skill = await saveManagedSkill(input);
    await writeFile(
      join(dirname(skill.path), "invalid.txt"),
      Buffer.from([0xc3, 0x28]),
    );

    await assert.rejects(
      readManagedSkillResource(skill.name, "invalid.txt"),
      { name: "TypeError" },
    );
  });

  it.each(["inside", "outside"])(
    "rejects directory links to targets %s the skill during reads and delivery",
    async (location) => {
      const skill = await saveManagedSkill(input);
      const root = dirname(skill.path);
      const target = join(location === "inside" ? root : temporaryDirectory, "target");
      await mkdir(target);
      await writeFile(join(target, "reference.txt"), "Linked content.");
      await symlink(
        target,
        join(root, "linked"),
        process.platform === "win32" ? "junction" : "dir",
      );

      await assert.rejects(
        readManagedSkillResource(skill.name, "linked/reference.txt"),
        /symbolic links/,
      );
      await assert.rejects(
        materializeManagedSkills(destination),
        /symbolic links/,
      );
      await assert.rejects(
        lstat(join(destination, skill.name, "linked")),
        { code: "ENOENT" },
      );
      assert.equal(
        await readFile(join(target, "reference.txt"), "utf8"),
        "Linked content.",
      );
    },
  );

  it("rejects file symlinks during resource reads and delivery", async (context) => {
    const skill = await saveManagedSkill(input);
    const outside = join(temporaryDirectory, "outside.txt");
    await writeFile(outside, "Outside content.");
    try {
      await symlink(outside, join(dirname(skill.path), "linked.txt"), "file");
    } catch (error) {
      if (
        process.platform === "win32" &&
        (error as NodeJS.ErrnoException).code === "EPERM"
      ) {
        context.skip("Creating file symlinks requires Windows developer mode or symlink privileges.");
        return;
      }
      throw error;
    }

    await assert.rejects(
      readManagedSkillResource(skill.name, "linked.txt"),
      /symbolic links/,
    );
    await assert.rejects(
      materializeManagedSkills(destination),
      /symbolic links/,
    );
    await assert.rejects(
      lstat(join(destination, skill.name, "linked.txt")),
      { code: "ENOENT" },
    );
    assert.equal(await readFile(outside, "utf8"), "Outside content.");
  });

  it("copies enabled skill bodies and assets with exact SHA-256 receipts", async () => {
    const skill = await saveManagedSkill(input);
    const disabled = await saveManagedSkill({
      ...input,
      name: "disabled-review",
      enabled: false,
    });
    await writeFile(join(dirname(disabled.path), "private.txt"), "Disabled asset.");
    const expectedFiles = new Map<string, Buffer>([
      ["SKILL.md", await readFile(skill.path)],
      [join("references", "guide.md"), Buffer.from("# Guide\n\nCheck café.\n")],
      [join("assets", "nested", "icon.bin"), Buffer.from([0, 255, 128, 10])],
      [join("assets", "empty.txt"), Buffer.alloc(0)],
      [join("scripts", "check.sh"), Buffer.from("#!/bin/sh\nexit 0\n")],
    ]);
    for (const [path, bytes] of expectedFiles) {
      if (path === "SKILL.md") continue;
      const source = join(dirname(skill.path), path);
      await mkdir(dirname(source), { recursive: true });
      await writeFile(source, bytes, { mode: path.endsWith(".sh") ? 0o700 : 0o600 });
    }

    const receipts = await materializeManagedSkills(destination);
    assert.deepEqual(await readdir(destination), [skill.name]);
    assert.deepEqual(
      receipts.map(({ path }) => path).sort(),
      [...expectedFiles.keys()].map((path) => join(destination, skill.name, path)).sort(),
    );
    for (const [path, expected] of expectedFiles) {
      const deliveredPath = join(destination, skill.name, path);
      const deliveredBytes = await readFile(deliveredPath);
      assert.deepEqual(deliveredBytes, expected);
      assert.equal(
        receipts.find((receipt) => receipt.path === deliveredPath)?.digest,
        createHash("sha256").update(deliveredBytes).digest("hex"),
      );
      assert.deepEqual(await readFile(join(dirname(skill.path), path)), expected);
      if (process.platform !== "win32") {
        assert.equal(
          (await lstat(deliveredPath)).mode & 0o777,
          path.endsWith(".sh") ? 0o700 : 0o600,
        );
      }
    }
  });

  it("refuses to overwrite an existing delivered file", async () => {
    const skill = await saveManagedSkill(input);
    const existing = join(destination, skill.name, "SKILL.md");
    await mkdir(dirname(existing), { recursive: true });
    await writeFile(existing, "Existing content.");

    await assert.rejects(materializeManagedSkills(destination), { code: "EEXIST" });
    assert.equal(await readFile(existing, "utf8"), "Existing content.");
    assert.deepEqual(await readManagedSkillResource(skill.name), {
      ...skill,
      directory: dirname(skill.path),
    });
  });

  it("rejects receipts if the skill changes after the initial catalog read", async () => {
    const skill = await saveManagedSkill(input);
    const listManagedSkills = managedSkills.listManagedSkills;
    vi.spyOn(managedSkills, "listManagedSkills").mockImplementationOnce(async () => {
      const snapshot = await listManagedSkills();
      await saveManagedSkill({
        ...input,
        content: "Changed during preparation.",
        expectedFingerprint: skill.fingerprint,
      });
      return snapshot;
    });

    await assert.rejects(
      materializeManagedSkills(destination),
      /changed during preparation/,
    );
  });
});
