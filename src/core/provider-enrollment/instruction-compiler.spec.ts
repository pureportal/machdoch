import { describe, expect, it } from "vitest";
import type { DiscoveredInstruction, ResolvedTaskContext } from "../types.js";
import {
  compileInstructionBundle,
  compilePersistentInstructionBundle,
  createStableInstructionId,
} from "./instruction-compiler.js";

const createContext = (): ResolvedTaskContext => ({
  task: "implement provider sync",
  effectiveTask: "implement provider sync",
  taskContextText: "implement provider sync",
  instructionContextText: "implement provider sync",
  workspacePaths: [],
  suggestedTools: [],
  instructionAudience: "executor",
  applicableInstructions: [
    {
      id: "instruction-b",
      bodyHash: "same-body",
      kind: "conditional",
      name: "B",
      path: ".machdoch/instructions/b.instructions.md",
      priority: 1,
      body: "Use strict TypeScript.",
      reason: "keyword",
    },
    {
      id: "instruction-a",
      bodyHash: "same-body",
      kind: "always-on",
      name: "A",
      path: ".machdoch/instructions.md",
      priority: 10,
      body: "Use strict TypeScript.",
      reason: "always",
    },
  ],
});

describe("instruction compiler", () => {
  it("deduplicates exact bodies while preserving stable source ids", () => {
    const bundle = compileInstructionBundle(createContext());

    expect(bundle.sources).toHaveLength(1);
    expect(bundle.sources[0]?.sourceIds).toEqual([
      "instruction-a",
      "instruction-b",
    ]);
    expect(bundle.renderedText).toContain("Use strict TypeScript.");
    expect(bundle.digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(compileInstructionBundle(createContext()).digest).toBe(bundle.digest);
  });

  it("uses stable identities and reports automatic budget compaction", () => {
    expect(
      createStableInstructionId({ name: "Rules", path: "A\\B.md", scope: "workspace" }),
    ).toBe(
      createStableInstructionId({ name: "rules", path: "a/b.md", scope: "workspace" }),
    );

    const context = createContext();
    context.applicableInstructions = [{
      kind: "always-on",
      name: "Large",
      path: "large.md",
      priority: 1,
      body: "x".repeat(2_000),
      reason: "always",
    }];
    const bundle = compileInstructionBundle(context, [], { maxRenderedChars: 300 });
    expect(bundle.truncated).toBe(true);
    expect(bundle.warnings).not.toHaveLength(0);
    expect(bundle.renderedText.length).toBeLessThanOrEqual(300);
    expect(bundle.degradedSourceIds).toEqual([bundle.sources[0]?.id]);
    expect(bundle.omittedSources).toEqual([]);
  });

  it("normalizes line endings and Unicode before hashing", () => {
    const left = createContext();
    const right = createContext();
    left.applicableInstructions = [{
      kind: "always-on",
      name: "Unicode",
      path: "unicode.md",
      priority: 1,
      body: "cafe\u0301\r\nrule",
      reason: "always",
    }];
    right.applicableInstructions = [{
      ...left.applicableInstructions[0]!,
      body: "caf\u00e9\nrule",
    }];
    expect(compileInstructionBundle(left).digest).toBe(
      compileInstructionBundle(right).digest,
    );
  });

  it("renders unsupported persistent conditions as explicit baseline guards", () => {
    const instructions: DiscoveredInstruction[] = [{
      kind: "conditional",
      path: ".machdoch/instructions/react.instructions.md",
      name: "React",
      body: "Use accessible components.",
      keywords: ["react"],
      applyToPatterns: ["src/**/*.tsx"],
      audience: "executor",
      scope: "workspace",
    }];
    const bundle = compilePersistentInstructionBundle(instructions, "executor", {
      scope: "workspace",
    });
    expect(bundle.renderedText).toContain("mode=auto");
    expect(bundle.renderedText).toContain("audience=executor");
    expect(bundle.renderedText).toContain("applyTo=src/**/*.tsx");
    expect(bundle.renderedText).toContain("keywords=react");
  });
});
