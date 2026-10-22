import { describe, expect, it, vi } from "vitest";
import {
  assessMemoryApplicability,
  normalizeMemoryApplicability,
  type MemoryApplicability,
} from "./memory-applicability.js";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 22);
const memory = {
  kind: "fact",
  content: "Deploy the service with Kubernetes.",
  updatedAt: NOW - DAY,
  confidence: 0.8,
  scope: "workspace",
};

describe("normalizeMemoryApplicability", () => {
  it("omits absent and empty rules", () => {
    expect(normalizeMemoryApplicability(undefined)).toBeUndefined();
    expect(normalizeMemoryApplicability({})).toBeUndefined();
    expect(
      normalizeMemoryApplicability({
        taskTerms: [],
        excludedTaskTerms: [],
        enabled: undefined,
      }),
    ).toBeUndefined();
  });

  it("normalizes and deduplicates terms without mutating input", () => {
    const input = Object.freeze({
      taskTerms: Object.freeze(["  RÉSUMÉ  ", "re\u0301sume\u0301", "ＦＬＥＥＴ"]),
      excludedTaskTerms: Object.freeze(["  READ\n ONLY  ", "read only"]),
      expiresAt: NOW + DAY,
      verifiedAt: NOW,
      maxAgeDays: 0.5,
      enabled: false,
    });

    expect(normalizeMemoryApplicability(input)).toEqual({
      taskTerms: ["résumé", "fleet"],
      excludedTaskTerms: ["read only"],
      expiresAt: NOW + DAY,
      verifiedAt: NOW,
      maxAgeDays: 0.5,
      enabled: false,
    });
    expect(input.taskTerms[0]).toBe("  RÉSUMÉ  ");
  });

  it("preserves valid zero values and explicit enabling", () => {
    expect(
      normalizeMemoryApplicability({
        expiresAt: 0,
        verifiedAt: 0,
        maxAgeDays: 0,
        enabled: true,
      }),
    ).toEqual({
      expiresAt: 0,
      verifiedAt: 0,
      maxAgeDays: 0,
      enabled: true,
    });
  });

  it.each([
    { label: "null", value: null },
    { label: "array", value: [] },
    { label: "string", value: "enabled" },
    { label: "date", value: new Date(NOW) },
    { label: "unknown field", value: { enable: false } },
    { label: "unknown undefined field", value: { enable: undefined } },
    { label: "nonboolean enabling", value: { enabled: "false" } },
    { label: "null enabling", value: { enabled: null } },
    { label: "nonnumeric expiry", value: { expiresAt: String(NOW) } },
    { label: "negative expiry", value: { expiresAt: -1 } },
    { label: "invalid expiry", value: { expiresAt: NaN } },
    { label: "out-of-range expiry", value: { expiresAt: 8_640_000_000_000_001 } },
    { label: "infinite verification", value: { verifiedAt: Infinity } },
    { label: "negative verification", value: { verifiedAt: -1 } },
    { label: "negative age", value: { maxAgeDays: -0.1 } },
    { label: "infinite age", value: { maxAgeDays: Infinity } },
    { label: "invalid age", value: { maxAgeDays: NaN } },
    { label: "nonnumeric age", value: { maxAgeDays: "1" } },
    { label: "nonarray terms", value: { taskTerms: "deploy" } },
    { label: "null terms", value: { taskTerms: null } },
    { label: "empty term", value: { taskTerms: [""] } },
    { label: "blank term", value: { taskTerms: [" \n "] } },
    { label: "wildcard term", value: { taskTerms: [".*"] } },
    { label: "nonword normalized term", value: { taskTerms: ["\u037a"] } },
    { label: "nonstring term", value: { taskTerms: ["deploy", 1] } },
    { label: "sparse terms", value: { taskTerms: new Array(1) } },
    { label: "invalid exclusion", value: { excludedTaskTerms: [null] } },
    { label: "inherited rules", value: Object.create({ enabled: false }) },
    { label: "symbol field", value: { [Symbol("enabled")]: false } },
  ])("rejects $label", ({ value }) => {
    expect(() => normalizeMemoryApplicability(value)).toThrow(TypeError);
    expect(
      assessMemoryApplicability(
        { ...memory, applicability: value as MemoryApplicability },
        "Kubernetes",
        NOW,
      ),
    ).toEqual({ applicable: false, reasons: ["invalid-applicability"] });
  });
});

describe("assessMemoryApplicability", () => {
  it.each(["fact", "workaround", "decision", "preference", "unknown"])(
    "requires content relevance for an unconditioned %s",
    (kind) => {
      expect(
        assessMemoryApplicability({ ...memory, kind }, "Gardening", NOW),
      ).toEqual({ applicable: false, reasons: ["irrelevant-content"] });
      expect(
        assessMemoryApplicability({ ...memory, kind }, "KUBERNETES", NOW),
      ).toEqual({ applicable: true, reasons: ["relevant-content"] });
    },
  );

  it.each([undefined, {}, { enabled: true }, { excludedTaskTerms: ["billing"] }])(
    "does not treat permissive rules as evidence of relevance: %j",
    (applicability) => {
      expect(
        assessMemoryApplicability(
          { ...memory, ...(applicability !== undefined ? { applicability } : {}) },
          "Gardening",
          NOW,
        ).applicable,
      ).toBe(false);
    },
  );

  it("allows a general global preference even for an empty task", () => {
    expect(
      assessMemoryApplicability(
        { ...memory, kind: "preference", scope: "global" },
        "",
        NOW,
      ),
    ).toEqual({ applicable: true, reasons: ["global-preference"] });
  });

  it.each(["fact", "workaround", "decision"])(
    "requires relevance for a global %s",
    (kind) => {
      expect(
        assessMemoryApplicability(
          { ...memory, kind, scope: "global" },
          "Gardening",
          NOW,
        ).applicable,
      ).toBe(false);
    },
  );

  it("does not infer global scope when it is missing", () => {
    const { scope: _scope, ...unscopedMemory } = memory;
    expect(
      assessMemoryApplicability(
        { ...unscopedMemory, kind: "preference" },
        "Gardening",
        NOW,
      ).applicable,
    ).toBe(false);
  });

  it.each(["", "  ", "What is the?", "KubernetesBackup"])(
    "rejects empty, stop-word-only, or partial-word relevance: %j",
    (query) => {
      expect(assessMemoryApplicability(memory, query, NOW).applicable).toBe(false);
    },
  );

  it("matches Unicode content words with canonical normalization", () => {
    expect(
      assessMemoryApplicability(
        { ...memory, content: "Résumé 日本語", applicability: {} },
        "RE\u0301SUME\u0301",
        NOW,
      ).applicable,
    ).toBe(true);
  });

  it("requires every positive condition and accepts matched conditions as relevance", () => {
    const entry = {
      ...memory,
      applicability: { taskTerms: ["React", "TypeScript"] },
    };

    expect(assessMemoryApplicability(entry, "React app", NOW)).toEqual({
      applicable: false,
      reasons: ["unmatched-task-terms"],
    });
    expect(
      assessMemoryApplicability(entry, "A REACT app with TYPESCRIPT", NOW),
    ).toEqual({ applicable: true, reasons: ["matched-task-terms"] });
  });

  it.each([
    { term: "RÉSUMÉ", query: "Use re\u0301sume\u0301", applicable: true },
    { term: "МОСКВА", query: "Погода: москва", applicable: true },
    { term: "ＦＬＥＥＴ", query: "fleet", applicable: true },
    { term: "日本語", query: "日本語", applicable: true },
    { term: "read only", query: "A READ\n\tONLY task", applicable: true },
    { term: "C++", query: "Use C++.", applicable: true },
    { term: "react|vue", query: "react", applicable: false },
    { term: "react|vue", query: "react|vue", applicable: true },
    { term: "a.*", query: "anything", applicable: false },
    { term: "a.*", query: "Use a.* literally", applicable: true },
    { term: "react", query: "reactive react", applicable: true },
    { term: "react", query: "reactive", applicable: false },
    { term: "react", query: "preact", applicable: false },
    { term: "react", query: "my_react", applicable: false },
    { term: "react", query: "react𐐀", applicable: false },
    { term: "react", query: "𐐀react", applicable: false },
    { term: "react", query: "react\u0301", applicable: false },
  ])("matches literal word terms: $term / $query", ({ term, query, applicable }) => {
    expect(
      assessMemoryApplicability(
        { ...memory, applicability: { taskTerms: [term] } },
        query,
        NOW,
      ).applicable,
    ).toBe(applicable);
  });

  it("lets any exclusion override matched conditions and global preferences", () => {
    expect(
      assessMemoryApplicability(
        {
          ...memory,
          kind: "preference",
          scope: "global",
          applicability: {
            taskTerms: ["Kubernetes"],
            excludedTaskTerms: ["billing", "READ ONLY"],
          },
        },
        "Kubernetes in read only mode",
        NOW,
      ),
    ).toEqual({ applicable: false, reasons: ["excluded-task-term"] });
  });

  it("does not match exclusions inside longer words", () => {
    expect(
      assessMemoryApplicability(
        {
          ...memory,
          applicability: { excludedTaskTerms: ["react"] },
        },
        "Kubernetes reactive service",
        NOW,
      ).applicable,
    ).toBe(true);
  });

  it("collects independent rejection reasons", () => {
    expect(
      assessMemoryApplicability(
        {
          ...memory,
          updatedAt: NOW - 2 * DAY,
          applicability: {
            enabled: false,
            expiresAt: NOW,
            maxAgeDays: 1,
            taskTerms: ["billing"],
            excludedTaskTerms: ["Kubernetes"],
          },
        },
        "Kubernetes",
        NOW,
      ),
    ).toEqual({
      applicable: false,
      reasons: [
        "disabled",
        "expired",
        "too-old",
        "unmatched-task-terms",
        "excluded-task-term",
      ],
    });
  });

  it.each([
    { expiresAt: NOW - 1, applicable: false },
    { expiresAt: NOW, applicable: false },
    { expiresAt: NOW + 1, applicable: true },
  ])("checks the expiration boundary: $expiresAt", ({ expiresAt, applicable }) => {
    expect(
      assessMemoryApplicability(
        { ...memory, applicability: { expiresAt } },
        "Kubernetes",
        NOW,
      ).applicable,
    ).toBe(applicable);
  });

  it.each([
    { updatedAt: NOW - DAY - 1, applicable: false },
    { updatedAt: NOW - DAY, applicable: true },
    { updatedAt: NOW - DAY + 1, applicable: true },
  ])("checks the age boundary: $updatedAt", ({ updatedAt, applicable }) => {
    expect(
      assessMemoryApplicability(
        { ...memory, updatedAt, applicability: { maxAgeDays: 1 } },
        "Kubernetes",
        NOW,
      ).applicable,
    ).toBe(applicable);
  });

  it("uses verification time rather than an edit to determine evidence age", () => {
    expect(
      assessMemoryApplicability(
        {
          ...memory,
          updatedAt: NOW,
          applicability: { verifiedAt: NOW - 2 * DAY, maxAgeDays: 1 },
        },
        "Kubernetes",
        NOW,
      ),
    ).toEqual({ applicable: false, reasons: ["too-old"] });
    expect(
      assessMemoryApplicability(
        {
          ...memory,
          updatedAt: NOW - 100 * DAY,
          applicability: { verifiedAt: NOW, maxAgeDays: 1 },
        },
        "Kubernetes",
        NOW,
      ).applicable,
    ).toBe(true);
  });

  it("supports zero-day and fractional-day age limits", () => {
    expect(
      assessMemoryApplicability(
        { ...memory, updatedAt: NOW, applicability: { maxAgeDays: 0 } },
        "Kubernetes",
        NOW,
      ).applicable,
    ).toBe(true);
    expect(
      assessMemoryApplicability(
        { ...memory, updatedAt: NOW - 1, applicability: { maxAgeDays: 0 } },
        "Kubernetes",
        NOW,
      ).reasons,
    ).toContain("too-old");
    expect(
      assessMemoryApplicability(
        { ...memory, updatedAt: NOW - DAY / 2, applicability: { maxAgeDays: 0.5 } },
        "Kubernetes",
        NOW,
      ).applicable,
    ).toBe(true);
  });

  it("does not impose an implicit maximum age", () => {
    expect(
      assessMemoryApplicability(
        { ...memory, updatedAt: NOW - 1_000 * DAY },
        "Kubernetes",
        NOW,
      ).applicable,
    ).toBe(true);
  });

  it.each([
    { updatedAt: NOW + 1 },
    { applicability: { verifiedAt: NOW + 1 } },
  ])("rejects evidence from the future: %j", (overrides) => {
    expect(
      assessMemoryApplicability({ ...memory, ...overrides }, "Kubernetes", NOW),
    ).toEqual({ applicable: false, reasons: ["future-evidence"] });
  });

  it.each([NaN, Infinity, -1, 8_640_000_000_000_001])(
    "rejects invalid evaluation or update timestamps: %j",
    (timestamp) => {
      expect(
        assessMemoryApplicability(memory, "Kubernetes", timestamp).reasons,
      ).toContain("invalid-timestamp");
      expect(
        assessMemoryApplicability(
          { ...memory, updatedAt: timestamp },
          "Kubernetes",
          NOW,
        ).reasons,
      ).toContain("invalid-timestamp");
    },
  );

  it.each([NaN, Infinity, -0.1, 1.1])(
    "rejects invalid confidence: %j",
    (confidence) => {
      expect(
        assessMemoryApplicability({ ...memory, confidence }, "Kubernetes", NOW),
      ).toEqual({ applicable: false, reasons: ["invalid-confidence"] });
    },
  );

  it("rejects zero confidence without imposing an arbitrary positive threshold", () => {
    expect(
      assessMemoryApplicability(
        { ...memory, confidence: 0 },
        "Kubernetes",
        NOW,
      ),
    ).toEqual({ applicable: false, reasons: ["no-confidence"] });
    expect(
      assessMemoryApplicability(
        { ...memory, confidence: 0.01 },
        "Kubernetes",
        NOW,
      ).applicable,
    ).toBe(true);
  });

  it("uses the current time when the caller omits it", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(NOW);

    try {
      expect(
        assessMemoryApplicability(
          { ...memory, applicability: { expiresAt: NOW } },
          "Kubernetes",
        ),
      ).toEqual({ applicable: false, reasons: ["expired"] });
    } finally {
      clock.mockRestore();
    }
  });
});
