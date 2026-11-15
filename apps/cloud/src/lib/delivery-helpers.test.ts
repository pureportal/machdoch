import { expect, it } from "vitest";
import { deliveryGates } from "./delivery-gates";
import { taskReport } from "./task-progress";
import { parseUnifiedDiff } from "./unified-diff";
import { detectRepositoryChecks } from "../server/cloud/execution/check-detection";

const patch = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -10,3 +10,4 @@ export function greet() {
   const name = "world";
-  return "Hello " + name;
+  return \`Hello \${name}\`;
+  // done
 }
diff --git a/old name.md b/new name.md
similarity index 90%
rename from old name.md
rename to new name.md
diff --git a/tests/app.test.ts b/tests/app.test.ts
deleted file mode 100644
--- a/tests/app.test.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-it("greets", () => {});
-it("waves", () => {});
diff --git a/logo.png b/logo.png
new file mode 100644
Binary files /dev/null and b/logo.png differ
`;

it("parses files, line numbers, renames, deletions and binaries", () => {
  const files = parseUnifiedDiff(patch);
  expect(
    files.map(({ path, status, binary }) => [path, status, binary]),
  ).toEqual([
    ["src/app.ts", "modified", false],
    ["new name.md", "renamed", false],
    ["tests/app.test.ts", "deleted", false],
    ["logo.png", "added", true],
  ]);
  expect(files[0]).toMatchObject({ additions: 2, deletions: 1 });
  expect(files[0]!.hunks[0]!.header).toBe("export function greet() {");
  expect(files[0]!.hunks[0]!.lines[2]).toEqual({
    kind: "addition",
    text: "  return `Hello ${name}`;",
    oldLine: null,
    newLine: 11,
  });
  expect(files[1]!.previousPath).toBe("old name.md");
});

it("flags weakened tests, sensitive areas and oversized changes", () => {
  const gates = deliveryGates(parseUnifiedDiff(patch), [
    { name: "unit", passed: true },
  ]);
  expect(
    Object.fromEntries(gates.map((gate) => [gate.id, gate.passed])),
  ).toEqual({
    checks: true,
    tests_intact: false,
    protected_paths: true,
    change_size: true,
  });
  const sensitive = deliveryGates(
    parseUnifiedDiff(
      "diff --git a/db/migrations/001.sql b/db/migrations/001.sql\n--- a/db/migrations/001.sql\n+++ b/db/migrations/001.sql\n@@ -1 +1 @@\n-a\n+b\n",
    ),
    [],
  );
  expect(sensitive.find((gate) => gate.id === "protected_paths")).toMatchObject(
    {
      passed: false,
      paths: ["db/migrations/001.sql"],
    },
  );
  expect(sensitive.find((gate) => gate.id === "checks")!.passed).toBe(false);
});

it("splits the agent report into its sections", () => {
  expect(
    taskReport(
      "## What changed\nNew greeting.\n\n## Decisions\n- Kept the API.\n\n## Checks\nnpm test passed\n\nChecks passed: unit.",
    ),
  ).toEqual({
    verdict: null,
    problems: null,
    changed: "New greeting.",
    decisions: "- Kept the API.",
    checks: "npm test passed\n\nChecks passed: unit.",
    other: null,
  });
  expect(taskReport("Fixed it.").other).toBe("Fixed it.");
});

it("suggests checks from the repository's own files", async () => {
  const files = new Map([
    [
      "package.json",
      JSON.stringify({
        scripts: { test: "vitest run", lint: "oxlint", start: "node ." },
      }),
    ],
    ["pnpm-lock.yaml", "lockfileVersion: 9"],
  ]);
  expect(
    await detectRepositoryChecks(async (path) => files.get(path) ?? null),
  ).toEqual([
    { name: "Lint", command: "pnpm run lint", timeoutSeconds: 300 },
    { name: "Tests", command: "pnpm run test", timeoutSeconds: 300 },
  ]);
  expect(
    await detectRepositoryChecks(async (path) =>
      path === "go.mod" ? "module app" : null,
    ),
  ).toEqual([
    { name: "Vet", command: "go vet ./...", timeoutSeconds: 300 },
    { name: "Tests", command: "go test ./...", timeoutSeconds: 300 },
  ]);
});
