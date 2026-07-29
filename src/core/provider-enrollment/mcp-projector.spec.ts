import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { projectMcpForProvider } from "./mcp-projector.js";

const roots: string[] = [];
const originalConfigDirectory = process.env.MACHDOCH_USER_CONFIG_DIR;

afterEach(async () => {
  if (originalConfigDirectory === undefined) delete process.env.MACHDOCH_USER_CONFIG_DIR;
  else process.env.MACHDOCH_USER_CONFIG_DIR = originalConfigDirectory;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("MCP projector", () => {
  it("uses direct native entries first and a named stdio proxy for field loss", async () => {
    const root = await mkdtemp(join(tmpdir(), "machdoch-projector-"));
    roots.push(root);
    process.env.MACHDOCH_USER_CONFIG_DIR = join(root, "user");
    const configDirectory = join(root, ".machdoch", "mcp");
    await mkdir(configDirectory, { recursive: true });
    await writeFile(
      join(configDirectory, "mcp.json"),
      JSON.stringify({
        schemaVersion: 1,
        servers: [
          { id: "direct", enabled: true, transport: { type: "stdio", command: "node", args: ["server.js"] } },
          { id: "legacy", enabled: true, transport: { type: "sse", url: "https://example.test/sse" } },
        ],
      }),
      "utf8",
    );
    const projection = await projectMcpForProvider("codex-cli", root, {
      machdochCommand: "machdoch-test",
    });
    expect(projection.servers.find((server) => server.canonicalId === "direct")?.route)
      .toBe("cli-native-mcp");
    const legacy = projection.servers.find((server) => server.canonicalId === "legacy");
    expect(legacy?.route).toBe("cli-stdio-proxy");
    expect(legacy?.providerConfig).toMatchObject({
      command: "machdoch-test",
      args: ["mcp", "proxy", "legacy", "--cwd", root],
    });
  });

  it("keeps workspace overrides out of the global user projection", async () => {
    const root = await mkdtemp(join(tmpdir(), "machdoch-projector-scope-"));
    roots.push(root);
    const userRoot = join(root, "user");
    const workspaceConfigRoot = join(root, ".machdoch", "mcp");
    process.env.MACHDOCH_USER_CONFIG_DIR = userRoot;
    await Promise.all([
      mkdir(userRoot, { recursive: true }),
      mkdir(workspaceConfigRoot, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(
        join(userRoot, "mcp.json"),
        JSON.stringify({
          schemaVersion: 1,
          servers: [
            {
              id: "shared",
              enabled: true,
              transport: { type: "stdio", command: "user-command" },
            },
          ],
        }),
        "utf8",
      ),
      writeFile(
        join(workspaceConfigRoot, "mcp.json"),
        JSON.stringify({
          schemaVersion: 1,
          servers: [
            {
              id: "shared",
              transport: { type: "stdio", command: "workspace-command" },
            },
          ],
        }),
        "utf8",
      ),
    ]);

    const userProjection = await projectMcpForProvider("codex-cli", root, {
      persistent: true,
      scope: "user",
    });
    const workspaceProjection = await projectMcpForProvider(
      "codex-cli",
      root,
      {
        persistent: true,
        scope: "workspace",
      },
    );

    expect(userProjection.servers).toHaveLength(1);
    expect(userProjection.servers[0]?.providerConfig).toMatchObject({
      command: "user-command",
    });
    expect(workspaceProjection.servers).toHaveLength(1);
    expect(workspaceProjection.servers[0]?.providerConfig).toMatchObject({
      command: "workspace-command",
    });
  });
});
