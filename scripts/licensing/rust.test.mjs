import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { collectRustPackages, parseRustMetadata } from "./rust.mjs";

const fixtureDirectory = resolve("rust-inventory-fixture");
const rootManifestPath = join(
  fixtureDirectory,
  "apps",
  "client",
  "src-tauri",
  "Cargo.toml",
);
const registry = "registry+https://github.com/rust-lang/crates.io-index";

function crate(name, fields = {}) {
  const version = fields.version ?? "1.0.0";
  const manifestPath =
    fields.manifest_path ??
    join(fixtureDirectory, "cargo", `${name}-${version}`, "Cargo.toml");
  return {
    id: `path+${manifestPath}#${name}@${version}`,
    name,
    version,
    license: "MIT OR Apache-2.0",
    repository: `https://example.test/${name}`,
    source: registry,
    manifest_path: manifestPath,
    ...fields,
  };
}

function rootCrate() {
  return crate("machdoch", { source: null, manifest_path: rootManifestPath });
}

function edge(pkg, depKinds = [{ kind: null, target: null }]) {
  return {
    name: pkg.name.replaceAll("-", "_"),
    pkg: pkg.id,
    dep_kinds: depKinds,
  };
}

function node(pkg, deps = []) {
  return { id: pkg.id, deps, features: [] };
}

function graph(packages, nodes, members, root = null) {
  return {
    version: 1,
    packages,
    workspace_members: members.map((pkg) => pkg.id),
    resolve: { root: root?.id ?? null, nodes },
  };
}

test("selects the requested manifest rather than another workspace root or all packages", () => {
  const root = rootCrate();
  const otherRoot = crate("another-app", {
    source: null,
    manifest_path: join(fixtureDirectory, "apps", "another-app", "Cargo.toml"),
  });
  const selected = crate("selected");
  const unrelated = crate("unrelated");
  for (const resolvedRoot of [null, otherRoot]) {
    const metadata = graph(
      [otherRoot, unrelated, selected, root],
      [
        node(otherRoot, [edge(unrelated)]),
        node(root, [edge(selected)]),
        node(selected),
        node(unrelated),
      ],
      [root, otherRoot],
      resolvedRoot,
    );
    assert.deepEqual(
      parseRustMetadata(metadata, rootManifestPath).map((pkg) => pkg.name),
      ["selected"],
    );
  }
});

test("resolves a relative requested manifest to its absolute package manifest", () => {
  const root = rootCrate();
  const dependency = crate("dependency");
  const metadata = graph(
    [root, dependency],
    [node(root, [edge(dependency)]), node(dependency)],
    [root],
    root,
  );
  const manifestPath = join(
    "rust-inventory-fixture",
    "apps",
    "client",
    "src-tauri",
    "Cargo.toml",
  );
  assert.equal(
    parseRustMetadata(metadata, manifestPath)[0].directory,
    dirname(dependency.manifest_path),
  );
});

test("excludes local workspace and Machdoch path crates while traversing their dependencies", () => {
  const root = rootCrate();
  const member = crate("shared-workspace-crate", { source: null });
  const fleet = crate("machdoch-fleet-protocol", {
    source: null,
    manifest_path: join(
      fixtureDirectory,
      "packages",
      "fleet-protocol",
      "Cargo.toml",
    ),
  });
  const fromMember = crate("member-dependency");
  const fromFleet = crate("fleet-dependency");
  const vendored = crate("third-party-path-crate", { source: null });
  const published = crate("machdoch-published-crate");
  const metadata = graph(
    [root, member, fleet, fromMember, fromFleet, vendored, published],
    [
      node(root, [edge(member), edge(fleet), edge(vendored), edge(published)]),
      node(member, [edge(fromMember)]),
      node(fleet, [edge(fromFleet)]),
      node(fromMember),
      node(fromFleet),
      node(vendored),
      node(published),
    ],
    [root, member],
    root,
  );
  const inventory = parseRustMetadata(metadata, rootManifestPath);
  assert.deepEqual(
    inventory.map((pkg) => pkg.name),
    [
      "fleet-dependency",
      "machdoch-published-crate",
      "member-dependency",
      "third-party-path-crate",
    ],
  );
  assert.equal(inventory.find((pkg) => pkg.name === vendored.name).source, "");
});

test("includes resolved normal, build, target, renamed, and mixed-kind edges while excluding dev-only edges", () => {
  const root = rootCrate();
  const normal = crate("normal");
  const build = crate("build");
  const target = crate("target");
  const renamed = crate("original-crate-name");
  const mixed = crate("mixed");
  const mixedBuild = crate("mixed-build");
  const dev = crate("dev-only");
  const transitiveDev = crate("transitive-dev-only");
  const disabled = crate("disabled-optional");
  const filtered = crate("filtered-target");
  const buildChild = crate("build-child");
  const metadata = graph(
    [
      root,
      normal,
      build,
      target,
      renamed,
      mixed,
      mixedBuild,
      dev,
      transitiveDev,
      disabled,
      filtered,
      buildChild,
    ],
    [
      node(root, [
        edge(normal),
        edge(build, [{ kind: "build", target: null }]),
        edge(target, [{ kind: null, target: "cfg(windows)" }]),
        { ...edge(renamed), name: "renamed_dependency" },
        edge(mixed, [
          { kind: "dev", target: null },
          { kind: null, target: null },
        ]),
        edge(mixedBuild, [
          { kind: "dev", target: null },
          { kind: "build", target: "cfg(windows)" },
        ]),
        edge(dev, [{ kind: "dev", target: null }]),
        edge(filtered, []),
      ]),
      node(normal, [edge(transitiveDev, [{ kind: "dev", target: null }])]),
      node(build, [edge(buildChild)]),
      ...[
        target,
        renamed,
        mixed,
        mixedBuild,
        dev,
        transitiveDev,
        disabled,
        filtered,
        buildChild,
      ].map((pkg) => node(pkg)),
    ],
    [root],
    root,
  );
  assert.deepEqual(
    parseRustMetadata(metadata, rootManifestPath).map((pkg) => pkg.name),
    [
      "build",
      "build-child",
      "mixed",
      "mixed-build",
      "normal",
      "original-crate-name",
      "target",
    ],
  );
});

test("deduplicates repeated and diamond edges, terminates cycles, and preserves versions and sources", () => {
  const root = rootCrate();
  const alpha = crate("alpha");
  const beta = crate("beta");
  const shared = crate("shared");
  const newer = crate("shared", { version: "2.0.0" });
  const git = crate("shared", {
    source: "git+https://example.test/shared?rev=123#123",
    manifest_path: join(fixtureDirectory, "git", "shared", "Cargo.toml"),
  });
  const metadata = graph(
    [git, newer, beta, root, shared, alpha],
    [
      node(root, [
        edge(beta),
        edge(alpha),
        edge(alpha),
        edge(newer),
        edge(git),
      ]),
      node(alpha, [edge(shared)]),
      node(beta, [edge(shared)]),
      node(shared, [edge(alpha)]),
      node(newer),
      node(git),
    ],
    [root],
    root,
  );
  const inventory = parseRustMetadata(metadata, rootManifestPath);
  assert.deepEqual(
    inventory.map(({ name, version, source }) => [name, version, source]),
    [
      ["alpha", "1.0.0", registry],
      ["beta", "1.0.0", registry],
      ["shared", "1.0.0", git.source],
      ["shared", "1.0.0", registry],
      ["shared", "2.0.0", registry],
    ],
  );
  metadata.packages.reverse();
  metadata.resolve.nodes.reverse();
  metadata.resolve.nodes
    .find((resolvedNode) => resolvedNode.id === root.id)
    .deps.reverse();
  assert.deepEqual(parseRustMetadata(metadata, rootManifestPath), inventory);
});

test("returns only inventory fields with declared licensing metadata and absolute crate directories", () => {
  const root = rootCrate();
  const declared = crate("declared", {
    license: "MPL-2.0",
    repository: "https://example.test/project",
  });
  const missing = crate("missing", { license: null, repository: null });
  const metadata = graph(
    [root, declared, missing],
    [
      node(root, [edge(missing), edge(declared)]),
      node(declared),
      node(missing),
    ],
    [root],
    root,
  );
  assert.deepEqual(parseRustMetadata(metadata, rootManifestPath), [
    {
      ecosystem: "cargo",
      name: "declared",
      version: "1.0.0",
      license: "MPL-2.0",
      repository: "https://example.test/project",
      directory: dirname(declared.manifest_path),
      source: registry,
    },
    {
      ecosystem: "cargo",
      name: "missing",
      version: "1.0.0",
      license: "",
      repository: "",
      directory: dirname(missing.manifest_path),
      source: registry,
    },
  ]);
});

test("returns an empty inventory when the selected crate has no dependencies", () => {
  const root = rootCrate();
  assert.deepEqual(
    parseRustMetadata(
      graph([root], [node(root)], [root], root),
      rootManifestPath,
    ),
    [],
  );
});

test("rejects metadata without a resolved graph or the requested manifest", () => {
  const root = rootCrate();
  for (const metadata of [
    null,
    { packages: [] },
    { packages: [root], workspace_members: [root.id], resolve: null },
  ]) {
    assert.throws(
      () => parseRustMetadata(metadata, rootManifestPath),
      /resolved dependency graph/,
    );
  }
  const metadata = graph([root], [node(root)], [root], root);
  assert.throws(
    () =>
      parseRustMetadata(
        metadata,
        join(fixtureDirectory, "missing", "Cargo.toml"),
      ),
    /no package for manifest/,
  );
});

test("rejects incomplete reachable graphs instead of producing a partial inventory", () => {
  const root = rootCrate();
  const dependency = crate("dependency");
  const metadataCases = [
    graph([root], [], [root], root),
    graph(
      [root],
      [node(root, [edge(dependency)]), node(dependency)],
      [root],
      root,
    ),
    graph([root, dependency], [node(root, [edge(dependency)])], [root], root),
  ];
  for (const metadata of metadataCases) {
    assert.throws(
      () => parseRustMetadata(metadata, rootManifestPath),
      /missing a package or resolved node/,
    );
  }
});

test("requires rich resolved edges and dependency kinds rather than using untyped dependency lists", () => {
  const root = rootCrate();
  const dependency = crate("dependency");
  const withoutEdges = graph(
    [root, dependency],
    [{ id: root.id, dependencies: [dependency.id] }, node(dependency)],
    [root],
    root,
  );
  assert.throws(
    () => parseRustMetadata(withoutEdges, rootManifestPath),
    /missing resolved dependency edges/,
  );
  const withoutKinds = graph(
    [root, dependency],
    [
      node(root, [{ name: dependency.name, pkg: dependency.id }]),
      node(dependency),
    ],
    [root],
    root,
  );
  assert.throws(
    () => parseRustMetadata(withoutKinds, rootManifestPath),
    /missing dependency kinds/,
  );
});

test("rejects a dependency without an absolute crate manifest path", () => {
  const root = rootCrate();
  const dependency = crate("dependency", {
    manifest_path: join("relative-crate", "Cargo.toml"),
  });
  const metadata = graph(
    [root, dependency],
    [node(root, [edge(dependency)]), node(dependency)],
    [root],
    root,
  );
  assert.throws(
    () => parseRustMetadata(metadata, rootManifestPath),
    /no absolute crate manifest path/,
  );
});

test("requires a manifest and an explicit target before invoking Cargo", async () => {
  assert.throws(() => parseRustMetadata({}, ""), /manifest path is required/);
  await assert.rejects(
    collectRustPackages("", "x86_64-pc-windows-msvc"),
    /manifest path is required/,
  );
  await assert.rejects(
    collectRustPackages(rootManifestPath, ""),
    /target triple is required/,
  );
  await assert.rejects(
    collectRustPackages(rootManifestPath),
    /target triple is required/,
  );
});
