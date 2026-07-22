import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  inspectManagedTarget,
  installManagedTarget,
  uninstallManagedTarget,
} from "./ownership-merge.js";

const roots: string[] = [];
const createRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "machdoch-ownership-"));
  roots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("provider ownership merge", () => {
  it("updates and uninstalls only the managed markdown region", async () => {
    const root = await createRoot();
    const path = join(root, "AGENTS.md");
    await writeFile(path, "# User rules\n\nKeep this.\n", "utf8");
    const first = await installManagedTarget({
      path,
      provider: "codex-cli",
      scope: "workspace",
      format: "markdown",
      payload: "Managed v1",
    });
    const second = await installManagedTarget({
      path,
      provider: "codex-cli",
      scope: "workspace",
      format: "markdown",
      payload: "Managed v2",
      previous: first.record,
    });
    const installed = await readFile(path, "utf8");
    expect(installed).toContain("Keep this.");
    expect(installed).not.toContain("Managed v1");
    expect(installed).toContain("Managed v2");
    await expect(inspectManagedTarget(second.record)).resolves.toMatchObject({
      exists: true,
      syntaxValid: true,
      managedCurrent: true,
    });

    await writeFile(
      path,
      installed.replace("Managed v2", "Externally changed"),
      "utf8",
    );
    await expect(inspectManagedTarget(second.record)).resolves.toMatchObject({
      exists: true,
      syntaxValid: true,
      managedCurrent: false,
    });
    await writeFile(path, installed, "utf8");

    expect((await uninstallManagedTarget(second.record)).removed).toBe(true);
    expect(await readFile(path, "utf8")).toBe("# User rules\n\nKeep this.\n");
  });

  it("merges named MCP entries without replacing unrelated JSON", async () => {
    const root = await createRoot();
    const path = join(root, "mcp.json");
    await writeFile(
      path,
      JSON.stringify({ note: "keep", mcpServers: { custom: { url: "x" } } }),
      "utf8",
    );
    const installed = await installManagedTarget({
      path,
      provider: "copilot-cli",
      scope: "user",
      format: "json",
      payload: {
        mcpServers: { "machdoch-test": { type: "local", command: "machdoch" } },
      },
    });
    const parsed = JSON.parse(await readFile(path, "utf8")) as Record<
      string,
      unknown
    >;
    expect(parsed.note).toBe("keep");
    expect(parsed.mcpServers).toMatchObject({
      custom: { url: "x" },
      "machdoch-test": { type: "local", command: "machdoch" },
    });

    await uninstallManagedTarget(installed.record);
    const uninstalled = JSON.parse(await readFile(path, "utf8")) as Record<
      string,
      unknown
    >;
    expect(uninstalled.mcpServers).toEqual({ custom: { url: "x" } });
  });

  it("backs up and removes externally changed owned regions when forced", async () => {
    const root = await createRoot();
    const path = join(root, "CLAUDE.md");
    const installed = await installManagedTarget({
      path,
      provider: "claude-cli",
      scope: "user",
      format: "markdown",
      payload: "Managed policy",
    });
    await writeFile(
      path,
      (await readFile(path, "utf8")).replace(
        "Managed policy",
        "Changed managed policy",
      ),
      "utf8",
    );

    const result = await uninstallManagedTarget(installed.record, {
      force: true,
    });

    expect(result).toMatchObject({ removed: true });
    expect(result.warning).toContain("backed up");
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("deletes a managed JSON file after its last owned server is removed", async () => {
    const root = await createRoot();
    const path = join(root, "mcp.json");
    const installed = await installManagedTarget({
      path,
      provider: "copilot-cli",
      scope: "user",
      format: "json",
      payload: {
        mcpServers: {
          "machdoch-test": { type: "local", command: "machdoch", args: [] },
        },
      },
    });

    expect((await uninstallManagedTarget(installed.record)).removed).toBe(true);
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("collapses duplicate managed regions during reconciliation", async () => {
    const root = await createRoot();
    const path = join(root, "AGENTS.md");
    const first = await installManagedTarget({
      path,
      provider: "codex-cli",
      scope: "workspace",
      format: "markdown",
      payload: "Managed v1",
    });
    const duplicated = `${await readFile(path, "utf8")}\n${await readFile(path, "utf8")}`;
    await writeFile(path, duplicated, "utf8");

    const reconciled = await installManagedTarget({
      path,
      provider: "codex-cli",
      scope: "workspace",
      format: "markdown",
      payload: "Managed v2",
      previous: first.record,
    });
    const content = await readFile(path, "utf8");

    expect(
      content.match(/machdoch-managed:provider-enrollment:start/gu),
    ).toHaveLength(1);
    expect(content).toContain("Managed v2");
    expect(reconciled.warnings).toContainEqual(
      expect.stringContaining("backed up"),
    );
  });
});
