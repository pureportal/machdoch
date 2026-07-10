import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFlow } from "../__test__/ralph-test-helpers.ts";
import { readRalphFlow, writeRalphFlow } from "../ralph.ts";
import { createRalphFlowFingerprint } from "./create-ralph-flow-fingerprint.helper.ts";
import {
  createAvailableGeneratedFlowAlias,
  createGeneratedFlowAliasCandidate,
  isRalphFlowAliasCollisionError,
  writeGeneratedRalphFlowWithAliasFallback,
} from "./create-available-generated-flow-alias.helper.ts";

describe("createGeneratedFlowAliasCandidate", () => {
  it("preserves the base alias for the first candidate", () => {
    expect(createGeneratedFlowAliasCandidate("release-flow", 0)).toBe(
      "release-flow",
    );
  });

  it("trims trailing separators before adding a suffix inside the length limit", () => {
    const baseAlias = `${"a".repeat(79)}-`;

    expect(createGeneratedFlowAliasCandidate(baseAlias, 12)).toBe(
      `${"a".repeat(77)}-12`,
    );
  });
});

describe("isRalphFlowAliasCollisionError", () => {
  it("accepts the Ralph alias collision error shape only", () => {
    expect(
      isRalphFlowAliasCollisionError(
        new Error("Ralph flow alias `release` is already used by `existing`."),
      ),
    ).toBe(true);
    expect(isRalphFlowAliasCollisionError(new Error("other"))).toBe(false);
    expect(isRalphFlowAliasCollisionError(null)).toBe(false);
    expect(isRalphFlowAliasCollisionError(undefined)).toBe(false);
  });
});

describe("createAvailableGeneratedFlowAlias", () => {
  it("returns the preferred alias when only the current flow already owns it", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "ralph-alias-current-"));

    try {
      await writeRalphFlow(
        workspaceRoot,
        createFlow({ id: "current-flow", alias: "release" }),
      );

      await expect(
        createAvailableGeneratedFlowAlias(
          workspaceRoot,
          "workspace",
          "release",
          "current-flow",
        ),
      ).resolves.toBe("release");
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("suffixes aliases that are already used by another flow", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "ralph-alias-used-"));

    try {
      await writeRalphFlow(
        workspaceRoot,
        createFlow({ id: "existing-flow", alias: "release" }),
      );

      await expect(
        createAvailableGeneratedFlowAlias(
          workspaceRoot,
          "workspace",
          "release",
          "new-flow",
        ),
      ).resolves.toBe("release-1");
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("rejects empty and undefined preferred aliases", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "ralph-alias-invalid-"));

    try {
      await expect(
        createAvailableGeneratedFlowAlias(workspaceRoot, "workspace", "", "new-flow"),
      ).rejects.toThrow("Expected a Ralph flow alias before generation.");
      await expect(
        createAvailableGeneratedFlowAlias(
          workspaceRoot,
          "workspace",
          undefined as unknown as string,
          "new-flow",
        ),
      ).rejects.toThrow("Expected a Ralph flow alias before generation.");
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});

describe("writeGeneratedRalphFlowWithAliasFallback", () => {
  it("rejects a generated replacement when the persisted flow changed", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "ralph-generation-cas-"));

    try {
      const original = createFlow({ id: "current-flow", alias: "release" });
      await writeRalphFlow(workspaceRoot, original);
      await writeRalphFlow(workspaceRoot, {
        ...original,
        name: "Changed while generation was running",
      });

      await expect(
        writeGeneratedRalphFlowWithAliasFallback(
          workspaceRoot,
          { ...original, name: "Generated replacement" },
          {
            scope: "workspace",
            fallbackAliasBase: "release",
            allowAliasFallback: false,
            expectedFingerprint: createRalphFlowFingerprint(original),
          },
        ),
      ).rejects.toThrow("Ralph flow CAS conflict");
      await expect(readRalphFlow(workspaceRoot, original.id)).resolves.toMatchObject({
        name: "Changed while generation was running",
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("writes a generated flow with a fallback alias when the preferred alias collides", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "ralph-alias-fallback-"));

    try {
      await writeRalphFlow(
        workspaceRoot,
        createFlow({ id: "existing-flow", alias: "release" }),
      );

      const writtenFlow = await writeGeneratedRalphFlowWithAliasFallback(
        workspaceRoot,
        createFlow({ id: "new-flow", alias: "release" }),
        {
          scope: "workspace",
          fallbackAliasBase: "release",
          allowAliasFallback: true,
        },
      );

      expect(writtenFlow.alias).toBe("release-1");
      await expect(readRalphFlow(workspaceRoot, "new-flow")).resolves.toMatchObject({
        alias: "release-1",
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("rethrows alias collisions when fallback is disabled", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "ralph-alias-no-fallback-"));

    try {
      await writeRalphFlow(
        workspaceRoot,
        createFlow({ id: "existing-flow", alias: "release" }),
      );

      await expect(
        writeGeneratedRalphFlowWithAliasFallback(
          workspaceRoot,
          createFlow({ id: "new-flow", alias: "release" }),
          {
            scope: "workspace",
            fallbackAliasBase: "release",
            allowAliasFallback: false,
          },
        ),
      ).rejects.toThrow("Ralph flow alias `release` is already used by");
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});
