import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeRalphWatchInput } from "./normalize-ralph-watch-input.helper.ts";
import type { RalphWatchInput } from "../ralph-watches.ts";

const createWatchInput = (rootPath: string): RalphWatchInput => ({
  id: "  Nightly Import! ",
  name: "  Nightly import  ",
  flow: { scope: "workspace", id: "Flow One" },
  roots: [{ path: rootPath, include: ["src/**"], exclude: ["**/*.tmp"] }],
  params: { mode: "dry-run" },
  permissions: {
    allowCommands: true,
    allowWrites: false,
    allowNetwork: true,
  },
});

describe("normalizeRalphWatchInput", () => {
  it("normalizes valid watch input with defaults and merged excludes", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "machdoch-watch-"));
    const normalized = await normalizeRalphWatchInput(createWatchInput(rootPath));
    const normalizedRootPath = normalized.roots[0]?.path;

    expect(normalized).toMatchObject({
      id: "nightly-import",
      enabled: true,
      name: "Nightly import",
      flow: { scope: "workspace", id: "flow-one" },
      executionWorkspaceRoot: normalizedRootPath,
      events: ["created", "changed"],
      params: { mode: "dry-run" },
      permissions: {
        allowedRoots: [normalizedRootPath],
        allowCommands: true,
        allowWrites: false,
        allowNetwork: true,
        allowMcpTools: false,
      },
      debounceMs: 1_000,
      stabilityMs: 300,
      pollIntervalMs: 5_000,
      maxEventsPerWindow: {
        maxEvents: 100,
        windowMs: 60_000,
      },
      concurrencyLimit: 1,
    });
    expect(normalized.roots[0]).toMatchObject({
      path: normalizedRootPath,
      include: ["src/**"],
    });
    expect(normalized.roots[0]?.exclude).toEqual(
      expect.arrayContaining(["node_modules/**", "**/*.tmp"]),
    );
  });

  it("retains existing values and overrides supplied fields", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "machdoch-watch-"));
    const existing = await normalizeRalphWatchInput({
      ...createWatchInput(rootPath),
      id: "existing-watch",
      params: { old: "value" },
      maxTransitions: 4,
    });
    const normalized = await normalizeRalphWatchInput(
      {
        flow: { id: "Flow Two" },
        roots: [{ path: rootPath }],
        params: { next: "value" },
        debounceMs: 2_500,
      },
      existing,
    );

    expect(normalized).toMatchObject({
      id: "existing-watch",
      flow: { scope: "workspace", id: "flow-two" },
      params: { old: "value", next: "value" },
      debounceMs: 2_500,
      maxTransitions: 4,
      createdAt: existing.createdAt,
    });
  });

  it.each([
    ["relative root", { roots: [{ path: "relative" }] }],
    ["empty roots", { roots: [] }],
    ["invalid maxTransitions", { maxTransitions: 0 }],
  ])("rejects invalid input: %s", async (_label, override) => {
    await expect(
      normalizeRalphWatchInput({
        flow: { id: "flow" },
        ...override,
      } as RalphWatchInput),
    ).rejects.toThrow();
  });

  it("rejects allowed roots outside the watched roots", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "machdoch-watch-"));
    const outsidePath = await mkdtemp(join(tmpdir(), "machdoch-outside-"));

    await expect(
      normalizeRalphWatchInput({
        ...createWatchInput(rootPath),
        permissions: { allowedRoots: [outsidePath] },
      }),
    ).rejects.toThrow(/outside the watched roots/u);
  });
});
