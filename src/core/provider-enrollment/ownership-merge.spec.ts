import {
  mkdtemp,
  open,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  inspectManagedTarget,
  installManagedTarget,
  loadOwnershipManifest,
  loadOwnershipManifestSnapshot,
  saveOwnershipManifest,
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

  it("serializes concurrent managed updates without losing unrelated servers", async () => {
    const root = await createRoot();
    const path = join(root, "mcp.json");

    await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        installManagedTarget({
          path,
          provider: "copilot-cli",
          scope: "user",
          format: "json",
          payload: {
            mcpServers: {
              [`server-${index}`]: { command: `command-${index}` },
            },
          },
        }),
      ),
    );

    const parsed = JSON.parse(await readFile(path, "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(Object.keys(parsed.mcpServers).sort()).toEqual(
      Array.from({ length: 6 }, (_, index) => `server-${index}`),
    );
  });

  it("preserves valid prototype-named MCP servers as own JSON keys", async () => {
    const root = await createRoot();
    const path = join(root, "mcp.json");
    const payload = JSON.parse(
      '{"mcpServers":{"__proto__":{"command":"prototype"},"constructor":{"command":"constructor"}}}',
    ) as Record<string, unknown>;

    const installed = await installManagedTarget({
      path,
      provider: "copilot-cli",
      scope: "user",
      format: "json",
      payload,
    });

    const parsed = JSON.parse(await readFile(path, "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(Object.hasOwn(parsed.mcpServers, "__proto__")).toBe(true);
    expect(Object.hasOwn(parsed.mcpServers, "constructor")).toBe(true);
    await expect(inspectManagedTarget(installed.record)).resolves.toMatchObject({
      managedCurrent: true,
    });
  });

  it("blocks an unmanaged MCP-name collision without changing the file", async () => {
    const root = await createRoot();
    const path = join(root, "mcp.json");
    const original = `${JSON.stringify({
      note: "keep",
      mcpServers: { managed: { command: "user-command" } },
    })}\n`;
    await writeFile(path, original, "utf8");

    await expect(
      installManagedTarget({
        path,
        provider: "copilot-cli",
        scope: "user",
        format: "json",
        payload: { mcpServers: { managed: { command: "machdoch" } } },
      }),
    ).rejects.toThrow("Refusing to overwrite unmanaged");
    expect(await readFile(path, "utf8")).toBe(original);
  });

  it("blocks malformed existing MCP container shapes without changing the file", async () => {
    const root = await createRoot();
    const path = join(root, "mcp.json");
    const original = '{"note":"keep","mcpServers":[]}\n';
    await writeFile(path, original, "utf8");

    await expect(
      installManagedTarget({
        path,
        provider: "copilot-cli",
        scope: "user",
        format: "json",
        payload: { mcpServers: { managed: { command: "machdoch" } } },
      }),
    ).rejects.toThrow("mcpServers must be an object");
    expect(await readFile(path, "utf8")).toBe(original);
  });

  it("backs up a managed MCP entry that was deleted externally", async () => {
    const root = await createRoot();
    const path = join(root, "mcp.json");
    const first = await installManagedTarget({
      path,
      provider: "copilot-cli",
      scope: "user",
      format: "json",
      payload: { mcpServers: { managed: { command: "machdoch-v1" } } },
    });
    await writeFile(
      path,
      `${JSON.stringify({ note: "keep", mcpServers: {} })}\n`,
      "utf8",
    );

    const reconciled = await installManagedTarget({
      path,
      provider: "copilot-cli",
      scope: "user",
      format: "json",
      payload: { mcpServers: { managed: { command: "machdoch-v2" } } },
      previous: first.record,
    });

    expect(reconciled.warnings).toContainEqual(
      expect.stringContaining("backed up"),
    );
    expect(await readFile(path, "utf8")).toContain("machdoch-v2");
  });

  it("blocks an unowned managed text region without changing the file", async () => {
    const root = await createRoot();
    const path = join(root, "config.toml");
    const original =
      "# user setting\n" +
      "# machdoch-managed:provider-enrollment:start\n" +
      "old = true\n" +
      "# machdoch-managed:provider-enrollment:end\n";
    await writeFile(path, original, "utf8");

    await expect(
      installManagedTarget({
        path,
        provider: "codex-cli",
        scope: "user",
        format: "toml",
        payload: "new = true",
      }),
    ).rejects.toThrow("unowned Machdoch-managed region");
    expect(await readFile(path, "utf8")).toBe(original);
  });

  it("blocks a duplicate unmanaged Codex MCP table", async () => {
    const root = await createRoot();
    const path = join(root, "config.toml");
    const original =
      'model = "gpt-5"\n\n[mcp_servers."machdoch server"]\ncommand = "user-command"\n';
    await writeFile(path, original, "utf8");

    await expect(
      installManagedTarget({
        path,
        provider: "codex-cli",
        scope: "user",
        format: "toml",
        payload:
          '[mcp_servers."machdoch server"]\ncommand = "machdoch-command"',
      }),
    ).rejects.toThrow("duplicate unmanaged Codex MCP table");
    expect(await readFile(path, "utf8")).toBe(original);
  });

  it("rejects oversized managed targets instead of reading them unbounded", async () => {
    const root = await createRoot();
    const path = join(root, "mcp.json");
    const handle = await open(path, "w");
    await handle.truncate(16 * 1024 * 1024 + 1);
    await handle.close();

    await expect(
      installManagedTarget({
        path,
        provider: "copilot-cli",
        scope: "user",
        format: "json",
        payload: { mcpServers: {} },
      }),
    ).rejects.toThrow("no larger than");
  });

  it.skipIf(process.platform === "win32")(
    "refuses to read or replace a managed-target symlink",
    async () => {
      const root = await createRoot();
      const target = join(root, "actual.json");
      const path = join(root, "mcp.json");
      await writeFile(
        target,
        JSON.stringify({ note: "must remain unchanged" }),
        "utf8",
      );
      await symlink(target, path, "file");

      await expect(
        installManagedTarget({
          path,
          provider: "copilot-cli",
          scope: "user",
          format: "json",
          payload: { mcpServers: { managed: { command: "machdoch" } } },
        }),
      ).rejects.toThrow("regular, unlinked file");
      expect(await readFile(target, "utf8")).toContain("must remain unchanged");
    },
  );

  it("rejects ownership metadata for a different target", async () => {
    const root = await createRoot();
    const firstPath = join(root, "first.json");
    const secondPath = join(root, "second.json");
    const installed = await installManagedTarget({
      path: firstPath,
      provider: "copilot-cli",
      scope: "user",
      format: "json",
      payload: { mcpServers: { managed: { command: "machdoch" } } },
    });

    await expect(
      installManagedTarget({
        path: secondPath,
        provider: "copilot-cli",
        scope: "user",
        format: "json",
        payload: { mcpServers: { replacement: { command: "machdoch" } } },
        previous: installed.record,
      }),
    ).rejects.toThrow("does not describe");
  });

  it("validates ownership manifests and rejects duplicate target authority", async () => {
    const root = await createRoot();
    const path = join(root, "ownership.json");
    const target = join(root, "mcp.json");
    const record = {
      path: target,
      provider: "copilot-cli",
      scope: "user" as const,
      format: "json" as const,
      managedDigest: "a".repeat(64),
      installedFileDigest: "b".repeat(64),
      createdFile: true,
      managedKeys: ["managed"],
      installedAt: new Date().toISOString(),
    };

    await expect(
      saveOwnershipManifest(path, {
        schemaVersion: 1,
        targets: [record, record],
      }),
    ).rejects.toThrow("duplicate ownership");
    await writeFile(
      path,
      JSON.stringify({ schemaVersion: 1, targets: [{ path: "relative" }] }),
      "utf8",
    );
    await expect(loadOwnershipManifest(path)).rejects.toThrow("malformed");
  });

  it("rejects a stale ownership-manifest commit without overwriting external state", async () => {
    const root = await createRoot();
    const path = join(root, "ownership.json");
    const initial = await saveOwnershipManifest(path, {
      schemaVersion: 1,
      targets: [],
    });
    const external = '{"schemaVersion":1,"targets":[],"external":true}\n';
    await writeFile(path, external, "utf8");

    await expect(
      saveOwnershipManifest(
        path,
        { schemaVersion: 1, targets: [] },
        { expectedTargetSnapshot: initial },
      ),
    ).rejects.toThrow("changed externally");
    expect(await readFile(path, "utf8")).toBe(external);
  });

  it("recovers an ownership checkpoint committed before an interrupted target write", async () => {
    const root = await createRoot();
    const path = join(root, "mcp.json");
    const ownershipPath = join(root, "ownership.json");

    await expect(
      installManagedTarget({
        path,
        provider: "copilot-cli",
        scope: "user",
        format: "json",
        payload: { mcpServers: { managed: { command: "machdoch" } } },
        beforeTargetCommit: async (record) => {
          await saveOwnershipManifest(
            ownershipPath,
            { schemaVersion: 1, targets: [record] },
            { expectedTargetSnapshot: undefined },
          );
          throw new Error("simulated interruption");
        },
      }),
    ).rejects.toThrow("simulated interruption");
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });

    const checkpoint = await loadOwnershipManifestSnapshot(ownershipPath);
    expect(checkpoint.manifest.targets).toHaveLength(1);
    const recovered = await installManagedTarget({
      path,
      provider: "copilot-cli",
      scope: "user",
      format: "json",
      payload: { mcpServers: { managed: { command: "machdoch" } } },
      previous: checkpoint.manifest.targets[0]!,
    });
    expect(recovered.record.createdFile).toBe(true);
    await expect(inspectManagedTarget(recovered.record)).resolves.toMatchObject({
      managedCurrent: true,
    });
  });
});
