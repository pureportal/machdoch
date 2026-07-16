import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  installManagedTarget,
  inspectManagedTarget,
  uninstallManagedTarget,
} from "./ownership-merge.js";

const roots: string[] = [];
const createRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "machdoch-ownership-"));
  roots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
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

    await writeFile(path, installed.replace("Managed v2", "Externally changed"), "utf8");
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
    await writeFile(path, JSON.stringify({ note: "keep", mcpServers: { custom: { url: "x" } } }), "utf8");
    const installed = await installManagedTarget({
      path,
      provider: "copilot-cli",
      scope: "user",
      format: "json",
      payload: { mcpServers: { "machdoch-test": { type: "local", command: "machdoch" } } },
    });
    const parsed = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    expect(parsed.note).toBe("keep");
    expect(parsed.mcpServers).toMatchObject({
      custom: { url: "x" },
      "machdoch-test": { type: "local", command: "machdoch" },
    });

    await uninstallManagedTarget(installed.record);
    const uninstalled = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    expect(uninstalled.mcpServers).toEqual({ custom: { url: "x" } });
  });
});
