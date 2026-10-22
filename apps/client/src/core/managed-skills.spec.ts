import assert from "node:assert/strict";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";
import {
  deleteManagedSkill,
  listManagedSkills,
  saveManagedSkill,
  type SaveManagedSkillInput,
} from "./managed-skills.js";

describe("managed skills", () => {
  let temporaryDirectory: string;
  let configDirectory: string;
  let skillsDirectory: string;
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
      join(await realpath(tmpdir()), "machdoch-managed-skills-"),
    );
    configDirectory = join(temporaryDirectory, "config");
    skillsDirectory = join(configDirectory, "skills");
    process.env.MACHDOCH_USER_CONFIG_DIR = configDirectory;
  });

  afterEach(async () => {
    if (previousConfigDirectory === undefined) {
      delete process.env.MACHDOCH_USER_CONFIG_DIR;
    } else {
      process.env.MACHDOCH_USER_CONFIG_DIR = previousConfigDirectory;
    }
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  it("lists an absent store without creating configuration", async () => {
    assert.deepEqual(await listManagedSkills(), []);
    await assert.rejects(lstat(configDirectory), { code: "ENOENT" });
  });

  it("creates, reloads, and updates a skill", async () => {
    const created = await saveManagedSkill(input);
    assert.deepEqual(
      { ...created, fingerprint: undefined, path: undefined },
      { ...input, fingerprint: undefined, path: undefined },
    );
    assert.equal(created.path, join(skillsDirectory, input.name, "SKILL.md"));
    assert.match(created.fingerprint, /^[a-f0-9]{64}$/);
    assert.deepEqual(await listManagedSkills(), [created]);

    const updated = await saveManagedSkill({
      ...input,
      content: "# Review\n\nCheck regressions.",
      expectedFingerprint: created.fingerprint,
    });
    assert.notEqual(updated.fingerprint, created.fingerprint);
    assert.equal(updated.content, "# Review\n\nCheck regressions.");
    assert.deepEqual(await listManagedSkills(), [updated]);
  });

  it("quotes descriptions safely and round trips escapes", async () => {
    const description = 'Use "quotes", C:\\skills, # tags: yes\n---\nname: injected\n\tDetails.';
    const saved = await saveManagedSkill({ ...input, description });
    assert.equal(saved.description, description);
    assert.deepEqual(await listManagedSkills(), [saved]);
    const source = await readFile(saved.path, "utf8");
    assert.equal(source.split("\n")[2], "description: " + JSON.stringify(description));
    assert.equal((source.match(/^name:/gm) ?? []).length, 1);
  });

  it("switches between canonical filenames and fingerprints the enabled state", async () => {
    const created = await saveManagedSkill(input);
    const disabled = await saveManagedSkill({
      ...input,
      enabled: false,
      expectedFingerprint: created.fingerprint,
    });
    assert.equal(disabled.path, join(skillsDirectory, input.name, "SKILL.disabled.md"));
    assert.equal(disabled.enabled, false);
    assert.notEqual(disabled.fingerprint, created.fingerprint);
    await assert.rejects(lstat(created.path), { code: "ENOENT" });
    assert.deepEqual(await listManagedSkills(), [disabled]);
    await assert.rejects(deleteManagedSkill(input.name, created.fingerprint), /changed/);

    const enabled = await saveManagedSkill({
      ...input,
      expectedFingerprint: disabled.fingerprint,
    });
    assert.equal(enabled.path, created.path);
    assert.equal(enabled.enabled, true);
    await assert.rejects(lstat(disabled.path), { code: "ENOENT" });
    assert.deepEqual(await listManagedSkills(), [enabled]);
  });

  it("reads existing global skills and orders them by name", async () => {
    const alpha = join(skillsDirectory, "alpha", "SKILL.md");
    const zeta = join(skillsDirectory, "zeta", "SKILL.disabled.md");
    await mkdir(dirname(alpha), { recursive: true });
    await mkdir(dirname(zeta), { recursive: true });
    await writeFile(alpha, "---\nname: alpha\ndescription: Existing skill\nmetadata:\n  name: unrelated\n  description: unrelated\n---\n\nExisting instructions.\n");
    await writeFile(zeta, "---\r\nname: zeta\r\ndescription: 'It''s useful: yes'\r\n---\r\n\r\nOther instructions.\r\n");
    const skills = await listManagedSkills();
    assert.deepEqual(skills.map((skill) => skill.name), ["alpha", "zeta"]);
    assert.equal(skills[0]?.description, "Existing skill");
    assert.equal(skills[0]?.content, "Existing instructions.");
    assert.equal(skills[1]?.description, "It's useful: yes");
    assert.equal(skills[1]?.enabled, false);
  });

  it("reads folded and literal descriptions in existing skills", async () => {
    const path = join(skillsDirectory, input.name, "SKILL.md");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "---\nname: code-review\ndescription: >-\n  Review changes\n  for defects.\n---\nInstructions.\n");
    assert.equal((await listManagedSkills())[0]?.description, "Review changes for defects.");
    await writeFile(path, "---\nname: code-review\ndescription: |-\n  Review changes\n  for defects.\n---\nInstructions.\n");
    assert.equal((await listManagedSkills())[0]?.description, "Review changes\nfor defects.");
  });

  for (const { label, lineEnding, style } of [
    { label: "folded LF", lineEnding: "\n", style: ">-" },
    { label: "literal CRLF", lineEnding: "\r\n", style: "|-" },
  ]) {
    it("preserves imported metadata and assets through edits with " + label + " frontmatter", async () => {
      const path = join(skillsDirectory, input.name, "SKILL.md");
      const asset = join(dirname(path), "assets", "template.bin");
      const assetBytes = Buffer.from([0, 255, 13, 10, 128]);
      await mkdir(dirname(asset), { recursive: true });
      await writeFile(asset, assetBytes);
      const descriptionField = [
        "description: " + style,
        "  Review imported changes.",
        "",
        "  Keep their context.",
      ].join(lineEnding);
      let frontmatter = [
        "# Imported license",
        "license: 'MIT' # retain this comment",
        "name: code-review # imported identity",
        "metadata:",
        "  name: unrelated-name",
        "  description: unrelated-description",
        "  version: '01'",
        descriptionField,
        "compatibility: |-",
        "  Requires git.",
        "  Works offline.",
        "allowed-tools: Bash(git:*) Read",
        "x-client: {mode: strict}",
      ].join(lineEnding);
      await writeFile(path, ["---", frontmatter, "---", "", "Imported instructions.", ""].join(lineEnding));
      const [imported] = await listManagedSkills();
      assert.ok(imported);
      let current = imported;
      const changes: Partial<Pick<SaveManagedSkillInput, "description" | "content" | "enabled">>[] = [
        { content: "# Updated\n\n---\nname: body-only\n\nRead assets/template.bin." },
        { description: 'Review "quotes", C:\\skills, $& and # tags:\n---\nname: injected' },
        { enabled: false },
        { enabled: true },
      ];
      for (const change of changes) {
        const updated = await saveManagedSkill({
          ...current,
          ...change,
          expectedFingerprint: current.fingerprint,
        });
        if (change.description !== undefined) {
          frontmatter = frontmatter.replace(
            descriptionField,
            () => "description: " + JSON.stringify(change.description),
          );
        }
        assert.equal(updated.name, input.name);
        assert.equal(updated.description, change.description ?? current.description);
        assert.equal(updated.content, change.content ?? current.content);
        assert.equal(updated.enabled, change.enabled ?? current.enabled);
        assert.notEqual(updated.fingerprint, current.fingerprint);
        assert.equal(
          await readFile(updated.path, "utf8"),
          ["---", frontmatter, "---", "", updated.content, ""].join(lineEnding),
        );
        assert.deepEqual(await readFile(asset), assetBytes);
        assert.equal(
          updated.path,
          join(dirname(path), updated.enabled ? "SKILL.md" : "SKILL.disabled.md"),
        );
        await assert.rejects(
          lstat(join(dirname(path), updated.enabled ? "SKILL.disabled.md" : "SKILL.md")),
          { code: "ENOENT" },
        );
        assert.deepEqual(await listManagedSkills(), [updated]);
        current = updated;
      }
    });
  }

  it("keeps optional YAML tags, aliases, and prototype keys as opaque source text", async () => {
    const path = join(skillsDirectory, input.name, "SKILL.md");
    await mkdir(dirname(path), { recursive: true });
    const frontmatter = [
      "name: code-review",
      "description: Imported skill",
      "license: !custom MIT",
      "metadata: &metadata",
      "  owner: Example",
      "  recursive: *metadata",
      "  tagged: !!js/function 'function () { throw new Error(\"Do not execute\"); }'",
      "__proto__:",
      "  skillPolluted: true",
      "constructor:",
      "  prototype:",
      "    skillPolluted: true",
    ].join("\n");
    await writeFile(path, ["---", frontmatter, "---", "", "Imported instructions.", ""].join("\n"));
    const [imported] = await listManagedSkills();
    assert.ok(imported);
    const updated = await saveManagedSkill({
      ...imported,
      content: "Updated instructions.",
      expectedFingerprint: imported.fingerprint,
    });
    assert.equal(
      await readFile(path, "utf8"),
      ["---", frontmatter, "---", "", updated.content, ""].join("\n"),
    );
    assert.deepEqual(Object.keys(updated).sort(), [
      "content", "description", "enabled", "fingerprint", "name", "path",
    ]);
    assert.equal(Object.hasOwn(Object.prototype, "skillPolluted"), false);
    assert.deepEqual(await listManagedSkills(), [updated]);
  });

  it("requires a current fingerprint when imported optional metadata changes", async () => {
    const path = join(skillsDirectory, input.name, "SKILL.md");
    await mkdir(dirname(path), { recursive: true });
    const source = [
      "---",
      "name: code-review",
      "description: Imported skill",
      "license: MIT",
      "---",
      "",
      "Imported instructions.",
      "",
    ].join("\n");
    await writeFile(path, source);
    const [imported] = await listManagedSkills();
    assert.ok(imported);
    const changedSource = source.replace("license: MIT", "license: Apache-2.0");
    await writeFile(path, changedSource);
    await assert.rejects(saveManagedSkill({ ...input, enabled: false }), /changed|already exists/);
    await assert.rejects(saveManagedSkill({
      ...imported,
      enabled: false,
      expectedFingerprint: imported.fingerprint,
    }), /changed/);
    await assert.rejects(deleteManagedSkill(input.name, imported.fingerprint), /changed/);
    assert.equal(await readFile(path, "utf8"), changedSource);
    await assert.rejects(lstat(join(dirname(path), "SKILL.disabled.md")), { code: "ENOENT" });
    const [reloaded] = await listManagedSkills();
    assert.ok(reloaded);
    assert.notEqual(reloaded.fingerprint, imported.fingerprint);
    const updated = await saveManagedSkill({
      ...reloaded,
      enabled: false,
      expectedFingerprint: reloaded.fingerprint,
    });
    assert.equal(await readFile(updated.path, "utf8"), changedSource);
    await assert.rejects(lstat(path), { code: "ENOENT" });
  });

  it("includes preserved optional metadata in the serialized size limit", async () => {
    const path = join(skillsDirectory, input.name, "SKILL.md");
    await mkdir(dirname(path), { recursive: true });
    const source = [
      "---",
      "name: code-review",
      "description: Imported skill",
      "license: " + "é".repeat(50_000),
      "---",
      "",
      "Imported instructions.",
      "",
    ].join("\n");
    await writeFile(path, source);
    const [imported] = await listManagedSkills();
    assert.ok(imported);
    await assert.rejects(saveManagedSkill({
      ...imported,
      enabled: false,
      content: "é".repeat(20_000),
      expectedFingerprint: imported.fingerprint,
    }), /128 KiB/);
    assert.equal(await readFile(path, "utf8"), source);
    await assert.rejects(lstat(join(dirname(path), "SKILL.disabled.md")), { code: "ENOENT" });
    assert.deepEqual(await listManagedSkills(), [imported]);
  });

  it("requires absence for creation and a current fingerprint for updates", async () => {
    const created = await saveManagedSkill(input);
    await assert.rejects(saveManagedSkill(input), /changed|already exists/);
    await assert.rejects(saveManagedSkill({
      ...input,
      content: "Overwrite.",
      expectedFingerprint: "0".repeat(64),
    }), /changed/);
    await assert.rejects(saveManagedSkill({
      ...input,
      name: "missing",
      expectedFingerprint: created.fingerprint,
    }), /changed/);
    await assert.rejects(deleteManagedSkill(input.name, ""), /Reload/);
    await assert.rejects(deleteManagedSkill(input.name, "0".repeat(64)), /changed/);
    assert.deepEqual(await listManagedSkills(), [created]);
  });

  it("allows only one concurrent creation", async () => {
    const results = await Promise.allSettled([
      saveManagedSkill(input),
      saveManagedSkill({ ...input, content: "Competing instructions." }),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    assert.equal((await listManagedSkills()).length, 1);
  });

  it("allows only one concurrent update with the same fingerprint", async () => {
    const created = await saveManagedSkill(input);
    const results = await Promise.allSettled([
      saveManagedSkill({ ...input, content: "First edit.", expectedFingerprint: created.fingerprint }),
      saveManagedSkill({ ...input, enabled: false, content: "Second edit.", expectedFingerprint: created.fingerprint }),
    ]);
    const winner = results.find((result) => result.status === "fulfilled");
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    assert.ok(winner?.status === "fulfilled");
    assert.deepEqual(await listManagedSkills(), [winner.value]);
  });

  it("serializes a concurrent update and deletion", async () => {
    const created = await saveManagedSkill(input);
    const results = await Promise.allSettled([
      saveManagedSkill({ ...input, content: "Updated.", expectedFingerprint: created.fingerprint }),
      deleteManagedSkill(input.name, created.fingerprint),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    const skills = await listManagedSkills();
    if (results[0]?.status === "fulfilled") {
      assert.deepEqual(skills, [results[0].value]);
    } else {
      assert.deepEqual(skills, []);
    }
  });

  it("rejects edits and deletes after external file changes", async () => {
    const created = await saveManagedSkill(input);
    const externalSource = (await readFile(created.path, "utf8")) + "\n";
    await writeFile(created.path, externalSource);
    await assert.rejects(saveManagedSkill({
      ...input,
      expectedFingerprint: created.fingerprint,
    }), /changed/);
    await assert.rejects(deleteManagedSkill(input.name, created.fingerprint), /changed/);
    assert.equal(await readFile(created.path, "utf8"), externalSource);
  });

  it("deletes only the managed entry and preserves assets and directories", async () => {
    const created = await saveManagedSkill({ ...input, enabled: false });
    const asset = join(dirname(created.path), "assets", "template.txt");
    await mkdir(dirname(asset), { recursive: true });
    await writeFile(asset, "Keep this asset.");
    assert.deepEqual(await deleteManagedSkill(created.name, created.fingerprint), created);
    await assert.rejects(lstat(created.path), { code: "ENOENT" });
    assert.equal(await readFile(asset, "utf8"), "Keep this asset.");
    assert.equal((await lstat(dirname(created.path))).isDirectory(), true);
    assert.deepEqual(await listManagedSkills(), []);
  });

  it("preserves unknown directories without skill files", async () => {
    const asset = join(skillsDirectory, input.name, "assets", "keep.txt");
    await mkdir(dirname(asset), { recursive: true });
    await writeFile(asset, "Keep.");
    await assert.rejects(deleteManagedSkill(input.name, "0".repeat(64)), /changed/);
    assert.equal(await readFile(asset, "utf8"), "Keep.");
  });

  it("rejects invalid names and path traversal before creating files", async () => {
    for (const name of ["", "../escape", "a/b", "a\\b", "-skill", "skill-", "two--hyphens", "Uppercase", "a".repeat(65), "con", "skill:stream"]) {
      await assert.rejects(saveManagedSkill({ ...input, name }), /skill name/);
      await assert.rejects(deleteManagedSkill(name, "0".repeat(64)), /skill name/);
    }
    await assert.rejects(lstat(configDirectory), { code: "ENOENT" });
  });

  it("rejects empty instructions and invalid descriptions", async () => {
    for (const description of ["", " \n ", "x".repeat(1025)]) {
      await assert.rejects(saveManagedSkill({ ...input, description }), /description/);
    }
    await assert.rejects(saveManagedSkill({ ...input, content: " \n\t " }), /instructions/);
    await assert.rejects(saveManagedSkill({
      ...input,
      enabled: undefined as unknown as boolean,
    }), /enabled/);
    await assert.rejects(lstat(configDirectory), { code: "ENOENT" });
  });

  it("enforces the complete serialized UTF-8 file size", async () => {
    await assert.rejects(saveManagedSkill({ ...input, content: "é".repeat(65_536) }), /128 KiB/);
    const overhead = Buffer.byteLength([
      "---",
      "name: " + JSON.stringify(input.name),
      "description: " + JSON.stringify(input.description),
      "---",
      "",
      "",
      "",
    ].join("\n"));
    const boundary = await saveManagedSkill({
      ...input,
      content: "x".repeat(128 * 1024 - overhead),
    });
    assert.equal((await lstat(boundary.path)).size, 128 * 1024);
    await writeFile(boundary.path, (await readFile(boundary.path, "utf8")) + "x");
    await assert.rejects(listManagedSkills(), /regular.*file|131072/);
    await assert.rejects(deleteManagedSkill(input.name, boundary.fingerprint), /regular.*file|131072/);
  });

  it("rejects duplicate canonical files without changing either file", async () => {
    const created = await saveManagedSkill(input);
    const disabled = join(dirname(created.path), "SKILL.disabled.md");
    const source = await readFile(created.path, "utf8");
    await writeFile(disabled, source);
    await assert.rejects(listManagedSkills(), /Both skill files/);
    await assert.rejects(saveManagedSkill({
      ...input,
      enabled: false,
      expectedFingerprint: created.fingerprint,
    }), /Both skill files/);
    await assert.rejects(deleteManagedSkill(input.name, created.fingerprint), /Both skill files/);
    assert.equal(await readFile(created.path, "utf8"), source);
    assert.equal(await readFile(disabled, "utf8"), source);
  });

  it("does not overwrite malformed existing skills or directories", async () => {
    const path = join(skillsDirectory, input.name, "SKILL.md");
    await mkdir(dirname(path), { recursive: true });
    for (const source of [
      "No frontmatter.",
      "---\nname: wrong-name\ndescription: Description\n---\nInstructions.",
      "---\nname: code-review\ndescription: Description\n---\n ",
      "---\nname: code-review\nname: duplicate\ndescription: Description\n---\nInstructions.",
    ]) {
      await writeFile(path, source);
      await assert.rejects(saveManagedSkill(input));
      assert.equal(await readFile(path, "utf8"), source);
    }
    await rm(path);
    await mkdir(path);
    await assert.rejects(saveManagedSkill(input), /regular.*file/);
    assert.equal((await lstat(path)).isDirectory(), true);
  });

  for (const location of ["ancestor", "config", "root", "skill", "lock"] as const) {
    it("rejects a symbolic link at the " + location + " directory", async () => {
      const outside = join(temporaryDirectory, "outside");
      await mkdir(outside);
      const locations = {
        ancestor: join(temporaryDirectory, "alias"),
        config: configDirectory,
        root: skillsDirectory,
        skill: join(skillsDirectory, input.name),
        lock: join(skillsDirectory, input.name + ".machdoch.lock"),
      };
      const link = locations[location];
      await mkdir(dirname(link), { recursive: true });
      await symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
      if (location === "ancestor") {
        process.env.MACHDOCH_USER_CONFIG_DIR = join(link, "config");
      }
      await assert.rejects(saveManagedSkill(input), /real director/);
      await assert.rejects(lstat(join(outside, "SKILL.md")), { code: "ENOENT" });
      if (location !== "lock") {
        await assert.rejects(listManagedSkills(), /real director/);
      }
    });
  }

  it("rejects symbolic links at either canonical file", async (context) => {
    const created = await saveManagedSkill(input);
    const outside = join(temporaryDirectory, "outside.md");
    await writeFile(outside, "Preserve outside content.");
    const disabled = join(dirname(created.path), "SKILL.disabled.md");
    try {
      await symlink(outside, disabled, "file");
    } catch (error) {
      if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") {
        context.skip("Creating file symlinks requires Windows developer mode or symlink privileges.");
        return;
      }
      throw error;
    }
    await assert.rejects(listManagedSkills(), /regular.*file/);
    await assert.rejects(saveManagedSkill({
      ...input,
      expectedFingerprint: created.fingerprint,
    }), /regular.*file/);
    await assert.rejects(deleteManagedSkill(input.name, created.fingerprint), /regular.*file/);
    await rm(disabled);
    await rm(created.path);
    await symlink(outside, created.path, "file");
    await assert.rejects(saveManagedSkill(input), /regular.*file/);
    assert.equal(await readFile(outside, "utf8"), "Preserve outside content.");
  });
});
