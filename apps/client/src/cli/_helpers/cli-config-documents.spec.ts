import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadConfigDocument,
  loadConfigDocumentEntries,
  saveConfigDocument,
} from "./cli-config-documents.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "machdoch-config-documents-"));
  vi.stubEnv("MACHDOCH_USER_CONFIG_DIR", join(root, "user"));
  const document = await loadConfigDocument(root, "workspace.mcp");
  await mkdir(dirname(document.path), { recursive: true });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe("configuration documents", () => {
  it("opens a canonical empty MCP configuration", async () => {
    const document = await loadConfigDocument(root, "workspace.mcp");
    await writeFile(document.path, '{"schemaVersion":1}');
    const entries = await loadConfigDocumentEntries(root);
    expect(
      entries.find((entry) => entry.setting === "workspace.mcp"),
    ).toMatchObject({ value: "0 connections", source: "saved" });
  });

  it("rejects invalid servers without overwriting existing settings", async () => {
    const document = await loadConfigDocument(root, "workspace.mcp");
    await expect(
      saveConfigDocument(
        root,
        "workspace.mcp",
        '{"schemaVersion":1,"servers":[{}]}',
      ),
    ).rejects.toThrow("invalid");
    expect((await loadConfigDocument(root, "workspace.mcp")).storedRaw).toBe(
      document.storedRaw,
    );
  });

  it("protects settings changed while the editor was open", async () => {
    const expected = await loadConfigDocument(root, "workspace.mcp");
    await writeFile(expected.path, '{"schemaVersion":1,"servers":[]}');
    await expect(
      saveConfigDocument(
        root,
        "workspace.mcp",
        '{"schemaVersion":1}',
        expected,
      ),
    ).rejects.toThrow("changed while");
    expect(await readFile(expected.path, "utf8")).toBe(
      '{"schemaVersion":1,"servers":[]}',
    );
  });

  it("keeps malformed documents accessible for repair", async () => {
    const document = await loadConfigDocument(root, "workspace.mcp");
    await writeFile(document.path, "invalid json");
    expect(
      (await loadConfigDocumentEntries(root)).find(
        (entry) => entry.setting === "workspace.mcp",
      ),
    ).toMatchObject({ source: "invalid" });
  });
});
