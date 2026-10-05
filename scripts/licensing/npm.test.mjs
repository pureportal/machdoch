import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { collectNpmPackages } from "./npm.mjs";

async function createFixture(t) {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "machdoch-npm-"));
  t.after(async () => {
    assert.equal(dirname(resolve(fixtureRoot)), resolve(tmpdir()));
    await rm(fixtureRoot, { recursive: true, force: true });
  });
  const repositoryRoot = join(fixtureRoot, "repository");
  await mkdir(repositoryRoot);
  const root = await realpath(repositoryRoot);

  async function packageAt(path, manifest) {
    const directory = join(root, path);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "package.json"), JSON.stringify(manifest));
    return realpath(directory);
  }

  async function link(owner, name, target) {
    const destination = join(owner, "node_modules", name);
    await mkdir(dirname(destination), { recursive: true });
    await symlink(
      target,
      destination,
      process.platform === "win32" ? "junction" : "dir",
    );
  }

  return { root, packageAt, link };
}

function record(name, version, directory, license = "", repository = "") {
  return { ecosystem: "npm", name, version, license, repository, directory };
}

test("resolves exact pnpm and hoisted roots without exports access or package execution", async (t) => {
  const fixture = await createFixture(t);
  const app = await fixture.packageAt("apps/app", {
    name: "@example/app",
    dependencies: { "@scope/feature": "^2", hoisted: "1", "data-only": "1" },
    devDependencies: { "development-only": "1" },
  });
  const feature = await fixture.packageAt(
    "node_modules/.pnpm/@scope+feature@2/node_modules/@scope/feature",
    {
      name: "@scope/feature",
      version: "2.0.0",
      license: "(MIT OR Apache-2.0)",
      repository: { type: "git", url: "git+https://example.com/feature.git" },
      exports: { ".": "./entry.mjs" },
      dependencies: { helper: "^1" },
      devDependencies: { "feature-development-only": "1" },
    },
  );
  await writeFile(
    join(feature, "entry.mjs"),
    'throw new Error("Package code was executed");',
  );
  const helper = await fixture.packageAt(
    "node_modules/.pnpm/helper@1/node_modules/helper",
    {
      name: "helper",
      version: "1.0.0",
      license: "BSD-3-Clause",
      repository: "github:example/helper",
    },
  );
  await fixture.packageAt("node_modules/helper", {
    name: "helper",
    version: "9.0.0",
  });
  const hoisted = await fixture.packageAt("node_modules/hoisted", {
    name: "hoisted",
    version: "1.0.0",
    dependencies: { nested: "^1" },
  });
  const nested = await fixture.packageAt(
    "node_modules/hoisted/node_modules/nested",
    {
      name: "nested",
      version: "1.0.0",
      license: "MIT",
    },
  );
  await fixture.packageAt("node_modules/nested", {
    name: "nested",
    version: "9.0.0",
  });
  const dataOnly = await fixture.packageAt("node_modules/data-only", {
    name: "data-only",
    version: "1.0.0",
    exports: {},
  });
  await fixture.packageAt("node_modules/development-only", {
    name: "development-only",
    version: "1.0.0",
  });
  await fixture.packageAt("node_modules/.pnpm/stale@1/node_modules/stale", {
    name: "stale",
    version: "1.0.0",
    dependencies: { "never-installed": "1" },
  });
  await fixture.link(app, "@scope/feature", feature);
  await fixture.link(
    join(fixture.root, "node_modules/.pnpm/@scope+feature@2"),
    "helper",
    helper,
  );

  assert.deepEqual(await collectNpmPackages(fixture.root, ["apps/app"]), [
    record(
      "@scope/feature",
      "2.0.0",
      feature,
      "(MIT OR Apache-2.0)",
      "https://example.com/feature.git",
    ),
    record("data-only", "1.0.0", dataOnly),
    record(
      "helper",
      "1.0.0",
      helper,
      "BSD-3-Clause",
      "https://github.com/example/helper",
    ),
    record("hoisted", "1.0.0", hoisted),
    record("nested", "1.0.0", nested, "MIT"),
  ]);
});

test("traverses linked workspaces and cycles without returning workspace packages", async (t) => {
  const fixture = await createFixture(t);
  const app = await fixture.packageAt("apps/app", {
    name: "@example/app",
    dependencies: { "@example/shared": "workspace:*" },
  });
  const shared = await fixture.packageAt("packages/shared", {
    name: "@example/shared",
    dependencies: { "@example/app": "workspace:*", runtime: "1" },
  });
  const runtime = await fixture.packageAt("node_modules/runtime", {
    name: "runtime",
    version: "1.0.0",
    license: "Apache-2.0",
  });
  await fixture.packageAt("packages/unused", {
    name: "@example/unused",
    dependencies: { "uninstalled-unused-runtime": "1" },
  });
  await fixture.link(app, "@example/shared", shared);
  await fixture.link(shared, "@example/app", app);

  const expected = [record("runtime", "1.0.0", runtime, "Apache-2.0")];
  assert.deepEqual(
    await collectNpmPackages(fixture.root, ["apps/app"]),
    expected,
  );
  assert.deepEqual(
    await collectNpmPackages(fixture.root, [
      "apps/app",
      "packages/shared",
      "apps/app",
    ]),
    expected,
  );
});

test("recognizes explicitly supplied workspace roots linked by ordinary version ranges", async (t) => {
  const fixture = await createFixture(t);
  const app = await fixture.packageAt("apps/app", {
    name: "@example/app",
    dependencies: { "@example/shared": "^1" },
  });
  const shared = await fixture.packageAt("packages/shared", {
    name: "@example/shared",
    version: "1.0.0",
    dependencies: { runtime: "1" },
  });
  const runtime = await fixture.packageAt("node_modules/runtime", {
    name: "runtime",
    version: "1.0.0",
  });
  await fixture.link(app, "@example/shared", shared);

  assert.deepEqual(
    await collectNpmPackages(fixture.root, ["apps/app", "packages/shared"]),
    [record("runtime", "1.0.0", runtime)],
  );
});

test("includes installed peers from their physical context and traverses peer dependencies", async (t) => {
  const fixture = await createFixture(t);
  const app = await fixture.packageAt("apps/app", {
    name: "@example/app",
    dependencies: { plugin: "1" },
  });
  const plugin = await fixture.packageAt(
    "node_modules/.pnpm/plugin@1_peer@2/node_modules/plugin",
    {
      name: "plugin",
      version: "1.0.0",
      peerDependencies: {
        peer: "^2",
        "absent-peer": "1",
        "optional-peer": "1",
      },
      peerDependenciesMeta: { "optional-peer": { optional: true } },
    },
  );
  const peer = await fixture.packageAt(
    "node_modules/.pnpm/peer@2/node_modules/peer",
    {
      name: "peer",
      version: "2.0.0",
      dependencies: { "peer-runtime": "1" },
    },
  );
  const peerRuntime = await fixture.packageAt("node_modules/peer-runtime", {
    name: "peer-runtime",
    version: "1.0.0",
  });
  const optionalPeer = await fixture.packageAt("node_modules/optional-peer", {
    name: "optional-peer",
    version: "1.0.0",
  });
  await fixture.packageAt("node_modules/peer", {
    name: "peer",
    version: "9.0.0",
  });
  await fixture.packageAt("node_modules/unrelated", {
    name: "unrelated",
    version: "1.0.0",
  });
  await fixture.link(app, "plugin", plugin);
  await fixture.link(
    join(fixture.root, "node_modules/.pnpm/plugin@1_peer@2"),
    "peer",
    peer,
  );

  assert.deepEqual(await collectNpmPackages(fixture.root, ["apps/app"]), [
    record("optional-peer", "1.0.0", optionalPeer),
    record("peer", "2.0.0", peer),
    record("peer-runtime", "1.0.0", peerRuntime),
    record("plugin", "1.0.0", plugin),
  ]);
});

test("skips absent optional dependencies and honors optional overrides while traversing installed ones", async (t) => {
  const fixture = await createFixture(t);
  await fixture.packageAt("apps/app", {
    name: "@example/app",
    dependencies: { base: "1", "platform-addon": "1" },
    optionalDependencies: { "platform-addon": "1", "absent-addon": "1" },
  });
  const base = await fixture.packageAt("node_modules/base", {
    name: "base",
    version: "1.0.0",
    optionalDependencies: { native: "1", "absent-native": "1" },
  });
  const native = await fixture.packageAt("node_modules/native", {
    name: "native",
    version: "1.0.0",
    dependencies: { helper: "1" },
  });
  const helper = await fixture.packageAt("node_modules/helper", {
    name: "helper",
    version: "1.0.0",
  });

  assert.deepEqual(await collectNpmPackages(fixture.root, ["apps/app"]), [
    record("base", "1.0.0", base),
    record("helper", "1.0.0", helper),
    record("native", "1.0.0", native),
  ]);
});

test("reports a missing required dependency even when an unlinked cache contains it", async (t) => {
  const fixture = await createFixture(t);
  const app = await fixture.packageAt("apps/app", {
    name: "@example/app",
    dependencies: { missing: "^3" },
  });
  await fixture.packageAt("node_modules/.pnpm/missing@3/node_modules/missing", {
    name: "missing",
    version: "3.0.0",
  });

  await assert.rejects(
    collectNpmPackages(fixture.root, ["apps/app"]),
    (error) => {
      assert.match(
        error.message,
        /Missing required npm dependency "missing" \(\^3\)/,
      );
      assert.ok(error.message.includes(join(app, "package.json")));
      return true;
    },
  );
});

test("reports missing required dependencies within an installed optional package", async (t) => {
  const fixture = await createFixture(t);
  await fixture.packageAt("apps/app", {
    name: "@example/app",
    optionalDependencies: { addon: "1" },
  });
  const addon = await fixture.packageAt("node_modules/addon", {
    name: "addon",
    version: "1.0.0",
    dependencies: { missing: "1" },
  });

  await assert.rejects(
    collectNpmPackages(fixture.root, ["apps/app"]),
    (error) => {
      assert.match(error.message, /Missing required npm dependency "missing"/);
      assert.ok(error.message.includes(join(addon, "package.json")));
      return true;
    },
  );
});

test("propagates malformed installed optional manifests instead of treating them as absent", async (t) => {
  const fixture = await createFixture(t);
  await fixture.packageAt("apps/app", {
    name: "@example/app",
    optionalDependencies: { addon: "1" },
  });
  const addon = await fixture.packageAt("node_modules/addon", {
    name: "addon",
    version: "1.0.0",
  });
  await writeFile(join(addon, "package.json"), "{ invalid");

  await assert.rejects(
    collectNpmPackages(fixture.root, ["apps/app"]),
    (error) => {
      assert.match(error.message, /Cannot read npm package manifest/);
      assert.ok(error.message.includes(join(addon, "package.json")));
      assert.ok(error.cause instanceof SyntaxError);
      return true;
    },
  );
});

test("deduplicates package versions after visiting every physical variant and handles aliases and cycles", async (t) => {
  const fixture = await createFixture(t);
  const left = await fixture.packageAt("apps/left", {
    name: "@example/left",
    dependencies: { shared: "1" },
  });
  const right = await fixture.packageAt("apps/right", {
    name: "@example/right",
    dependencies: { shared: "1", alias: "npm:shared@2" },
  });
  const first = await fixture.packageAt(
    "node_modules/.pnpm/shared@1_left/node_modules/shared",
    {
      name: "shared",
      version: "1.0.0",
      license: "MIT",
      dependencies: { "left-only": "1", variant: "npm:shared@1" },
    },
  );
  const second = await fixture.packageAt(
    "node_modules/.pnpm/shared@1_right/node_modules/shared",
    {
      name: "shared",
      version: "1.0.0",
      license: "MIT",
      dependencies: { "right-only": "1", variant: "npm:shared@1" },
    },
  );
  const newer = await fixture.packageAt(
    "node_modules/.pnpm/shared@2/node_modules/shared",
    {
      name: "shared",
      version: "2.0.0",
      license: "Apache-2.0",
    },
  );
  const leftOnly = await fixture.packageAt("node_modules/left-only", {
    name: "left-only",
    version: "1.0.0",
  });
  const rightOnly = await fixture.packageAt("node_modules/right-only", {
    name: "right-only",
    version: "1.0.0",
  });
  await fixture.link(left, "shared", first);
  await fixture.link(right, "shared", second);
  await fixture.link(right, "alias", newer);
  await fixture.link(first, "variant", second);
  await fixture.link(second, "variant", first);

  const expected = [
    record("left-only", "1.0.0", leftOnly),
    record("right-only", "1.0.0", rightOnly),
    record("shared", "1.0.0", first, "MIT"),
    record("shared", "2.0.0", newer, "Apache-2.0"),
  ];
  assert.deepEqual(
    await collectNpmPackages(fixture.root, ["apps/left", "apps/right"]),
    expected,
  );
  assert.deepEqual(
    await collectNpmPackages(fixture.root, ["apps/right", "apps/left"]),
    expected,
  );
});

test("returns declared license strings and repository URLs without legacy license inference", async (t) => {
  const fixture = await createFixture(t);
  const metadata = [
    {
      repository: "https://example.com/project.git",
      license: " MIT ",
      expected: "https://example.com/project.git",
    },
    {
      repository: { url: "git+https://example.com/project.git" },
      license: "Apache-2.0",
      expected: "https://example.com/project.git",
    },
    {
      repository: "owner/project",
      expected: "https://github.com/owner/project",
    },
    {
      repository: "gitlab:group/team/project",
      expected: "https://gitlab.com/group/team/project",
    },
    {
      repository: "bitbucket:owner/project",
      expected: "https://bitbucket.org/owner/project",
    },
    {
      repository: "git@github.com:owner/project.git",
      expected: "ssh://git@github.com/owner/project.git",
    },
    { repository: "not a repository", license: { type: "MIT" }, expected: "" },
    { repository: { type: "git" }, expected: "" },
    { expected: "" },
  ];
  const dependencies = {};
  const expected = [];

  for (const [index, metadataEntry] of metadata.entries()) {
    const name = `metadata-${index}`;
    dependencies[name] = "1";
    const directory = await fixture.packageAt(`node_modules/${name}`, {
      name,
      version: "1.0.0",
      repository: metadataEntry.repository,
      license: metadataEntry.license,
    });
    expected.push(
      record(
        name,
        "1.0.0",
        directory,
        typeof metadataEntry.license === "string"
          ? metadataEntry.license.trim()
          : "",
        metadataEntry.expected,
      ),
    );
  }
  await fixture.packageAt("apps/app", { name: "@example/app", dependencies });

  assert.deepEqual(
    await collectNpmPackages(fixture.root, ["apps/app"]),
    expected,
  );
});

test("rejects installed third-party packages without a declared identity", async (t) => {
  const fixture = await createFixture(t);
  await fixture.packageAt("apps/app", {
    name: "@example/app",
    dependencies: { anonymous: "1" },
  });
  const anonymous = await fixture.packageAt("node_modules/anonymous", {
    license: "MIT",
  });

  await assert.rejects(
    collectNpmPackages(fixture.root, ["apps/app"]),
    (error) => {
      assert.match(error.message, /must declare a name and version/);
      assert.ok(error.message.includes(join(anonymous, "package.json")));
      return true;
    },
  );
});
