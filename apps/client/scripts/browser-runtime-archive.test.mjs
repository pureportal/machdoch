import assert from "node:assert/strict";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { list as listTar } from "tar";
import { buildBrowserRuntimeArchive } from "./browser-runtime-archive.mjs";

const readArchive = async (file) => {
  const entries = new Map();
  await listTar.asyncFile(
    {
      file,
      strict: true,
      onReadEntry(entry) {
        const chunks = [];
        entry.on("data", (chunk) => chunks.push(chunk));
        entry.on("end", () => {
          entries.set(entry.path, {
            type: entry.type,
            contents: Buffer.concat(chunks),
          });
        });
      },
    },
    [],
  );
  return entries;
};

void test("packages hard-linked dependencies as byte-exact regular files", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "machdoch-browser-runtime-test-"),
  );
  try {
    const source = join(directory, "package");
    const output = join(directory, "runtime.tar.gz");
    await mkdir(join(source, "lib"), { recursive: true });
    const files = new Map([
      ["package.json", '{"name":"playwright-core","type":"module"}'],
      ["index.mjs", "export const chromium = {};"],
      ["browsers.json", '{"browsers":[]}'],
      ["lib/help.json", '{"help":"Run a browser command"}'],
    ]);
    for (const [path, contents] of files) {
      await writeFile(join(source, path), contents);
      await link(
        join(source, path),
        join(directory, path.replaceAll("/", "-")),
      );
    }
    await link(join(source, "index.mjs"), join(source, "lib/linked.mjs"));
    files.set("lib/linked.mjs", files.get("index.mjs"));

    await buildBrowserRuntimeArchive(source, output);

    const entries = await readArchive(output);
    assert.equal(entries.size, files.size);
    for (const [path, contents] of files) {
      const entry = entries.get(`node_modules/playwright-core/${path}`);
      assert.equal(entry?.type, "File", path);
      assert.deepEqual(entry.contents, Buffer.from(contents), path);
      assert.equal(await readFile(join(source, path), "utf8"), contents);
    }

    const repeatedOutput = join(directory, "repeated.tar.gz");
    await buildBrowserRuntimeArchive(source, repeatedOutput);
    assert.deepEqual(await readFile(repeatedOutput), await readFile(output));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("fails when the browser package is missing", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "machdoch-browser-runtime-test-"),
  );
  try {
    await assert.rejects(
      buildBrowserRuntimeArchive(
        join(directory, "missing"),
        join(directory, "runtime.tar.gz"),
      ),
      { code: "ENOENT" },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("fails when the browser package is empty", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "machdoch-browser-runtime-test-"),
  );
  try {
    const source = join(directory, "package");
    await mkdir(source);
    await assert.rejects(
      buildBrowserRuntimeArchive(source, join(directory, "runtime.tar.gz")),
      /browser runtime package contains no files/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
