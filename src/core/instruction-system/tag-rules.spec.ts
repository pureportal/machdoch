import { describe, expect, it } from "vitest";
import {
  formatInstructionTagRule,
  instructionTagRuleMatches,
  normalizeInstructionTagRule,
  normalizeInstructionTags,
} from "./tag-rules.js";

describe("instruction tag rules", () => {
  it("matches nested case-insensitive AND and OR groups", () => {
    const rule = normalizeInstructionTagRule({
      op: "and",
      rules: [
        { op: "tag", tag: "NestJS" },
        {
          op: "or",
          rules: [
            { op: "tag", tag: "Node.js" },
            { op: "tag", tag: "Deno" },
          ],
        },
      ],
    });
    expect(instructionTagRuleMatches(rule, ["nestjs", "NODE.JS"])).toBe(true);
    expect(instructionTagRuleMatches(rule, ["NestJS", "Browser"])).toBe(false);
    expect(formatInstructionTagRule(rule)).toBe(
      "(NestJS AND (Node.js OR Deno))",
    );
  });

  it("normalizes and deduplicates flexible technology tags", () => {
    expect(
      normalizeInstructionTags(
        [" React ", "react", "C++", "Node   JS"],
        "workspace.tags",
      ),
    ).toEqual(["React", "C++", "Node JS"]);
  });

  it("rejects empty groups and excessive nesting", () => {
    expect(() => normalizeInstructionTagRule({ op: "and", rules: [] })).toThrow(
      /cannot be empty/u,
    );
    let nested: unknown = { op: "tag", tag: "Node.js" };
    for (let index = 0; index < 10; index += 1) {
      nested = { op: "and", rules: [nested] };
    }
    expect(() => normalizeInstructionTagRule(nested)).toThrow(/complexity/u);
  });
});
