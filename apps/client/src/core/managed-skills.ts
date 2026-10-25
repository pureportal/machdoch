import { createHash } from "node:crypto";
import { skillRequestSchema } from "@machdoch/fleet-protocol/skills";
import {
  lstat,
  mkdir,
  readdir,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { getUserConfigPath } from "./env.js";
import { parseMarkdownDocument } from "./frontmatter.js";
import { readStableRegularFile } from "./_helpers/read-stable-regular-file.helper.js";
import { withCooperativeFileLock } from "./_helpers/with-cooperative-file-lock.helper.js";
import { writeFileAtomically } from "./_helpers/write-file-atomically.helper.js";

const MAX_SKILL_BYTES = 128 * 1024;
export async function runManagedSkillsRequest(
  input: unknown,
): Promise<unknown> {
  const request = skillRequestSchema.parse(input);
  switch (request.action) {
    case "list":
      return listManagedSkills();
    case "save":
      return saveManagedSkill(request.skill);
    case "delete":
      return deleteManagedSkill(request.name, request.expectedFingerprint);
  }
}
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RESERVED_NAME_PATTERN = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/;

export interface ManagedSkill {
  name: string;
  description: string;
  content: string;
  enabled: boolean;
  fingerprint: string;
  path: string;
}

interface ManagedSkillDocument {
  skill: ManagedSkill;
  frontmatter: string;
}

export interface SaveManagedSkillInput {
  name: string;
  description: string;
  content: string;
  enabled: boolean;
  expectedFingerprint?: string | undefined;
}

const validateName = (name: string): void => {
  if (
    typeof name !== "string" ||
    name.length > 64 ||
    !SKILL_NAME_PATTERN.test(name) ||
    RESERVED_NAME_PATTERN.test(name)
  ) {
    throw new Error(
      "Use a skill name of 1–64 lowercase letters or numbers separated by single hyphens; reserved device names are not allowed.",
    );
  }
};

const validateSkill = (skill: SaveManagedSkillInput): void => {
  validateName(skill.name);
  if (
    typeof skill.description !== "string" ||
    !skill.description.trim() ||
    skill.description.length > 1024
  ) {
    throw new Error("A skill description must contain 1–1024 characters.");
  }
  if (typeof skill.content !== "string" || !skill.content.trim()) {
    throw new Error("Skill instructions must not be empty.");
  }
  if (typeof skill.enabled !== "boolean") {
    throw new Error("Choose whether the skill is enabled.");
  }
};

const validateFingerprint = (fingerprint: string): void => {
  if (typeof fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(fingerprint)) {
    throw new Error("Reload the skill before saving or deleting it.");
  }
};

const readMetadata = async (path: string) => {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
};

const ensureDirectory = async (
  path: string,
  create: boolean,
): Promise<boolean> => {
  const missing: string[] = [];
  let current = resolve(path);
  let metadata = await readMetadata(current);
  while (!metadata) {
    const parent = dirname(current);
    if (parent === current) {
      if (create)
        throw new Error(
          "Skill storage is unavailable. Reconnect its drive and retry.",
        );
      return false;
    }
    missing.push(current);
    current = parent;
    metadata = await readMetadata(current);
  }
  if (
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    relative(current, await realpath(current)) !== ""
  )
    throw new Error(
      "Skill directories must be real directories, without symbolic links.",
    );
  if (!create) return missing.length === 0;
  for (const directory of missing.reverse()) {
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    metadata = await readMetadata(directory);
    if (
      !metadata ||
      metadata.isSymbolicLink() ||
      !metadata.isDirectory() ||
      relative(directory, await realpath(directory)) !== ""
    )
      throw new Error(
        "Skill directories must be real directories, without symbolic links.",
      );
  }
  return true;
};

const readFrontmatterString = (
  frontmatter: string,
  key: "name" | "description",
): string => {
  const lines = frontmatter.split(/\r?\n/);
  const matches = lines
    .map((line, index) => ({
      index,
      match: line.match(new RegExp("^" + key + ":[ \\t]*(.*)$")),
    }))
    .filter((entry) => entry.match !== null);
  const entry = matches[0];
  if (matches.length !== 1 || !entry?.match) {
    throw new Error(
      "Skill frontmatter must contain one name and one description.",
    );
  }
  const raw = (entry.match[1] ?? "").trim();
  if (raw.startsWith('"')) {
    const quoted = raw.match(/^("(?:[^"\\]|\\.)*")\s*(?:#.*)?$/);
    if (!quoted?.[1]) throw new Error("Invalid quoted skill frontmatter.");
    const value: unknown = JSON.parse(quoted[1]);
    if (typeof value !== "string")
      throw new Error("Skill metadata must be text.");
    return value;
  }
  if (raw.startsWith("'")) {
    const quoted = raw.match(/^'((?:[^']|'')*)'\s*(?:#.*)?$/);
    if (!quoted) throw new Error("Invalid quoted skill frontmatter.");
    return (quoted[1] ?? "").replace(/''/g, "'");
  }
  const block = raw.match(/^([>|])([+-]?)(?:\s+#.*)?$/);
  if (block) {
    const body: string[] = [];
    for (const line of lines.slice(entry.index + 1)) {
      if (line.trim() && !line.startsWith(" ")) break;
      body.push(line);
    }
    const indentation = Math.min(
      ...body
        .filter((line) => line.trim())
        .map((line) => line.length - line.trimStart().length),
    );
    let value = body.map((line) => line.slice(indentation)).join("\n");
    if (block[1] === ">") {
      value = value
        .split(/\n\n/)
        .map((paragraph) => paragraph.replace(/([^\n])\n(?=[^\s])/g, "$1 "))
        .join("\n");
    }
    if (block[2] === "-") return value.replace(/\n+$/, "");
    return value.replace(/\n+$/, "") + "\n";
  }
  const document = parseMarkdownDocument(
    "---\n" + key + ": " + raw.replace(/\s+#.*$/, "") + "\n---\n",
  );
  const value = document.attributes[key];
  if (typeof value !== "string")
    throw new Error("Skill metadata must be text.");
  return value;
};

const parseSkill = (
  name: string,
  path: string,
  enabled: boolean,
  bytes: Buffer,
): ManagedSkillDocument => {
  const source = bytes.toString("utf8");
  const header = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!header?.[1])
    throw new Error("A skill must begin with YAML frontmatter.");
  if (readFrontmatterString(header[1], "name") !== name) {
    throw new Error("The skill name must match its directory.");
  }
  const skill = {
    name,
    description: readFrontmatterString(header[1], "description"),
    content: source.slice(header[0].length).trim(),
    enabled,
    path,
    fingerprint: createHash("sha256")
      .update(enabled ? "enabled\0" : "disabled\0")
      .update(bytes)
      .digest("hex"),
  };
  validateSkill(skill);
  return { skill, frontmatter: header[1] };
};

const serializeSkill = (
  input: SaveManagedSkillInput,
  current: ManagedSkillDocument | undefined,
): string => {
  const frontmatter = current
    ? current.frontmatter.replace(
        /^(name|description):[^\r\n]*(?:\r?\n(?:[ \t][^\r\n]*|(?=\r?$)))*/gm,
        (field, key: "name" | "description") =>
          current.skill[key] === input[key]
            ? field
            : key + ": " + JSON.stringify(input[key]),
      )
    : [
        "name: " + JSON.stringify(input.name),
        "description: " + JSON.stringify(input.description),
      ].join("\n");
  const lineEnding = frontmatter.includes("\r\n") ? "\r\n" : "\n";
  const source = ["---", frontmatter, "---", "", input.content.trim(), ""].join(
    lineEnding,
  );
  if (Buffer.byteLength(source, "utf8") > MAX_SKILL_BYTES) {
    throw new Error("A skill file must not exceed 128 KiB.");
  }
  return source;
};

const readSkill = async (
  root: string,
  name: string,
): Promise<ManagedSkillDocument | undefined> => {
  const directory = join(root, name);
  if (!(await ensureDirectory(directory, false))) return undefined;
  const enabledPath = join(directory, "SKILL.md");
  const disabledPath = join(directory, "SKILL.disabled.md");
  const enabled = await readStableRegularFile(enabledPath, {
    maxBytes: MAX_SKILL_BYTES,
  });
  const disabled = await readStableRegularFile(disabledPath, {
    maxBytes: MAX_SKILL_BYTES,
  });
  await ensureDirectory(directory, false);
  if (enabled !== undefined && disabled !== undefined) {
    throw new Error(
      "Both skill files exist. Resolve the duplicate files before editing this skill.",
    );
  }
  if (enabled !== undefined)
    return parseSkill(name, enabledPath, true, enabled);
  if (disabled !== undefined)
    return parseSkill(name, disabledPath, false, disabled);
  return undefined;
};

const assertExpectedSkill = (
  current: ManagedSkillDocument | undefined,
  expectedFingerprint: string | undefined,
): void => {
  if (
    expectedFingerprint === undefined
      ? current !== undefined
      : current?.skill.fingerprint !== expectedFingerprint
  ) {
    throw new Error(
      "The skill changed or already exists. Reload it before saving or deleting.",
    );
  }
};

const withSkillLock = async <T>(
  root: string,
  name: string,
  operation: () => Promise<T>,
): Promise<T> => {
  if (!(await ensureDirectory(root, false))) {
    throw new Error("The skill directory disappeared. Reload and try again.");
  }
  const destination = join(root, name);
  const lock = await readMetadata(destination + ".machdoch.lock");
  if (lock && (lock.isSymbolicLink() || !lock.isDirectory())) {
    throw new Error("The skill lock must be a real directory.");
  }
  return withCooperativeFileLock(destination, operation);
};

export const listManagedSkills = async (): Promise<ManagedSkill[]> => {
  const root = resolve(dirname(getUserConfigPath()), "skills");
  if (!(await ensureDirectory(root, false))) return [];
  const skills: ManagedSkill[] = [];
  const directories = await readdir(root, { withFileTypes: true });
  for (const directory of directories) {
    if (
      !SKILL_NAME_PATTERN.test(directory.name) ||
      directory.name.length > 64 ||
      RESERVED_NAME_PATTERN.test(directory.name)
    )
      continue;
    if (!directory.isDirectory() && !directory.isSymbolicLink()) continue;
    const skill = await withSkillLock(root, directory.name, () =>
      readSkill(root, directory.name),
    );
    if (skill) skills.push(skill.skill);
  }
  return skills.sort((left, right) => left.name.localeCompare(right.name));
};

export const saveManagedSkill = async (
  input: SaveManagedSkillInput,
): Promise<ManagedSkill> => {
  validateSkill(input);
  if (input.expectedFingerprint !== undefined)
    validateFingerprint(input.expectedFingerprint);
  const root = resolve(dirname(getUserConfigPath()), "skills");
  await ensureDirectory(root, true);
  return withSkillLock(root, input.name, async () => {
    const current = await readSkill(root, input.name);
    assertExpectedSkill(current, input.expectedFingerprint);
    const source = serializeSkill(input, current);
    const directory = join(root, input.name);
    await ensureDirectory(directory, true);
    const target = join(
      directory,
      input.enabled ? "SKILL.md" : "SKILL.disabled.md",
    );
    const writePath = current?.skill.path ?? target;
    await writeFileAtomically(writePath, source, "utf8", {
      mode: 0o600,
      beforeCommit: async () => {
        assertExpectedSkill(
          await readSkill(root, input.name),
          input.expectedFingerprint,
        );
      },
    });
    if (writePath !== target) {
      const written = parseSkill(
        input.name,
        writePath,
        current!.skill.enabled,
        Buffer.from(source),
      );
      assertExpectedSkill(
        await readSkill(root, input.name),
        written.skill.fingerprint,
      );
      await rename(writePath, target);
    }
    return parseSkill(input.name, target, input.enabled, Buffer.from(source))
      .skill;
  });
};

export const deleteManagedSkill = async (
  name: string,
  expectedFingerprint: string,
): Promise<ManagedSkill> => {
  validateName(name);
  validateFingerprint(expectedFingerprint);
  const root = resolve(dirname(getUserConfigPath()), "skills");
  return withSkillLock(root, name, async () => {
    const current = await readSkill(root, name);
    assertExpectedSkill(current, expectedFingerprint);
    if (!current) throw new Error("The skill no longer exists.");
    await unlink(current.skill.path);
    return current.skill;
  });
};
