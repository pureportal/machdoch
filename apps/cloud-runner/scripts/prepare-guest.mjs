import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";

const { values } = parseArgs({
  options: {
    base: { type: "string" },
    modules: { type: "string" },
    output: { type: "string" },
    runtime: { type: "string" },
  },
});
if (!values.base || !values.modules || !values.output || !values.runtime)
  throw new Error(
    "Provide --base initramfs, --modules directory, --runtime agent bundle and --output initramfs.",
  );
let inode = 0;
function entry(name, data, mode) {
  const bytes = Buffer.from(data);
  const path = Buffer.from(name + "\0");
  const header = Buffer.from(
    "070701" +
      [++inode, mode, 0, 0, 1, 0, bytes.length, 0, 0, 0, 0, path.length, 0]
        .map((value) => value.toString(16).padStart(8, "0"))
        .join(""),
  );
  return Buffer.concat([
    header,
    path,
    Buffer.alloc((4 - ((header.length + path.length) % 4)) % 4),
    bytes,
    Buffer.alloc((4 - (bytes.length % 4)) % 4),
  ]);
}
const guest = new URL("../guest/", import.meta.url);
const runtime = await readFile(resolve(values.runtime));
if (!runtime.length || runtime.length > 12 * 1024 * 1024)
  throw new Error("The shared agent bundle must be between 1 byte and 12 MiB.");
const records = [
  entry("cloud-enter", await readFile(new URL("boot.sh", guest)), 0o100755),
  entry("cloud-agent", "", 0o40755),
  entry("cloud-agent/shared-agent.cjs", runtime, 0o100444),
];
for (const file of (await readdir(guest))
  .filter((name) => name.endsWith(".ts") || name.endsWith(".py") || name === "package.json")
  .sort())
  records.push(
    entry(
      `cloud-agent/${file}`,
      await readFile(new URL(file, guest)),
      0o100644,
    ),
  );
records.push(entry("cloud-modules", "", 0o40755));
for (const name of ["rng-core.ko", "virtio-rng.ko"])
  records.push(
    entry(
      `cloud-modules/${name}`,
      await readFile(resolve(values.modules, name)),
      0o100644,
    ),
  );
records.push(entry("TRAILER!!!", "", 0));
const bytes = Buffer.concat([
  await readFile(resolve(values.base)),
  gzipSync(Buffer.concat(records)),
]);
const path = resolve(values.output);
await mkdir(dirname(path), { recursive: true });
await writeFile(path, bytes, { flag: "wx" });
process.stdout.write(
  JSON.stringify({
    path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  }) + "\n",
);
