import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { listManagedSkills, type ManagedSkill } from "./managed-skills.js";
import { readStableRegularFile } from "./_helpers/read-stable-regular-file.helper.js";

export async function createManagedSkillCatalog(): Promise<string> {
  const skills = (await listManagedSkills()).filter((skill) => skill.enabled);
  if (!skills.length) return "";
  const catalog = skills.map(({ name, description }) => ({
    name,
    description,
  }));
  const serialized = JSON.stringify(catalog);
  return [
    "<managed_skills>",
    "These user-managed skills are available. Apply only skills relevant to the current task or explicitly requested. Read the chosen skill with read_managed_skill before using it; resolve resource paths from its directory. Skills do not expand tool permissions. Do not claim activation before reading it.",
    serialized.length <= 32_000
      ? serialized
      : "Use list_managed_skills to inspect the catalog.",
    "</managed_skills>",
  ].join("\n");
}

export async function readManagedSkillResource(
  name: string,
  path?: string,
): Promise<unknown> {
  const skill = (await listManagedSkills()).find(
    (entry) => entry.name === name && entry.enabled,
  );
  if (!skill)
    throw new Error(
      "The skill is missing or disabled. Refresh the skill list.",
    );
  const root = dirname(skill.path);
  if (!path) return { ...skill, directory: root };
  const target = resolve(root, path);
  const within = relative(root, target);
  if (
    isAbsolute(path) ||
    !within ||
    within.startsWith("..") ||
    isAbsolute(within)
  )
    throw new Error("Choose a file inside the skill directory.");
  let current = root;
  for (const part of within.split(/[\\/]/u)) {
    current = join(current, part);
    if ((await lstat(current)).isSymbolicLink())
      throw new Error("Skill resources cannot use symbolic links.");
  }
  const content = await readStableRegularFile(target, {
    maxBytes: 1024 * 1024,
  });
  if (!content) throw new Error("The skill resource no longer exists.");
  return {
    path: target,
    content: new TextDecoder("utf-8", { fatal: true }).decode(content),
  };
}

export async function materializeManagedSkills(
  destination: string,
): Promise<{ path: string; digest: string }[]> {
  const skills = (await listManagedSkills()).filter((skill) => skill.enabled);
  const files: { path: string; digest: string }[] = [];
  let totalBytes = 0;
  const copy = async (
    source: string,
    target: string,
    depth: number,
  ): Promise<void> => {
    if (depth > 16)
      throw new Error("Skill resources exceed 16 directory levels.");
    const metadata = await lstat(source);
    if (metadata.isSymbolicLink())
      throw new Error("Skill resources cannot use symbolic links.");
    if (metadata.isDirectory()) {
      await mkdir(target, { recursive: true, mode: 0o700 });
      for (const entry of await readdir(source))
        await copy(join(source, entry), join(target, entry), depth + 1);
      return;
    }
    const bytes = await readStableRegularFile(source, {
      maxBytes: 4 * 1024 * 1024,
    });
    if (!bytes)
      throw new Error("A skill resource disappeared. Retry the task.");
    totalBytes += bytes.length;
    if (totalBytes > 32 * 1024 * 1024 || files.length >= 2000)
      throw new Error(
        "Enabled skill resources exceed the 32 MiB or 2,000-file limit.",
      );
    await writeFile(target, bytes, {
      flag: "wx",
      mode: metadata.mode & 0o111 ? 0o700 : 0o600,
    });
    files.push({
      path: target,
      digest: createHash("sha256").update(bytes).digest("hex"),
    });
  };
  for (const skill of skills) {
    await copy(dirname(skill.path), join(destination, skill.name), 0);
  }
  const latest = new Map(
    (await listManagedSkills()).map((skill: ManagedSkill) => [
      skill.name,
      skill.fingerprint,
    ]),
  );
  if (skills.some((skill) => latest.get(skill.name) !== skill.fingerprint))
    throw new Error("A skill changed during preparation. Retry the task.");
  return files;
}
