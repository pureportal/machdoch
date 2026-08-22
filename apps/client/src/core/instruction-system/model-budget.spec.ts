import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("../model-capabilities.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../model-capabilities.js")>();
  return {
    ...actual,
    getModelContextWindowTokens: (_provider: string, model: string) =>
      model === "fixture-mcp-context" ? 20_000 : 16_500,
  };
});

import {
  adaptFrozenInstructionSet,
  assertInstructionInvocationBudget,
  createInstructionDeliveryPlan,
  createInstructionProfile,
  resolveInstructionSet,
} from "./index.js";
import { createInstructionResolutionFixture } from "../__test__/instruction-test-helpers.js";
import { createInstructionDeliveryPlanForRuntime } from "../provider-enrollment/instruction-delivery-preflight.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

it("blocks a verified model-specific shortfall before the core byte limit", async () => {
  const root = await mkdtemp(join(tmpdir(), "machdoch-model-budget-"));
  const workspaceRoot = join(root, "workspace");
  const libraryPath = join(root, "instruction-library.json");
  roots.push(root);
  await mkdir(workspaceRoot);
  await createInstructionProfile(
    {
      name: "Within core limit",
      body: "x".repeat(4_096),
      global: true,
    },
    { path: libraryPath },
  );

  await expect(
    resolveInstructionSet(
      {
        workspaceRoot,
        providerId: "openai",
        surface: "api",
        model: "fixture-small-context",
      },
      {
        libraryPath,
      },
    ),
  ).rejects.toMatchObject({
    code: "INSTRUCTION_INPUT_BUDGET_EXCEEDED",
    diagnostics: [
      expect.objectContaining({
        code: "INSTRUCTION_INPUT_BUDGET_EXCEEDED",
        details: expect.objectContaining({
          providerLimitTokens: 16_500,
          providerReserveTokens: 16_384,
          availableInstructionTokens: 116,
          truncation: "none",
        }),
      }),
    ],
  });
});

it("includes frozen MCP initialization hints in provider/model preflight", async () => {
  const root = await mkdtemp(join(tmpdir(), "machdoch-model-budget-"));
  const workspaceRoot = join(root, "workspace");
  const mcpRoot = join(workspaceRoot, ".machdoch", "mcp");
  roots.push(root);
  await mkdir(mcpRoot, { recursive: true });
  await writeFile(
    join(mcpRoot, "mcp.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      servers: [
        {
          id: "fixture",
          enabled: true,
          transport: {
            type: "streamable-http",
            url: "https://example.com/mcp",
          },
        },
      ],
    })}\n`,
    "utf8",
  );
  const input = {
    workspaceRoot,
    providerId: "openai" as const,
    surface: "api" as const,
    model: "fixture-mcp-context",
  };
  const options = {
    libraryPath: join(root, "instruction-library.json"),
  };
  const withoutHint = await resolveInstructionSet(input, options);
  expect(withoutHint.budget.blockingErrors).toEqual([]);

  await writeFile(
    join(mcpRoot, "discovery-cache.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      servers: {
        fixture: {
          serverId: "fixture",
          discoveredAt: "2026-01-01T00:00:00.000Z",
          transportType: "streamable-http",
          instructions: "x".repeat(3_500),
          tools: [],
          resources: [],
          resourceTemplates: [],
          prompts: [],
        },
      },
    })}\n`,
    "utf8",
  );

  await expect(resolveInstructionSet(input, options)).rejects.toMatchObject({
    code: "INSTRUCTION_INPUT_BUDGET_EXCEEDED",
    diagnostics: [
      expect.objectContaining({
        details: expect.objectContaining({
          runtimeSupplementBytes: expect.any(Number),
          estimatedRuntimeSupplementTokens: expect.any(Number),
        }),
      }),
    ],
  });
});

it("replans a frozen set for a provider/model switch and blocks an incapable surface", async () => {
  const root = await mkdtemp(join(tmpdir(), "machdoch-model-switch-"));
  const workspaceRoot = join(root, "workspace");
  const libraryPath = join(root, "instruction-library.json");
  roots.push(root);
  await mkdir(workspaceRoot);
  await createInstructionProfile(
    {
      name: "Frozen switch",
      body: `${"line\n".repeat(201)}${"x".repeat(4_096)}`,
      global: true,
    },
    { path: libraryPath },
  );
  const initial = await resolveInstructionSet(
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

  const adapted = await adaptFrozenInstructionSet(initial, {
    workspaceRoot,
    providerId: "openai",
    surface: "api",
    model: "fixture-small-context",
  });
  const plan = createInstructionDeliveryPlan(adapted);

  expect(adapted.canonicalDigest).toBe(initial.canonicalDigest);
  expect(adapted.selectedSources).toEqual(initial.selectedSources);
  expect(adapted.environmentDigest).not.toBe(initial.environmentDigest);
  expect(adapted.budget.blockingErrors).not.toEqual([]);
  expect(
    adapted.diagnostics.filter(
      (diagnostic) => diagnostic.code === "LONG_INSTRUCTION_SOURCE",
    ),
  ).toHaveLength(1);
  expect(plan).toMatchObject({
    grade: "unsupported",
    canonicalDigest: initial.canonicalDigest,
  });
  expect(plan.blockingReasons.join(" ")).toContain("Only 116 tokens remain");
});

it("rechecks growing continuation context and blocks before invocation", () => {
  const base = createInstructionResolutionFixture({
    providerId: "openai",
    surface: "api",
    model: "fixture-growing-context",
  });
  const fixture = {
    ...base,
    budget: {
      ...base.budget,
      providerLimitTokens: 20_000,
      providerReserveTokens: 16_384,
      availableInstructionTokens: 3_616,
    },
  };

  expect(() =>
    assertInstructionInvocationBudget(fixture, {
      phase: "continuation",
      assembledRequestBytes: fixture.budget.envelopeBytes + 5_000,
    }),
  ).toThrowError(
    /continuation request needs.*provider was not invoked.*not truncated/su,
  );
});

it("does not claim subagent instruction inheritance for the OpenAI multi-agent beta", async () => {
  const resolution = createInstructionResolutionFixture({
    providerId: "openai",
    surface: "api",
    model: "gpt-5.6-sol",
  });

  const plan = await createInstructionDeliveryPlanForRuntime(resolution, {
    workspaceRoot: process.cwd(),
    reasoning: "ultra",
  });

  expect(plan.grade).toBe("compatible");
  expect(plan.capability.lifecycle.subagents).toBe("unknown");
  expect(
    plan.dimensions.find((dimension) => dimension.name === "subagents"),
  ).toMatchObject({ status: "compatible" });
});
