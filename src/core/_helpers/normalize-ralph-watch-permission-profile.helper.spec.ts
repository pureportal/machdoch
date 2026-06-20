import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeRalphWatchPermissionProfile } from "./normalize-ralph-watch-permission-profile.helper.ts";
import type { RalphWatchInput, RalphWatchRoot } from "../ralph-watches.ts";

const createInput = (root: string): RalphWatchInput => ({
  flow: { id: "flow" },
  roots: [{ path: root }],
});

describe("normalizeRalphWatchPermissionProfile", () => {
  it("defaults allowed roots to watch roots and disables privileged capabilities", async () => {
    const root = await mkdtemp(join(tmpdir(), "machdoch-watch-root-"));
    const canonicalRoot = await realpath(root);
    const roots: RalphWatchRoot[] = [
      { path: canonicalRoot, include: [], exclude: [] },
    ];

    await expect(
      normalizeRalphWatchPermissionProfile(createInput(root), roots),
    ).resolves.toEqual({
      allowedRoots: [canonicalRoot],
      allowCommands: false,
      allowWrites: false,
      allowNetwork: false,
      allowMcpTools: false,
    });
  });

  it("deduplicates allowed roots and preserves explicit permission flags", async () => {
    const root = await mkdtemp(join(tmpdir(), "machdoch-watch-root-"));
    const canonicalRoot = await realpath(root);
    const roots: RalphWatchRoot[] = [
      { path: canonicalRoot, include: [], exclude: [] },
    ];

    await expect(
      normalizeRalphWatchPermissionProfile(
        {
          ...createInput(root),
          permissions: {
            allowedRoots: [root, root],
            allowCommands: true,
            allowWrites: true,
            allowNetwork: true,
            allowMcpTools: true,
          },
        },
        roots,
      ),
    ).resolves.toMatchObject({
      allowedRoots: [canonicalRoot],
      allowCommands: true,
      allowWrites: true,
      allowNetwork: true,
      allowMcpTools: true,
    });
  });

  it("rejects allowed roots outside watched roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "machdoch-watch-root-"));
    const outsideRoot = await mkdtemp(join(tmpdir(), "machdoch-outside-root-"));
    const canonicalRoot = await realpath(root);
    const roots: RalphWatchRoot[] = [
      { path: canonicalRoot, include: [], exclude: [] },
    ];

    await expect(
      normalizeRalphWatchPermissionProfile(
        {
          ...createInput(root),
          permissions: { allowedRoots: [outsideRoot] },
        },
        roots,
      ),
    ).rejects.toThrow(/outside the watched roots/u);
  });
});
