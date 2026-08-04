import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const digests = vi.hoisted(() => ({
  canonical: "a".repeat(64),
  source: "b".repeat(64),
}));

vi.mock("./normalization.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./normalization.js")>();
  return {
    ...actual,
    canonicalDigest: () => digests.canonical,
    sha256: () => digests.source,
  };
});

import { createInstructionProfile, resolveInstructionSet } from "./index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

it("chooses a collision-free deterministic boundary without rewriting a body", async () => {
  const root = await mkdtemp(join(tmpdir(), "machdoch-envelope-boundary-"));
  const workspaceRoot = join(root, "workspace");
  const libraryPath = join(root, "instruction-library.json");
  const collidingBase = `machdoch-${digests.canonical.slice(0, 32)}`;
  const body = `The candidate boundary is ${collidingBase} and must remain exact.`;
  roots.push(root);
  await mkdir(workspaceRoot);
  await createInstructionProfile(
    { name: "Boundary collision", body, global: true },
    { path: libraryPath },
  );

  const resolution = await resolveInstructionSet(
    {
      workspaceRoot,
      providerId: "openai",
      surface: "api",
    },
    {
      libraryPath,
      now: new Date("2026-01-01T00:00:00.000Z"),
    },
  );

  expect(resolution.envelopeBoundary).toBe(
    `${collidingBase}-${digests.source.slice(0, 12)}`,
  );
  expect(resolution.bodyGroups[0]?.body).toBe(body);
  expect(body).not.toContain(resolution.envelopeBoundary);
  expect(resolution.renderedEnvelope).toContain(`${body}\n`);
});
