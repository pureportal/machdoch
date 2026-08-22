import {
  appendFile,
  mkdtemp,
  open,
  rm,
  writeFile,
} from "node:fs/promises";
import { closeSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  readOpenedFileExactly,
  readOpenedFileExactlySync,
} from "./read-opened-file-exactly.helper.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

it("does not follow a growing EOF beyond the validated byte bound", async () => {
  const root = await mkdtemp(join(tmpdir(), "machdoch-bounded-read-"));
  const path = join(root, "fixture.txt");
  roots.push(root);
  await writeFile(path, "abc", "utf8");
  const handle = await open(path, "r");
  try {
    await appendFile(path, "unbounded-growth", "utf8");
    await expect(readOpenedFileExactly(handle, 3)).resolves.toEqual(
      Buffer.from("abc"),
    );
  } finally {
    await handle.close();
  }
});

it("fails if a file shrinks below its validated byte bound", async () => {
  const root = await mkdtemp(join(tmpdir(), "machdoch-bounded-read-"));
  const path = join(root, "fixture.txt");
  roots.push(root);
  await writeFile(path, "abc", "utf8");
  const handle = await open(path, "r");
  try {
    await expect(readOpenedFileExactly(handle, 4)).rejects.toThrow(
      "ended before its validated size",
    );
  } finally {
    await handle.close();
  }
});

it("keeps synchronous descriptor reads within the validated byte bound", async () => {
  const root = await mkdtemp(join(tmpdir(), "machdoch-bounded-read-"));
  const path = join(root, "fixture.txt");
  roots.push(root);
  await writeFile(path, "abc", "utf8");
  const descriptor = openSync(path, "r");
  try {
    await appendFile(path, "unbounded-growth", "utf8");
    expect(readOpenedFileExactlySync(descriptor, 3)).toEqual(
      Buffer.from("abc"),
    );
  } finally {
    closeSync(descriptor);
  }
});
