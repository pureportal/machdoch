import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  encodeWorkspaceFileContent,
  maximumWorkspaceFileBytes,
  maximumWorkspaceRequestBodyBytes,
  workspaceRequestSchema,
} from "./workspace.ts";

const invocation = <T>(command: string, args: T) => ({
  kind: "invoke",
  id: "bc856a02-3b42-4c1e-8aa3-b28a97873092",
  command,
  args,
});

await test("MCP updates carry both reviewed and replacement documents at the editor boundary", () => {
  const encoded = encodeWorkspaceFileContent(
    "\0".repeat(maximumWorkspaceFileBytes),
  );
  const request = invocation("save_workspace_mcp_config_document", {
    workspaceRoot: "/projects/demo",
    rawBase64: encoded,
    expectedRawBase64: encoded,
  });
  assert.equal(workspaceRequestSchema.safeParse(request).success, true);
  assert.ok(
    Buffer.byteLength(JSON.stringify(request)) <
      maximumWorkspaceRequestBodyBytes,
  );
  assert.equal(
    workspaceRequestSchema.safeParse(
      invocation("save_workspace_mcp_config_document", {
        workspaceRoot: "/projects/demo",
        rawBase64: encoded,
      }),
    ).success,
    false,
  );
});

await test("workspace tools match the shared Rust conformance cases", async () => {
  const cases: { name: string; request: unknown; accepted: boolean }[] =
    JSON.parse(
      await readFile(
        new URL(
          "../fixtures/workspace-tools-conformance.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
  for (const entry of cases)
    assert.equal(
      workspaceRequestSchema.safeParse(entry.request).success,
      entry.accepted,
      entry.name,
    );
});

await test("workspace requests reject paths outside the selected root and unknown fields", () => {
  for (const relativePath of [
    "../secret",
    "folder/../secret",
    "C:\\secret",
    "\\\\server\\secret",
    "/secret",
    "file\0name",
  ])
    assert.equal(
      workspaceRequestSchema.safeParse(
        invocation("read_workspace_file", {
          workspaceRoot: "/projects/demo",
          relativePath,
        }),
      ).success,
      false,
      relativePath,
    );
  assert.equal(
    workspaceRequestSchema.safeParse(
      invocation("read_workspace_file", {
        workspaceRoot: "/projects/demo",
        relativePath: "src/main.ts",
      }),
    ).success,
    true,
  );
  assert.equal(
    workspaceRequestSchema.safeParse(
      invocation("read_workspace_file", {
        workspaceRoot: "/projects/demo",
        relativePath: "src/main.ts",
        force: true,
      }),
    ).success,
    false,
  );
});

await test("Git requests require only the fields used by their action", () => {
  const request = {
    workspaceRoot: "/projects/demo",
    repositoryRoot: "/projects/demo",
    action: "create-branch",
    branchName: "review",
  };
  assert.equal(
    workspaceRequestSchema.safeParse(
      invocation("run_workspace_git_action", { request }),
    ).success,
    true,
  );
  assert.equal(
    workspaceRequestSchema.safeParse(
      invocation("run_workspace_git_action", {
        request: {
          ...request,
          remoteUrl: "https://example.test/repository.git",
        },
      }),
    ).success,
    false,
  );
  assert.equal(
    workspaceRequestSchema.safeParse(
      invocation("run_workspace_git_action", {
        request: { ...request, branchName: "" },
      }),
    ).success,
    false,
  );
  assert.equal(
    workspaceRequestSchema.safeParse(
      invocation("run_workspace_git_action", {
        request: { ...request, action: "reset-hard" },
      }),
    ).success,
    false,
  );
});

await test("file saves preserve Unicode and fit the relay limit at the native editing boundary", () => {
  const text =
    "\t".repeat(maximumWorkspaceFileBytes - Buffer.byteLength("🌿")) + "🌿";
  const contentBase64 = encodeWorkspaceFileContent(text);
  const request = invocation("save_workspace_file", {
    request: {
      workspaceRoot: "/projects/demo",
      relativePath: "review.txt",
      contentBase64,
      expectedRevision: "a".repeat(64),
      force: false,
      bom: true,
    },
  });
  assert.equal(workspaceRequestSchema.safeParse(request).success, true);
  assert.equal(Buffer.from(contentBase64, "base64").toString("utf8"), text);
  assert.ok(Buffer.byteLength(JSON.stringify(request)) < 2_200_000);
  assert.throws(() => encodeWorkspaceFileContent(text + "x"), /editing limit/);
  assert.throws(() => encodeWorkspaceFileContent("\ud800"), /invalid Unicode/);
  for (const value of ["Zg=", "Zg===", "Zh==", "***=", "/w=="])
    assert.equal(
      workspaceRequestSchema.safeParse({
        ...request,
        args: { request: { ...request.args.request, contentBase64: value } },
      }).success,
      false,
      value,
    );
});
