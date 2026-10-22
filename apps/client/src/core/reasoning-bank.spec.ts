import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLocalReasoningBank,
  getReasoningBankPath,
  retrieveReasoningLessons,
  type ReasoningLessonCandidate,
} from "./reasoning-bank.js";

const roots: string[] = [];
const DAY_MILLISECONDS = 86_400_000;
const invalidApplicabilities: unknown[] = [
  null,
  { taskTerms: "schema" },
  { excludedTaskTerms: [" "] },
  { maxAgeDays: -1 },
  { verifiedAt: -1 },
  { enabled: "yes" },
  { unknownRule: true },
];

const createWorkspace = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "machdoch-reasoning-bank-"));
  roots.push(root);
  return root;
};

const lesson = (
  overrides: Partial<ReasoningLessonCandidate> = {},
): ReasoningLessonCandidate => ({
  title: "Verify generated contracts after schema changes",
  description:
    "When a runtime schema changes, regenerate bindings before tests.",
  content:
    "After editing the runtime schema, regenerate TypeScript and Rust contracts before running verification because stale bindings can hide integration errors.",
  triggerTerms: ["runtime schema", "generated bindings"],
  outcome: "success",
  confidence: 0.8,
  ...overrides,
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("local ReasoningBank", () => {
  it("persists, consolidates, and retrieves a transferable lesson", async () => {
    const root = await createWorkspace();
    const bank = createLocalReasoningBank(root);
    const [first] = await bank.consolidate([lesson()]);
    expect(first).toBeDefined();

    const [second] = await bank.consolidate([
      lesson({ confidence: 0.9, triggerTerms: ["schema", "bindings"] }),
    ]);
    expect(second?.id).toBe(first?.id);
    expect(second?.evidenceCount).toBe(2);
    expect(second?.triggerTerms).toContain("bindings");

    const reloaded = await createLocalReasoningBank(root).load();
    expect(reloaded).toHaveLength(1);
    expect(
      retrieveReasoningLessons(
        "Update the runtime schema and bindings",
        reloaded,
      ),
    ).toHaveLength(1);
    expect(retrieveReasoningLessons("Paint a landscape", reloaded)).toEqual([]);
  });

  it("normalizes applicability on write and read and preserves it on disk", async () => {
    const root = await createWorkspace();
    const bank = createLocalReasoningBank(root);
    const now = Date.now();
    const applicability = {
      taskTerms: [" Runtime   Schema ", "runtime schema"],
      excludedTaskTerms: [" Prototype "],
      maxAgeDays: 7,
      verifiedAt: now - 1_000,
      expiresAt: now + DAY_MILLISECONDS,
      enabled: true,
    };
    const expected = {
      ...applicability,
      taskTerms: ["runtime schema"],
      excludedTaskTerms: ["prototype"],
    };
    const [stored] = await bank.consolidate([lesson({ applicability })]);
    expect(stored?.applicability).toEqual(expected);
    const path = getReasoningBankPath(root);
    const document = JSON.parse(await readFile(path, "utf8"));
    expect(document.lessons[0].applicability).toEqual(expected);
    expect(await createLocalReasoningBank(root).load()).toEqual([stored]);

    document.lessons[0].applicability = applicability;
    await writeFile(path, JSON.stringify(document));
    expect((await bank.load())[0]?.applicability).toEqual(expected);
  });

  it("rejects invalid applicability without changing persisted lessons", async () => {
    const root = await createWorkspace();
    const bank = createLocalReasoningBank(root);
    await bank.consolidate([lesson()]);
    const path = getReasoningBankPath(root);
    const before = await readFile(path, "utf8");

    for (const applicability of invalidApplicabilities) {
      await expect(
        bank.consolidate([
          lesson({ title: "A valid candidate must not be partially persisted" }),
          lesson({
            applicability: applicability as ReasoningLessonCandidate["applicability"],
          }),
        ]),
      ).rejects.toThrow("Invalid ReasoningBank lesson candidate");
      expect(await readFile(path, "utf8")).toBe(before);
    }
  });

  it("rejects malformed applicability in persisted lessons", async () => {
    const root = await createWorkspace();
    const bank = createLocalReasoningBank(root);
    const [stored] = await bank.consolidate([lesson()]);
    const path = getReasoningBankPath(root);

    for (const applicability of invalidApplicabilities) {
      await writeFile(
        path,
        JSON.stringify({
          version: 1,
          lessons: [{ ...stored, applicability }],
        }),
      );
      await expect(bank.load()).rejects.toThrow(
        "Unsupported ReasoningBank document",
      );
    }
  });

  it("gates task conditions, exclusions, expiration and disabled lessons before ranking", async () => {
    const root = await createWorkspace();
    const [stored] = await createLocalReasoningBank(root).consolidate([lesson()]);
    const now = Date.now();
    const query = "Update the runtime schema and generated bindings";
    const rules = [
      { taskTerms: ["schema", "rust"] },
      { excludedTaskTerms: ["bindings"] },
      { expiresAt: now - 1 },
      { maxAgeDays: 1, verifiedAt: now - 2 * DAY_MILLISECONDS },
      { enabled: false },
    ];
    const highlyRated = { ...stored!, confidence: 1, helpfulCount: 100 };
    expect(retrieveReasoningLessons(query, [highlyRated])).toHaveLength(1);

    for (const applicability of rules) {
      expect(
        retrieveReasoningLessons(query, [{ ...highlyRated, applicability }]),
      ).toEqual([]);
    }
    expect(
      retrieveReasoningLessons(query, [
        {
          ...highlyRated,
          applicability: {
            taskTerms: ["runtime schema", "bindings"],
            excludedTaskTerms: ["prototype"],
          },
        },
      ]),
    ).toHaveLength(1);
  });

  it("keeps durable lessons eligible and treats trigger terms as search aliases", async () => {
    const root = await createWorkspace();
    const [stored] = await createLocalReasoningBank(root).consolidate([
      lesson({
        triggerTerms: ["contract synchronization", "schema migration"],
        applicability: { verifiedAt: Date.now() - 3_650 * DAY_MILLISECONDS },
      }),
    ]);
    expect(
      retrieveReasoningLessons("contract synchronization", [stored!]),
    ).toHaveLength(1);
    expect(retrieveReasoningLessons("Paint a landscape", [stored!])).toEqual([]);
    expect(stored?.applicability?.maxAgeDays).toBeUndefined();
  });

  it("preserves the evidence date and age rule through repeated lessons and feedback", async () => {
    const root = await createWorkspace();
    const now = Date.now();
    const verifiedAt = now - 10 * DAY_MILLISECONDS;
    const clock = vi.spyOn(Date, "now").mockReturnValue(verifiedAt);
    const bank = createLocalReasoningBank(root);
    const [stored] = await bank.consolidate([
      lesson({ applicability: { taskTerms: ["schema"], maxAgeDays: 7 } }),
    ]);
    clock.mockReturnValue(now);
    const [refreshed] = await bank.consolidate([
      lesson({ applicability: { verifiedAt: now } }),
    ]);
    expect(refreshed?.id).toBe(stored?.id);
    expect(refreshed?.updatedAt).toBe(now);
    expect(refreshed?.applicability).toEqual({
      taskTerms: ["schema"],
      maxAgeDays: 7,
      verifiedAt,
    });

    await bank.consolidate([lesson()]);
    await bank.recordRetrieval([stored!.id]);
    await bank.recordOutcome([stored!.id], "success");
    const reloaded = await createLocalReasoningBank(root).load();
    expect(reloaded[0]?.applicability).toEqual(refreshed?.applicability);
    expect(
      retrieveReasoningLessons("Update runtime schema and bindings", reloaded),
    ).toEqual([]);
  });

  it("records reuse outcomes and allows a lesson to be removed", async () => {
    const root = await createWorkspace();
    const bank = createLocalReasoningBank(root);
    const [stored] = await bank.consolidate([
      lesson({ outcome: "failure", title: "Avoid stale generated contracts" }),
    ]);
    expect(stored).toBeDefined();
    await bank.recordOutcome([stored!.id], "success");
    await bank.recordOutcome([stored!.id], "failure");
    expect((await bank.load())[0]).toMatchObject({
      helpfulCount: 1,
      harmfulCount: 1,
    });
    expect(await bank.forget(stored!.id)).toBe(true);
    expect(await bank.load()).toEqual([]);
  });

  it("records unique prompt retrievals and resets usage for revised guidance", async () => {
    const root = await createWorkspace();
    const bank = createLocalReasoningBank(root);
    const [stored] = await bank.consolidate([lesson()]);

    await bank.recordRetrieval([stored!.id, stored!.id, "unknown"]);
    const [retrieved] = await bank.load();
    expect(retrieved?.retrievalCount).toBe(1);
    expect(retrieved?.lastRetrievedAt).toEqual(expect.any(Number));

    const [revised] = await bank.consolidate([
      lesson({
        content:
          "After editing a runtime schema, regenerate both language contracts and inspect their diff before type checking to catch stale bindings.",
      }),
    ]);
    expect(revised?.id).not.toBe(stored?.id);
    expect(revised?.retrievalCount).toBe(0);
    expect(revised?.lastRetrievedAt).toBeUndefined();
  });

  it("suppresses harmful guidance and reconsiders revised content", async () => {
    const root = await createWorkspace();
    const bank = createLocalReasoningBank(root);
    const [stored] = await bank.consolidate([lesson()]);
    await bank.recordOutcome([stored!.id], "failure");

    expect(
      retrieveReasoningLessons(
        "Update runtime schema and bindings",
        await bank.load(),
      ),
    ).toEqual([]);

    const [revised] = await bank.consolidate([
      lesson({
        content:
          "After changing a runtime schema, inspect the generated contract diff and regenerate any stale bindings before verification.",
        triggerTerms: ["contract diff"],
        confidence: 0.6,
      }),
    ]);
    expect(revised?.id).not.toBe(stored!.id);
    expect(revised).toMatchObject({
      content:
        "After changing a runtime schema, inspect the generated contract diff and regenerate any stale bindings before verification.",
      triggerTerms: ["contract diff"],
      confidence: 0.6,
      evidenceCount: 1,
      helpfulCount: 0,
      harmfulCount: 0,
    });
    await bank.recordOutcome([stored!.id], "success");
    expect((await bank.load())[0]?.helpfulCount).toBe(0);
    expect(
      retrieveReasoningLessons(
        "Update runtime schema and bindings",
        await bank.load(),
      ),
    ).toHaveLength(1);
  });

  it("counts duplicate candidates from one review only once", async () => {
    const root = await createWorkspace();
    const stored = await createLocalReasoningBank(root).consolidate([
      lesson(),
      lesson({ confidence: 0.9 }),
    ]);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ confidence: 0.9, evidenceCount: 1 });
  });

  it("rejects invalid candidates before changing the stored bank", async () => {
    const root = await createWorkspace();
    const bank = createLocalReasoningBank(root);

    await expect(
      bank.consolidate([lesson({ title: "    ", confidence: Number.NaN })]),
    ).rejects.toThrow("Invalid ReasoningBank lesson candidate");
    expect(await bank.load()).toEqual([]);
  });

  it("preserves concurrent writes from separate local bank instances", async () => {
    const root = await createWorkspace();
    await Promise.all([
      createLocalReasoningBank(root).consolidate([lesson()]),
      createLocalReasoningBank(root).consolidate([
        lesson({
          title: "Check failure output before retrying",
          description: "Use the first failure to choose a targeted retry.",
          content:
            "Before repeating a failed command, inspect its output and change the next action to address the observed cause.",
          triggerTerms: ["retry", "failure output"],
          outcome: "failure",
        }),
      ]),
    ]);
    expect(await createLocalReasoningBank(root).load()).toHaveLength(2);
  });

  it("rejects malformed persisted lessons", async () => {
    const root = await createWorkspace();
    const path = getReasoningBankPath(root);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ version: 1, lessons: [{}] }));
    await expect(createLocalReasoningBank(root).load()).rejects.toThrow(
      "Unsupported ReasoningBank document",
    );

    await writeFile(path, "null");
    await expect(createLocalReasoningBank(root).load()).rejects.toThrow(
      "Unsupported ReasoningBank document",
    );

    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        lessons: [
          {
            ...lesson(),
            id: "test",
            evidenceCount: 1,
            helpfulCount: -1,
            harmfulCount: 0,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        ],
      }),
    );
    await expect(createLocalReasoningBank(root).load()).rejects.toThrow(
      "Unsupported ReasoningBank document",
    );
  });
});
