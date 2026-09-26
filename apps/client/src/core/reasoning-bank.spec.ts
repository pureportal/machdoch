import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createLocalReasoningBank,
  getReasoningBankPath,
  retrieveReasoningLessons,
  type ReasoningLessonCandidate,
} from "./reasoning-bank.js";

const roots: string[] = [];

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
    await mkdir(join(root, ".machdoch"), { recursive: true });
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
