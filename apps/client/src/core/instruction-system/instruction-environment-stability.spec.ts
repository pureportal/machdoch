import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createInstructionDeliveryPlan } from "./delivery.js";
import {
  adaptFrozenInstructionSet,
  resolveInstructionSet,
} from "./resolver.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
}, 30_000);

const createFixture = async () => {
  const root = await mkdtemp(
    join(tmpdir(), "machdoch-instruction-environment-"),
  );
  roots.push(root);
  const workspaceRoot = join(root, "workspace");
  await mkdir(join(workspaceRoot, ".codex"), { recursive: true });
  return { root, workspaceRoot, libraryPath: join(root, "library.json") };
};

describe("instruction environment stability", () => {
  it("keeps fresh and adapted delivery identities stable when suppressed configuration grows", async () => {
    const fixture = await createFixture();
    const configPath = join(fixture.workspaceRoot, ".codex", "config.toml");
    await writeFile(configPath, 'model = "first"\n');
    const input = {
      workspaceRoot: fixture.workspaceRoot,
      providerId: "codex-cli" as const,
      surface: "cli" as const,
      model: "gpt-5.5",
    };
    const before = await resolveInstructionSet(input, {
      libraryPath: fixture.libraryPath,
    });
    const adaptedBefore = await adaptFrozenInstructionSet(before, {
      ...input,
      model: "gpt-5.4",
    });
    await writeFile(
      configPath,
      'model = "first"\n# suppressed settings changed\n',
    );
    const after = await resolveInstructionSet(input, {
      libraryPath: fixture.libraryPath,
    });
    const adaptedAfter = await adaptFrozenInstructionSet(before, {
      ...input,
      model: "gpt-5.4",
    });
    const config = (resolution: typeof before) =>
      resolution.nativeInventory.find(
        (record) => record.convention === "codex-project-configuration",
      );

    expect(config(before)?.status).toBe("suppressed");
    expect(config(after)?.byteLength).toBeGreaterThan(
      config(before)!.byteLength!,
    );
    expect(after.canonicalDigest).toBe(before.canonicalDigest);
    expect(after.environmentDigest).toBe(before.environmentDigest);
    expect(createInstructionDeliveryPlan(after).planId).toBe(
      createInstructionDeliveryPlan(before).planId,
    );
    expect(adaptedAfter.environmentDigest).toBe(
      adaptedBefore.environmentDigest,
    );
    expect(createInstructionDeliveryPlan(adaptedAfter).planId).toBe(
      createInstructionDeliveryPlan(adaptedBefore).planId,
    );
  }, 60_000);

  it("detects changed content in native instructions that remain active", async () => {
    const fixture = await createFixture();
    const nativePath = join(fixture.workspaceRoot, "CLAUDE.md");
    await writeFile(nativePath, "First native policy.\n");
    const input = {
      workspaceRoot: fixture.workspaceRoot,
      providerId: "claude-cli" as const,
      surface: "cli" as const,
    };
    const before = await resolveInstructionSet(input, {
      libraryPath: fixture.libraryPath,
    });
    await writeFile(nativePath, "Other native policy.\n");
    const after = await resolveInstructionSet(input, {
      libraryPath: fixture.libraryPath,
    });

    expect(after.canonicalDigest).toBe(before.canonicalDigest);
    expect(after.environmentDigest).not.toBe(before.environmentDigest);
  }, 60_000);
});
