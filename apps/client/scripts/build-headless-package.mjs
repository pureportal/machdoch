import { create as createTar } from "tar";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(projectRoot, "../..");
const dist = join(projectRoot, "dist");
const require = createRequire(import.meta.url);
const metadata = JSON.parse(
  await readFile(join(projectRoot, "package.json"), "utf8"),
);
await mkdir(dist, { recursive: true });
const stage = await mkdtemp(join(dist, "headless-stage-"));
if (dirname(stage) !== dist)
  throw new Error("Refusing to use an unexpected staging path.");
try {
  const root = join(stage, "machdoch");
  await mkdir(root);
  await cp(join(dist, "machdoch-cli.cjs"), join(root, "machdoch-cli.cjs"));
  await cp(
    join(repositoryRoot, "packaging/headless/machdoch"),
    join(root, "machdoch"),
  );
  // Git checkouts on Windows can use CRLF; the Linux entry point must use LF.
  await writeFile(
    join(root, "machdoch"),
    (await readFile(join(root, "machdoch"), "utf8")).replaceAll("\r\n", "\n"),
  );
  await chmod(join(root, "machdoch"), 0o755);
  await cp(
    dirname(require.resolve("playwright-core/package.json")),
    join(root, "node_modules/playwright-core"),
    { recursive: true, dereference: true },
  );
  await cp(
    join(repositoryRoot, "packaging/systemd/machdoch-fleet.service"),
    join(root, "machdoch-fleet.service"),
  );
  await cp(
    join(repositoryRoot, "docs/fleet-background-service.md"),
    join(root, "README.md"),
  );
  await writeFile(
    join(root, "package.json"),
    `${JSON.stringify({ name: "machdoch-headless", version: metadata.version, private: true, engines: metadata.engines }, null, 2)}\n`,
  );
  const archive = join(dist, "machdoch-headless.tar.gz");
  await createTar(
    {
      cwd: stage,
      file: archive,
      gzip: true,
      portable: true,
      strict: true,
      onWriteEntry(entry) {
        // Windows chmod cannot represent Unix execute bits. Write them into the archive.
        entry.stat.mode =
          entry.type === "Directory" ||
          entry.path === "machdoch/machdoch" ||
          entry.path.endsWith(".sh") ||
          entry.stat.mode & 0o111
            ? 0o755
            : 0o644;
      },
    },
    ["machdoch"],
  );
  console.log(
    `Headless Linux package: ${archive} (requires Node.js ${metadata.engines.node})`,
  );
} finally {
  // mkdtemp returns a fresh directory strictly under this build's dist folder.
  await rm(stage, { recursive: true, force: true });
}
