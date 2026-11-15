import type { ChangedFileStat } from "@machdoch/fleet-protocol/cloud-delivery";

export interface DiffLine {
  kind: "context" | "addition" | "deletion";
  text: string;
  oldLine: number | null;
  newLine: number | null;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export interface DiffFile extends ChangedFileStat {
  hunks: DiffHunk[];
}

function unquote(path: string): string {
  if (!path.startsWith('"')) return path;
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  const body = path.slice(1, -1);
  const escapes: Record<string, number> = {
    n: 10,
    t: 9,
    r: 13,
    '"': 34,
    "\\": 92,
  };
  for (let index = 0; index < body.length; index++) {
    const character = body[index]!;
    if (character !== "\\") {
      bytes.push(...encoder.encode(character));
      continue;
    }
    const next = body[index + 1] ?? "";
    if (/[0-7]/.test(next)) {
      bytes.push(parseInt(body.slice(index + 1, index + 4), 8));
      index += 3;
    } else {
      bytes.push(escapes[next] ?? next.charCodeAt(0));
      index += 1;
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

function stripPrefix(path: string): string {
  const value = unquote(path.trim());
  return value.startsWith("a/") || value.startsWith("b/")
    ? value.slice(2)
    : value;
}

function headerPaths(line: string): [string, string] {
  const body = line.slice("diff --git ".length);
  if (body.startsWith('"')) {
    const end = body.indexOf('"', 1);
    return [
      stripPrefix(body.slice(0, end + 1)),
      stripPrefix(body.slice(end + 2)),
    ];
  }
  const middle = body.indexOf(" b/");
  return [
    stripPrefix(body.slice(0, middle)),
    stripPrefix(body.slice(middle + 1)),
  ];
}

export function parseUnifiedDiff(patch: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;
  for (const raw of patch.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.startsWith("diff --git ")) {
      const [previous, current] = headerPaths(line);
      file = {
        path: current,
        previousPath: previous === current ? null : previous,
        status: previous === current ? "modified" : "renamed",
        additions: 0,
        deletions: 0,
        binary: false,
        hunks: [],
      };
      hunk = null;
      files.push(file);
      continue;
    }
    if (!file) continue;
    if (hunk) {
      if (line.startsWith("+")) {
        hunk.lines.push({
          kind: "addition",
          text: line.slice(1),
          oldLine: null,
          newLine: newLine++,
        });
        file.additions++;
        continue;
      }
      if (line.startsWith("-")) {
        hunk.lines.push({
          kind: "deletion",
          text: line.slice(1),
          oldLine: oldLine++,
          newLine: null,
        });
        file.deletions++;
        continue;
      }
      if (line.startsWith(" ")) {
        hunk.lines.push({
          kind: "context",
          text: line.slice(1),
          oldLine: oldLine++,
          newLine: newLine++,
        });
        continue;
      }
      if (line.startsWith("\\")) continue;
    }
    const range = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
    if (range) {
      oldLine = Number(range[1]);
      newLine = Number(range[2]);
      hunk = { header: range[3]!.trim(), lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    hunk = null;
    if (line.startsWith("new file mode")) file.status = "added";
    else if (line.startsWith("deleted file mode")) file.status = "deleted";
    else if (line.startsWith("rename from "))
      file.previousPath = unquote(line.slice("rename from ".length));
    else if (line.startsWith("rename to ")) {
      file.path = unquote(line.slice("rename to ".length));
      file.status = "renamed";
    } else if (
      line.startsWith("Binary files ") ||
      line.startsWith("GIT binary patch")
    )
      file.binary = true;
    else if (line.startsWith("+++ ") && !line.startsWith("+++ /dev/null"))
      file.path = stripPrefix(line.slice(4));
  }
  return files;
}

export function changedFileStats(files: DiffFile[]): ChangedFileStat[] {
  return files.map(({ hunks: _, ...stat }) => stat);
}
