import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildPartialPatch,
  hunkLineKeys,
  parseFilePatch,
  patchLineKey,
} from "./workspace-git-partial-patch";

const roots: string[] = [];

const git = (cwd: string, args: string[], input?: string): string =>
  execFileSync("git", args, {
    cwd,
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });

const repository = (base: string, changed: string): string => {
  const root = mkdtempSync(join(tmpdir(), "machdoch-partial-patch-"));
  roots.push(root);
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.email", "patch@example.test"]);
  git(root, ["config", "user.name", "Patch"]);
  git(root, ["config", "core.autocrlf", "false"]);
  writeFileSync(join(root, "file.txt"), base);
  git(root, ["add", "file.txt"]);
  git(root, ["commit", "-q", "-m", "base"]);
  writeFileSync(join(root, "file.txt"), changed);
  return root;
};

const lines = (count: number, label = "line"): string =>
  Array.from({ length: count }, (_, index) => `${label} ${index + 1}\n`).join(
    "",
  );

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("partial Git patches", () => {
  it("stages one hunk of several and leaves the rest unstaged", () => {
    const base = lines(30);
    const changed = base
      .replace("line 2\n", "line 2 edited\n")
      .replace("line 25\n", "line 25 edited\nline 25b\n");
    const root = repository(base, changed);
    const parsed = parseFilePatch(git(root, ["diff", "--", "file.txt"]))!;
    expect(parsed.hunks).toHaveLength(2);
    const patch = buildPartialPatch(parsed, new Set(hunkLineKeys(parsed, 1)), {
      reverse: false,
    })!;
    git(root, ["apply", "--cached", "-"], patch);
    expect(git(root, ["diff", "--cached", "--", "file.txt"])).toContain(
      "+line 25b",
    );
    expect(git(root, ["diff", "--cached", "--", "file.txt"])).not.toContain(
      "line 2 edited",
    );
    expect(git(root, ["diff", "--", "file.txt"])).toContain("+line 2 edited");
  });

  it("stages single lines inside a hunk", () => {
    const base = lines(6);
    const changed = base.replace("line 3\n", "added a\nadded b\n");
    const root = repository(base, changed);
    const parsed = parseFilePatch(git(root, ["diff", "--", "file.txt"]))!;
    const additionB = parsed.hunks[0]!.lines.findIndex(
      (line) => line.text === "added b",
    );
    const patch = buildPartialPatch(
      parsed,
      new Set([patchLineKey(0, additionB)]),
      {
        reverse: false,
      },
    )!;
    git(root, ["apply", "--cached", "-"], patch);
    expect(git(root, ["show", ":file.txt"])).toBe(
      "line 1\nline 2\nline 3\nadded b\nline 4\nline 5\nline 6\n",
    );
  });

  it("unstages and discards selected lines with reversed patches", () => {
    const base = lines(8);
    const changed = base
      .replace("line 2\n", "two\n")
      .replace("line 7\n", "seven\n");
    const root = repository(base, changed);
    git(root, ["add", "file.txt"]);
    const staged = parseFilePatch(
      git(root, ["diff", "--cached", "--", "file.txt"]),
    )!;
    const firstChanges = staged.hunks
      .flatMap((_, index) => hunkLineKeys(staged, index))
      .filter((key) => {
        const [hunk, line] = key.split(":").map(Number);
        return staged.hunks[hunk!]!.lines[line!]!.text.match(/two|line 2$/u);
      });
    git(
      root,
      ["apply", "--cached", "-R", "-"],
      buildPartialPatch(staged, new Set(firstChanges), { reverse: true })!,
    );
    expect(git(root, ["show", ":file.txt"])).toContain("seven");
    expect(git(root, ["show", ":file.txt"])).toContain("line 2\n");

    const unstaged = parseFilePatch(git(root, ["diff", "--", "file.txt"]))!;
    git(
      root,
      ["apply", "-R", "-"],
      buildPartialPatch(unstaged, new Set(hunkLineKeys(unstaged, 0)), {
        reverse: true,
      })!,
    );
    expect(readFileSync(join(root, "file.txt"), "utf8")).toContain("line 2\n");
    expect(readFileSync(join(root, "file.txt"), "utf8")).toContain("seven\n");
  });

  it("keeps missing final newlines and returns nothing for an empty selection", () => {
    const root = repository("a\nb", "a\nc");
    const parsed = parseFilePatch(git(root, ["diff", "--", "file.txt"]))!;
    expect(buildPartialPatch(parsed, new Set(), { reverse: false })).toBeNull();
    const patch = buildPartialPatch(parsed, new Set(hunkLineKeys(parsed, 0)), {
      reverse: false,
    })!;
    expect(patch).toContain("\\ No newline at end of file");
    git(root, ["apply", "--cached", "-"], patch);
    expect(git(root, ["show", ":file.txt"])).toBe("a\nc");
  });
});
